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
  avg_score: number | null;
  sd_score: number | null;
  scored: number;
}

/**
 * Per-variant aggregates for one A/B test.
 *
 * Standard deviations and counts are returned alongside the means because a
 * difference of means says nothing on its own — the caller needs the spread and
 * the sample size to decide whether the gap is signal or noise.
 *
 * Outcomes are joined on client_trace_id rather than a foreign key, because an
 * outcome may be recorded before its trace is flushed. The join is one-to-one
 * (both columns are unique), so it cannot inflate the operational aggregates.
 */
export async function GET(request: NextRequest) {
  try {
    const abTestId = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(abTestId) || abTestId <= 0) {
      return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
    }

    const rows = await prisma.$queryRaw<ComparisonRow[]>`
      SELECT t.variant,
             AVG(t.latency_ms)          AS avg_latency,
             STDDEV_SAMP(t.latency_ms)  AS sd_latency,
             AVG(t.cost_usd)            AS avg_cost,
             STDDEV_SAMP(t.cost_usd)    AS sd_cost,
             COUNT(*)                   AS total,
             COUNT(*) FILTER (WHERE t.status = 'ERROR')  AS errors,
             COUNT(*) FILTER (WHERE t.pricing_unknown)   AS unpriced,
             AVG(o.score)               AS avg_score,
             STDDEV_SAMP(o.score)       AS sd_score,
             COUNT(o.id)                AS scored
      FROM traces t
      LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
      WHERE t.ab_test_id = ${abTestId}
      GROUP BY t.variant
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
      // The only metric here that reflects answer quality rather than mechanics,
      // and the only one the host application has to supply.
      avgScore: nullableNumber(r.avg_score),
      sdScore: nullableNumber(r.sd_score),
      scored: Number(r.scored),
    }));

    return NextResponse.json(data);
  } catch (error) {
    console.error("ab-test comparison failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
