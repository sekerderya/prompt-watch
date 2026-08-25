import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

import { assessLiveReleases, assessRelease } from "@/lib/regression";
import {
  autoRollbackPolicy,
  decideRollback,
  performRollback,
  DEFAULT_AUTO_ROLLBACK_MIN_SAMPLES,
} from "@/lib/autoRollback";
import { liveReleases } from "@/lib/releases";
import { prisma } from "@/lib/prisma";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

const HOUR = 3600_000;

/** Writes n traces for a version at a fixed time, with a given success rate. */
async function seedTraffic(options: {
  promptId: number;
  n: number;
  at: Date;
  scoreRate?: number;
  errorRate?: number;
  latencyMs?: number;
  prefix: string;
}) {
  const { promptId, n, at, prefix } = options;
  const scoreRate = options.scoreRate ?? 0;
  const errorRate = options.errorRate ?? 0;
  const latencyMs = options.latencyMs ?? 200;

  const traces = Array.from({ length: n }, (_, i) => ({
    promptId,
    latencyMs,
    promptTokens: 10,
    completionTokens: 10,
    costUsd: 0.0001,
    status: (i < Math.round(n * errorRate) ? "ERROR" : "SUCCESS") as "ERROR" | "SUCCESS",
    clientTraceId: `${prefix}-${i}`,
    createdAt: at,
  }));
  await prisma.trace.createMany({ data: traces });

  if (options.scoreRate !== undefined) {
    const successes = Math.round(n * scoreRate);
    await prisma.outcome.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        clientTraceId: `${prefix}-${i}`,
        score: i < successes ? 1 : 0,
        createdAt: at,
        updatedAt: at,
      })),
    });
  }
}

async function seedRelease(promptId: number, promptName: string, at: Date, source = "MANUAL") {
  return prisma.promptRelease.create({
    data: { promptName, promptId, source: source as "MANUAL", createdAt: at },
  });
}

describe("assessRelease", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  async function twoVersions() {
    return {
      v1: await createPrompt("support", 1, "old"),
      v2: await createPrompt("support", 2, "new"),
    };
  }

  it("reports nothing to compare for a first release", async () => {
    const { v1 } = await twoVersions();
    const release = await seedRelease(v1.id, "support", new Date());

    expect(await assessRelease(release.id)).toBeNull();
  });

  it("detects a quality regression after a release", async () => {
    const { v1, v2 } = await twoVersions();
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    // v1 satisfied 90% of users in the hours before the switch.
    await seedTraffic({
      promptId: v1.id,
      n: 100,
      at: new Date(releasedAt.getTime() - HOUR),
      scoreRate: 0.9,
      prefix: "before",
    });

    const release = await seedRelease(v2.id, "support", releasedAt);
    // v2 satisfies 50%.
    await seedTraffic({
      promptId: v2.id,
      n: 100,
      at: new Date(releasedAt.getTime() + 60_000),
      scoreRate: 0.5,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;

    expect(report.previousVersion).toBe(1);
    expect(report.worst?.metric).toBe("quality");
    expect(report.worst?.before).toBeCloseTo(0.9, 2);
    expect(report.worst?.after).toBeCloseTo(0.5, 2);
    expect(report.worst?.pValue).toBeLessThan(0.05);
  });

  it("does not call an improvement a regression", async () => {
    const { v1, v2 } = await twoVersions();
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    await seedTraffic({
      promptId: v1.id,
      n: 100,
      at: new Date(releasedAt.getTime() - HOUR),
      scoreRate: 0.5,
      prefix: "before",
    });

    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n: 100,
      at: new Date(releasedAt.getTime() + 60_000),
      scoreRate: 0.9,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;
    const quality = report.metrics.find((m) => m.metric === "quality")!;

    expect(report.worst).toBeNull();
    expect(quality.regressed).toBe(false);
    // And it says so. Reporting a significant improvement as "no significant
    // change" told the operator the opposite of what happened.
    expect(quality.improved).toBe(true);
    expect(quality.note).toMatch(/^improved \(p = /);
  });

  /** The same gate the A/B page uses, for the same reason. */
  it("refuses a verdict on too little traffic", async () => {
    const { v1, v2 } = await twoVersions();
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    await seedTraffic({
      promptId: v1.id,
      n: 5,
      at: new Date(releasedAt.getTime() - HOUR),
      scoreRate: 1,
      prefix: "before",
    });
    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n: 5,
      at: new Date(releasedAt.getTime() + 60_000),
      scoreRate: 0,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;
    expect(report.worst).toBeNull();
    expect(report.metrics.find((m) => m.metric === "quality")?.note).toMatch(/needs 30/);
    expect(report.metrics.find((m) => m.metric === "quality")?.improved).toBe(false);
  });

  it("detects an error-rate regression", async () => {
    const { v1, v2 } = await twoVersions();
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    await seedTraffic({
      promptId: v1.id,
      n: 200,
      at: new Date(releasedAt.getTime() - HOUR),
      errorRate: 0.01,
      prefix: "before",
    });
    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n: 200,
      at: new Date(releasedAt.getTime() + 60_000),
      errorRate: 0.2,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;
    expect(report.worst?.metric).toBe("errorRate");
  });

  it("compares against the hours before the switch, not the old version's whole history", async () => {
    const { v1, v2 } = await twoVersions();
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 100 * HOUR));
    // Ancient, excellent traffic that must not enter the comparison.
    await seedTraffic({
      promptId: v1.id,
      n: 500,
      at: new Date(releasedAt.getTime() - 90 * HOUR),
      scoreRate: 1,
      prefix: "ancient",
    });
    // Recent traffic, mediocre — this is what the new version replaced.
    await seedTraffic({
      promptId: v1.id,
      n: 100,
      at: new Date(releasedAt.getTime() - HOUR),
      scoreRate: 0.5,
      prefix: "recent",
    });

    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n: 100,
      at: new Date(releasedAt.getTime() + 60_000),
      scoreRate: 0.5,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;
    // Against the recent window the new version is level; against all history
    // it would have looked like a catastrophe.
    expect(report.before.n).toBe(100);
    expect(report.worst).toBeNull();
  });

  it("ignores a re-release of the same version", async () => {
    const { v1 } = await twoVersions();
    const releasedAt = new Date(Date.now() - HOUR);
    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - HOUR));
    const again = await seedRelease(v1.id, "support", releasedAt);

    expect(await assessRelease(again.id)).toBeNull();
  });

  it("assesses the live release of each prompt", async () => {
    const a1 = await createPrompt("support", 1);
    const a2 = await createPrompt("support", 2);
    const b1 = await createPrompt("sales", 1);
    const at = new Date(Date.now() - HOUR);

    await seedRelease(a1.id, "support", new Date(at.getTime() - HOUR));
    await seedRelease(a2.id, "support", at);
    await seedRelease(b1.id, "sales", at); // first release, not comparable

    const reports = await assessLiveReleases();
    expect(reports.map((r) => r.promptName)).toEqual(["support"]);
  });
});

describe("auto-rollback policy", () => {
  const ORIGINAL_ENV = process.env;

  beforeAll(assertTestDatabase);
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await resetDatabase();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function regressedRelease(n = 200, scoreRate = 0.4) {
    const v1 = await createPrompt("support", 1, "old");
    const v2 = await createPrompt("support", 2, "new");
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    await seedTraffic({
      promptId: v1.id,
      n,
      at: new Date(releasedAt.getTime() - HOUR),
      scoreRate: 0.95,
      prefix: "before",
    });
    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n,
      at: new Date(releasedAt.getTime() + 60_000),
      scoreRate,
      prefix: "after",
    });

    return { v1, v2, report: (await assessRelease(release.id))! };
  }

  it("is off unless explicitly switched on", async () => {
    delete process.env.PROMPTWATCH_AUTO_ROLLBACK;
    expect(autoRollbackPolicy().enabled).toBe(false);

    process.env.PROMPTWATCH_AUTO_ROLLBACK = "true";
    expect(autoRollbackPolicy().enabled).toBe(true);
    expect(autoRollbackPolicy().minSamples).toBe(DEFAULT_AUTO_ROLLBACK_MIN_SAMPLES);
  });

  it("refuses to act while disabled, even on a clear regression", async () => {
    const { report } = await regressedRelease();
    expect(report.worst?.metric).toBe("quality");

    const decision = await decideRollback(report, { enabled: false, minSamples: 10 });
    expect(decision.act).toBe(false);
  });

  /**
   * Detection and action are separate questions. A regression that clears
   * significance may still be too thin to revert production over unattended.
   */
  it("requires more evidence to act than to report", async () => {
    const { report } = await regressedRelease(40);
    expect(report.worst).not.toBeNull(); // reported

    const decision = await decideRollback(report, { enabled: true, minSamples: 100 });
    expect(decision.act).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining("needs 100") });
  });

  it("never reverts on latency alone", async () => {
    const v1 = await createPrompt("support", 1);
    const v2 = await createPrompt("support", 2);
    const releasedAt = new Date(Date.now() - HOUR);

    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    await seedTraffic({
      promptId: v1.id,
      n: 200,
      at: new Date(releasedAt.getTime() - HOUR),
      latencyMs: 100,
      prefix: "before",
    });
    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n: 200,
      at: new Date(releasedAt.getTime() + 60_000),
      latencyMs: 900,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;
    expect(report.worst?.metric).toBe("latency");

    // A slower but better prompt is often the right trade; a machine must not
    // silently undo that decision.
    const decision = await decideRollback(report, { enabled: true, minSamples: 10 });
    expect(decision.act).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining("never auto-reverted") });
  });

  it("reverts a well-evidenced quality regression and records why", async () => {
    const { v1, report } = await regressedRelease(200);

    const decision = await decideRollback(report, { enabled: true, minSamples: 100 });
    expect(decision.act).toBe(true);

    const outcome = await performRollback(report, decision as never);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.toVersion).toBe(1);

    const [live] = await liveReleases("support");
    expect(live.promptId).toBe(v1.id);
    expect(live.source).toBe("ROLLBACK");

    const created = await prisma.promptRelease.findFirst({ orderBy: { id: "desc" } });
    expect(created?.actor).toBe("auto-rollback");
    expect(created?.reason).toMatch(/quality moved/);
    // The numbers that justified it survive the traces being aged out.
    expect((created?.evidence as { metric: string }).metric).toBe("quality");
  });

  it("does nothing when there is no regression", async () => {
    const v1 = await createPrompt("support", 1);
    const v2 = await createPrompt("support", 2);
    const releasedAt = new Date(Date.now() - HOUR);
    await seedRelease(v1.id, "support", new Date(releasedAt.getTime() - 4 * HOUR));
    await seedTraffic({
      promptId: v1.id,
      n: 200,
      at: new Date(releasedAt.getTime() - HOUR),
      scoreRate: 0.5,
      prefix: "before",
    });
    const release = await seedRelease(v2.id, "support", releasedAt);
    await seedTraffic({
      promptId: v2.id,
      n: 200,
      at: new Date(releasedAt.getTime() + 60_000),
      scoreRate: 0.5,
      prefix: "after",
    });

    const report = (await assessRelease(release.id))!;
    const decision = await decideRollback(report, { enabled: true, minSamples: 10 });
    expect(decision).toMatchObject({ act: false, reason: "no regression" });
  });
});
