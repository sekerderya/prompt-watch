import { prisma } from "./prisma";
import { createRelease } from "./releases";
import type { RegressionReport } from "./regression";

/**
 * Metrics a machine is allowed to revert a production change over.
 *
 * Latency is deliberately absent. A prompt that is slower but produces better
 * answers is often the right trade, and a system that silently undoes that
 * decision is worse than one that says nothing. Speed regressions are reported;
 * only quality and failures are actionable without a human.
 */
const AUTO_ROLLBACK_METRICS = new Set(["quality", "errorRate"]);

export const DEFAULT_AUTO_ROLLBACK_MIN_SAMPLES = 100;

export interface AutoRollbackPolicy {
  enabled: boolean;
  /** Evidence required on each side before a machine may act. */
  minSamples: number;
}

export function autoRollbackPolicy(): AutoRollbackPolicy {
  const raw = process.env.PROMPTWATCH_AUTO_ROLLBACK;
  const enabled = raw === "true" || raw === "1";

  const configured = Number(process.env.PROMPTWATCH_AUTO_ROLLBACK_MIN_SAMPLES);
  const minSamples =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_AUTO_ROLLBACK_MIN_SAMPLES;

  return { enabled, minSamples };
}

export type RollbackDecision =
  | { act: false; reason: string }
  | { act: true; metric: string; targetPromptId: number; targetVersion: number };

/**
 * Decides whether a regression clears the higher bar for acting unattended.
 *
 * Detection and action are separated on purpose. Detection answers "is this
 * real"; action answers "am I confident enough to change production without
 * asking". The second is a stricter question, and collapsing the two would mean
 * every reported blip reverted a deploy.
 */
export async function decideRollback(
  report: RegressionReport,
  policy: AutoRollbackPolicy
): Promise<RollbackDecision> {
  if (!policy.enabled) return { act: false, reason: "auto-rollback is disabled" };
  if (!report.worst) return { act: false, reason: "no regression" };

  if (!AUTO_ROLLBACK_METRICS.has(report.worst.metric)) {
    return {
      act: false,
      reason: `${report.worst.metric} regressions are reported, never auto-reverted`,
    };
  }

  const evidence =
    report.worst.metric === "quality"
      ? Math.min(report.before.scored, report.after.scored)
      : Math.min(report.before.n, report.after.n);

  if (evidence < policy.minSamples) {
    return {
      act: false,
      reason: `only ${evidence} calls of evidence, needs ${policy.minSamples} to act unattended`,
    };
  }

  // Revert to whatever was live immediately before this release.
  const previous = await prisma.promptRelease.findFirst({
    where: {
      promptName: report.promptName,
      OR: [
        { createdAt: { lt: new Date(report.releasedAt) } },
        { createdAt: new Date(report.releasedAt), id: { lt: report.releaseId } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { prompt: { select: { id: true, version: true } } },
  });
  if (!previous) return { act: false, reason: "no previous release to revert to" };

  return {
    act: true,
    metric: report.worst.metric,
    targetPromptId: previous.promptId,
    targetVersion: previous.prompt.version,
  };
}

export interface RollbackOutcome {
  rolledBack: boolean;
  toVersion?: number;
  error?: string;
}

/** Performs the revert, recording the numbers that justified it. */
export async function performRollback(
  report: RegressionReport,
  decision: Extract<RollbackDecision, { act: true }>
): Promise<RollbackOutcome> {
  const change = report.worst!;
  const format = (v: number | null) =>
    v === null ? "n/a" : change.metric === "latency" ? `${Math.round(v)}ms` : `${(v * 100).toFixed(1)}%`;

  const result = await createRelease({
    promptId: decision.targetPromptId,
    source: "ROLLBACK",
    actor: "auto-rollback",
    reason:
      `Reverted v${report.version} to v${decision.targetVersion}: ${change.metric} moved ` +
      `${format(change.before)} → ${format(change.after)} (p = ${change.pValue?.toFixed(3)}).`,
    evidence: {
      trigger: "auto-rollback",
      regressedRelease: report.releaseId,
      metric: change.metric,
      capturedAt: new Date().toISOString(),
      before: report.before,
      after: report.after,
      metrics: report.metrics,
    },
  });

  if (!result.ok) return { rolledBack: false, error: result.error };
  return { rolledBack: true, toVersion: decision.targetVersion };
}
