import { NextRequest, NextResponse } from "next/server";
import { isValidApiKey, hashValue } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { apiKey } = body;

    if (typeof apiKey !== "string" || apiKey === "") {
      return NextResponse.json(
        { error: "apiKey is required" },
        { status: 400 }
      );
    }

    const isValid = await isValidApiKey(apiKey);

    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      );
    }

    const hashed = await hashValue(apiKey);
    const response = NextResponse.json({ ok: true });

    response.cookies.set("pw_session", hashed, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });

    return response;
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400 }
    );
  }
}