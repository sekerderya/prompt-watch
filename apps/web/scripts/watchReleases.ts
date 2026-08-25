/**
 * Checks every live release against the version it replaced.
 *
 *   npm run watch:releases --workspace=apps/web
 *
 * Exits 1 when a regression is found, so a scheduler can alert on it:
 *
 *   *\/15 * * * *  docker compose exec -T web npm run watch:releases
 *
 * Detection is the default and always runs. Reverting without a human is opt-in
 * (PROMPTWATCH_AUTO_ROLLBACK=true) and held to a stricter bar — see ADR-14.
 */
import { assessLiveReleases, type MetricComparison } from "../lib/regression";
import { autoRollbackPolicy, decideRollback, performRollback } from "../lib/autoRollback";
import { prisma } from "../lib/prisma";

function format(metric: MetricComparison): string {
  const show = (v: number | null) =>
    v === null
      ? "n/a"
      : metric.metric === "latency"
        ? `${Math.round(v)}ms`
        : `${(v * 100).toFixed(1)}%`;
  const p = metric.pValue === null ? "" : ` (p = ${metric.pValue.toFixed(3)})`;
  return `${metric.metric}: ${show(metric.before)} → ${show(metric.after)}${p}`;
}

async function main() {
  const policy = autoRollbackPolicy();
  const reports = await assessLiveReleases();

  if (reports.length === 0) {
    console.log("No releases with a predecessor to compare against.");
    return 0;
  }

  let regressions = 0;

  for (const report of reports) {
    const header = `${report.promptName} v${report.version} (release #${report.releaseId})`;

    if (!report.worst) {
      const improved = report.metrics.filter((m) => m.improved);
      const blocked = report.metrics.find((m) => m.note.startsWith("needs"));
      const summary = improved.length
        ? improved.map((m) => `${m.metric} ${m.note}`).join(", ")
        : (blocked?.note ?? "no significant change");
      console.log(`✓ ${header} — ${summary}`);
      continue;
    }

    regressions++;
    console.log(`✗ ${header} — REGRESSION vs v${report.previousVersion}`);
    for (const metric of report.metrics) {
      console.log(`    ${metric.regressed ? "!" : " "} ${format(metric)}`);
    }

    const decision = await decideRollback(report, policy);
    if (!decision.act) {
      console.log(`    → not reverting automatically: ${decision.reason}`);
      continue;
    }

    const outcome = await performRollback(report, decision);
    if (outcome.rolledBack) {
      console.log(`    → reverted to v${outcome.toVersion}`);
    } else {
      console.log(`    → revert failed: ${outcome.error}`);
    }
  }

  if (regressions > 0) {
    console.log(`\n${regressions} regression(s) found.`);
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
