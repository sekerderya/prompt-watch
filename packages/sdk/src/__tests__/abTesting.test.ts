import { afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";

import { ABCache, assignVariant, type ABTestConfig } from "../abTesting";

const testConfig: ABTestConfig = {
  id: 10,
  promptName: "support-bot",
  variantAId: 1,
  variantAText: "Variant A",
  variantBId: 2,
  variantBText: "Variant B",
  splitPercent: 50,
};

async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("assignVariant", () => {
  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it("is deterministic for the same distinctId", () => {
    const first = assignVariant(testConfig, "user-123");
    for (let i = 0; i < 100; i++) {
      expect(assignVariant(testConfig, "user-123")).toEqual(first);
    }
  });

  it("does not throw when distinctId is missing", () => {
    expect(() => assignVariant(testConfig)).not.toThrow();
    const res = assignVariant(testConfig);
    expect(res.variant).toMatch(/^[AB]$/);
    expect(res.promptId).toBe(res.variant === "A" ? 1 : 2);
  });

  it("distributes ~following splitPercent across many distinctIds", () => {
    const n = 1000;
    let countA = 0;
    for (let i = 0; i < n; i++) {
      const { variant } = assignVariant(testConfig, `user-${i}`);
      if (variant === "A") countA++;
    }
    const pct = countA / n;
    expect(pct).toBeGreaterThan(0.4);
    expect(pct).toBeLessThan(0.6);
  });

  it("ABCache fetches active tests and indexes them by promptName", async () => {
    const cache = new ABCache();
    const scope = nock("http://localhost:3000")
      .get("/api/ab-tests/active")
      .reply(200, [testConfig]);

    cache.start("http://localhost:3000", 60000);
    await waitFor(() => cache.get("support-bot") !== undefined);

    expect(scope.isDone()).toBe(true);
    expect(cache.get("support-bot")).toEqual(testConfig);
    expect(cache.get("missing")).toBeUndefined();
    cache.stop();
  });

  it("ABCache.stop clears the refresh interval", async () => {
    const cache = new ABCache();
    const scope = nock("http://localhost:3000")
      .get("/api/ab-tests/active")
      .times(3)
      .reply(200, []);

    cache.start("http://localhost:3000", 10);
    cache.stop();
    await new Promise((r) => setTimeout(r, 120));

    expect(scope.isDone()).toBe(false);
  });
});