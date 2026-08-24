import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const name = params.get("name");
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    // A long-lived prompt accumulates a version per edit; the list is paged so
    // the response size stays bounded no matter how old the prompt is.
    const limit = parseLimit(params.get("limit"));
    const offsetParam = Number(params.get("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;

    const prompts = await prisma.prompt.findMany({
      where: { name },
      orderBy: { version: "desc" },
      take: limit,
      skip: offset,
    });

    return NextResponse.json(prompts);
  } catch (error) {
    console.error("list prompts failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
