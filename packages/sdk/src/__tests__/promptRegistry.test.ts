import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nock from "nock";
import OpenAI from "openai";

import { wrapOpenAI, type TraceHandle } from "../wrapOpenAI";
import { PromptCache } from "../promptRegistry";
import { ABCache, type ABTestConfig } from "../abTesting";
import { TelemetryClient } from "../telemetry";

const BACKEND = "http://localhost:7000";
const LOCAL_PROMPT = "You are the prompt written in the application's source.";
const RELEASED_PROMPT = "You are the prompt promoted in the dashboard.";

let sentSystem: string | undefined;
let traces: any[] = [];

function mockOpenAI(times = 1) {
  nock("https://api.openai.com")
    .post("/v1/chat/completions", (body) => {
      sentSystem = body.messages.find((m: any) => m.role === "system")?.content;
      return true;
    })
    .times(times)
    .reply(200, {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-4o-mini",
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
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

function seededRegistry(): PromptCache {
  const cache = new PromptCache();
  cache.seed([
    {
      promptName: "support",
      promptId: 42,
      version: 3,
      promptText: RELEASED_PROMPT,
      releaseId: 7,
    },
  ]);
  return cache;
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

async function call(client: OpenAI) {
  return client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: LOCAL_PROMPT },
      { role: "user", content: "hi" },
    ],
  });
}

async function waitFor(cond: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("prompt registry", () => {
  beforeAll(() => nock.disableNetConnect());

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    traces = [];
    sentSystem = undefined;
    vi.restoreAllMocks();
  });

  it("serves the released version instead of the prompt in the code", async () => {
    mockOpenAI();
    mockTraces();
    // No /resolve interceptor for the released text: a release already carries
    // its prompt id, so no round trip should be needed to attribute the trace.
    nock(BACKEND).post("/api/prompts/resolve").reply(200, { id: 99, name: "support", version: 9 });

    const handles: TraceHandle[] = [];
    await call(
      makeClient({ promptCache: seededRegistry(), onTrace: (h: TraceHandle) => handles.push(h) })
    );

    expect(sentSystem).toBe(RELEASED_PROMPT);
    expect(handles[0].promptSource).toBe("registry");
    expect(handles[0].releaseId).toBe(7);

    await waitFor(() => traces.length > 0);
    expect(traces[0].promptId).toBe(42);
  });

  /**
   * The whole reason the registry is safe to use. Serving prompts remotely
   * would otherwise put PromptWatch on the critical path, which ADR-3 forbids.
   */
  it("falls back to the local prompt when the registry is empty", async () => {
    mockOpenAI();
    mockTraces();
    nock(BACKEND).post("/api/prompts/resolve").reply(200, { id: 1, name: "support", version: 1 });

    const handles: TraceHandle[] = [];
    await call(
      makeClient({
        promptCache: new PromptCache(), // never polled successfully
        onTrace: (h: TraceHandle) => handles.push(h),
      })
    );

    expect(sentSystem).toBe(LOCAL_PROMPT);
    expect(handles[0].promptSource).toBe("local");
  });

  it("falls back to the local prompt when the backend is unreachable", async () => {
    const cache = new PromptCache();
    nock(BACKEND).get("/api/prompts/published").replyWithError("connection refused");
    cache.start(BACKEND, 60_000, undefined, { onError: () => {} });

    mockOpenAI();
    mockTraces();
    nock(BACKEND).post("/api/prompts/resolve").reply(200, { id: 1, name: "support", version: 1 });

    const handles: TraceHandle[] = [];
    await call(makeClient({ promptCache: cache, onTrace: (h: TraceHandle) => handles.push(h) }));

    expect(sentSystem).toBe(LOCAL_PROMPT);
    expect(handles[0].promptSource).toBe("local");
    cache.stop();
  });

  it("keeps serving the last known release after a poll starts failing", async () => {
    const cache = new PromptCache();
    nock(BACKEND)
      .get("/api/prompts/published")
      .reply(200, [
        { promptName: "support", promptId: 42, version: 3, promptText: RELEASED_PROMPT, releaseId: 7 },
      ]);
    cache.start(BACKEND, 60_000, undefined, { onError: () => {} });
    await waitFor(() => cache.size() === 1);

    // A later poll fails; the cache must not blank itself.
    nock(BACKEND).get("/api/prompts/published").replyWithError("backend down");
    await (cache as unknown as { refresh: () => Promise<void> }).refresh();

    expect(cache.get("support")?.promptText).toBe(RELEASED_PROMPT);
    cache.stop();
  });

  it("ignores the registry entirely when useRegistry is not enabled", async () => {
    mockOpenAI();
    mockTraces();
    nock(BACKEND).post("/api/prompts/resolve").reply(200, { id: 1, name: "support", version: 1 });

    // A cache is supplied but the option is off, so nothing should be served.
    const handles: TraceHandle[] = [];
    const client = wrapOpenAI(new OpenAI({ apiKey: "test" }), {
      promptName: "support",
      backendUrl: BACKEND,
      cache: new ABCache(),
      telemetry: new TelemetryClient(BACKEND, undefined, { maxRetries: 0 }),
      onTrace: (h) => handles.push(h),
    });

    await call(client);
    expect(sentSystem).toBe(LOCAL_PROMPT);
    expect(handles[0].promptSource).toBe("local");
  });

  it("lets a running A/B test outrank a release", async () => {
    const abCache = new ABCache();
    const test: ABTestConfig = {
      id: 11,
      promptName: "support",
      variantAId: 1,
      variantAText: "VARIANT A",
      variantBId: 2,
      variantBText: "VARIANT B",
      splitPercent: 50,
    };
    abCache.seed([test]);

    mockOpenAI();
    mockTraces();

    const handles: TraceHandle[] = [];
    await call(
      makeClient({
        cache: abCache,
        promptCache: seededRegistry(),
        getDistinctId: () => "user-1",
        onTrace: (h: TraceHandle) => handles.push(h),
      })
    );

    expect(["VARIANT A", "VARIANT B"]).toContain(sentSystem);
    expect(sentSystem).not.toBe(RELEASED_PROMPT);
    expect(handles[0].promptSource).toBe("ab-test");
    expect(handles[0].abTestId).toBe(11);
  });

  it("still registers the local text, so a new deploy can be promoted later", async () => {
    mockOpenAI();
    mockTraces();

    let resolvedText: string | undefined;
    const resolveScope = nock(BACKEND)
      .post("/api/prompts/resolve", (body) => {
        resolvedText = body.promptText;
        return true;
      })
      .reply(200, { id: 99, name: "support", version: 9 });

    await call(makeClient({ promptCache: seededRegistry() }));

    // Without this the registry would freeze on whatever was released first:
    // the newly deployed prompt would never appear as a version to promote.
    await waitFor(() => resolveScope.isDone());
    expect(resolvedText).toBe(LOCAL_PROMPT);
    expect(sentSystem).toBe(RELEASED_PROMPT);
  });

  it("does not re-register text identical to the release", async () => {
    mockOpenAI();
    mockTraces();
    const unusedResolve = nock(BACKEND).post("/api/prompts/resolve").reply(200, {});

    const cache = new PromptCache();
    cache.seed([
      { promptName: "support", promptId: 42, version: 3, promptText: LOCAL_PROMPT, releaseId: 7 },
    ]);

    await call(makeClient({ promptCache: cache }));

    await new Promise((r) => setTimeout(r, 150));
    expect(unusedResolve.isDone()).toBe(false);
  });

  it("leaves a call with no system prompt alone", async () => {
    mockOpenAI();
    const unusedTrace = nock(BACKEND).post("/api/traces").reply(201, {});

    const client = makeClient({ promptCache: seededRegistry() });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(sentSystem).toBeUndefined();
    await new Promise((r) => setTimeout(r, 150));
    expect(unusedTrace.isDone()).toBe(false);
  });
});
