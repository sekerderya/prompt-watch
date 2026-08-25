import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface OverviewRow {
  name: string;
  versions: number;
  latest_version: number;
  last_seen: Date | null;
  total: number;
  errors: number;
  total_cost: number | null;
  avg_latency: number | null;
  avg_score: number | null;
  scored: number;
}

const MAX_DAYS = 365;

function parseDays(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(parsed)));
}

/**
 * One row per tracked prompt: how many versions exist and how the prompt has
 * been behaving.
 *
 * The dashboard had no way to see this. Prompts were versioned automatically on
 * every call and the result was only reachable through the A/B test form's
 * dropdown — a tool named PromptWatch in which you could not look at a prompt.
 */
export async function GET(request: NextRequest) {
  try {
    const days = parseDays(request.nextUrl.searchParams.get("days"));

    const rows = await prisma.$queryRaw<OverviewRow[]>`
      SELECT p.name,
             COUNT(DISTINCT p.id)                       AS versions,
             MAX(p.version)                             AS latest_version,
             MAX(t.created_at)                          AS last_seen,
             COUNT(t.id)                                AS total,
             COUNT(t.id) FILTER (WHERE t.status = 'ERROR') AS errors,
             SUM(t.cost_usd)                            AS total_cost,
             AVG(t.latency_ms)                          AS avg_latency,
             AVG(o.score)                               AS avg_score,
             COUNT(o.id)                                AS scored
      FROM prompts p
      LEFT JOIN traces t
        ON t.prompt_id = p.id
       AND t.created_at > now() - make_interval(days => ${days}::int)
      LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
      GROUP BY p.name
      ORDER BY COUNT(t.id) DESC, p.name ASC
    `;

    const nullable = (v: number | null) => (v === null ? null : Number(v));

    return NextResponse.json(
      rows.map((r) => ({
        name: r.name,
        versions: Number(r.versions),
        latestVersion: Number(r.latest_version),
        lastSeen: r.last_seen ? r.last_seen.toISOString() : null,
        total: Number(r.total),
        errors: Number(r.errors),
        totalCost: Number(r.total_cost ?? 0),
        avgLatency: nullable(r.avg_latency),
        avgScore: nullable(r.avg_score),
        scored: Number(r.scored),
      }))
    );
  } catch (error) {
    console.error("prompt overview failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
