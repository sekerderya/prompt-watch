import { afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import OpenAI from "openai";

import { wrapOpenAI } from "../wrapOpenAI";
import { sha256 } from "../hash";
import { ABCache, type ABTestConfig } from "../abTesting";

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
  status: string;
}

let resolveBody: any;
let resolveScope: nock.Scope;
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

function mockTrace(id = 1) {
  traceBody = undefined;
  traceScope = nock(BACKEND)
    .post("/api/traces", (body) => {
      traceBody = body as TraceBody;
      return true;
    })
    .reply(201, { id });
  return traceScope;
}

function mockOpenAICompletions(model = "gpt-4o-mini") {
  nock("https://api.openai.com")
    .post("/v1/chat/completions")
    .reply(200, {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      system_fingerprint: "fp_test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Here is your answer.",
            refusal: null,
            annotations: [],
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 340, total_tokens: 460 },
    });
}

function makeClient(options?: { cache?: ABCache; getDistinctId?: () => string | undefined }) {
  return wrapOpenAI(new OpenAI({ apiKey: "test-key" }), {
    promptName: "support-bot",
    backendUrl: BACKEND,
    cache: options?.cache ?? new ABCache(),
    getDistinctId: options?.getDistinctId,
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
    nock.cleanAll();
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
    expect(JSON.stringify(traceBody)).not.toContain(USER_CONTENT);
  });

  it("skips resolve entirely when there is no system prompt", async () => {
    mockOpenAICompletions();
    const unusedResolve = nock(BACKEND).post("/api/prompts/resolve").reply(200, {});
    const unusedTrace = nock(BACKEND).post("/api/traces").reply(201, { id: 1 });

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
    const traceScopes = [mockTrace(1), mockTrace(2)];

    const client = makeClient({ cache, getDistinctId: () => "user-456" });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM_TEXT }],
    });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: SYSTEM_TEXT }],
    });

    await waitFor(() => traceScopes.every((s) => s.isDone()));
    expect(sentVariants).toHaveLength(2);
    expect(sentVariants[0]).toBe(sentVariants[1]);
    expect(traceBody?.promptId).toBe(sentVariants[1] === "KEEP A" ? 1 : 2);
    cache.stop();
  });
});