import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const MAX_BATCH_SIZE = 500;
const MAX_TRACE_ID_LENGTH = 128;
/** A label is a tag, not a place to put user content (ADR-2). */
const MAX_LABEL_LENGTH = 64;

interface ParsedOutcome {
  clientTraceId: string;
  score: number;
  label: string | null;
}

function parseOutcome(raw: unknown): ParsedOutcome | string {
  if (!raw || typeof raw !== "object") return "outcome must be an object";
  const body = raw as Record<string, unknown>;

  const traceId = body.traceId ?? body.clientTraceId;
  if (typeof traceId !== "string" || traceId === "") return "traceId is required";
  if (traceId.length > MAX_TRACE_ID_LENGTH) {
    return `traceId must be at most ${MAX_TRACE_ID_LENGTH} characters`;
  }

  const score = body.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return "score must be a finite number";
  }
  if (score < 0 || score > 1) return "score must be between 0 and 1";

  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== "string") return "label must be a string";
    if (body.label.length > MAX_LABEL_LENGTH) {
      return `label must be at most ${MAX_LABEL_LENGTH} characters`;
    }
    label = body.label;
  }

  return { clientTraceId: traceId, score, label };
}

/**
 * Records the quality signal for one or more traced calls.
 *
 * Deliberately independent of whether the trace itself has arrived. Traces are
 * buffered and batched by the SDK, while an application often knows the outcome
 * immediately, so the outcome can legitimately land first. Both rows carry the
 * same client trace id and are joined on it when metrics are computed.
 *
 * Recording is an upsert keyed on that id, so a user changing their rating
 * updates the existing row instead of creating a second, contradictory one.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rawOutcomes: unknown[] = Array.isArray(body) ? body : [body];

    if (rawOutcomes.length === 0) return NextResponse.json({ recorded: 0 });
    if (rawOutcomes.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `batch too large: ${rawOutcomes.length} outcomes (max ${MAX_BATCH_SIZE})` },
        { status: 413 }
      );
    }

    const parsed: ParsedOutcome[] = [];
    for (let i = 0; i < rawOutcomes.length; i++) {
      const result = parseOutcome(rawOutcomes[i]);
      if (typeof result === "string") {
        return NextResponse.json({ error: `outcome[${i}]: ${result}` }, { status: 400 });
      }
      parsed.push(result);
    }

    // A repeated trace id inside one batch would deadlock the transaction
    // against itself; last value wins, matching the upsert semantics.
    const byTraceId = new Map<string, ParsedOutcome>();
    for (const entry of parsed) byTraceId.set(entry.clientTraceId, entry);

    await prisma.$transaction(
      [...byTraceId.values()].map((entry) =>
        prisma.outcome.upsert({
          where: { clientTraceId: entry.clientTraceId },
          create: entry,
          update: { score: entry.score, label: entry.label },
        })
      )
    );

    return NextResponse.json({ recorded: byTraceId.size }, { status: 201 });
  } catch (error) {
    console.error("record outcome failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
