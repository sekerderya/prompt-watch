import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nock from "nock";
import OpenAI from "openai";

import { createPromptWatch } from "../promptWatch";
import { resolvePricing, type ModelPricing } from "../pricing";
import { wrapOpenAI } from "../wrapOpenAI";
import { ABCache } from "../abTesting";
import { TelemetryClient } from "../telemetry";

const BACKEND = "http://localhost:6000";
const SYSTEM_TEXT = "You are a helpful assistant.";

function mockOpenAI(times = 1, model = "gpt-4o-mini") {
  nock("https://api.openai.com")
    .post("/v1/chat/completions")
    .times(times)
    .reply(200, {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    });
}

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("createPromptWatch", () => {
  beforeAll(() => nock.disableNetConnect());

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  it("polls for active tests once, no matter how many prompts are wrapped", async () => {
    // The point of the factory: N prompts must not mean N poll loops.
    const poll = nock(BACKEND).get("/api/ab-tests/active").times(1).reply(200, []);

    const pw = createPromptWatch({ backendUrl: BACKEND, pollIntervalMs: 60_000 });
    const openai = new OpenAI({ apiKey: "test" });
    pw.wrap(openai, { promptName: "support" });
    pw.wrap(openai, { promptName: "summariser" });
    pw.wrap(openai, { promptName: "classifier" });

    await waitFor(() => poll.isDone());
    expect(poll.isDone()).toBe(true);
    await pw.close();
  });

  it("routes every wrapped prompt through one telemetry queue", async () => {
    nock(BACKEND).get("/api/ab-tests/active").reply(200, []);
    nock(BACKEND).post("/api/prompts/resolve").times(2).reply(200, { id: 1, name: "x", version: 1 });
    mockOpenAI(2);

    const batches: unknown[][] = [];
    nock(BACKEND)
      .post("/api/traces", (body) => {
        batches.push(body as unknown[]);
        return true;
      })
      .times(2)
      .reply(201, {});

    const pw = createPromptWatch({ backendUrl: BACKEND, pollIntervalMs: 60_000 });
    const openai = new OpenAI({ apiKey: "test" });
    const support = pw.wrap(openai, { promptName: "support" });
    const summariser = pw.wrap(openai, { promptName: "summariser" });

    await Promise.all([
      support.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_TEXT }],
      }),
      summariser.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "Summarise this." }],
      }),
    ]);
    await pw.flush();

    expect(batches.flat()).toHaveLength(2);
    expect(pw.telemetry.stats().sent).toBe(2);
    await pw.close();
  });

  it("leaves the underlying client untouched by any wrap", () => {
    nock(BACKEND).get("/api/ab-tests/active").reply(200, []);

    const openai = new OpenAI({ apiKey: "test" });
    const original = openai.chat.completions.create;

    const pw = createPromptWatch({ backendUrl: BACKEND, pollIntervalMs: 60_000 });
    const a = pw.wrap(openai, { promptName: "a" });
    const b = pw.wrap(openai, { promptName: "b" });

    expect(openai.chat.completions.create).toBe(original);
    expect(a).not.toBe(b);
    void pw.close();
  });

  it("close() stops polling and refuses further traces", async () => {
    nock(BACKEND).get("/api/ab-tests/active").reply(200, []);

    const pw = createPromptWatch({ backendUrl: BACKEND, pollIntervalMs: 20 });
    await pw.close();

    const afterClose = nock(BACKEND).get("/api/ab-tests/active").reply(200, []);
    await new Promise((r) => setTimeout(r, 120));
    expect(afterClose.isDone()).toBe(false);
  });
});

describe("pricing overrides", () => {
  beforeAll(() => nock.disableNetConnect());

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
  });

  const custom: Record<string, ModelPricing> = {
    "acme-llm": { promptPricePer1k: 0.002, completionPricePer1k: 0.004 },
  };

  it("prices a model the built-in table has never heard of", () => {
    const { pricing, unknown, matchedKey } = resolvePricing("acme-llm-2026-01-01", custom);
    expect(unknown).toBe(false);
    expect(matchedKey).toBe("acme-llm");
    expect(pricing).toEqual(custom["acme-llm"]);
  });

  it("lets an override correct a built-in price", () => {
    const corrected = resolvePricing("gpt-4o-mini", {
      "gpt-4o-mini": { promptPricePer1k: 9, completionPricePer1k: 9 },
    });
    expect(corrected.pricing.promptPricePer1k).toBe(9);
  });

  it("leaves the built-in table intact when no override matches", () => {
    expect(resolvePricing("gpt-4o-mini", custom).matchedKey).toBe("gpt-4o-mini");
  });

  it("is used by wrapOpenAI, so an unknown model stops being an estimate", async () => {
    nock(BACKEND).post("/api/prompts/resolve").reply(200, { id: 5, name: "x", version: 1 });
    mockOpenAI(1, "acme-llm");

    let recorded: any;
    nock(BACKEND)
      .post("/api/traces", (body) => {
        recorded = (body as any[])[0];
        return true;
      })
      .reply(201, {});

    const client = wrapOpenAI(new OpenAI({ apiKey: "test" }), {
      promptName: "support",
      backendUrl: BACKEND,
      cache: new ABCache(),
      telemetry: new TelemetryClient(BACKEND, undefined, { maxRetries: 0 }),
      pricing: custom,
    });

    await client.chat.completions.create({
      model: "acme-llm",
      messages: [{ role: "system", content: SYSTEM_TEXT }],
    });

    await waitFor(() => recorded !== undefined);
    expect(recorded.pricingUnknown).toBe(false);
    // 100/1000 * 0.002 + 200/1000 * 0.004
    expect(recorded.costUsd).toBeCloseTo(0.001, 9);
  });
});
