import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

async function parseId(context: RouteContext): Promise<number | null> {
  const { id } = await context.params;
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const id = await parseId(context);
  if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  try {
    const test = await prisma.aBTest.findUnique({
      where: { id },
      include: { variantA: true, variantB: true },
    });
    if (!test) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(test);
  } catch (error) {
    console.error("get ab test failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Ends a running test (or restarts a stopped one).
 *
 * Until this existed every test created was ACTIVE forever, so running the demo
 * twice left two active tests for the same prompt and the SDK's cache silently
 * picked whichever arrived last.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const id = await parseId(context);
  if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  try {
    const body = await request.json().catch(() => null);
    const status = body?.status;

    if (status !== "ACTIVE" && status !== "STOPPED") {
      return NextResponse.json(
        { error: "status must be ACTIVE or STOPPED" },
        { status: 400 }
      );
    }

    const existing = await prisma.aBTest.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (existing.status === status) return NextResponse.json(existing);

    if (status === "ACTIVE") {
      // Reactivating must respect the same one-active-test-per-prompt rule that
      // creation does, and for the same reason.
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${existing.promptName}))`;
        const running = await tx.aBTest.findFirst({
          where: { promptName: existing.promptName, status: "ACTIVE" },
          select: { id: true, name: true },
        });
        if (running) return { conflict: running };
        return {
          test: await tx.aBTest.update({
            where: { id },
            data: { status: "ACTIVE", endedAt: null },
          }),
        };
      });

      if ("conflict" in updated && updated.conflict) {
        return NextResponse.json(
          {
            error:
              `"${existing.promptName}" already has an active test ` +
              `("${updated.conflict.name}", id ${updated.conflict.id}). Stop it first.`,
            activeTestId: updated.conflict.id,
          },
          { status: 409 }
        );
      }
      return NextResponse.json(updated.test);
    }

    const stopped = await prisma.aBTest.update({
      where: { id },
      data: { status: "STOPPED", endedAt: new Date() },
    });
    return NextResponse.json(stopped);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    console.error("update ab test failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
