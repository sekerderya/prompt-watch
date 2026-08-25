import { NextRequest, NextResponse } from "next/server";
import { ReleaseSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { variantComparison } from "@/lib/comparison";
import { createRelease } from "@/lib/releases";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Ships the winning variant of an A/B test.
 *
 * This is the step that closes the loop. Before it existed the dashboard could
 * tell you variant B was better and then do nothing about it — you went and
 * edited a string in your source. Now the decision and the rollout are the same
 * action, and the reason is recorded next to it.
 *
 * The comparison is recomputed here rather than trusted from the request body.
 * The client already knows the answer, but a release justified by numbers the
 * client supplied is a release justified by nothing.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const abTestId = Number(id);
  if (!Number.isInteger(abTestId) || abTestId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const body = await request.json().catch(() => null);
    const variant = body?.variant;
    const reason = typeof body?.reason === "string" ? body.reason.trim() : null;

    if (variant !== "A" && variant !== "B") {
      return NextResponse.json({ error: "variant must be A or B" }, { status: 400 });
    }

    const test = await prisma.aBTest.findUnique({
      where: { id: abTestId },
      include: {
        variantA: { select: { id: true, version: true } },
        variantB: { select: { id: true, version: true } },
      },
    });
    if (!test) return NextResponse.json({ error: "not found" }, { status: 404 });

    const winner = variant === "A" ? test.variantA : test.variantB;

    // Snapshotted because retention will eventually delete the traces behind
    // these numbers, and a promotion has to keep explaining itself afterwards.
    const metrics = await variantComparison(abTestId);
    const evidence = {
      abTestId,
      testName: test.name,
      promotedVariant: variant,
      capturedAt: new Date().toISOString(),
      variants: metrics,
    };

    const release = await createRelease({
      promptId: winner.id,
      source: ReleaseSource.AB_TEST_WINNER,
      reason:
        reason ||
        `Won "${test.name}" as variant ${variant} (v${winner.version}).`,
      abTestId,
      evidence,
    });

    if (!release.ok) {
      return NextResponse.json({ error: release.error }, { status: release.status });
    }

    // A promoted test has served its purpose; leaving it running would keep
    // splitting traffic against the version that just won.
    if (test.status === "ACTIVE") {
      await prisma.aBTest.update({
        where: { id: abTestId },
        data: { status: "STOPPED", endedAt: new Date() },
      });
    }

    return NextResponse.json(
      { release: release.release, testStopped: test.status === "ACTIVE" },
      { status: 201 }
    );
  } catch (error) {
    console.error("promote winner failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
