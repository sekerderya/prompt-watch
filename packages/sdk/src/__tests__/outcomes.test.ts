import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nock from "nock";

import { OutcomeClient, validateOutcome, MAX_LABEL_LENGTH } from "../outcomes";

const BACKEND = "http://localhost:5000";

describe("validateOutcome", () => {
  it("accepts a score at either end of the range", () => {
    expect(validateOutcome({ score: 0 })).toBeNull();
    expect(validateOutcome({ score: 1 })).toBeNull();
    expect(validateOutcome({ score: 0.42 })).toBeNull();
  });

  it("rejects a score outside 0..1", () => {
    expect(validateOutcome({ score: -0.1 })).toMatch(/between 0 and 1/);
    expect(validateOutcome({ score: 5 })).toMatch(/between 0 and 1/);
  });

  it("rejects a non-finite score", () => {
    expect(validateOutcome({ score: NaN })).toMatch(/finite/);
    expect(validateOutcome({ score: Infinity })).toMatch(/finite/);
    expect(validateOutcome({ score: "1" as unknown as number })).toMatch(/finite/);
  });

  it("caps the label so it stays a tag, not a place for user content", () => {
    expect(validateOutcome({ score: 1, label: "x".repeat(MAX_LABEL_LENGTH) })).toBeNull();
    expect(validateOutcome({ score: 1, label: "x".repeat(MAX_LABEL_LENGTH + 1) })).toMatch(
      /at most/
    );
  });
});

describe("OutcomeClient", () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  it("posts a single outcome as a batch of one", async () => {
    let received: any;
    const scope = nock(BACKEND)
      .post("/api/outcomes", (body) => {
        received = body;
        return true;
      })
      .reply(201, { recorded: 1 });

    const client = new OutcomeClient(BACKEND);
    const ok = await client.record("trace-1", { score: 1, label: "thumbs_up" });

    expect(ok).toBe(true);
    expect(scope.isDone()).toBe(true);
    expect(received).toEqual([{ traceId: "trace-1", score: 1, label: "thumbs_up" }]);
  });

  it("posts several outcomes in one request", async () => {
    let received: any;
    nock(BACKEND)
      .post("/api/outcomes", (body) => {
        received = body;
        return true;
      })
      .reply(201, { recorded: 3 });

    const client = new OutcomeClient(BACKEND);
    const ok = await client.recordMany([
      { traceId: "a", score: 1 },
      { traceId: "b", score: 0 },
      { traceId: "c", score: 0.5 },
    ]);

    expect(ok).toBe(true);
    expect(received).toHaveLength(3);
  });

  it("rejects an invalid score before sending anything", async () => {
    const unused = nock(BACKEND).post("/api/outcomes").reply(201, {});
    const onError = vi.fn();

    const client = new OutcomeClient(BACKEND, undefined, { onError });
    const ok = await client.record("trace-1", { score: 42 });

    expect(ok).toBe(false);
    expect(unused.isDone()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing trace id", async () => {
    const onError = vi.fn();
    const client = new OutcomeClient(BACKEND, undefined, { onError });

    expect(await client.record("", { score: 1 })).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("returns false instead of throwing when the backend rejects", async () => {
    nock(BACKEND).post("/api/outcomes").reply(400, { error: "nope" });
    const onError = vi.fn();

    const client = new OutcomeClient(BACKEND, undefined, { onError });
    const ok = await client.record("trace-1", { score: 1 });

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("returns false instead of hanging when the backend stalls", async () => {
    nock(BACKEND).post("/api/outcomes").delay(5000).reply(201, {});

    const client = new OutcomeClient(BACKEND, undefined, {
      requestTimeoutMs: 150,
      onError: () => {},
    });
    const startedAt = Date.now();
    const ok = await client.record("trace-1", { score: 1 });

    expect(ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("attaches the bearer token when an apiKey is configured", async () => {
    const scope = nock(BACKEND, { reqheaders: { authorization: "Bearer secret" } })
      .post("/api/outcomes")
      .reply(201, {});

    const client = new OutcomeClient(BACKEND, "secret");
    await client.record("trace-1", { score: 1 });

    expect(scope.isDone()).toBe(true);
  });

  it("treats an empty batch as a no-op", async () => {
    const unused = nock(BACKEND).post("/api/outcomes").reply(201, {});
    const client = new OutcomeClient(BACKEND);

    expect(await client.recordMany([])).toBe(true);
    expect(unused.isDone()).toBe(false);
  });
});
