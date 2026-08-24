import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isValidApiKey, hashValue } from "./auth";

const ORIGINAL_ENV = process.env;

describe("auth integration: login cookie -> middleware validation", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.PROMPTWATCH_API_KEY = "test-secret-key-123";
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("login sets cookie with RAW apiKey; that raw value passes isValidApiKey (simulates middleware)", async () => {
    // Simulate what the login route does: stores raw apiKey in cookie
    const rawApiKey = "test-secret-key-123";
    const cookieValue = rawApiKey; // login route now stores raw key

    // Simulate what middleware does: extracts cookie and passes to isValidApiKey
    const isValid = await isValidApiKey(cookieValue);

    expect(isValid).toBe(true);
  });

  it("wrong raw key in cookie fails validation", async () => {
    const cookieValue = "wrong-key";
    const isValid = await isValidApiKey(cookieValue);
    expect(isValid).toBe(false);
  });

  it("empty cookie fails validation", async () => {
    const cookieValue = "";
    const isValid = await isValidApiKey(cookieValue);
    expect(isValid).toBe(false);
  });

  it("hashed key in cookie (old behavior) would FAIL - this test documents the fix", async () => {
    const rawApiKey = "test-secret-key-123";
    const hashedApiKey = await hashValue(rawApiKey); // old behavior stored this
    const isValid = await isValidApiKey(hashedApiKey);
    // This would be true if we double-hashed, but isValidApiKey hashes again
    // So hashed key would hash to something different and FAIL
    expect(isValid).toBe(false);
  });

  it("auth disabled: any cookie value passes", async () => {
    delete process.env.PROMPTWATCH_API_KEY;
    await expect(isValidApiKey("anything")).resolves.toBe(true);
    await expect(isValidApiKey("")).resolves.toBe(true);
  });
});