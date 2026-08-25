import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** Probes must not be cached, or they report a stale verdict forever. */
export const dynamic = "force-dynamic";

/**
 * Liveness plus a real dependency check.
 *
 * Deliberately public (see `PUBLIC_PATHS` in middleware): a container
 * orchestrator or uptime monitor cannot present a bearer token, and a health
 * endpoint that 401s is a health endpoint that always reports unhealthy. It
 * leaks nothing beyond "the database is reachable", which an attacker learns
 * from any other endpoint anyway.
 */
export async function GET() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      database: "up",
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("health check failed:", error);
    return NextResponse.json(
      { status: "degraded", database: "down", latencyMs: Date.now() - startedAt },
      { status: 503 }
    );
  }
}
