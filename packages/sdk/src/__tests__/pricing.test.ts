import { describe, it, expect } from "vitest";
import { DEFAULT_PRICING, MODEL_PRICING, resolvePricing } from "../pricing";

describe("resolvePricing", () => {
  it("matches an exact alias", () => {
    const { pricing, unknown, matchedKey } = resolvePricing("gpt-4o-mini");
    expect(unknown).toBe(false);
    expect(matchedKey).toBe("gpt-4o-mini");
    expect(pricing).toEqual(MODEL_PRICING["gpt-4o-mini"]);
  });

  it("matches the dated snapshot id the API actually returns", () => {
    // This is the whole reason the function exists: the response's `model` is
    // a snapshot id, and an exact lookup silently fell through to the default.
    const { pricing, unknown } = resolvePricing("gpt-4o-mini-2024-07-18");
    expect(unknown).toBe(false);
    expect(pricing).toEqual(MODEL_PRICING["gpt-4o-mini"]);
  });

  it("prefers the most specific key when several are prefixes", () => {
    expect(resolvePricing("gpt-4o-mini-2024-07-18").matchedKey).toBe("gpt-4o-mini");
    expect(resolvePricing("gpt-4o-2024-08-06").matchedKey).toBe("gpt-4o");
    expect(resolvePricing("gpt-4-turbo-2024-04-09").matchedKey).toBe("gpt-4-turbo");
    expect(resolvePricing("gpt-4-0613").matchedKey).toBe("gpt-4");
  });

  it("does not let a shorter key swallow a different family", () => {
    // "gpt-4" must not claim "gpt-4o": the rates differ by an order of magnitude.
    expect(resolvePricing("gpt-4o").matchedKey).toBe("gpt-4o");
  });

  it("flags an unknown model instead of quietly guessing", () => {
    const { pricing, unknown, matchedKey } = resolvePricing("some-future-model");
    expect(unknown).toBe(true);
    expect(matchedKey).toBeNull();
    expect(pricing).toEqual(DEFAULT_PRICING);
  });

  it("flags missing or empty model ids", () => {
    expect(resolvePricing(undefined).unknown).toBe(true);
    expect(resolvePricing(null).unknown).toBe(true);
    expect(resolvePricing("").unknown).toBe(true);
  });

  it("keeps gpt-4o-mini far cheaper than the fallback rate", () => {
    // Guards the specific regression: falling back cost ~16x too much.
    const mini = MODEL_PRICING["gpt-4o-mini"];
    expect(mini.promptPricePer1k).toBeLessThan(DEFAULT_PRICING.promptPricePer1k / 10);
    expect(mini.completionPricePer1k).toBeLessThan(DEFAULT_PRICING.completionPricePer1k / 10);
  });
});
