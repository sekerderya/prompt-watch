import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { POST as loginRoute } from "../app/api/auth/login/route";
import { middleware } from "../middleware";
import { resetRateLimits } from "./rateLimit";

/**
 * Exercises the real login route and the real middleware against each other.
 *
 * The previous version of this file re-implemented the login route's logic
 * inside the test (`const cookieValue = rawApiKey`) and asserted on that, so it
 * stayed green no matter what the route actually did — the exact bug it was
 * written to catch could have come back unnoticed.
 */

const ORIGINAL_ENV = process.env;
const SECRET = "test-secret-key-123";

function loginRequest(body: unknown, ip = "10.0.0.1"): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function pageRequest(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

function bearerRequest(path: string, token: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("auth integration: login route -> cookie -> middleware", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, PROMPTWATCH_API_KEY: SECRET };
    resetRateLimits();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    resetRateLimits();
  });

  it("issues a session cookie the middleware then accepts", async () => {
    const loginResponse = await loginRoute(loginRequest({ apiKey: SECRET }));
    expect(loginResponse.status).toBe(200);

    const session = loginResponse.cookies.get("pw_session");
    expect(session?.value).toBe(SECRET);

    // Round-trip that exact cookie through the middleware.
    const allowed = await middleware(pageRequest("/", `pw_session=${session!.value}`));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("location")).toBeNull();
  });

  it("marks the session cookie HttpOnly and SameSite=Lax", async () => {
    const loginResponse = await loginRoute(loginRequest({ apiKey: SECRET }));
    const session = loginResponse.cookies.get("pw_session");

    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("lax");
    expect(session?.path).toBe("/");
  });

  it("rejects a wrong key and sets no cookie", async () => {
    const response = await loginRoute(loginRequest({ apiKey: "wrong-key" }));

    expect(response.status).toBe(401);
    expect(response.cookies.get("pw_session")).toBeUndefined();
  });

  it("rejects a missing key", async () => {
    const response = await loginRoute(loginRequest({}));
    expect(response.status).toBe(400);
  });

  it("refuses to issue a session when auth is disabled", async () => {
    delete process.env.PROMPTWATCH_API_KEY;

    const response = await loginRoute(loginRequest({ apiKey: "anything" }));

    // Handing out a cookie here would imply protection that is not in place.
    expect(response.status).toBe(400);
    expect(response.cookies.get("pw_session")).toBeUndefined();
  });

  it("rate limits repeated wrong guesses", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const response = await loginRoute(loginRequest({ apiKey: "guess" }, "10.0.0.99"));
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("rate limits per client, not globally", async () => {
    for (let i = 0; i < 11; i++) {
      await loginRoute(loginRequest({ apiKey: "guess" }, "10.0.0.1"));
    }

    const otherClient = await loginRoute(loginRequest({ apiKey: SECRET }, "10.0.0.2"));
    expect(otherClient.status).toBe(200);
  });
});

describe("middleware", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, PROMPTWATCH_API_KEY: SECRET };
    resetRateLimits();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("redirects an unauthenticated page request to /login with a next param", async () => {
    const response = await middleware(pageRequest("/ab-tests"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/ab-tests");
  });

  it("answers 401 for an unauthenticated API request instead of redirecting", async () => {
    const response = await middleware(pageRequest("/api/ab-tests/active"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("accepts a valid bearer token, which is how the SDK authenticates", async () => {
    const response = await middleware(bearerRequest("/api/traces", SECRET));
    expect(response.status).toBe(200);
  });

  it("rejects a bearer token that is merely a prefix of the real key", async () => {
    const response = await middleware(bearerRequest("/api/traces", SECRET.slice(0, -1)));
    expect(response.status).toBe(401);
  });

  it("rejects the hashed form of the key, which is not what the cookie carries", async () => {
    const { hashValue } = await import("./auth");
    const hashed = await hashValue(SECRET);

    const response = await middleware(pageRequest("/", `pw_session=${hashed}`));
    expect(response.status).toBe(307);
  });

  it("leaves the login page reachable while unauthenticated", async () => {
    const response = await middleware(pageRequest("/login"));
    expect(response.status).toBe(200);
  });

  it("lets everything through when auth is disabled", async () => {
    delete process.env.PROMPTWATCH_API_KEY;

    const page = await middleware(pageRequest("/"));
    const api = await middleware(pageRequest("/api/traces"));

    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
  });
});
