import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface VersionRow {
  prompt_id: number;
  version: number;
  total: number;
  errors: number;
  avg_latency: number | null;
  total_cost: number | null;
  avg_score: number | null;
  scored: number;
  unpriced: number;
  last_seen: Date | null;
}

interface ErrorRow {
  error_type: string | null;
  count: number;
}

const MAX_DAYS = 365;

function parseDays(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(parsed)));
}

/**
 * Per-version metrics for one prompt, plus a breakdown of why its calls failed.
 *
 * The version numbers alone answer "what changed"; these numbers answer
 * "did it help", which is the reason to version a prompt at all.
 */
export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const days = parseDays(request.nextUrl.searchParams.get("days"));

    const [versions, errorBreakdown] = await Promise.all([
      prisma.$queryRaw<VersionRow[]>`
        SELECT p.id                                        AS prompt_id,
               p.version,
               COUNT(t.id)                                 AS total,
               COUNT(t.id) FILTER (WHERE t.status = 'ERROR') AS errors,
               AVG(t.latency_ms)                           AS avg_latency,
               SUM(t.cost_usd)                             AS total_cost,
               AVG(o.score)                                AS avg_score,
               COUNT(o.id)                                 AS scored,
               COUNT(t.id) FILTER (WHERE t.pricing_unknown) AS unpriced,
               MAX(t.created_at)                           AS last_seen
        FROM prompts p
        LEFT JOIN traces t
          ON t.prompt_id = p.id
         AND t.created_at > now() - make_interval(days => ${days}::int)
        LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
        WHERE p.name = ${name}
        GROUP BY p.id, p.version
        ORDER BY p.version DESC
      `,
      prisma.$queryRaw<ErrorRow[]>`
        SELECT t.error_type::text AS error_type, COUNT(*) AS count
        FROM traces t
        JOIN prompts p ON p.id = t.prompt_id
        WHERE p.name = ${name}
          AND t.status = 'ERROR'
          AND t.created_at > now() - make_interval(days => ${days}::int)
        GROUP BY t.error_type
        ORDER BY COUNT(*) DESC
      `,
    ]);

    const nullable = (v: number | null) => (v === null ? null : Number(v));

    return NextResponse.json({
      versions: versions.map((r) => ({
        promptId: Number(r.prompt_id),
        version: Number(r.version),
        total: Number(r.total),
        errors: Number(r.errors),
        avgLatency: nullable(r.avg_latency),
        totalCost: Number(r.total_cost ?? 0),
        avgScore: nullable(r.avg_score),
        scored: Number(r.scored),
        unpriced: Number(r.unpriced),
        lastSeen: r.last_seen ? r.last_seen.toISOString() : null,
      })),
      errorBreakdown: errorBreakdown.map((r) => ({
        errorType: r.error_type ?? "UNKNOWN",
        count: Number(r.count),
      })),
    });
  } catch (error) {
    console.error("prompt metrics failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
