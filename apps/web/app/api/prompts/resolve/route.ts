import { NextRequest, NextResponse } from "next/server";
import { prisma, LOCKED_TRANSACTION_OPTIONS } from "@/lib/prisma";

interface ResolvedPrompt {
  id: number;
  name: string;
  version: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name : "";
    const promptText = typeof body?.promptText === "string" ? body.promptText : "";
    const hash = typeof body?.hash === "string" ? body.hash : "";

    if (!name || !hash) {
      return NextResponse.json({ error: "name and hash are required" }, { status: 400 });
    }

    // Fast path. A prompt that has not changed is the overwhelmingly common
    // case — it happens on every single LLM call — and it needs no lock at all.
    // Taking one anyway serialised every resolve for a given prompt name across
    // the whole fleet, turning a read into a global bottleneck.
    const known = await prisma.prompt.findFirst({
      where: { name, promptHash: hash },
      select: { id: true, name: true, version: true },
    });
    if (known) return NextResponse.json(known);

    const result = await prisma.$transaction(async (tx) => {
      // Serialises version assignment for this prompt name. Only reached when
      // the prompt text has genuinely changed.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;

      // One statement picks the next version and inserts it, so the lock is
      // held for a single round trip instead of three.
      const inserted = await tx.$queryRaw<ResolvedPrompt[]>`
        INSERT INTO prompts (name, prompt_text, prompt_hash, version)
        SELECT ${name}, ${promptText}, ${hash}, COALESCE(MAX(version), 0) + 1
        FROM prompts WHERE name = ${name}
        ON CONFLICT (name, prompt_hash) DO NOTHING
        RETURNING id, name, version
      `;
      if (inserted.length > 0) return inserted[0];

      // DO NOTHING fired: another writer inserted this exact hash first.
      return tx.prompt.findFirstOrThrow({
        where: { name, promptHash: hash },
        select: { id: true, name: true, version: true },
      });
    }, LOCKED_TRANSACTION_OPTIONS);

    return NextResponse.json(result);
  } catch (error) {
    console.error("resolve prompt failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
