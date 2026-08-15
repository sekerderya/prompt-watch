import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const prisma = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

interface SummaryRow {
  day: Date;
  total_cost: number;
  total: number;
  errors: number;
}

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get("days");
    const days = Number(daysParam) || 7;

    const rows = await prisma.$queryRaw<SummaryRow[]>`
      SELECT date_trunc('day', created_at) AS day,
             SUM(cost_usd) AS total_cost,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'ERROR') AS errors
      FROM traces
      WHERE created_at > now() - make_interval(days => ${days}::int)
      GROUP BY day ORDER BY day
    `;

    const data = rows.map((r) => ({
      day: r.day.toISOString(),
      totalCost: Number(r.total_cost),
      total: Number(r.total),
      errors: Number(r.errors),
    }));

    return NextResponse.json(data);
  } catch (error) {
    console.error("metrics summary failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}