import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthEnabled, isValidApiKey } from "./lib/auth";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  // Orchestrators and uptime monitors cannot send a bearer token, and a health
  // check that answers 401 always reads as unhealthy.
  "/api/health",
  "/favicon.ico",
  "/icon.svg",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/static/") ||
    /\.(ico|png|jpg|jpeg|svg|css|js|map|woff|woff2)$/.test(pathname)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  if (isPublicPath(pathname) || isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const cookieToken = request.cookies.get("pw_session")?.value ?? null;

  const providedToken = bearerToken ?? cookieToken;

  const isValid = await isValidApiKey(providedToken);

  if (!isValid) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl, 307);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};