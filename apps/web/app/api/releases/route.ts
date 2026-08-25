import { NextRequest, NextResponse } from "next/server";
import { ReleaseSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createRelease, liveReleases, normalizeActor } from "@/lib/releases";

const MAX_REASON_LENGTH = 500;

function isSource(value: unknown): value is ReleaseSource {
  return typeof value === "string" && value in ReleaseSource;
}

/**
 * Promotes a prompt version by hand.
 *
 * Deliberately unopinionated: it does not require the version to have won
 * anything. The A/B page only offers its button for a significant winner, but a
 * rollback at 3am must not be blocked by a statistics check.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const promptId = typeof body?.promptId === "number" ? body.promptId : NaN;
    const reason = typeof body?.reason === "string" ? body.reason.trim() : null;
    const source = isSource(body?.source) ? body.source : ReleaseSource.MANUAL;

    const actor = normalizeActor(body?.actor);
    if (actor instanceof RangeError) {
      return NextResponse.json({ error: actor.message }, { status: 400 });
    }

    if (!Number.isInteger(promptId) || promptId <= 0) {
      return NextResponse.json({ error: "promptId is required" }, { status: 400 });
    }
    if (reason !== null && reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { error: `reason must be at most ${MAX_REASON_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (source === ReleaseSource.AB_TEST_WINNER) {
      // That source is a claim about evidence, and this endpoint has none.
      return NextResponse.json(
        { error: "AB_TEST_WINNER releases are created via /api/ab-tests/[id]/promote" },
        { status: 400 }
      );
    }

    const result = await createRelease({ promptId, source, reason, actor });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.release, { status: 201 });
  } catch (error) {
    console.error("create release failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** Release history for one prompt, newest first, plus which one is live. */
export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name");
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const [history, live] = await Promise.all([
      prisma.promptRelease.findMany({
        where: { promptName: name },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        include: { prompt: { select: { version: true } } },
      }),
      liveReleases(name),
    ]);

    return NextResponse.json({
      liveReleaseId: live[0]?.releaseId ?? null,
      releases: history.map((r) => ({
        id: r.id,
        promptId: r.promptId,
        version: r.prompt.version,
        source: r.source,
        reason: r.reason,
        actor: r.actor,
        abTestId: r.abTestId,
        evidence: r.evidence,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("list releases failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
