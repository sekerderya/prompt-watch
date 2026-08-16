import { NextResponse } from "next/server";
import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

type ActiveTestPayload = Prisma.ABTestGetPayload<{
  select: {
    id: true;
    promptName: true;
    variantAId: true;
    variantBId: true;
    splitPercent: true;
    variantA: { select: { promptText: true } };
    variantB: { select: { promptText: true } };
  };
}>;

export async function GET() {
  try {
    const tests: ActiveTestPayload[] = await prisma.aBTest.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        promptName: true,
        variantAId: true,
        variantBId: true,
        splitPercent: true,
        variantA: {
          select: { promptText: true },
        },
        variantB: {
          select: { promptText: true },
        },
      },
    });

    const result = tests.map((t: ActiveTestPayload) => ({
      id: t.id,
      promptName: t.promptName,
      variantAId: t.variantAId,
      variantAText: t.variantA.promptText,
      variantBId: t.variantBId,
      variantBText: t.variantB.promptText,
      splitPercent: t.splitPercent,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("list active ab tests failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}