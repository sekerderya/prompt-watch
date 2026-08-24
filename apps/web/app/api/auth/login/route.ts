import { NextRequest, NextResponse } from "next/server";
import { isAuthEnabled, isValidApiKey } from "@/lib/auth";
import { clientKey, rateLimit } from "@/lib/rateLimit";

/** Ten attempts per five minutes is generous for a human, useless for a script. */
const LOGIN_LIMIT = { limit: 10, windowMs: 5 * 60 * 1000 };

export async function POST(request: NextRequest) {
  try {
    // Without this the shared secret could be brute-forced at request speed,
    // which is a much cheaper attack than the timing side-channel the auth
    // design already defends against.
    const limit = rateLimit(`login:${clientKey(request)}`, LOGIN_LIMIT);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }

    const body = await request.json();
    const { apiKey } = body;

    if (typeof apiKey !== "string" || apiKey === "") {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }

    // With auth disabled there is no secret to check, so issuing a session
    // cookie would imply a protection that is not in place.
    if (!isAuthEnabled()) {
      return NextResponse.json(
        { error: "Auth is disabled on this server; no login is required." },
        { status: 400 }
      );
    }

    if (!(await isValidApiKey(apiKey))) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("pw_session", apiKey, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
