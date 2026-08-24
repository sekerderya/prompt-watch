import { NextRequest, NextResponse } from "next/server";
import { Prisma, TraceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Guards against a single request trying to insert an unbounded number of rows. */
const MAX_BATCH_SIZE = 500;

interface ParsedTrace {
  promptId: number;
  abTestId: number | null;
  variant: string | null;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  pricingUnknown: boolean;
  status: TraceStatus;
}

function parseTrace(raw: unknown): ParsedTrace | string {
  if (!raw || typeof raw !== "object") return "trace must be an object";
  const body = raw as Record<string, unknown>;

  const promptId = typeof body.promptId === "number" ? body.promptId : NaN;
  const latencyMs = typeof body.latencyMs === "number" ? body.latencyMs : NaN;
  const status = body.status;

  if (!Number.isInteger(promptId) || promptId <= 0) return "promptId must be a positive integer";
  if (!Number.isInteger(latencyMs) || latencyMs < 0) {
    return "latencyMs must be a non-negative integer";
  }
  if (status !== "SUCCESS" && status !== "ERROR") return "status must be SUCCESS or ERROR";

  const nonNegative = (value: unknown): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
    return n < 0 ? 0 : n;
  };

  return {
    promptId,
    abTestId: typeof body.abTestId === "number" ? body.abTestId : null,
    variant: body.variant === "A" || body.variant === "B" ? body.variant : null,
    latencyMs,
    promptTokens: Math.round(nonNegative(body.promptTokens)),
    completionTokens: Math.round(nonNegative(body.completionTokens)),
    costUsd: nonNegative(body.costUsd),
    pricingUnknown: body.pricingUnknown === true,
    status: status as TraceStatus,
  };
}

/**
 * Accepts one trace or a batch of them.
 *
 * The SDK batches whenever traces queue up behind an in-flight request, so a
 * high-volume host application costs the backend round trips proportional to
 * latency rather than to call count. A bare object is still accepted so older
 * SDK builds keep working.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rawTraces: unknown[] = Array.isArray(body) ? body : [body];

    if (rawTraces.length === 0) {
      return NextResponse.json({ created: 0 });
    }
    if (rawTraces.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `batch too large: ${rawTraces.length} traces (max ${MAX_BATCH_SIZE})` },
        { status: 413 }
      );
    }

    const parsed: ParsedTrace[] = [];
    for (let i = 0; i < rawTraces.length; i++) {
      const result = parseTrace(rawTraces[i]);
      if (typeof result === "string") {
        return NextResponse.json(
          { error: `trace[${i}]: ${result}` },
          { status: 400 }
        );
      }
      parsed.push(result);
    }

    const { count } = await prisma.trace.createMany({ data: parsed });
    return NextResponse.json({ created: count }, { status: 201 });
  } catch (error) {
    // A trace referencing a prompt that does not exist is a client mistake, not
    // a server fault; answering 500 would make the SDK retry it forever.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return NextResponse.json(
        { error: "promptId or abTestId does not reference an existing row" },
        { status: 400 }
      );
    }
    console.error("create trace failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
