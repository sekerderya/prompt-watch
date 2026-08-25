import { NextRequest, NextResponse } from "next/server";
import { assessRelease } from "@/lib/regression";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * How a release is performing against the version it replaced.
 *
 * Shipping a prompt is where this tool stops observing and starts changing
 * things, so noticing a bad change is its obligation rather than the operator's.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const releaseId = Number(id);
  if (!Number.isInteger(releaseId) || releaseId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const lookbackParam = Number(request.nextUrl.searchParams.get("lookbackHours"));
    const lookbackHours =
      Number.isFinite(lookbackParam) && lookbackParam > 0
        ? Math.min(24 * 30, Math.floor(lookbackParam))
        : undefined;

    const report = await assessRelease(releaseId, { lookbackHours });
    if (!report) {
      // A first release has no predecessor; that is an answer, not an error.
      return NextResponse.json({ comparable: false, report: null });
    }
    return NextResponse.json({ comparable: true, report });
  } catch (error) {
    console.error("assess release failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
