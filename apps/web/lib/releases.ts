import type { Prisma, ReleaseSource } from "@prisma/client";
import { prisma } from "./prisma";

export interface LiveRelease {
  promptName: string;
  promptId: number;
  version: number;
  promptText: string;
  releaseId: number;
  source: ReleaseSource;
  reason: string | null;
  releasedAt: string;
}

/** Keeps a self-declared name a name rather than a paragraph. */
export const MAX_ACTOR_LENGTH = 64;

/**
 * Normalises the self-declared operator name.
 *
 * Empty becomes null rather than an empty string, so "nobody said who" reads
 * differently from "someone said their name was ''".
 */
export function normalizeActor(raw: unknown): string | null | RangeError {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return new RangeError("actor must be a string");
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_ACTOR_LENGTH) {
    return new RangeError(`actor must be at most ${MAX_ACTOR_LENGTH} characters`);
  }
  return trimmed;
}

interface LiveReleaseRow {
  release_id: number;
  prompt_name: string;
  prompt_id: number;
  version: number;
  prompt_text: string;
  source: ReleaseSource;
  reason: string | null;
  created_at: Date;
}

/**
 * The currently served version of each prompt.
 *
 * "Currently served" is not stored anywhere — it is the newest release row per
 * prompt name, which is what `DISTINCT ON` computes in one index scan. Deriving
 * it rather than maintaining an `isCurrent` column means the pointer cannot
 * drift away from the history it is supposed to summarise.
 */
export async function liveReleases(promptName?: string): Promise<LiveRelease[]> {
  const rows = promptName
    ? await prisma.$queryRaw<LiveReleaseRow[]>`
        SELECT DISTINCT ON (r.prompt_name)
               r.id AS release_id, r.prompt_name, r.prompt_id, r.source, r.reason,
               r.created_at, p.version, p.prompt_text
        FROM prompt_releases r
        JOIN prompts p ON p.id = r.prompt_id
        WHERE r.prompt_name = ${promptName}
        ORDER BY r.prompt_name, r.created_at DESC, r.id DESC
      `
    : await prisma.$queryRaw<LiveReleaseRow[]>`
        SELECT DISTINCT ON (r.prompt_name)
               r.id AS release_id, r.prompt_name, r.prompt_id, r.source, r.reason,
               r.created_at, p.version, p.prompt_text
        FROM prompt_releases r
        JOIN prompts p ON p.id = r.prompt_id
        ORDER BY r.prompt_name, r.created_at DESC, r.id DESC
      `;

  return rows.map((r) => ({
    promptName: r.prompt_name,
    promptId: Number(r.prompt_id),
    version: Number(r.version),
    promptText: r.prompt_text,
    releaseId: Number(r.release_id),
    source: r.source,
    reason: r.reason,
    releasedAt: r.created_at.toISOString(),
  }));
}

export interface CreateReleaseInput {
  promptId: number;
  source: ReleaseSource;
  reason?: string | null;
  abTestId?: number | null;
  /**
   * Any JSON-serialisable snapshot. Typed loosely because Prisma's
   * `InputJsonValue` rejects ordinary interfaces (they have no index
   * signature), and the alternative is spreading that cast across callers.
   */
  evidence?: unknown;
  /**
   * Self-declared name of whoever did this. Attribution, not authentication:
   * with a single shared secret there is no identity to verify (ADR-13).
   */
  actor?: string | null;
}

export type CreateReleaseResult =
  | { ok: true; release: Awaited<ReturnType<typeof prisma.promptRelease.create>> }
  | { ok: false; status: number; error: string };

/**
 * Promotes one prompt version to be the served one.
 *
 * The prompt name is read from the version rather than accepted from the
 * caller: a release that named a different prompt than the version it points at
 * would be served under the wrong name and be impossible to notice.
 */
export async function createRelease(input: CreateReleaseInput): Promise<CreateReleaseResult> {
  const prompt = await prisma.prompt.findUnique({
    where: { id: input.promptId },
    select: { id: true, name: true, version: true },
  });
  if (!prompt) {
    return { ok: false, status: 400, error: "promptId must reference an existing prompt version" };
  }

  const [current] = await liveReleases(prompt.name);
  if (current && current.promptId === prompt.id) {
    return {
      ok: false,
      status: 409,
      error: `v${prompt.version} of "${prompt.name}" is already the released version.`,
    };
  }

  const release = await prisma.promptRelease.create({
    data: {
      promptName: prompt.name,
      promptId: prompt.id,
      source: input.source,
      reason: input.reason ?? null,
      abTestId: input.abTestId ?? null,
      evidence: (input.evidence ?? undefined) as Prisma.InputJsonValue | undefined,
      actor: input.actor ?? null,
    },
  });

  return { ok: true, release };
}
