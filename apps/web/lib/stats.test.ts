import { describe, it, expect } from "vitest";
import {
  ALPHA,
  MIN_SAMPLES_PER_VARIANT,
  decideVerdict,
  twoProportionZTest,
  twoSidedP,
  welchTTest,
} from "./stats";

describe("twoSidedP", () => {
  it("returns ~1 for a zero statistic", () => {
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
  });

  it("matches the textbook value at z = 1.96", () => {
    expect(twoSidedP(1.96)).toBeCloseTo(0.05, 3);
  });

  it("is symmetric around zero", () => {
    expect(twoSidedP(2.5)).toBeCloseTo(twoSidedP(-2.5), 12);
  });

  it("shrinks as the statistic grows", () => {
    expect(twoSidedP(3)).toBeLessThan(twoSidedP(1));
  });
});

describe("welchTTest", () => {
  it("finds no significance in two overlapping samples", () => {
    const result = welchTTest({ mean: 500, sd: 100, n: 50 }, { mean: 510, sd: 100, n: 50 });
    expect(result?.significant).toBe(false);
  });

  it("finds significance when the gap is large relative to the spread", () => {
    const result = welchTTest({ mean: 300, sd: 40, n: 200 }, { mean: 500, sd: 40, n: 200 });
    expect(result?.significant).toBe(true);
    expect(result!.pValue).toBeLessThan(ALPHA);
    expect(result!.difference).toBe(-200);
  });

  it("handles unequal variances, which is the whole point of Welch", () => {
    const result = welchTTest({ mean: 300, sd: 10, n: 100 }, { mean: 320, sd: 400, n: 100 });
    // A huge spread in B means a 20ms gap proves nothing.
    expect(result?.significant).toBe(false);
  });

  it("returns null when a sample is too small to have a variance", () => {
    expect(welchTTest({ mean: 100, sd: null, n: 1 }, { mean: 200, sd: 50, n: 30 })).toBeNull();
  });

  it("returns null when a mean is missing", () => {
    expect(welchTTest({ mean: null, sd: null, n: 0 }, { mean: 200, sd: 50, n: 30 })).toBeNull();
  });

  it("treats two zero-variance samples as an exact comparison", () => {
    const differing = welchTTest({ mean: 100, sd: 0, n: 10 }, { mean: 200, sd: 0, n: 10 });
    expect(differing?.significant).toBe(true);

    const identical = welchTTest({ mean: 100, sd: 0, n: 10 }, { mean: 100, sd: 0, n: 10 });
    expect(identical?.significant).toBe(false);
  });
});

describe("twoProportionZTest", () => {
  it("finds no significance between similar error rates", () => {
    const result = twoProportionZTest(10, 100, 12, 100);
    expect(result?.significant).toBe(false);
  });

  it("finds significance between clearly different error rates at scale", () => {
    const result = twoProportionZTest(10, 1000, 100, 1000);
    expect(result?.significant).toBe(true);
    expect(result!.difference).toBeCloseTo(-0.09, 6);
  });

  it("reports no difference when both arms are error-free", () => {
    const result = twoProportionZTest(0, 100, 0, 100);
    expect(result?.significant).toBe(false);
    expect(result?.pValue).toBe(1);
  });

  it("returns null for an empty arm", () => {
    expect(twoProportionZTest(0, 0, 5, 100)).toBeNull();
  });
});

describe("decideVerdict", () => {
  const significant = { difference: -100, statistic: -9, pValue: 0.0001, significant: true };

  it("refuses to call a winner below the minimum sample size", () => {
    // This is the case the old dashboard got wrong: three requests per arm and
    // a "winner" badge on whichever average happened to be lower.
    const verdict = decideVerdict(significant, 3, 3);
    expect(verdict.kind).toBe("insufficient-data");
    if (verdict.kind === "insufficient-data") {
      expect(verdict.needed).toBe(MIN_SAMPLES_PER_VARIANT);
      expect(verdict.haveA).toBe(3);
    }
  });

  it("refuses when only one arm has enough data", () => {
    expect(decideVerdict(significant, 500, 4).kind).toBe("insufficient-data");
  });

  it("calls A the winner when A is lower and the result is significant", () => {
    const verdict = decideVerdict(significant, 100, 100);
    expect(verdict).toEqual({ kind: "winner", winner: "A", pValue: 0.0001 });
  });

  it("calls B the winner when B is lower", () => {
    const verdict = decideVerdict(
      { difference: 100, statistic: 9, pValue: 0.001, significant: true },
      100,
      100
    );
    expect(verdict.kind === "winner" && verdict.winner).toBe("B");
  });

  it("reports inconclusive when the sample is large but the gap is not significant", () => {
    const verdict = decideVerdict(
      { difference: -1, statistic: -0.2, pValue: 0.84, significant: false },
      500,
      500
    );
    expect(verdict).toEqual({ kind: "inconclusive", pValue: 0.84 });
  });

  it("reports inconclusive when there is no test result at all", () => {
    expect(decideVerdict(null, 100, 100).kind).toBe("inconclusive");
  });

  it("flips the winner for a higher-is-better metric", () => {
    // The quality score is the one metric where more is better; latency, cost
    // and error rate all read the other way.
    const lower = decideVerdict(significant, 100, 100);
    const higher = decideVerdict(significant, 100, 100, { higherIsBetter: true });

    expect(lower.kind === "winner" && lower.winner).toBe("A");
    expect(higher.kind === "winner" && higher.winner).toBe("B");
  });

  it("honours a custom minimum sample size", () => {
    expect(decideVerdict(significant, 5, 5, { minSamples: 5 }).kind).toBe("winner");
  });
});
