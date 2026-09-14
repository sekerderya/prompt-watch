import { NextRequest, NextResponse } from "next/server";
import { compareModels, parseDays } from "@/lib/modelComparison";

/** Matches the traces column cap, so a filter cannot exceed a stored value. */
const MAX_MODEL_LENGTH = 128;

function parseModel(raw: string | null): string | null | RangeError {
  if (raw === null) return null;
  if (raw === "" || raw.length > MAX_MODEL_LENGTH) {
    return new RangeError(`model names must be 1-${MAX_MODEL_LENGTH} characters`);
  }
  return raw;
}

/**
 * Compares the models serving one prompt.
 *
 * The comparison itself lives in lib/modelComparison because it is the same
 * machinery ADR-6 and ADR-14 use; only the axis differs. Answering "should we
 * move to the cheaper model" is the question this endpoint exists for, and the
 * honest caveat travels with it: nothing here randomised which call went to
 * which model, so a difference is grounds for a controlled test rather than a
 * conclusion.
 */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const promptName = params.get("promptName");
    if (!promptName) {
      return NextResponse.json({ error: "promptName is required" }, { status: 400 });
    }

    const a = parseModel(params.get("a"));
    if (a instanceof RangeError) {
      return NextResponse.json({ error: a.message }, { status: 400 });
    }
    const b = parseModel(params.get("b"));
    if (b instanceof RangeError) {
      return NextResponse.json({ error: b.message }, { status: 400 });
    }

    const comparison = await compareModels(promptName, {
      days: parseDays(params.get("days")),
      a,
      b,
    });
    return NextResponse.json({ ...comparison, observational: true });
  } catch (error) {
    console.error("model comparison failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
