import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nock from "nock";
import OpenAI from "openai";

import { wrapOpenAI, type TraceHandle } from "../wrapOpenAI";
import { normalizeUsage, responsesAdapter } from "../apiAdapters";
import { ABCache, type ABTestConfig } from "../abTesting";
import { PromptCache } from "../promptRegistry";
import { TelemetryClient } from "../telemetry";

const BACKEND = "http://localhost:8000";
const INSTRUCTIONS = "You are a helpful assistant.";

let sentBody: any;
let traces: any[] = [];

/** Mirrors the shape openai@4 declares for a Responses call. */
function mockResponses(usage: unknown = { input_tokens: 120, output_tokens: 340, total_tokens: 460 }) {
  nock("https://api.openai.com")
    .post("/v1/responses", (body) => {
      sentBody = body;
      return true;
    })
    .reply(200, {
      id: "resp_123",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: "gpt-4o-mini-2024-07-18",
      status: "completed",
      output: [
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Here is your answer.", annotations: [] }],
        },
      ],
      usage,
    });
}

function mockTraces(times = 1) {
  return nock(BACKEND)
    .post("/api/traces", (body) => {
      traces.push(...(Array.isArray(body) ? body : [body]));
      return true;
    })
    .times(times)
    .reply(201, {});
}

function mockResolve(id = 55) {
  return nock(BACKEND)
    .post("/api/prompts/resolve")
    .reply(200, { id, name: "support", version: 1 });
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return wrapOpenAI(new OpenAI({ apiKey: "test" }), {
    promptName: "support",
    backendUrl: BACKEND,
    cache: new ABCache(),
    telemetry: new TelemetryClient(BACKEND, undefined, { maxRetries: 0, requestTimeoutMs: 800 }),
    backendTimeoutMs: 800,
    ...overrides,
  });
}

async function waitFor(cond: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("normalizeUsage", () => {
  it("reads the Chat Completions shape", () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20 })).toEqual({
      promptTokens: 10,
      completionTokens: 20,
    });
  });

  it("reads the Responses shape", () => {
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 20, total_tokens: 30 })).toEqual({
      promptTokens: 10,
      completionTokens: 20,
    });
  });

  it("returns undefined for a shape it does not recognise", () => {
    // A provider renaming a field should cost the cost figure, never the trace.
    expect(normalizeUsage({ tokens_in: 1, tokens_out: 2 })).toBeUndefined();
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage("nonsense")).toBeUndefined();
  });

  it("tolerates a half-present usage object", () => {
    expect(normalizeUsage({ input_tokens: 7 })).toEqual({ promptTokens: 7, completionTokens: 0 });
  });
});

describe("responsesAdapter", () => {
  it("reads and writes instructions without mutating the caller's body", () => {
    const body = { model: "gpt-4o-mini", instructions: "original", input: "hi" };
    const next = responsesAdapter.writePrompt(body, "replaced");

    expect(responsesAdapter.readPrompt(body)).toBe("original");
    expect(next.instructions).toBe("replaced");
    expect(next.input).toBe("hi");
    expect(body.instructions).toBe("original");
  });

  it("reports no prompt when the call has no instructions", () => {
    expect(responsesAdapter.readPrompt({ model: "m", input: "hi" })).toBeNull();
  });

  it("neither injects nor swallows anything on a stream", () => {
    const body = { model: "m", input: "hi", stream: true };
    const { body: prepared, streamOptions } = responsesAdapter.prepareStream(body);

    // Purely observational: no assumption about this API's request options can
    // corrupt a caller's stream.
    expect(prepared).toBe(body);
    expect(streamOptions.isSyntheticUsageChunk).toBeUndefined();
  });

  it("finds usage on the terminal response.completed event", () => {
    const { streamOptions } = responsesAdapter.prepareStream({ stream: true });
    const event = {
      type: "response.completed",
      response: { usage: { input_tokens: 3, output_tokens: 4 } },
    };
    expect(streamOptions.readUsage!(event)).toEqual({ input_tokens: 3, output_tokens: 4 });
    expect(streamOptions.readUsage!({ type: "response.output_text.delta" })).toBeUndefined();
  });
});

describe("wrapOpenAI — Responses API", () => {
  beforeAll(() => nock.disableNetConnect());

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    traces = [];
    sentBody = undefined;
    vi.restoreAllMocks();
  });

  it("versions the instructions and traces the call", async () => {
    mockResponses();
    const resolveScope = mockResolve(55);
    mockTraces();

    const client = makeClient();
    const res: any = await client.responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: "When will my order arrive?",
    });

    expect(res.output[0].content[0].text).toBe("Here is your answer.");
    expect(resolveScope.isDone()).toBe(true);

    await waitFor(() => traces.length > 0);
    expect(traces[0].promptId).toBe(55);
    expect(traces[0].promptTokens).toBe(120);
    expect(traces[0].completionTokens).toBe(340);
    expect(traces[0].status).toBe("SUCCESS");
  });

  it("prices the Responses token shape correctly", async () => {
    mockResponses();
    mockResolve();
    mockTraces();

    await makeClient().responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: "hi",
    });

    await waitFor(() => traces.length > 0);
    // 120/1000 * 0.00015 + 340/1000 * 0.0006 — the same figure the chat path
    // produces for the same token counts.
    expect(traces[0].costUsd).toBeCloseTo(0.000222, 9);
    expect(traces[0].pricingUnknown).toBe(false);
  });

  it("records an ERROR trace when the call fails", async () => {
    nock("https://api.openai.com")
      .post("/v1/responses")
      .times(4) // the client retries; every attempt must see the 429
      .reply(429, { error: { message: "slow down" } });
    mockResolve(77);
    mockTraces();

    await expect(
      makeClient().responses.create({
        model: "gpt-4o-mini",
        instructions: INSTRUCTIONS,
        input: "hi",
      })
    ).rejects.toThrow();

    await waitFor(() => traces.some((t) => t.promptId === 77));
    const trace = traces.find((t) => t.promptId === 77)!;
    expect(trace.status).toBe("ERROR");
    expect(trace.errorType).toBe("RATE_LIMIT");
  });

  it("still traces a call whose usage block is missing or unfamiliar", async () => {
    mockResponses({ tokens_used: 999 });
    mockResolve();
    mockTraces();

    await makeClient().responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: "hi",
    });

    await waitFor(() => traces.length > 0);
    expect(traces[0].status).toBe("SUCCESS");
    expect(traces[0].promptTokens).toBe(0);
  });

  it("skips a call with no instructions to track", async () => {
    mockResponses();
    const unusedResolve = nock(BACKEND).post("/api/prompts/resolve").reply(200, {});
    const unusedTrace = nock(BACKEND).post("/api/traces").reply(201, {});

    await makeClient().responses.create({ model: "gpt-4o-mini", input: "hi" });

    await new Promise((r) => setTimeout(r, 150));
    expect(unusedResolve.isDone()).toBe(false);
    expect(unusedTrace.isDone()).toBe(false);
  });

  it("substitutes an A/B variant into instructions", async () => {
    const cache = new ABCache();
    const test: ABTestConfig = {
      id: 12,
      promptName: "support",
      variantAId: 1,
      variantAText: "VARIANT A",
      variantBId: 2,
      variantBText: "VARIANT B",
      splitPercent: 50,
    };
    cache.seed([test]);
    mockResponses();
    mockTraces();

    const handles: TraceHandle[] = [];
    await makeClient({
      cache,
      getDistinctId: () => "user-1",
      onTrace: (h: TraceHandle) => handles.push(h),
    }).responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: "hi",
    });

    expect(["VARIANT A", "VARIANT B"]).toContain(sentBody.instructions);
    expect(handles[0].promptSource).toBe("ab-test");
    expect(handles[0].api).toBe("responses");

    await waitFor(() => traces.length > 0);
    expect(traces[0].abTestId).toBe(12);
  });

  it("serves a released version through instructions", async () => {
    const promptCache = new PromptCache();
    promptCache.seed([
      {
        promptName: "support",
        promptId: 42,
        version: 3,
        promptText: "RELEASED TEXT",
        releaseId: 9,
      },
    ]);
    mockResponses();
    mockResolve();
    mockTraces();

    const handles: TraceHandle[] = [];
    await makeClient({ promptCache, onTrace: (h: TraceHandle) => handles.push(h) }).responses.create(
      { model: "gpt-4o-mini", instructions: INSTRUCTIONS, input: "hi" }
    );

    expect(sentBody.instructions).toBe("RELEASED TEXT");
    expect(handles[0].promptSource).toBe("registry");
  });

  it("falls back to the caller's instructions when the registry is empty", async () => {
    mockResponses();
    mockResolve();
    mockTraces();

    const handles: TraceHandle[] = [];
    await makeClient({
      promptCache: new PromptCache(),
      onTrace: (h: TraceHandle) => handles.push(h),
    }).responses.create({ model: "gpt-4o-mini", instructions: INSTRUCTIONS, input: "hi" });

    expect(sentBody.instructions).toBe(INSTRUCTIONS);
    expect(handles[0].promptSource).toBe("local");
  });

  it("never sends the user input to the backend", async () => {
    const secret = "my card number is 4111 1111 1111 1111";
    mockResponses();
    let resolveBody: any;
    nock(BACKEND)
      .post("/api/prompts/resolve", (b) => {
        resolveBody = b;
        return true;
      })
      .reply(200, { id: 1, name: "support", version: 1 });
    mockTraces();

    await makeClient().responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: secret,
    });

    await waitFor(() => traces.length > 0);
    expect(JSON.stringify(resolveBody)).not.toContain(secret);
    expect(JSON.stringify(traces)).not.toContain(secret);
  });

  it("leaves the original client's responses.create untouched", () => {
    const raw = new OpenAI({ apiKey: "test" });
    const original = raw.responses.create;

    const wrapped = wrapOpenAI(raw, { promptName: "support", backendUrl: BACKEND });

    expect(raw.responses.create).toBe(original);
    expect(wrapped.responses.create).not.toBe(original);
  });

  it("passes other responses methods straight through", () => {
    const raw = new OpenAI({ apiKey: "test" });
    const wrapped = wrapOpenAI(raw, { promptName: "support", backendUrl: BACKEND });

    expect(typeof wrapped.responses.retrieve).toBe("function");
  });

  it("does not break on a client that has no responses API at all", async () => {
    // Older openai releases have no `responses` property; the proxy must not
    // invent one, and chat.completions must still work.
    const legacy = {
      chat: { completions: { create: async () => ({ usage: undefined }) } },
    } as unknown as OpenAI;

    const wrapped = wrapOpenAI(legacy, { promptName: "support", backendUrl: BACKEND });

    expect((wrapped as unknown as { responses?: unknown }).responses).toBeUndefined();
    expect(typeof wrapped.chat.completions.create).toBe("function");
  });
});

describe("wrapOpenAI — Responses streaming", () => {
  beforeAll(() => nock.disableNetConnect());

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    traces = [];
    vi.restoreAllMocks();
  });

  /** Stands in for the event sequence the Responses API streams. */
  function streamingClient(events: any[]) {
    const fake = {
      chat: { completions: { create: async () => ({}) } },
      responses: {
        create: async () =>
          (async function* () {
            for (const event of events) yield event;
          })(),
      },
    } as unknown as OpenAI;

    return wrapOpenAI(fake, {
      promptName: "support",
      backendUrl: BACKEND,
      cache: new ABCache(),
      telemetry: new TelemetryClient(BACKEND, undefined, { maxRetries: 0 }),
    });
  }

  it("passes every event through untouched and captures usage from the last one", async () => {
    mockResolve(31);
    mockTraces();

    const events = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      {
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 11, output_tokens: 22 } },
      },
    ];

    const received: any[] = [];
    const stream: any = await streamingClient(events).responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: "hi",
      stream: true,
    });
    for await (const event of stream) received.push(event);

    // Nothing swallowed: the caller sees exactly what the API sent.
    expect(received).toEqual(events);

    await waitFor(() => traces.some((t) => t.promptId === 31));
    const trace = traces.find((t) => t.promptId === 31)!;
    expect(trace.promptTokens).toBe(11);
    expect(trace.completionTokens).toBe(22);
    expect(trace.status).toBe("SUCCESS");
  });

  it("still records a trace when the consumer stops early", async () => {
    mockResolve(31);
    mockTraces();

    const stream: any = await streamingClient([
      { type: "response.output_text.delta", delta: "one" },
      { type: "response.output_text.delta", delta: "two" },
    ]).responses.create({
      model: "gpt-4o-mini",
      instructions: INSTRUCTIONS,
      input: "hi",
      stream: true,
    });

    for await (const _event of stream) break;

    await waitFor(() => traces.some((t) => t.promptId === 31));
    expect(traces.find((t) => t.promptId === 31)!.status).toBe("SUCCESS");
  });
});
