import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import { sha256, sha256Words } from "../hash";
import { randomId } from "../random";
import { assignVariant, type ABTestConfig } from "../abTesting";

/**
 * The SDK ships its own SHA-256 so it can run on edge runtimes where
 * `node:crypto` does not exist. Reimplementing a hash is only acceptable if it
 * is provably identical to the reference, so these tests compare against
 * `node:crypto` directly — including the cases where hand-rolled versions
 * usually break: empty input, multi-byte UTF-8, and the 55/56/64-byte padding
 * boundaries.
 */
function reference(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("sha256", () => {
  it("matches the published test vectors", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches node:crypto across the padding boundaries", () => {
    // 55 bytes fits with the length field; 56 forces a second block.
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const input = "a".repeat(length);
      expect(sha256(input)).toBe(reference(input));
    }
  });

  it("matches node:crypto for multi-byte UTF-8", () => {
    for (const input of [
      "Türkçe karakterler: ğüşiöçĞÜŞİÖÇ",
      "日本語のテキスト",
      "emoji 👩‍💻🚀 and combining é",
      "mixed ascii + ünïcödé + 中文 + 🎉",
    ]) {
      expect(sha256(input)).toBe(reference(input));
    }
  });

  it("matches node:crypto for realistic system prompts", () => {
    const prompt =
      "You are a courteous, professional customer support assistant working for Acme Inc. " +
      "Answer questions with detailed, comprehensive explanations and a formal tone.";
    expect(sha256(prompt)).toBe(reference(prompt));
  });

  it("returns 64 lowercase hex characters", () => {
    expect(sha256("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exposes the first word as the same big-endian uint32 node produces", () => {
    // Variant bucketing reads these bits, so a mismatch would silently reshuffle
    // every existing A/B assignment.
    for (const input of ["10:user-123", "42:alice", "7:", "1:🚀"]) {
      const expected = createHash("sha256").update(input).digest().readUInt32BE(0);
      expect(sha256Words(input)[0]).toBe(expected);
    }
  });
});

describe("assignVariant bucketing stability", () => {
  const test: ABTestConfig = {
    id: 10,
    promptName: "support-bot",
    variantAId: 1,
    variantAText: "A",
    variantBId: 2,
    variantBText: "B",
    splitPercent: 50,
  };

  it("buckets exactly as the previous node:crypto implementation did", () => {
    for (let i = 0; i < 200; i++) {
      const distinctId = `user-${i}`;
      const legacyBucket =
        createHash("sha256").update(`${test.id}:${distinctId}`).digest().readUInt32BE(0) % 100;
      const expected = legacyBucket < test.splitPercent ? "A" : "B";

      expect(assignVariant(test, distinctId).variant).toBe(expected);
    }
  });
});

describe("randomId", () => {
  it("produces a v4 UUID in the same shape as node's", () => {
    const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(randomId()).toMatch(shape);
    expect(randomUUID()).toMatch(shape);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, randomId));
    expect(ids.size).toBe(2000);
  });
});
