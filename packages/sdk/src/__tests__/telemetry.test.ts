import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import nock from "nock";

import { TelemetryClient, type TracePayload } from "../telemetry";

const BACKEND = "http://localhost:4000";

function trace(promptId: number): TracePayload {
  return {
    promptId,
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.001,
    status: "SUCCESS",
  };
}

describe("TelemetryClient", () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  it("posts a single trace as a batch of one", async () => {
    let received: any;
    const scope = nock(BACKEND)
      .post("/api/traces", (body) => {
        received = body;
        return true;
      })
      .reply(201, { created: 1 });

    const client = new TelemetryClient(BACKEND);
    client.send(trace(1));
    await client.flush();

    expect(scope.isDone()).toBe(true);
    expect(Array.isArray(received)).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].promptId).toBe(1);
    expect(client.stats().sent).toBe(1);
  });

  it("coalesces traces that arrive while a request is in flight", async () => {
    const batches: any[][] = [];
    nock(BACKEND)
      .post("/api/traces", (body) => {
        batches.push(body);
        return true;
      })
      .delay(50)
      .times(5)
      .reply(201, {});

    const client = new TelemetryClient(BACKEND);
    // The first send goes out alone; the rest pile into the following batch.
    for (let i = 0; i < 10; i++) client.send(trace(i));
    await client.flush();

    expect(client.stats().sent).toBe(10);
    expect(batches.length).toBeLessThan(10);
    expect(batches.flat()).toHaveLength(10);
  });

  it("never exceeds the configured batch size", async () => {
    const batches: any[][] = [];
    nock(BACKEND)
      .post("/api/traces", (body) => {
        batches.push(body);
        return true;
      })
      .delay(20)
      .times(20)
      .reply(201, {});

    const client = new TelemetryClient(BACKEND, undefined, { batchSize: 3 });
    for (let i = 0; i < 10; i++) client.send(trace(i));
    await client.flush();

    expect(batches.every((b) => b.length <= 3)).toBe(true);
    expect(batches.flat()).toHaveLength(10);
  });

  it("drops the oldest traces once the queue is full, and counts them", async () => {
    nock(BACKEND).post("/api/traces").delay(80).times(10).reply(201, {});

    const client = new TelemetryClient(BACKEND, undefined, {
      maxQueueSize: 5,
      batchSize: 5,
    });
    for (let i = 0; i < 50; i++) client.send(trace(i));

    // Bounded for real: the queue never grew past its cap.
    expect(client.stats().queued).toBeLessThanOrEqual(5);
    expect(client.stats().dropped).toBeGreaterThan(0);
    await client.flush();
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    const scope = nock(BACKEND)
      .post("/api/traces")
      .reply(500, {})
      .post("/api/traces")
      .reply(201, {});

    const client = new TelemetryClient(BACKEND, undefined, { maxRetries: 2 });
    client.send(trace(1));
    await client.flush();

    expect(scope.isDone()).toBe(true);
    expect(client.stats().sent).toBe(1);
    expect(client.stats().dropped).toBe(0);
  });

  it("does not retry a 400, since the payload itself is the problem", async () => {
    const scope = nock(BACKEND).post("/api/traces").times(1).reply(400, {});
    const onError = vi.fn();

    const client = new TelemetryClient(BACKEND, undefined, { maxRetries: 3, onError });
    client.send(trace(1));
    await client.flush();

    expect(scope.isDone()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.stats().dropped).toBe(1);
  });

  it("reports permanently failed traces through onError instead of console", async () => {
    nock(BACKEND).post("/api/traces").times(3).reply(503, {});
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = new TelemetryClient(BACKEND, undefined, { maxRetries: 2, onError });
    client.send(trace(1));
    await client.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe(1); // dropped count
    expect(consoleError).not.toHaveBeenCalled();
    expect(client.stats().dropped).toBe(1);
  });

  it("keeps draining after a batch fails permanently", async () => {
    nock(BACKEND).post("/api/traces").reply(500, {});
    nock(BACKEND).post("/api/traces").times(5).reply(201, {});
    const onError = vi.fn();

    const client = new TelemetryClient(BACKEND, undefined, { maxRetries: 0, batchSize: 1, onError });
    client.send(trace(1));
    client.send(trace(2));
    client.send(trace(3));
    await client.flush();

    expect(client.stats().dropped).toBe(1);
    expect(client.stats().sent).toBe(2);
    expect(client.stats().queued).toBe(0);
  });

  it("times out a hanging backend rather than blocking forever", async () => {
    nock(BACKEND).post("/api/traces").delay(5000).reply(201, {});
    const onError = vi.fn();

    const client = new TelemetryClient(BACKEND, undefined, {
      requestTimeoutMs: 150,
      maxRetries: 0,
      onError,
    });
    const startedAt = Date.now();
    client.send(trace(1));
    await client.flush();

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("send() returns synchronously without awaiting the network", () => {
    nock(BACKEND).post("/api/traces").delay(3000).reply(201, {});

    const client = new TelemetryClient(BACKEND, undefined, { maxRetries: 0 });
    const startedAt = Date.now();
    client.send(trace(1));
    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  it("attaches the bearer token when an apiKey is configured", async () => {
    const scope = nock(BACKEND, { reqheaders: { authorization: "Bearer secret-key" } })
      .post("/api/traces")
      .reply(201, {});

    const client = new TelemetryClient(BACKEND, "secret-key");
    client.send(trace(1));
    await client.flush();

    expect(scope.isDone()).toBe(true);
  });

  it("ignores traces sent after close()", async () => {
    nock(BACKEND).post("/api/traces").reply(201, {});

    const client = new TelemetryClient(BACKEND);
    client.send(trace(1));
    await client.close();

    client.send(trace(2));
    expect(client.stats().queued).toBe(0);
    expect(client.stats().sent).toBe(1);
  });
});
