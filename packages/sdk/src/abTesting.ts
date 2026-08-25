import { sha256Words } from "./hash";
import { randomId } from "./random";
import { PollingCache, type PollingOptions } from "./polling";

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

/**
 * Deterministic bucketing: the same test and distinct id always land in the
 * same variant, on any machine, without coordination.
 *
 * Without a distinct id there is nothing stable to hash, so the caller gets an
 * effectively random bucket per call. That is correct for genuinely anonymous
 * traffic but means the assignment is no longer sticky — pass `getDistinctId`
 * whenever a stable per-user identity exists.
 */
export function assignVariant(test: ABTestConfig, distinctId?: string): VariantAssignment {
  const key = distinctId ?? randomId();
  // First 32 bits of the digest, big-endian — the same value the previous
  // node:crypto implementation produced, so existing assignments do not shift.
  const bucket = sha256Words(`${test.id}:${key}`)[0] % 100;
  const variant: "A" | "B" = bucket < test.splitPercent ? "A" : "B";
  return {
    variant,
    promptId: variant === "A" ? test.variantAId : test.variantBId,
    promptText: variant === "A" ? test.variantAText : test.variantBText,
  };
}

export type ABCacheOptions = PollingOptions;

export class ABCache extends PollingCache<ABTestConfig[]> {
  protected readonly path = "/api/ab-tests/active";
  protected readonly label = "ab-cache";

  private tests = new Map<string, ABTestConfig>();
  private warnedCollisions = new Set<string>();

  protected apply(active: ABTestConfig[]): void {
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
  }

  get(promptName: string): ABTestConfig | undefined {
    return this.tests.get(promptName);
  }

  /** Test hook: seed the cache without waiting for a poll. */
  seed(tests: ABTestConfig[]): void {
    this.apply(tests);
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
