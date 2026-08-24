import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nock from "nock";
import OpenAI from "openai";

import { wrapOpenAI } from "../wrapOpenAI";
import { sha256 } from "../hash";
import { ABCache, type ABTestConfig } from "../abTesting";
import { TelemetryClient } from "../telemetry";

const BACKEND = "http://localhost:3000";
const SYSTEM_TEXT = "You are a helpful assistant.";
const SYSTEM_HASH = sha256(SYSTEM_TEXT);
const USER_CONTENT = "Private user data: SSN 123-45-6789";
const WAIT_TIMEOUT = 5000;

interface TraceBody {
  promptId: number;
  abTestId?: number;
  variant?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  pricingUnknown?: boolean;
  status: string;
}

let resolveBody: any;
let resolveScope: nock.Scope;
/** Every trace the backend received, flattened out of the batch envelopes. */
let traces: TraceBody[] = [];
let traceBody: TraceBody | undefined;
let traceScope: nock.Scope;

function mockResolve({ delay = 0, id = 42 }: { delay?: number; id?: number } = {}) {
  resolveBody = undefined;
  resolveScope = nock(BACKEND)
    .post("/api/prompts/resolve", (body) => {
      resolveBody = body;
      return true;
    })
    .delay(delay)
    .reply(200, { id, name: "support-bot", version: 1 });
  return resolveScope;
}

/** The telemetry client posts an array; record each trace it contains. */
function mockTrace(times = 1) {
  traceScope = nock(BACKEND)
    .post("/api/traces", (body) => {
      const batch: TraceBody[] = Array.isArray(body) ? body : [body];
      traces.push(...batch);
      traceBody = batch[batch.length - 1];
      return true;
    })
    .times(times)
    .reply(201, { created: 1 });
  return traceScope;
}

function mockOpenAICompletions(responseModel = "gpt-4o-mini") {
  nock("https://api.openai.com")
    .post("/v1/chat/completions")
    .reply(200, {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Here is your answer." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 },
    });
}

function makeClient(options?: {
  cache?: ABCache;
  getDistinctId?: () => string | undefined;
  telemetry?: TelemetryClient;
}) {
  return wrapOpenAI(new OpenAI({ apiKey: "test-key" }), {
    promptName: "support-bot",
    backendUrl: BACKEND,
    cache: options?.cache ?? new ABCache(),
    getDistinctId: options?.getDistinctId,
    // Retries are disabled here so a request aborted by nock.cleanAll() at the
    // end of one test cannot be replayed into the next test's interceptors.
    // Retry behaviour has its own coverage in telemetry.test.ts.
    telemetry:
      options?.telemetry ??
      new TelemetryClient(BACKEND, undefined, { maxRetries: 0, requestTimeoutMs: 1000 }),
    backendTimeoutMs: 1000,
  });
}

async function waitFor(cond: () => boolean, timeout = WAIT_TIMEOUT): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mockActiveTests(tests: ABTestConfig[]) {
  return nock(BACKEND).get("/api/ab-tests/active").reply(200, tests);
}

describe("wrapOpenAI", () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    traces = [];
    traceBody = undefined;
    vi.restoreAllMocks();
  });

  it("computes the correct hash for the system prompt", async () => {
    mockOpenAICompletions();
    mockResolve();
    mockTrace();

    const res = await makeClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_TEXT },
        { role: "user", content: USER_CONTENT },
      ],
    });

    expect(res.choices[0]?.message.content).toBe("Here is your answer.");
    expect(resolveScope.isDone()).toBe(true);
    expect(resolveBody.hash).toBe(SYSTEM_HASH);
    expect(resolveBody.promptText).toBe(SYSTEM_TEXT);
    await waitFor(() => !!traceScope.isDone());
    expect(traceBody?.promptId).toBe(42);
  });

  it("never sends user message content in any backend payload", async () => {
    mockOpenAICompletions();
    mockResolve();
    mockTrace();

    await makeClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_TEXT },
        { role: "user", content: USER_CONTENT },
      ],
    });

    await waitFor(() => !!traceScope.isDone());
    expect(JSON.stringify(resolveBody)).not.toContain(USER_CONTENT);
    expect(JSON.stringify(traces)).not.toContain(USER_CONTENT);
  });

  it("skips resolve entirely when there is no system prompt", async () => {
    mockOpenAICompletions();
    const unusedResolve = nock(BACKEND).post("/api/prompts/resolve").reply(200, {});
    const unusedTrace = nock(BACKEND).post("/api/traces").reply(201, {});

    const res = await makeClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(res.choices[0]?.message.content).toBe("Here is your answer.");
    await new Promise((r) => setTimeout(r, 200));
    expect(unusedResolve.isDone()).toBe(false);
    expect(unusedTrace.isDone()).toBe(false);
  });

  it("sends the trace with the correct promptId even when resolve returns late", async () => {
    mockOpenAICompletions();
    mockResolve({ delay: 300, id: 77 });
    mockTrace();

    await makeClient().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_TEXT },
        { role: "user", content: "Hello" },
      ],
    });

    await waitFor(() => !!traceScope.isDone());
    expect(traceBody?.promptId).toBe(77);
    expect(traceBody?.status).toBe("SUCCESS");
    expect(traceBody?.promptTokens).toBe(120);
    expect(traceBody?.completionTokens).toBe(340);
  });

  it("uses an active AB test to substitute the variant prompt and skips resolve", async () => {
    const cache = new ABCache();
    mockActiveTests([
      {
        id: 10,
        promptName: "support-bot",
        variantAId: 1,
        variantAText: "VARIANT A TEXT",
        variantBId: 2,
        variantBText: "VARIANT B TEXT",
        splitPercent: 50,
      },
    ]);
    cache.start(BACKEND, 60000);
    await waitFor(() => cache.get("support-bot") !== undefined);

    let sentBody: any;
    nock("https://api.openai.com")
      .post("/v1/chat/completions", (body) => {
        sentBody = body;
        return true;
      })
      .reply(200, {
        id: "chatcmpl-ab",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "AB answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    const unusedResolve = nock(BACKEND).post("/api/prompts/resolve").reply(200, {});
    mockTrace();

    await makeClient({ cache, getDistinctId: () => "user-123" }).chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_TEXT },
        { role: "user", content: "Hello" },
      ],
    });

    await waitFor(() => !!traceScope.isDone());
    const sentSystem = sentBody.messages.find((m: any) => m.role === "system").content;
    expect(sentSystem).not.toBe(SYSTEM_TEXT);
    expect(["VARIANT A TEXT", "VARIANT B TEXT"]).toContain(sentSystem);
    expect(unusedResolve.isDone()).toBe(false);
    expect(traceBody?.abTestId).toBe(10);
    expect(traceBody?.variant).toMatch(/^[AB]$/);
    expect(traceBody?.promptId).toBe(sentSystem === "VARIANT A TEXT" ? 1 : 2);
    cache.stop();
  });

  it("assigns the same variant for the same distinctId across calls", async () => {
    const cache = new ABCache();
    mockActiveTests([
      {
        id: 20,
        promptName: "support-bot",
        variantAId: 1,
        variantAText: "KEEP A",
        variantBId: 2,
        variantBText: "KEEP B",
        splitPercent: 50,
      },
    ]);
    cache.start(BACKEND, 60000);
    await waitFor(() => cache.get("support-bot") !== undefined);

    const sentVariants: string[] = [];
    nock("https://api.openai.com")
      .post("/v1/chat/completions", (body) => {
        sentVariants.push(body.messages.find((m: any) => m.role === "system").content);
        return true;
      })
      .times(2)
      .reply(200, {
        id: "chatcmpl-ab",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "AB answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    // Two calls may arrive as one batch or two, depending on timing.
    mockTrace(2);

    const client = makeClient({ cache, getDistinctId: () => "user-456" });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM_TEXT }],
    });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM_TEXT }],
    });

    await waitFor(() => traces.length === 2);
    expect(sentVariants).toHaveLength(2);
    expect(sentVariants[0]).toBe(sentVariants[1]);
    const expectedPromptId = sentVariants[1] === "KEEP A" ? 1 : 2;
    expect(traces.every((t) => t.promptId === expectedPromptId)).toBe(true);
    cache.stop();
  });

  describe("error handling", () => {
    it("records an ERROR trace when the OpenAI call fails", async () => {
      nock("https://api.openai.com")
        .post("/v1/chat/completions")
        .reply(500, { error: { message: "upstream boom" } });
      mockResolve({ id: 99 });
      mockTrace();

      await expect(
        makeClient().chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_TEXT },
            { role: "user", content: "Hello" },
          ],
        })
      ).rejects.toThrow();

      await waitFor(() => !!traceScope.isDone());
      expect(traceBody?.status).toBe("ERROR");
      expect(traceBody?.promptId).toBe(99);
      expect(traceBody?.costUsd).toBe(0);
    });

    it("still emits a SUCCESS trace when the response carries no usage block", async () => {
      nock("https://api.openai.com")
        .post("/v1/chat/completions")
        .reply(200, {
          id: "chatcmpl-nousage",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
        });
      mockResolve({ id: 55 });
      mockTrace();

      await makeClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_TEXT }],
      });

      await waitFor(() => !!traceScope.isDone());
      expect(traceBody?.status).toBe("SUCCESS");
      expect(traceBody?.promptId).toBe(55);
      expect(traceBody?.promptTokens).toBe(0);
    });

    it("returns to the caller without waiting for a hanging backend", async () => {
      mockOpenAICompletions();
      // /resolve accepts the connection and then stalls well past the timeout.
      nock(BACKEND).post("/api/prompts/resolve").delay(3000).reply(200, { id: 1 });
      nock(BACKEND).post("/api/traces").reply(201, {});

      const startedAt = Date.now();
      const res = await makeClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_TEXT }],
      });
      const elapsed = Date.now() - startedAt;

      expect(res.choices[0]?.message.content).toBe("Here is your answer.");
      // The old implementation awaited /resolve before returning, so this took 3s.
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("cost accounting", () => {
    it("prices against the requested model, not the dated snapshot echoed back", async () => {
      // The real API answers "gpt-4o-mini" with a dated snapshot id, which
      // matches no pricing alias and used to silently fall back to gpt-4o rates.
      mockOpenAICompletions("gpt-4o-mini-2024-07-18");
      mockResolve();
      mockTrace();

      await makeClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_TEXT }],
      });

      await waitFor(() => !!traceScope.isDone());
      // 120/1000 * 0.00015 + 340/1000 * 0.0006
      expect(traceBody?.costUsd).toBeCloseTo(0.000222, 9);
      expect(traceBody?.pricingUnknown).toBe(false);
    });

    it("flags the trace when the model is not in the pricing table", async () => {
      mockOpenAICompletions("some-unlisted-model");
      mockResolve();
      mockTrace();

      await makeClient().chat.completions.create({
        model: "some-unlisted-model",
        messages: [{ role: "system", content: SYSTEM_TEXT }],
      });

      await waitFor(() => !!traceScope.isDone());
      expect(traceBody?.pricingUnknown).toBe(true);
    });
  });

  describe("wrapping semantics", () => {
    it("does not mutate the client it was given", async () => {
      const raw = new OpenAI({ apiKey: "test-key" });
      const originalCreate = raw.chat.completions.create;

      const wrapped = wrapOpenAI(raw, { promptName: "support-bot", backendUrl: BACKEND });

      expect(raw.chat.completions.create).toBe(originalCreate);
      expect(wrapped.chat.completions.create).not.toBe(originalCreate);
      expect(wrapped).not.toBe(raw);
    });

    it("refuses to wrap the same client twice", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const raw = new OpenAI({ apiKey: "test-key" });

      const once = wrapOpenAI(raw, { promptName: "support-bot", backendUrl: BACKEND });
      const twice = wrapOpenAI(once, { promptName: "support-bot", backendUrl: BACKEND });

      expect(twice).toBe(once);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("emits exactly one trace per call after a double-wrap attempt", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockOpenAICompletions();
      mockResolve();
      mockTrace();

      const once = makeClient();
      const twice = wrapOpenAI(once, { promptName: "support-bot", backendUrl: BACKEND });

      await twice.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_TEXT }],
      });

      await waitFor(() => traces.length > 0);
      await new Promise((r) => setTimeout(r, 150));
      expect(traces).toHaveLength(1);
    });

    it("passes non-chat properties through to the underlying client", () => {
      const raw = new OpenAI({ apiKey: "test-key", baseURL: "https://api.openai.com/v1" });
      const wrapped = wrapOpenAI(raw, { promptName: "support-bot", backendUrl: BACKEND });

      expect(wrapped.baseURL).toBe(raw.baseURL);
      expect(typeof wrapped.embeddings.create).toBe("function");
    });
  });
});
