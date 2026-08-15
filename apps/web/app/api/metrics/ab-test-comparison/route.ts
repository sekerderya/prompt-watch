import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

interface ComparisonRow {
  variant: string | null;
  avg_latency: number;
  avg_cost: number;
  total: number;
  errors: number;
}

export async function GET(request: NextRequest) {
  try {
    const idParam = request.nextUrl.searchParams.get("id");
    const abTestId = Number(idParam);
    if (!Number.isInteger(abTestId)) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const rows = await prisma.$queryRaw<ComparisonRow[]>`
      SELECT variant,
             AVG(latency_ms) AS avg_latency,
             AVG(cost_usd) AS avg_cost,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'ERROR') AS errors
      FROM traces
      WHERE ab_test_id = ${abTestId}
      GROUP BY variant
    `;

    const data = rows.map((r) => ({
      variant: r.variant,
      avgLatency: Number(r.avg_latency),
      avgCost: Number(r.avg_cost),
      total: Number(r.total),
      errors: Number(r.errors),
    }));

    return NextResponse.json(data);
  } catch (error) {
    console.error("ab-test comparison failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}