import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface TraceRow {
  id: number;
  created_at: Date;
  prompt_id: number;
  version: number;
  variant: string | null;
  ab_test_id: number | null;
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
 * Individual calls, newest first.
 *
 * Every other endpoint aggregates. Aggregates answer "how is this prompt
 * doing"; they cannot answer "what happened to that one request that took four
 * seconds", which is the question anyone actually debugging is asking.
 *
 * Pagination is keyset (`before=<id>`), not offset. Offsets make the database
 * count and discard everything it skips, so page 400 of a busy prompt gets
 * slower and slower — and rows arriving between requests shift the window, so
 * pages silently duplicate or drop entries. An id cursor has neither problem.
 */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const limit = parseLimit(params.get("limit"));
    const before = parseId(params.get("before"));

    const promptName = params.get("promptName");
    const promptId = parseId(params.get("promptId"));
    const abTestId = parseId(params.get("abTestId"));
    const status = params.get("status");
    const errorsOnly = status === "ERROR";

    if (status !== null && status !== "ERROR" && status !== "SUCCESS") {
      return NextResponse.json(
        { error: "status must be SUCCESS or ERROR" },
        { status: 400 }
      );
    }

    const filters: Prisma.Sql[] = [];
    if (before !== null) filters.push(Prisma.sql`t.id < ${before}`);
    if (promptName) filters.push(Prisma.sql`p.name = ${promptName}`);
    if (promptId !== null) filters.push(Prisma.sql`t.prompt_id = ${promptId}`);
    if (abTestId !== null) filters.push(Prisma.sql`t.ab_test_id = ${abTestId}`);
    if (status !== null) {
      filters.push(errorsOnly ? Prisma.sql`t.status = 'ERROR'` : Prisma.sql`t.status = 'SUCCESS'`);
    }

    const where =
      filters.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`
        : Prisma.empty;

    // One extra row tells us whether another page exists without a second query.
    const rows = await prisma.$queryRaw<TraceRow[]>`
      SELECT t.id, t.created_at, t.prompt_id, p.version, t.variant, t.ab_test_id,
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

    return NextResponse.json({
      traces: page.map((r) => ({
        id: Number(r.id),
        createdAt: r.created_at.toISOString(),
        promptId: Number(r.prompt_id),
        version: Number(r.version),
        variant: r.variant,
        abTestId: r.ab_test_id === null ? null : Number(r.ab_test_id),
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
    });
  } catch (error) {
    console.error("list traces failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
