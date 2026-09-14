import { prisma } from "./prisma";
import {
  MIN_SAMPLES_PER_VARIANT,
  decideVerdict,
  twoProportionZTest,
  welchTTest,
  type Verdict,
} from "./stats";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export interface ModelMetrics {
  model: string;
  avgLatency: number | null;
  sdLatency: number | null;
  avgCost: number | null;
  sdCost: number | null;
  total: number;
  errors: number;
  /** Calls whose cost came from the fallback rate rather than a known price (ADR-7). */
  unpriced: number;
  avgScore: number | null;
  sdScore: number | null;
  scored: number;
}

/**
 * Cost cannot always be compared, and saying so is not the same as saying the
 * difference was too small to call. When either side contains a guessed price
 * there is no measured figure to test, so no verdict is produced at all.
 */
export type CostVerdict = Verdict | { kind: "estimated"; unpricedA: number; unpricedB: number };

export interface ModelMetricComparison {
  metric: "quality" | "errorRate" | "latency" | "cost";
  valueA: number | null;
  valueB: number | null;
  verdict: Verdict | CostVerdict;
}

export interface ModelComparison {
  promptName: string;
  days: number;
  /** Every model seen for this prompt in the window, busiest first. */
  models: ModelMetrics[];
  /** The two models compared, when there are at least two to compare. */
  a: string | null;
  b: string | null;
  metrics: ModelMetricComparison[];
}

interface ModelRow {
  model: string;
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

export function parseDays(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(parsed)));
}

/**
 * Per-model aggregates for one prompt.
 *
 * Filters on `prompt_id` rather than joining to `prompts` and filtering on
 * `name`, for the reason recorded in ADR-9: the join form cannot use the
 * `traces` indexes and scans the table.
 *
 * `model IS NULL` rows are excluded rather than bucketed as "unknown". They are
 * traces from SDK builds that predate the column, and folding them into a named
 * model would attribute calls to a model that may not have served them.
 */
export async function modelMetrics(promptName: string, days: number): Promise<ModelMetrics[]> {
  const versions = await prisma.prompt.findMany({
    where: { name: promptName },
    select: { id: true },
  });
  if (versions.length === 0) return [];
  const promptIds = versions.map((v) => v.id);

  const rows = await prisma.$queryRaw<ModelRow[]>`
    SELECT t.model,
           AVG(t.latency_ms)          AS avg_latency,
           STDDEV_SAMP(t.latency_ms)  AS sd_latency,
           AVG(t.cost_usd)            AS avg_cost,
           STDDEV_SAMP(t.cost_usd)    AS sd_cost,
           COUNT(*)                   AS total,
           COUNT(*) FILTER (WHERE t.status = 'ERROR') AS errors,
           COUNT(*) FILTER (WHERE t.pricing_unknown)  AS unpriced,
           AVG(o.score)               AS avg_score,
           STDDEV_SAMP(o.score)       AS sd_score,
           COUNT(o.id)                AS scored
    FROM traces t
    LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
    WHERE t.prompt_id = ANY(${promptIds})
      AND t.model IS NOT NULL
      AND t.created_at > now() - make_interval(days => ${days}::int)
    GROUP BY t.model
    ORDER BY COUNT(*) DESC, t.model ASC
  `;

  const nullable = (v: number | null): number | null => (v === null ? null : Number(v));

  return rows.map((r) => ({
    model: r.model,
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

function pick(models: ModelMetrics[], name: string | null): ModelMetrics | undefined {
  return name === null ? undefined : models.find((m) => m.model === name);
}

export interface CompareModelsOptions {
  days?: number;
  a?: string | null;
  b?: string | null;
  minSamples?: number;
}

/**
 * Compares two models serving the same prompt.
 *
 * Reuses the A/B machinery unchanged — Welch's t-test on quality, latency and
 * cost, a two-proportion z-test on error rate, the same minimum sample gate.
 * Only the axis differs, which is the third time that interface has paid for
 * itself (ADR-6 for variants, ADR-14 for releases, here for models).
 *
 * **This comparison is observational.** Unlike an A/B test, nothing randomised
 * which call went to which model: the two populations are whatever traffic
 * happened to use each one, and they may differ in ways this cannot see — one
 * model used only for the hard requests would look worse than it is. A
 * significant difference here is a reason to run a controlled test, not a
 * substitute for one. The caller is expected to say so where the numbers appear.
 */
export async function compareModels(
  promptName: string,
  options: CompareModelsOptions = {}
): Promise<ModelComparison> {
  const days = options.days ?? DEFAULT_DAYS;
  const minSamples = options.minSamples ?? MIN_SAMPLES_PER_VARIANT;
  const models = await modelMetrics(promptName, days);

  // Default to the two busiest models, which is the comparison anyone asking
  // this question means. An explicit pair overrides it.
  const a = pick(models, options.a ?? null) ?? models[0];
  const b = pick(models, options.b ?? null) ?? models.find((m) => m.model !== a?.model);

  if (!a || !b) {
    return { promptName, days, models, a: a?.model ?? null, b: null, metrics: [] };
  }

  const rate = (errors: number, n: number): number | null => (n > 0 ? errors / n : null);

  // Cost is measured in the same units on both sides only when both sides were
  // actually priced. A guessed rate is the same constant for every unknown
  // model, so comparing two guesses would produce a confident "no difference"
  // that means nothing at all.
  const costVerdict: CostVerdict =
    a.unpriced > 0 || b.unpriced > 0
      ? { kind: "estimated", unpricedA: a.unpriced, unpricedB: b.unpriced }
      : decideVerdict(
          welchTTest(
            { mean: a.avgCost, sd: a.sdCost, n: a.total },
            { mean: b.avgCost, sd: b.sdCost, n: b.total }
          ),
          a.total,
          b.total,
          { minSamples, higherIsBetter: false }
        );

  const metrics: ModelMetricComparison[] = [
    {
      metric: "quality",
      valueA: a.avgScore,
      valueB: b.avgScore,
      verdict: decideVerdict(
        welchTTest(
          { mean: a.avgScore, sd: a.sdScore, n: a.scored },
          { mean: b.avgScore, sd: b.sdScore, n: b.scored }
        ),
        a.scored,
        b.scored,
        { minSamples, higherIsBetter: true }
      ),
    },
    {
      metric: "errorRate",
      valueA: rate(a.errors, a.total),
      valueB: rate(b.errors, b.total),
      verdict: decideVerdict(
        twoProportionZTest(a.errors, a.total, b.errors, b.total),
        a.total,
        b.total,
        { minSamples, higherIsBetter: false }
      ),
    },
    {
      metric: "latency",
      valueA: a.avgLatency,
      valueB: b.avgLatency,
      verdict: decideVerdict(
        welchTTest(
          { mean: a.avgLatency, sd: a.sdLatency, n: a.total },
          { mean: b.avgLatency, sd: b.sdLatency, n: b.total }
        ),
        a.total,
        b.total,
        { minSamples, higherIsBetter: false }
      ),
    },
    { metric: "cost", valueA: a.avgCost, valueB: b.avgCost, verdict: costVerdict },
  ];

  return { promptName, days, models, a: a.model, b: b.model, metrics };
}
