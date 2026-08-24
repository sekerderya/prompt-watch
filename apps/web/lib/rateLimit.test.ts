import { describe, it, expect, beforeEach } from "vitest";
import { clientKey, rateLimit, resetRateLimits } from "./rateLimit";

const CONFIG = { limit: 3, windowMs: 1000 };

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows requests up to the limit", () => {
    expect(rateLimit("k", CONFIG).allowed).toBe(true);
    expect(rateLimit("k", CONFIG).allowed).toBe(true);
    expect(rateLimit("k", CONFIG).allowed).toBe(true);
  });

  it("blocks once the limit is exceeded", () => {
    for (let i = 0; i < 3; i++) rateLimit("k", CONFIG);
    const blocked = rateLimit("k", CONFIG);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts down the remaining allowance", () => {
    expect(rateLimit("k", CONFIG).remaining).toBe(2);
    expect(rateLimit("k", CONFIG).remaining).toBe(1);
    expect(rateLimit("k", CONFIG).remaining).toBe(0);
  });

  it("keeps separate counters per key", () => {
    for (let i = 0; i < 4; i++) rateLimit("a", CONFIG);
    expect(rateLimit("b", CONFIG).allowed).toBe(true);
  });

  it("opens a fresh window once the old one expires", () => {
    const start = 1_000_000;
    for (let i = 0; i < 4; i++) rateLimit("k", CONFIG, start);
    expect(rateLimit("k", CONFIG, start).allowed).toBe(false);

    expect(rateLimit("k", CONFIG, start + CONFIG.windowMs + 1).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("prefers the first entry of x-forwarded-for", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientKey(request)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-real-ip": "198.51.100.4" },
    });
    expect(clientKey(request)).toBe("198.51.100.4");
  });

  it("returns a stable placeholder when no client hint is present", () => {
    expect(clientKey(new Request("http://localhost/"))).toBe("unknown");
  });
});
