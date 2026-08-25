import { prisma } from "./prisma";

export interface RetentionResult {
  cutoff: string;
  tracesDeleted: number;
  orphanOutcomesDeleted: number;
}

/** Deleting in chunks keeps one long transaction from locking the table. */
const DELETE_BATCH_SIZE = 5000;

export const DEFAULT_RETENTION_DAYS = 90;

export function retentionDays(): number | null {
  const raw = process.env.PROMPTWATCH_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;

  // An explicit 0 (or anything non-positive) means "keep everything", which is
  // a legitimate choice for a low-volume install.
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * Deletes telemetry older than the retention window.
 *
 * An observability tool writes a row per model call and, until this existed,
 * never deleted one. At a modest ten calls a second that is roughly 860k rows a
 * day, growing without bound, under a dashboard that scans the table for every
 * rollup.
 *
 * Prompts and A/B tests are never deleted: they are configuration, they are
 * tiny, and a prompt version is the thing a trace refers to. Only the
 * unbounded, per-call data ages out.
 */
export async function applyRetention(days: number | null): Promise<RetentionResult | null> {
  if (days === null) return null;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let tracesDeleted = 0;
  for (;;) {
    // deleteMany has no LIMIT, so the ids to remove are selected first.
    const doomed = await prisma.trace.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: DELETE_BATCH_SIZE,
    });
    if (doomed.length === 0) break;

    const { count } = await prisma.trace.deleteMany({
      where: { id: { in: doomed.map((t) => t.id) } },
    });
    tracesDeleted += count;
    if (doomed.length < DELETE_BATCH_SIZE) break;
  }

  // Outcomes have no foreign key to traces (ADR-8), so deleting a trace leaves
  // its outcome behind. Sweep the ones whose trace is gone, but only past the
  // cutoff: a recent outcome may still be waiting for its trace to be flushed.
  const orphans = await prisma.$executeRaw`
    DELETE FROM outcomes o
    WHERE o.created_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM traces t WHERE t.client_trace_id = o.client_trace_id
      )
  `;

  return {
    cutoff: cutoff.toISOString(),
    tracesDeleted,
    orphanOutcomesDeleted: Number(orphans),
  };
}
