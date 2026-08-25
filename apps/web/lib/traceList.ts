import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface TraceRow {
  id: number;
  created_at: Date;
  prompt_id: number;
  version: number;
  variant: string | null;
  ab_test_id: number | null;
  prompt_source: string | null;
  release_id: number | null;
  status: string;
  error_type: string | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  pricing_unknown: boolean;
  score: number | null;
  label: string | null;
}

function parseLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function parseId(raw: string | null): number | null {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A page of individual calls.
 *
 * Pagination is keyset (`before=<id>`), not offset. An offset makes the
 * database count and discard everything it skips, so page 400 of a busy prompt
 * keeps getting slower, and rows arriving between requests shift the window so
 * pages silently duplicate or drop entries.
 *
 * The prompt filter resolves `promptName` to ids first and then filters on
 * `prompt_id`. Joining to `prompts` and filtering on `name` reads better but
 * cannot use an index for the `ORDER BY id DESC LIMIT n`, so it sequentially
 * scanned the whole table and sorted — reintroducing exactly the cost that
 * keyset pagination was chosen to avoid.
 *
 * Throws RangeError for a caller mistake, so the route can map it to a 400.
 */
export async function listTraces(params: URLSearchParams) {
  const limit = parseLimit(params.get("limit"));
  const before = parseId(params.get("before"));

  const promptName = params.get("promptName");
  const promptId = parseId(params.get("promptId"));
  const abTestId = parseId(params.get("abTestId"));
  const releaseId = parseId(params.get("releaseId"));
  const status = params.get("status");
  const source = params.get("source");

  if (status !== null && status !== "ERROR" && status !== "SUCCESS") {
    throw new RangeError("status must be SUCCESS or ERROR");
  }
  if (source !== null && !["LOCAL", "REGISTRY", "AB_TEST"].includes(source)) {
    throw new RangeError("source must be LOCAL, REGISTRY or AB_TEST");
  }

  let promptIds: number[] | null = null;
  if (promptName) {
    const versions = await prisma.prompt.findMany({
      where: { name: promptName },
      select: { id: true },
    });
    // No versions means no calls; answering with an empty page beats running a
    // query whose IN list is empty.
    if (versions.length === 0) return { traces: [], nextCursor: null };
    promptIds = versions.map((v) => v.id);
  }

  const filters: Prisma.Sql[] = [];
  if (before !== null) filters.push(Prisma.sql`t.id < ${before}`);
  if (promptIds) filters.push(Prisma.sql`t.prompt_id = ANY(${promptIds})`);
  if (promptId !== null) filters.push(Prisma.sql`t.prompt_id = ${promptId}`);
  if (abTestId !== null) filters.push(Prisma.sql`t.ab_test_id = ${abTestId}`);
  if (releaseId !== null) filters.push(Prisma.sql`t.release_id = ${releaseId}`);
  if (status !== null) {
    filters.push(
      status === "ERROR" ? Prisma.sql`t.status = 'ERROR'` : Prisma.sql`t.status = 'SUCCESS'`
    );
  }
  if (source !== null) {
    filters.push(Prisma.sql`t.prompt_source::text = ${source}`);
  }

  const where =
    filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;

  // One extra row tells us whether another page exists without a second query.
  const rows = await prisma.$queryRaw<TraceRow[]>`
    SELECT t.id, t.created_at, t.prompt_id, p.version, t.variant, t.ab_test_id,
           t.prompt_source::text AS prompt_source, t.release_id,
           t.status::text AS status, t.error_type::text AS error_type,
           t.latency_ms, t.prompt_tokens, t.completion_tokens,
           t.cost_usd, t.pricing_unknown,
           o.score, o.label
    FROM traces t
    JOIN prompts p ON p.id = t.prompt_id
    LEFT JOIN outcomes o ON o.client_trace_id = t.client_trace_id
    ${where}
    ORDER BY t.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    traces: page.map((r) => ({
      id: Number(r.id),
      createdAt: r.created_at.toISOString(),
      promptId: Number(r.prompt_id),
      version: Number(r.version),
      variant: r.variant,
      abTestId: r.ab_test_id === null ? null : Number(r.ab_test_id),
      promptSource: r.prompt_source,
      releaseId: r.release_id === null ? null : Number(r.release_id),
      status: r.status,
      errorType: r.error_type,
      latencyMs: Number(r.latency_ms),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      costUsd: Number(r.cost_usd),
      pricingUnknown: r.pricing_unknown,
      score: r.score === null ? null : Number(r.score),
      label: r.label,
    })),
    nextCursor: hasMore ? Number(page[page.length - 1].id) : null,
  };
}
