import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name : "";
    const promptName = typeof body?.promptName === "string" ? body.promptName : "";
    const variantAId = typeof body?.variantAId === "number" ? body.variantAId : NaN;
    const variantBId = typeof body?.variantBId === "number" ? body.variantBId : NaN;
    const splitPercent = typeof body?.splitPercent === "number" ? body.splitPercent : 50;

    if (!name || !promptName || !Number.isInteger(variantAId) || !Number.isInteger(variantBId)) {
      return NextResponse.json(
        { error: "name, promptName, variantAId and variantBId are required" },
        { status: 400 }
      );
    }

    const [variantA, variantB] = await Promise.all([
      prisma.prompt.findUnique({ where: { id: variantAId } }),
      prisma.prompt.findUnique({ where: { id: variantBId } }),
    ]);

    if (!variantA || !variantB) {
      return NextResponse.json(
        { error: "variantAId and variantBId must reference existing prompts" },
        { status: 400 }
      );
    }

    const created = await prisma.aBTest.create({
      data: {
        name,
        promptName,
        variantAId,
        variantBId,
        splitPercent,
        status: "ACTIVE",
      },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("create ab test failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const status = request.nextUrl.searchParams.get("status");
    const where = status ? { status } : {};

    const tests = await prisma.aBTest.findMany({
      where,
      include: {
        variantA: true,
        variantB: true,
      },
    });

    return NextResponse.json(tests);
  } catch (error) {
    console.error("list ab tests failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}