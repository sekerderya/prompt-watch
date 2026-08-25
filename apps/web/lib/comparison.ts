import { prisma } from "./prisma";

export interface VariantMetrics {
  variant: string | null;
  avgLatency: number | null;
  sdLatency: number | null;
  avgCost: number | null;
  sdCost: number | null;
  total: number;
  errors: number;
  unpriced: number;
  avgScore: number | null;
  sdScore: number | null;
  scored: number;
}

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
 * Lives here rather than in the route because promotion snapshots the same
 * numbers as evidence. If the two were computed separately they could disagree,
 * and a release record that contradicts the dashboard is worse than no record.
 *
 * Standard deviations and counts accompany the means because a difference of
 * means says nothing on its own — the caller needs the spread and the sample
 * size to decide whether the gap is signal or noise.
 *
 * Outcomes join on client_trace_id rather than a foreign key, because an outcome
 * may be recorded before its trace is flushed. Both columns are unique, so the
 * join is one-to-one and cannot inflate the operational aggregates.
 */
export async function variantComparison(abTestId: number): Promise<VariantMetrics[]> {
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

  const nullable = (v: number | null): number | null => (v === null ? null : Number(v));

  return rows.map((r) => ({
    variant: r.variant,
    avgLatency: nullable(r.avg_latency),
    // STDDEV_SAMP is null for a single row; callers treat that as "unknown".
    sdLatency: nullable(r.sd_latency),
    avgCost: nullable(r.avg_cost),
    sdCost: nullable(r.sd_cost),
    total: Number(r.total),
    errors: Number(r.errors),
    unpriced: Number(r.unpriced),
    avgScore: nullable(r.avg_score),
    sdScore: nullable(r.sd_score),
    scored: Number(r.scored),
  }));
}
