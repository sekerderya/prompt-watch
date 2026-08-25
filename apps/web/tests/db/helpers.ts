import { prisma } from "@/lib/prisma";

/**
 * These tests truncate every table, so they must never be pointed at a real
 * database. The name check is the guard: CI and local runs both use a database
 * whose name ends in `_test`, and anything else is refused outright rather than
 * wiped.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error("DATABASE_URL is not set; database tests need one.");
  }
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to run destructive tests against database "${dbName}". ` +
        `Point DATABASE_URL at a throwaway database whose name ends with "_test".`
    );
  }
}

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "outcomes", "traces", "ab_tests", "prompts" RESTART IDENTITY CASCADE'
  );
}

export async function createPrompt(
  name: string,
  version: number,
  text = `prompt ${version}`
) {
  return prisma.prompt.create({
    data: { name, version, promptText: text, promptHash: `${name}-hash-${version}` },
  });
}

/** Builds a Request the App Router handlers accept. */
export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
