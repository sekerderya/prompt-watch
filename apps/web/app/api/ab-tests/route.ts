import { NextRequest, NextResponse } from "next/server";
import { ABTestStatus } from "@prisma/client";
import { prisma, LOCKED_TRANSACTION_OPTIONS } from "@/lib/prisma";

function isABTestStatus(value: string): value is ABTestStatus {
  return value === "ACTIVE" || value === "STOPPED";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const promptName = typeof body?.promptName === "string" ? body.promptName.trim() : "";
    const variantAId = typeof body?.variantAId === "number" ? body.variantAId : NaN;
    const variantBId = typeof body?.variantBId === "number" ? body.variantBId : NaN;
    const splitPercent = body?.splitPercent === undefined ? 50 : body.splitPercent;

    if (!name || !promptName || !Number.isInteger(variantAId) || !Number.isInteger(variantBId)) {
      return NextResponse.json(
        { error: "name, promptName, variantAId and variantBId are required" },
        { status: 400 }
      );
    }

    // Comparing a prompt against itself produces two indistinguishable arms and
    // a meaningless winner, so it is rejected rather than silently allowed.
    if (variantAId === variantBId) {
      return NextResponse.json(
        { error: "variantAId and variantBId must be different prompt versions" },
        { status: 400 }
      );
    }

    if (!Number.isInteger(splitPercent) || splitPercent < 0 || splitPercent > 100) {
      return NextResponse.json(
        { error: "splitPercent must be an integer between 0 and 100" },
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

    // The SDK looks tests up by promptName, so a variant belonging to a
    // different prompt would be served under the wrong name.
    if (variantA.name !== promptName || variantB.name !== promptName) {
      return NextResponse.json(
        { error: `both variants must be versions of the prompt "${promptName}"` },
        { status: 400 }
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      // Same advisory lock the resolve route uses, keyed on the prompt name, so
      // two concurrent requests cannot both pass the "no active test" check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${promptName}))`;

      const running = await tx.aBTest.findFirst({
        where: { promptName, status: "ACTIVE" },
        select: { id: true, name: true },
      });
      if (running) return { conflict: running };

      return {
        test: await tx.aBTest.create({
          data: {
            name,
            promptName,
            variantAId,
            variantBId,
            splitPercent,
            status: "ACTIVE",
          },
        }),
      };
    }, LOCKED_TRANSACTION_OPTIONS);

    // The SDK caches one active test per prompt name; a second one would make
    // which variant a user sees depend on response ordering.
    if ("conflict" in created && created.conflict) {
      return NextResponse.json(
        {
          error:
            `"${promptName}" already has an active test ` +
            `("${created.conflict.name}", id ${created.conflict.id}). Stop it first.`,
          activeTestId: created.conflict.id,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(created.test, { status: 201 });
  } catch (error) {
    console.error("create ab test failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const statusParam = request.nextUrl.searchParams.get("status");
    if (statusParam !== null && !isABTestStatus(statusParam)) {
      return NextResponse.json(
        { error: "status must be ACTIVE or STOPPED" },
        { status: 400 }
      );
    }

    const tests = await prisma.aBTest.findMany({
      where: statusParam === null ? {} : { status: statusParam },
      include: { variantA: true, variantB: true },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json(tests);
  } catch (error) {
    console.error("list ab tests failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
