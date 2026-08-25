import { requestJson } from "./http";

export interface PollingOptions {
  requestTimeoutMs?: number;
  /**
   * Fraction of the interval to randomise each tick by, spreading polls across
   * replicas instead of having them all fire on the same second. 0 disables it.
   */
  jitterRatio?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_JITTER_RATIO = 0.2;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as unknown as { unref?: () => void };
  if (typeof maybe.unref === "function") maybe.unref();
}

/**
 * Shared machinery for the SDK's background caches.
 *
 * Both the A/B test cache and the prompt registry cache need the same three
 * behaviours, and getting any of them subtly different between the two would be
 * the kind of bug nobody notices for months:
 *
 *   - a self-rescheduling timeout rather than setInterval, so each tick can
 *     carry its own jitter and replicas do not synchronise;
 *   - an unref'd timer, so a polling cache is never the reason a short-lived
 *     script refuses to exit;
 *   - failure that logs and retries on the next tick, never throws, and never
 *     discards the last good value — a backend outage must leave the cache
 *     serving what it already knows.
 */
export abstract class PollingCache<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  protected backendUrl: string | undefined;
  protected apiKey: string | undefined;
  private intervalMs = 30000;
  protected options: PollingOptions = {};

  /** Endpoint path, e.g. "/api/ab-tests/active". */
  protected abstract readonly path: string;

  /** Called with each successful response body. */
  protected abstract apply(payload: T): void;

  /** Human-readable name used in the default error log. */
  protected abstract readonly label: string;

  start(
    backendUrl: string,
    intervalMs = 30000,
    apiKey?: string,
    options: PollingOptions = {}
  ): void {
    this.stop();
    this.backendUrl = backendUrl;
    this.apiKey = apiKey;
    this.intervalMs = intervalMs;
    this.options = options;
    this.running = true;
    void this.refresh();
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const ratio = this.options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const spread = this.intervalMs * ratio;
    const delay = Math.max(0, this.intervalMs - spread / 2 + Math.random() * spread);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.scheduleNext());
    }, delay);
    unrefTimer(this.timer);
  }

  protected async refresh(): Promise<void> {
    if (!this.backendUrl) return;
    try {
      const payload = await requestJson<T>(`${this.backendUrl}${this.path}`, {
        apiKey: this.apiKey,
        timeoutMs: this.options.requestTimeoutMs,
      });
      this.apply(payload);
    } catch (err) {
      // Deliberately does not clear existing state: a failed poll must leave
      // the cache serving its last known-good value.
      if (this.options.onError) this.options.onError(err);
      else console.error(`[promptwatch] ${this.label} refresh failed:`, err);
    }
  }
}
