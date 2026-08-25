import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface SummaryRow {
  day: Date;
  total_cost: number;
  total: number;
  errors: number;
  unpriced: number;
  avg_score: number | null;
  scored: number;
}

const MIN_DAYS = 1;
const MAX_DAYS = 365;

/** Unbounded or negative windows are rejected rather than passed to the planner. */
function parseDays(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 7;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(parsed)));
}

export async function GET(request: NextRequest) {
  try {
    const days = parseDays(request.nextUrl.searchParams.get("days"));

    const rows = await prisma.$queryRaw<SummaryRow[]>`
      SELECT date_trunc('day', t.created_at) AS day,
             SUM(t.cost_usd) AS total_cost,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE t.status = 'ERROR') AS errors,
             COUNT(*) FILTER (WHERE t.pricing_unknown) AS unpriced,
             AVG(o.score) AS avg_score,
             COUNT(o.id) AS scored
      FROM traces t
      LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
      WHERE t.created_at > now() - make_interval(days => ${days}::int)
      GROUP BY day ORDER BY day
    `;

    const data = rows.map((r) => ({
      day: r.day.toISOString(),
      totalCost: Number(r.total_cost),
      total: Number(r.total),
      errors: Number(r.errors),
      // Traces whose cost came from fallback pricing. Surfaced so the dashboard
      // can say the total is an estimate instead of implying it was measured.
      unpriced: Number(r.unpriced),
      // Mean quality score over the traces that carry an outcome.
      avgScore: r.avg_score === null ? null : Number(r.avg_score),
      scored: Number(r.scored),
    }));

    return NextResponse.json(data);
  } catch (error) {
    console.error("metrics summary failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
