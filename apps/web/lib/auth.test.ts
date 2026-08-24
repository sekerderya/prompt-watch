import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashValue, constantTimeEqual, isAuthEnabled, isValidApiKey } from "./auth";

const ORIGINAL_ENV = process.env;

describe("lib/auth", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PROMPTWATCH_API_KEY;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe("hashValue", () => {
    it("returns a 64-char hex string", async () => {
      const hash = await hashValue("test");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic", async () => {
      const h1 = await hashValue("same");
      const h2 = await hashValue("same");
      expect(h1).toBe(h2);
    });

    it("differs for different inputs", async () => {
      const h1 = await hashValue("a");
      const h2 = await hashValue("b");
      expect(h1).not.toBe(h2);
    });
  });

  describe("constantTimeEqual", () => {
    it("returns true for equal strings", async () => {
      await expect(constantTimeEqual("secret", "secret")).resolves.toBe(true);
    });

    it("returns false for different strings of same length", async () => {
      await expect(constantTimeEqual("secret1", "secret2")).resolves.toBe(false);
    });

    it("returns false for different length strings WITHOUT throwing", async () => {
      await expect(constantTimeEqual("short", "very-long-string-that-is-different-length")).resolves.toBe(false);
    });

    it("returns false for empty vs non-empty", async () => {
      await expect(constantTimeEqual("", "non-empty")).resolves.toBe(false);
    });
  });

  describe("isAuthEnabled", () => {
    it("returns false when PROMPTWATCH_API_KEY is not set", () => {
      delete process.env.PROMPTWATCH_API_KEY;
      expect(isAuthEnabled()).toBe(false);
    });

    it("returns false when PROMPTWATCH_API_KEY is empty string", () => {
      process.env.PROMPTWATCH_API_KEY = "";
      expect(isAuthEnabled()).toBe(false);
    });

    it("returns true when PROMPTWATCH_API_KEY is set", () => {
      process.env.PROMPTWATCH_API_KEY = "test-key";
      expect(isAuthEnabled()).toBe(true);
    });
  });

  describe("isValidApiKey", () => {
    it("returns true when auth is disabled (no key set)", async () => {
      delete process.env.PROMPTWATCH_API_KEY;
      await expect(isValidApiKey(null)).resolves.toBe(true);
      await expect(isValidApiKey("anything")).resolves.toBe(true);
      await expect(isValidApiKey("")).resolves.toBe(true);
    });

    it("returns true when auth is disabled (empty key)", async () => {
      process.env.PROMPTWATCH_API_KEY = "";
      await expect(isValidApiKey("anything")).resolves.toBe(true);
    });

    it("returns true for correct key when auth is enabled", async () => {
      process.env.PROMPTWATCH_API_KEY = "correct-secret";
      await expect(isValidApiKey("correct-secret")).resolves.toBe(true);
    });

    it("returns false for wrong key when auth is enabled", async () => {
      process.env.PROMPTWATCH_API_KEY = "correct-secret";
      await expect(isValidApiKey("wrong-secret")).resolves.toBe(false);
    });

    it("returns false for null/undefined/empty when auth is enabled", async () => {
      process.env.PROMPTWATCH_API_KEY = "correct-secret";
      await expect(isValidApiKey(null)).resolves.toBe(false);
      await expect(isValidApiKey(undefined as any)).resolves.toBe(false);
      await expect(isValidApiKey("")).resolves.toBe(false);
    });

    it("uses constant-time comparison via hashing", async () => {
      process.env.PROMPTWATCH_API_KEY = "a".repeat(100);
      // The function should complete without throwing and return false
      // (correctness of timing attack resistance is in the algorithm, not
      // something we can reliably measure in a unit test)
      await expect(isValidApiKey("b".repeat(100))).resolves.toBe(false);
    });
  });
});