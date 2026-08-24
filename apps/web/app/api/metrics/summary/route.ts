import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface SummaryRow {
  day: Date;
  total_cost: number;
  total: number;
  errors: number;
  unpriced: number;
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
      SELECT date_trunc('day', created_at) AS day,
             SUM(cost_usd) AS total_cost,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'ERROR') AS errors,
             COUNT(*) FILTER (WHERE pricing_unknown) AS unpriced
      FROM traces
      WHERE created_at > now() - make_interval(days => ${days}::int)
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
    }));

    return NextResponse.json(data);
  } catch (error) {
    console.error("metrics summary failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
