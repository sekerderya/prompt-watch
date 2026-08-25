import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { POST as resolveRoute } from "@/app/api/prompts/resolve/route";
import { GET as listPrompts } from "@/app/api/prompts/route";
import { prisma } from "@/lib/prisma";
import { assertTestDatabase, resetDatabase } from "./helpers";

function resolveRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/prompts/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/prompts/resolve", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("creates version 1 for a prompt it has not seen", async () => {
    const res = await resolveRoute(
      resolveRequest({ name: "support", promptText: "v1 text", hash: "h1" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "support", version: 1 });
  });

  it("is idempotent: the same hash always resolves to the same row", async () => {
    const first = await (
      await resolveRoute(resolveRequest({ name: "support", promptText: "v1", hash: "h1" }))
    ).json();
    const second = await (
      await resolveRoute(resolveRequest({ name: "support", promptText: "v1", hash: "h1" }))
    ).json();

    expect(second).toEqual(first);
    expect(await prisma.prompt.count({ where: { name: "support" } })).toBe(1);
  });

  it("opens a new version when the prompt text changes", async () => {
    await resolveRoute(resolveRequest({ name: "support", promptText: "v1", hash: "h1" }));
    const second = await (
      await resolveRoute(resolveRequest({ name: "support", promptText: "v2", hash: "h2" }))
    ).json();

    expect(second.version).toBe(2);
  });

  it("versions each prompt name independently", async () => {
    await resolveRoute(resolveRequest({ name: "a", promptText: "x", hash: "hx" }));
    const b = await (
      await resolveRoute(resolveRequest({ name: "b", promptText: "y", hash: "hy" }))
    ).json();

    expect(b.version).toBe(1);
  });

  /**
   * The advisory lock in the resolve route is the project's most load-bearing
   * design decision, and until now nothing proved it worked. Without it, two
   * concurrent requests both read "latest version = N" and both try to write
   * N+1: one crashes on the unique constraint, or worse, two prompts share a
   * version number.
   */
  it("assigns unique consecutive versions under concurrent writes", async () => {
    const CONCURRENCY = 12;

    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        resolveRoute(resolveRequest({ name: "hot", promptText: `v${i}`, hash: `hash-${i}` }))
      )
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);

    const rows = await prisma.prompt.findMany({
      where: { name: "hot" },
      orderBy: { version: "asc" },
    });
    expect(rows).toHaveLength(CONCURRENCY);
    expect(rows.map((r) => r.version)).toEqual(
      Array.from({ length: CONCURRENCY }, (_, i) => i + 1)
    );
  });

  it("returns one shared row when the same hash races with itself", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveRoute(resolveRequest({ name: "same", promptText: "identical", hash: "one-hash" }))
      )
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(await prisma.prompt.count({ where: { name: "same" } })).toBe(1);
  });

  it("rejects a request missing name or hash", async () => {
    expect((await resolveRoute(resolveRequest({ promptText: "x", hash: "h" }))).status).toBe(400);
    expect((await resolveRoute(resolveRequest({ name: "x", promptText: "y" }))).status).toBe(400);
  });
});

describe("GET /api/prompts", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("returns versions newest first", async () => {
    for (let v = 1; v <= 3; v++) {
      await resolveRoute(resolveRequest({ name: "p", promptText: `v${v}`, hash: `h${v}` }));
    }

    const res = await listPrompts(new NextRequest("http://localhost:3000/api/prompts?name=p"));
    const body = await res.json();

    expect(body.map((p: { version: number }) => p.version)).toEqual([3, 2, 1]);
  });

  it("pages results so an old prompt cannot return an unbounded list", async () => {
    for (let v = 1; v <= 5; v++) {
      await resolveRoute(resolveRequest({ name: "p", promptText: `v${v}`, hash: `h${v}` }));
    }

    const page = await listPrompts(
      new NextRequest("http://localhost:3000/api/prompts?name=p&limit=2&offset=1")
    );
    const body = await page.json();

    expect(body).toHaveLength(2);
    expect(body.map((p: { version: number }) => p.version)).toEqual([4, 3]);
  });

  it("requires a name", async () => {
    const res = await listPrompts(new NextRequest("http://localhost:3000/api/prompts"));
    expect(res.status).toBe(400);
  });
});
