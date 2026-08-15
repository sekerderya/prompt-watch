import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name : "";
    const promptText = typeof body?.promptText === "string" ? body.promptText : "";
    const hash = typeof body?.hash === "string" ? body.hash : "";

    if (!name || !hash) {
      return NextResponse.json(
        { error: "name and hash are required" },
        { status: 400 }
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;

      const existing = await tx.prompt.findFirst({
        where: { name, promptHash: hash },
      });
      if (existing) return existing;

      const latest = await tx.prompt.findFirst({
        where: { name },
        orderBy: { version: "desc" },
      });
      const nextVersion = latest ? latest.version + 1 : 1;

      return tx.prompt.create({
        data: {
          name,
          promptText,
          promptHash: hash,
          version: nextVersion,
        },
      });
    });

    return NextResponse.json({
      id: result.id,
      name: result.name,
      version: result.version,
    });
  } catch (error) {
    console.error("resolve prompt failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}