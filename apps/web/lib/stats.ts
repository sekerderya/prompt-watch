/**
 * The statistics behind the A/B "winner" badge.
 *
 * Declaring a winner from two raw averages is the classic A/B testing mistake:
 * with a handful of requests per arm, the arm that happens to be faster is
 * usually just noise. Everything here exists so the dashboard can distinguish
 * "B is better" from "B looks better so far".
 *
 * Scope note: p-values use the normal approximation rather than an exact
 * t-distribution. That is anti-conservative for tiny samples, which is why
 * MIN_SAMPLES_PER_VARIANT gates the verdict before any p-value is trusted.
 */

/** Below this many traces per arm, no comparison is reported as conclusive. */
export const MIN_SAMPLES_PER_VARIANT = 30;

/** Two-sided significance threshold. */
export const ALPHA = 0.05;

/** Abramowitz & Stegun 7.1.26 — max absolute error ~1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Two-sided p-value for a z (or large-df t) statistic. */
export function twoSidedP(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(0, Math.min(1, 1 - erf(Math.abs(z) / Math.SQRT2)));
}

export interface SampleSummary {
  mean: number | null;
  /** Sample standard deviation. Null when undefined (n < 2). */
  sd: number | null;
  n: number;
}

export interface TestResult {
  /** Difference of means, a - b. */
  difference: number;
  statistic: number;
  pValue: number;
  significant: boolean;
}

/**
 * Welch's t-test — the unequal-variance form, because two prompt variants have
 * no reason to produce equally variable latencies.
 */
export function welchTTest(a: SampleSummary, b: SampleSummary): TestResult | null {
  if (a.mean === null || b.mean === null) return null;
  if (a.n < 2 || b.n < 2) return null;

  const sdA = a.sd ?? 0;
  const sdB = b.sd ?? 0;
  const varianceTerm = (sdA * sdA) / a.n + (sdB * sdB) / b.n;

  const difference = a.mean - b.mean;
  if (varianceTerm <= 0) {
    // Zero variance in both arms: any difference at all is exact, not noisy.
    return {
      difference,
      statistic: difference === 0 ? 0 : Infinity,
      pValue: difference === 0 ? 1 : 0,
      significant: difference !== 0,
    };
  }

  const statistic = difference / Math.sqrt(varianceTerm);
  const pValue = twoSidedP(statistic);
  return { difference, statistic, pValue, significant: pValue < ALPHA };
}

/** Two-proportion z-test with a pooled estimate, used for error rates. */
export function twoProportionZTest(
  successesA: number,
  nA: number,
  successesB: number,
  nB: number
): TestResult | null {
  if (nA < 1 || nB < 1) return null;

  const pA = successesA / nA;
  const pB = successesB / nB;
  const pooled = (successesA + successesB) / (nA + nB);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));

  const difference = pA - pB;
  if (standardError === 0) {
    return { difference, statistic: 0, pValue: 1, significant: false };
  }

  const statistic = difference / standardError;
  const pValue = twoSidedP(statistic);
  return { difference, statistic, pValue, significant: pValue < ALPHA };
}

export type Verdict =
  | { kind: "insufficient-data"; needed: number; haveA: number; haveB: number }
  | { kind: "inconclusive"; pValue: number }
  | { kind: "winner"; winner: "A" | "B"; pValue: number };

export interface VerdictOptions {
  /** Traces required per arm before any verdict is reported. */
  minSamples?: number;
  /**
   * Direction of "better". Latency, cost and error rate are lower-is-better;
   * the quality score reported by the host application is higher-is-better.
   */
  higherIsBetter?: boolean;
}

/**
 * Turns a test result into what the UI is allowed to claim.
 *
 * Nothing is called a winner until both arms clear `minSamples` *and* the
 * difference survives a significance test. Everything short of that is reported
 * as "not enough data" or "no significant difference" rather than as a result.
 */
export function decideVerdict(
  result: TestResult | null,
  nA: number,
  nB: number,
  options: VerdictOptions = {}
): Verdict {
  const minSamples = options.minSamples ?? MIN_SAMPLES_PER_VARIANT;

  if (nA < minSamples || nB < minSamples) {
    return { kind: "insufficient-data", needed: minSamples, haveA: nA, haveB: nB };
  }
  if (!result) return { kind: "inconclusive", pValue: 1 };
  if (!result.significant) return { kind: "inconclusive", pValue: result.pValue };

  // difference is (A - B). Lower-is-better metrics favour the negative side.
  const aWins = options.higherIsBetter ? result.difference > 0 : result.difference < 0;
  return { kind: "winner", winner: aWins ? "A" : "B", pValue: result.pValue };
}
