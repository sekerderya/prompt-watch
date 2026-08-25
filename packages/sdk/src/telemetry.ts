import { HttpError, requestJson } from "./http";

export interface TracePayload {
  promptId: number;
  abTestId?: number;
  variant?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** True when costUsd is a fallback guess because the model was not in the pricing table. */
  pricingUnknown?: boolean;
  status: "SUCCESS" | "ERROR";
  /**
   * Client-generated id for this call, handed to the host application through
   * `onTrace` so it can attach an outcome to the same call later.
   */
  clientTraceId?: string;
}

export interface TelemetryOptions {
  /** Hard cap on buffered traces. Oldest are dropped first once reached. */
  maxQueueSize?: number;
  /** Maximum traces per HTTP request. */
  batchSize?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Retry attempts after the initial try, for retryable failures only. */
  maxRetries?: number;
  /** Called when traces are permanently lost, instead of console.error. */
  onError?: (error: unknown, droppedTraces: number) => void;
}

const DEFAULTS = {
  maxQueueSize: 1000,
  batchSize: 25,
  requestTimeoutMs: 5000,
  maxRetries: 2,
} as const;

export interface TelemetryStats {
  queued: number;
  sent: number;
  dropped: number;
  inFlight: boolean;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as unknown as { unref?: () => void };
  if (typeof maybe.unref === "function") maybe.unref();
}

/**
 * Buffers traces and ships them to the backend without ever blocking the caller.
 *
 * Delivery model — adaptive batching with a single in-flight request:
 *   - Under low load a trace is dispatched immediately (one trace per request),
 *     which keeps the dashboard live during a demo.
 *   - Under burst load, traces that arrive while a request is in flight collect
 *     into the next batch, so throughput is bounded by round trips, not by call
 *     volume.
 *
 * The queue is genuinely bounded: once `maxQueueSize` is reached the oldest
 * traces are dropped and counted, rather than growing without limit.
 */
export class TelemetryClient {
  private readonly queue: TracePayload[] = [];
  private readonly opts: Required<Omit<TelemetryOptions, "onError">> &
    Pick<TelemetryOptions, "onError">;
  private inFlight: Promise<void> | null = null;
  private droppedCount = 0;
  private sentCount = 0;
  private closed = false;

  constructor(
    private readonly backendUrl: string,
    private readonly apiKey?: string,
    options: TelemetryOptions = {}
  ) {
    this.opts = {
      maxQueueSize: options.maxQueueSize ?? DEFAULTS.maxQueueSize,
      batchSize: options.batchSize ?? DEFAULTS.batchSize,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      onError: options.onError,
    };
  }

  /** Enqueue a trace. Never throws, never awaits, never blocks. */
  send(payload: TracePayload): void {
    if (this.closed) return;

    if (this.queue.length >= this.opts.maxQueueSize) {
      this.queue.shift();
      this.droppedCount++;
    }
    this.queue.push(payload);
    void this.pump();
  }

  stats(): TelemetryStats {
    return {
      queued: this.queue.length,
      sent: this.sentCount,
      dropped: this.droppedCount,
      inFlight: this.inFlight !== null,
    };
  }

  /** Drain the queue and wait for every in-flight request to settle. */
  async flush(): Promise<void> {
    while (this.queue.length > 0 || this.inFlight) {
      await (this.inFlight ?? this.pump());
    }
  }

  /** Flush, then refuse further traces. Safe to call more than once. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private pump(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return Promise.resolve();

    const batch = this.queue.splice(0, this.opts.batchSize);
    const run = this.deliver(batch)
      .then(() => {
        this.sentCount += batch.length;
      })
      .catch((err) => {
        this.droppedCount += batch.length;
        this.report(err, batch.length);
      })
      .finally(() => {
        this.inFlight = null;
        // Anything that arrived while this request was in flight goes out next.
        if (this.queue.length > 0) void this.pump();
      });

    this.inFlight = run;
    return run;
  }

  private async deliver(batch: TracePayload[]): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await requestJson(`${this.backendUrl}/api/traces`, {
          method: "POST",
          body: batch,
          apiKey: this.apiKey,
          timeoutMs: this.opts.requestTimeoutMs,
        });
        return;
      } catch (err) {
        const retryable = !(err instanceof HttpError) || err.retryable;
        if (!retryable || attempt >= this.opts.maxRetries) throw err;
        attempt++;
        // 100ms, 200ms, 400ms …
        await new Promise<void>((resolve) => {
          unrefTimer(setTimeout(resolve, 100 * 2 ** (attempt - 1)));
        });
      }
    }
  }

  private report(error: unknown, dropped: number): void {
    if (this.opts.onError) {
      this.opts.onError(error, dropped);
      return;
    }
    console.error(`[promptwatch] dropped ${dropped} trace(s):`, error);
  }
}
