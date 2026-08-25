import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { POST as createTest, GET as listTests } from "@/app/api/ab-tests/route";
import { PATCH as patchTest } from "@/app/api/ab-tests/[id]/route";
import { GET as activeTests } from "@/app/api/ab-tests/active/route";
import { prisma } from "@/lib/prisma";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/ab-tests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(id: number, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3000/api/ab-tests/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: { params: Promise.resolve({ id: String(id) }) },
  };
}

async function seedVariants() {
  const a = await createPrompt("support", 1, "formal");
  const b = await createPrompt("support", 2, "friendly");
  return { a, b };
}

describe("POST /api/ab-tests", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("creates an active test for two versions of the same prompt", async () => {
    const { a, b } = await seedVariants();

    const res = await createTest(
      postRequest({
        name: "tone",
        promptName: "support",
        variantAId: a.id,
        variantBId: b.id,
        splitPercent: 40,
      })
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "ACTIVE", splitPercent: 40, endedAt: null });
  });

  it("rejects a prompt compared against itself", async () => {
    const { a } = await seedVariants();

    const res = await createTest(
      postRequest({ name: "self", promptName: "support", variantAId: a.id, variantBId: a.id })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/different prompt versions/);
    expect(await prisma.aBTest.count()).toBe(0);
  });

  it("rejects a split percentage outside 0..100", async () => {
    const { a, b } = await seedVariants();

    for (const splitPercent of [-1, 101, 500, 12.5]) {
      const res = await createTest(
        postRequest({
          name: "x",
          promptName: "support",
          variantAId: a.id,
          variantBId: b.id,
          splitPercent,
        })
      );
      expect(res.status).toBe(400);
    }
  });

  it("rejects variants that belong to a different prompt", async () => {
    const { a } = await seedVariants();
    const other = await createPrompt("sales", 1);

    const res = await createTest(
      postRequest({ name: "x", promptName: "support", variantAId: a.id, variantBId: other.id })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/versions of the prompt/);
  });

  it("rejects variants that do not exist", async () => {
    const { a } = await seedVariants();

    const res = await createTest(
      postRequest({ name: "x", promptName: "support", variantAId: a.id, variantBId: 99999 })
    );

    expect(res.status).toBe(400);
  });

  it("refuses a second active test for the same prompt", async () => {
    const { a, b } = await seedVariants();
    await createTest(
      postRequest({ name: "first", promptName: "support", variantAId: a.id, variantBId: b.id })
    );

    const res = await createTest(
      postRequest({ name: "second", promptName: "support", variantAId: a.id, variantBId: b.id })
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already has an active test/);
    expect(await prisma.aBTest.count({ where: { status: "ACTIVE" } })).toBe(1);
  });

  /**
   * The duplicate check and the insert have to be atomic. Without the advisory
   * lock, concurrent creates all read "no active test" and all insert, leaving
   * the SDK's per-prompt cache to pick a winner by response ordering.
   */
  it("allows exactly one active test when creates race", async () => {
    const { a, b } = await seedVariants();

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createTest(
          postRequest({
            name: `race-${i}`,
            promptName: "support",
            variantAId: a.id,
            variantBId: b.id,
          })
        )
      )
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await prisma.aBTest.count({ where: { status: "ACTIVE" } })).toBe(1);
  });

  it("allows an active test per prompt, independently", async () => {
    const { a, b } = await seedVariants();
    const s1 = await createPrompt("sales", 1);
    const s2 = await createPrompt("sales", 2);

    await createTest(
      postRequest({ name: "support-test", promptName: "support", variantAId: a.id, variantBId: b.id })
    );
    const res = await createTest(
      postRequest({ name: "sales-test", promptName: "sales", variantAId: s1.id, variantBId: s2.id })
    );

    expect(res.status).toBe(201);
  });
});

describe("PATCH /api/ab-tests/[id]", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  async function createActive() {
    const { a, b } = await seedVariants();
    const res = await createTest(
      postRequest({ name: "tone", promptName: "support", variantAId: a.id, variantBId: b.id })
    );
    return { test: await res.json(), a, b };
  }

  it("stops a running test and stamps endedAt", async () => {
    const { test } = await createActive();
    const { request, context } = patchRequest(test.id, { status: "STOPPED" });

    const res = await patchTest(request, context);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("STOPPED");
    expect(body.endedAt).not.toBeNull();
  });

  it("drops a stopped test out of the SDK's active feed", async () => {
    const { test } = await createActive();
    expect(await (await activeTests()).json()).toHaveLength(1);

    const { request, context } = patchRequest(test.id, { status: "STOPPED" });
    await patchTest(request, context);

    expect(await (await activeTests()).json()).toHaveLength(0);
  });

  it("frees the prompt so a new test can be created", async () => {
    const { test, a, b } = await createActive();
    const { request, context } = patchRequest(test.id, { status: "STOPPED" });
    await patchTest(request, context);

    const res = await createTest(
      postRequest({ name: "next", promptName: "support", variantAId: a.id, variantBId: b.id })
    );
    expect(res.status).toBe(201);
  });

  it("restarts a stopped test and clears endedAt", async () => {
    const { test } = await createActive();
    const stop = patchRequest(test.id, { status: "STOPPED" });
    await patchTest(stop.request, stop.context);

    const start = patchRequest(test.id, { status: "ACTIVE" });
    const body = await (await patchTest(start.request, start.context)).json();

    expect(body.status).toBe("ACTIVE");
    expect(body.endedAt).toBeNull();
  });

  it("refuses to restart into a conflict with another active test", async () => {
    const { test, a, b } = await createActive();
    const stop = patchRequest(test.id, { status: "STOPPED" });
    await patchTest(stop.request, stop.context);
    await createTest(
      postRequest({ name: "replacement", promptName: "support", variantAId: a.id, variantBId: b.id })
    );

    const restart = patchRequest(test.id, { status: "ACTIVE" });
    const res = await patchTest(restart.request, restart.context);

    expect(res.status).toBe(409);
  });

  it("rejects an unknown status and an unknown id", async () => {
    const { test } = await createActive();

    const bad = patchRequest(test.id, { status: "PAUSED" });
    expect((await patchTest(bad.request, bad.context)).status).toBe(400);

    const missing = patchRequest(999999, { status: "STOPPED" });
    expect((await patchTest(missing.request, missing.context)).status).toBe(404);
  });
});

describe("GET /api/ab-tests", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("filters by status and rejects an invalid one", async () => {
    const { a, b } = await seedVariants();
    await createTest(
      postRequest({ name: "tone", promptName: "support", variantAId: a.id, variantBId: b.id })
    );

    const active = await listTests(
      new NextRequest("http://localhost:3000/api/ab-tests?status=ACTIVE")
    );
    expect(await active.json()).toHaveLength(1);

    const stopped = await listTests(
      new NextRequest("http://localhost:3000/api/ab-tests?status=STOPPED")
    );
    expect(await stopped.json()).toHaveLength(0);

    const invalid = await listTests(
      new NextRequest("http://localhost:3000/api/ab-tests?status=WHATEVER")
    );
    expect(invalid.status).toBe(400);
  });

  it("exposes the variant prompt text the SDK needs to serve", async () => {
    const { a, b } = await seedVariants();
    await createTest(
      postRequest({ name: "tone", promptName: "support", variantAId: a.id, variantBId: b.id })
    );

    const [test] = await (await activeTests()).json();

    expect(test.variantAText).toBe("formal");
    expect(test.variantBText).toBe("friendly");
    expect(test.splitPercent).toBe(50);
  });
});
