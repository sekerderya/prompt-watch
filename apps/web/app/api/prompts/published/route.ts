import { NextResponse } from "next/server";
import { liveReleases } from "@/lib/releases";

/** The SDK polls this; a cached answer would delay every rollout and rollback. */
export const dynamic = "force-dynamic";

/**
 * The prompt text the SDK should serve, per prompt name.
 *
 * Shaped for the SDK rather than for a human: just enough to substitute a
 * prompt and attribute the trace to the right version. An empty array is the
 * normal state for an installation that only observes — nothing is overridden
 * until someone promotes a version.
 */
export async function GET() {
  try {
    const releases = await liveReleases();
    return NextResponse.json(
      releases.map((r) => ({
        promptName: r.promptName,
        promptId: r.promptId,
        version: r.version,
        promptText: r.promptText,
        releaseId: r.releaseId,
      }))
    );
  } catch (error) {
    console.error("published prompts failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
