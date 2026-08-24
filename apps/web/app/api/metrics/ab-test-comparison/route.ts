import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface ComparisonRow {
  variant: string | null;
  avg_latency: number | null;
  sd_latency: number | null;
  avg_cost: number | null;
  sd_cost: number | null;
  total: number;
  errors: number;
  unpriced: number;
}

/**
 * Per-variant aggregates for one A/B test.
 *
 * Standard deviations and counts are returned alongside the means because a
 * difference of means says nothing on its own — the caller needs the spread and
 * the sample size to decide whether the gap is signal or noise.
 */
export async function GET(request: NextRequest) {
  try {
    const abTestId = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(abTestId) || abTestId <= 0) {
      return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
    }

    const rows = await prisma.$queryRaw<ComparisonRow[]>`
      SELECT variant,
             AVG(latency_ms)          AS avg_latency,
             STDDEV_SAMP(latency_ms)  AS sd_latency,
             AVG(cost_usd)            AS avg_cost,
             STDDEV_SAMP(cost_usd)    AS sd_cost,
             COUNT(*)                 AS total,
             COUNT(*) FILTER (WHERE status = 'ERROR')   AS errors,
             COUNT(*) FILTER (WHERE pricing_unknown)    AS unpriced
      FROM traces
      WHERE ab_test_id = ${abTestId}
      GROUP BY variant
    `;

    const nullableNumber = (v: number | null): number | null => (v === null ? null : Number(v));

    const data = rows.map((r) => ({
      variant: r.variant,
      avgLatency: nullableNumber(r.avg_latency),
      // STDDEV_SAMP is null for a single row; the caller treats that as "unknown".
      sdLatency: nullableNumber(r.sd_latency),
      avgCost: nullableNumber(r.avg_cost),
      sdCost: nullableNumber(r.sd_cost),
      total: Number(r.total),
      errors: Number(r.errors),
      unpriced: Number(r.unpriced),
    }));

    return NextResponse.json(data);
  } catch (error) {
    console.error("ab-test comparison failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
