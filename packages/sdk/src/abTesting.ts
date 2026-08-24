import { createHash, randomUUID } from "node:crypto";

import { requestJson } from "./http";

export interface ABTestConfig {
  id: number;
  promptName: string;
  variantAId: number;
  variantAText: string;
  variantBId: number;
  variantBText: string;
  splitPercent: number;
}

export interface VariantAssignment {
  variant: "A" | "B";
  promptId: number;
  promptText: string;
}

export function assignVariant(test: ABTestConfig, distinctId?: string): VariantAssignment {
  const key = distinctId ?? randomUUID();
  const hash = createHash("sha256").update(`${test.id}:${key}`).digest();
  const bucket = hash.readUInt32BE(0) % 100;
  const variant: "A" | "B" = bucket < test.splitPercent ? "A" : "B";
  return {
    variant,
    promptId: variant === "A" ? test.variantAId : test.variantBId,
    promptText: variant === "A" ? test.variantAText : test.variantBText,
  };
}

export interface ABCacheOptions {
  /** Per-request timeout for the poll. */
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

export class ABCache {
  private tests = new Map<string, ABTestConfig>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backendUrl: string | undefined;
  private apiKey: string | undefined;
  private intervalMs = 30000;
  private options: ABCacheOptions = {};
  private running = false;
  private warnedCollisions = new Set<string>();

  start(
    backendUrl: string,
    intervalMs = 30000,
    apiKey?: string,
    options: ABCacheOptions = {}
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

  get(promptName: string): ABTestConfig | undefined {
    return this.tests.get(promptName);
  }

  /**
   * A self-rescheduling timeout rather than setInterval, so each tick can carry
   * its own jitter. The timer is unref'd: a polling cache must never be the
   * reason a short-lived script refuses to exit.
   */
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

  private async refresh(): Promise<void> {
    if (!this.backendUrl) return;
    try {
      const active = await requestJson<ABTestConfig[]>(
        `${this.backendUrl}/api/ab-tests/active`,
        { apiKey: this.apiKey, timeoutMs: this.options.requestTimeoutMs }
      );
      if (!Array.isArray(active)) return;

      const next = new Map<string, ABTestConfig>();
      for (const test of active) {
        const existing = next.get(test.promptName);
        if (existing) {
          // The backend enforces one active test per prompt, but if that ever
          // slips, resolve it deterministically (newest wins) and say so once
          // rather than letting response ordering decide.
          this.warnCollision(test.promptName);
          if (existing.id > test.id) continue;
        }
        next.set(test.promptName, test);
      }
      this.tests = next;
    } catch (err) {
      if (this.options.onError) this.options.onError(err);
      else console.error("[promptwatch] ab-cache refresh failed:", err);
    }
  }

  private warnCollision(promptName: string): void {
    if (this.warnedCollisions.has(promptName)) return;
    this.warnedCollisions.add(promptName);
    console.warn(
      `[promptwatch] multiple active A/B tests for prompt "${promptName}"; ` +
        `using the most recently created one. Stop the stale test to remove this warning.`
    );
  }
}
