import { prisma } from "./prisma";
import {
  MIN_SAMPLES_PER_VARIANT,
  decideVerdict,
  twoProportionZTest,
  welchTTest,
  type TestResult,
} from "./stats";

export interface WindowStats {
  n: number;
  scored: number;
  avgScore: number | null;
  sdScore: number | null;
  avgLatency: number | null;
  sdLatency: number | null;
  errors: number;
}

export type RegressionMetric = "quality" | "errorRate" | "latency";

export interface MetricComparison {
  metric: RegressionMetric;
  before: number | null;
  after: number | null;
  /** Signed change in the metric's own units, after minus before. */
  delta: number | null;
  pValue: number | null;
  /** True when the change is both significant and in the bad direction. */
  regressed: boolean;
  /** True when it is significant and in the good direction. */
  improved: boolean;
  /** Plain-language verdict, always populated. */
  note: string;
}

export interface RegressionReport {
  releaseId: number;
  promptName: string;
  version: number;
  releasedAt: string;
  previousVersion: number | null;
  before: WindowStats;
  after: WindowStats;
  metrics: MetricComparison[];
  /** The worst regression found, or null when the release looks fine. */
  worst: MetricComparison | null;
}

interface WindowRow {
  n: number;
  scored: number;
  avg_score: number | null;
  sd_score: number | null;
  avg_latency: number | null;
  sd_latency: number | null;
  errors: number;
}

const EMPTY: WindowStats = {
  n: 0,
  scored: 0,
  avgScore: null,
  sdScore: null,
  avgLatency: null,
  sdLatency: null,
  errors: 0,
};

/**
 * Aggregates the calls that used one prompt version inside a time window.
 *
 * Bounded on both sides so "before" means the previous version's traffic
 * *immediately preceding* the release, not its entire history — a version that
 * ran well for a month and badly for an hour before being replaced should be
 * compared on the hour.
 */
async function windowStats(
  promptId: number,
  from: Date,
  to: Date
): Promise<WindowStats> {
  const [row] = await prisma.$queryRaw<WindowRow[]>`
    SELECT COUNT(*)                    AS n,
           COUNT(o.id)                 AS scored,
           AVG(o.score)                AS avg_score,
           STDDEV_SAMP(o.score)        AS sd_score,
           AVG(t.latency_ms)           AS avg_latency,
           STDDEV_SAMP(t.latency_ms)   AS sd_latency,
           COUNT(*) FILTER (WHERE t.status = 'ERROR') AS errors
    FROM traces t
    LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
    WHERE t.prompt_id = ${promptId}
      AND t.created_at >= ${from}
      AND t.created_at < ${to}
  `;
  if (!row) return EMPTY;

  const nullable = (v: number | null) => (v === null ? null : Number(v));
  return {
    n: Number(row.n),
    scored: Number(row.scored),
    avgScore: nullable(row.avg_score),
    sdScore: nullable(row.sd_score),
    avgLatency: nullable(row.avg_latency),
    sdLatency: nullable(row.sd_latency),
    errors: Number(row.errors),
  };
}

function compare(
  metric: RegressionMetric,
  before: number | null,
  after: number | null,
  result: TestResult | null,
  nBefore: number,
  nAfter: number,
  higherIsBetter: boolean,
  minSamples: number
): MetricComparison {
  const base = {
    metric,
    before,
    after,
    delta: before === null || after === null ? null : after - before,
    pValue: result?.pValue ?? null,
    regressed: false,
    improved: false,
  };

  // `decideVerdict` compares (A - B); here A is the *new* version, so a winner
  // of "B" means the old one was better — which is what a regression is.
  const verdict = decideVerdict(result, nAfter, nBefore, { higherIsBetter, minSamples });

  if (verdict.kind === "insufficient-data") {
    return {
      ...base,
      note: `needs ${verdict.needed} each side — have ${verdict.haveA} after, ${verdict.haveB} before`,
    };
  }
  if (verdict.kind === "inconclusive") {
    return { ...base, note: "no significant change" };
  }

  // A significant move in the good direction is a result worth reporting, not
  // an absence of one. Letting it fall through to "no significant change" told
  // the operator the opposite of what had happened.
  const regressed = verdict.winner === "B";
  const p = verdict.pValue.toFixed(3);
  return {
    ...base,
    regressed,
    improved: !regressed,
    note: regressed ? `worse (p = ${p})` : `improved (p = ${p})`,
  };
}

export interface RegressionOptions {
  /**
   * How much traffic on each side to compare. Defaults to the same gate the A/B
   * page uses, for the same reason: a handful of calls cannot distinguish a
   * regression from noise, and acting on that would be worse than not looking.
   */
  minSamples?: number;
  /** How far back before the release to look. */
  lookbackHours?: number;
}

const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Compares a release against the version it replaced.
 *
 * Shipping a prompt is the point at which this tool stops observing and starts
 * changing things, so the obligation to notice a bad change is on the tool. The
 * comparison reuses the A/B machinery unchanged — the axis is simply "before
 * the release vs after" instead of "variant A vs variant B", which is why this
 * is a small file rather than a second statistics implementation.
 *
 * Returns null when there is nothing to compare against: the first release of a
 * prompt has no predecessor.
 */
export async function assessRelease(
  releaseId: number,
  options: RegressionOptions = {}
): Promise<RegressionReport | null> {
  const minSamples = options.minSamples ?? MIN_SAMPLES_PER_VARIANT;
  const lookbackMs = (options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3600_000;

  const release = await prisma.promptRelease.findUnique({
    where: { id: releaseId },
    include: { prompt: { select: { id: true, version: true } } },
  });
  if (!release) return null;

  // The version this one replaced: the newest release of the same prompt that
  // came strictly before it.
  const previous = await prisma.promptRelease.findFirst({
    where: {
      promptName: release.promptName,
      OR: [
        { createdAt: { lt: release.createdAt } },
        { createdAt: release.createdAt, id: { lt: release.id } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { prompt: { select: { id: true, version: true } } },
  });
  if (!previous) return null;

  // A re-release of the same version has nothing to compare.
  if (previous.promptId === release.promptId) return null;

  const releasedAt = release.createdAt;
  const [before, after] = await Promise.all([
    windowStats(previous.promptId, new Date(releasedAt.getTime() - lookbackMs), releasedAt),
    windowStats(release.promptId, releasedAt, new Date()),
  ]);

  const metrics: MetricComparison[] = [
    compare(
      "quality",
      before.avgScore,
      after.avgScore,
      welchTTest(
        { mean: after.avgScore, sd: after.sdScore, n: after.scored },
        { mean: before.avgScore, sd: before.sdScore, n: before.scored }
      ),
      before.scored,
      after.scored,
      true,
      minSamples
    ),
    compare(
      "errorRate",
      before.n > 0 ? before.errors / before.n : null,
      after.n > 0 ? after.errors / after.n : null,
      twoProportionZTest(after.errors, after.n, before.errors, before.n),
      before.n,
      after.n,
      false,
      minSamples
    ),
    compare(
      "latency",
      before.avgLatency,
      after.avgLatency,
      welchTTest(
        { mean: after.avgLatency, sd: after.sdLatency, n: after.n },
        { mean: before.avgLatency, sd: before.sdLatency, n: before.n }
      ),
      before.n,
      after.n,
      false,
      minSamples
    ),
  ];

  // Quality first: it is the reason to prefer a prompt, and the operational
  // metrics are tie-breakers.
  const worst = metrics.find((m) => m.regressed) ?? null;

  return {
    releaseId: release.id,
    promptName: release.promptName,
    version: release.prompt.version,
    releasedAt: releasedAt.toISOString(),
    previousVersion: previous.prompt.version,
    before,
    after,
    metrics,
    worst,
  };
}

/** Assesses the currently live release of every prompt that has one. */
export async function assessLiveReleases(
  options: RegressionOptions = {}
): Promise<RegressionReport[]> {
  const live = await prisma.$queryRaw<{ id: number }[]>`
    SELECT DISTINCT ON (prompt_name) id
    FROM prompt_releases
    ORDER BY prompt_name, created_at DESC, id DESC
  `;

  const reports = await Promise.all(
    live.map((r) => assessRelease(Number(r.id), options))
  );
  return reports.filter((r): r is RegressionReport => r !== null);
}
