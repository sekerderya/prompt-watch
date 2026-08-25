import { NextRequest, NextResponse } from "next/server";
import { variantComparison } from "@/lib/comparison";

/**
 * Per-variant aggregates for one A/B test.
 *
 * The query itself lives in lib/comparison so promotion can snapshot exactly
 * these numbers as its evidence; a release that disagreed with the dashboard
 * would be worse than no release record at all.
 */
export async function GET(request: NextRequest) {
  try {
    const abTestId = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isInteger(abTestId) || abTestId <= 0) {
      return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
    }
    return NextResponse.json(await variantComparison(abTestId));
  } catch (error) {
    console.error("ab-test comparison failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
