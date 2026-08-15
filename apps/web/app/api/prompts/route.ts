import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const prompts = await prisma.prompt.findMany({
      where: { name },
      orderBy: { version: "desc" },
    });

    return NextResponse.json(prompts);
  } catch (error) {
    console.error("list prompts failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}