import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const promptId = typeof body?.promptId === "number" ? body.promptId : NaN;
    const abTestId = typeof body?.abTestId === "number" ? body.abTestId : null;
    const variant = typeof body?.variant === "string" ? body.variant : null;
    const latencyMs = typeof body?.latencyMs === "number" ? body.latencyMs : NaN;
    const promptTokens = typeof body?.promptTokens === "number" ? body.promptTokens : 0;
    const completionTokens = typeof body?.completionTokens === "number" ? body.completionTokens : 0;
    const costUsd = typeof body?.costUsd === "number" ? body.costUsd : 0;
    const status = typeof body?.status === "string" ? body.status : "";

    if (
      !Number.isInteger(promptId) ||
      !Number.isInteger(latencyMs) ||
      (status !== "SUCCESS" && status !== "ERROR")
    ) {
      return NextResponse.json(
        { error: "promptId, latencyMs and status (SUCCESS|ERROR) are required" },
        { status: 400 }
      );
    }

    const trace = await prisma.trace.create({
      data: {
        promptId,
        abTestId,
        variant,
        latencyMs,
        promptTokens,
        completionTokens,
        costUsd,
        status,
      },
      select: { id: true },
    });

    return NextResponse.json({ id: trace.id }, { status: 201 });
  } catch (error) {
    console.error("create trace failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}