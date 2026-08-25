import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET as published } from "@/app/api/prompts/published/route";
import { POST as postRelease, GET as getReleases } from "@/app/api/releases/route";
import { PATCH as promote } from "@/app/api/ab-tests/[id]/promote/route";
import { POST as postTraces } from "@/app/api/traces/route";
import { POST as postOutcomes } from "@/app/api/outcomes/route";
import { prisma } from "@/lib/prisma";
import { liveReleases } from "@/lib/releases";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const releaseRequest = (b: unknown) => post("http://localhost:3000/api/releases", b);

function promoteRequest(id: number, body: unknown) {
  return {
    request: new NextRequest(`http://localhost:3000/api/ab-tests/${id}/promote`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: { params: Promise.resolve({ id: String(id) }) },
  };
}

describe("POST /api/releases", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("promotes a version and serves it to the SDK", async () => {
    const v1 = await createPrompt("support", 1, "formal");
    const v2 = await createPrompt("support", 2, "friendly");
    await postRelease(releaseRequest({ promptId: v2.id, reason: "nicer" }));

    const served = await (await published()).json();

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      promptName: "support",
      promptId: v2.id,
      version: 2,
      promptText: "friendly",
    });
    expect(v1.id).not.toBe(served[0].promptId);
  });

  it("serves nothing at all until something is released", async () => {
    await createPrompt("support", 1);
    expect(await (await published()).json()).toEqual([]);
  });

  /**
   * There is no `isCurrent` column: the live release is the newest row. This is
   * the behaviour that makes rollback an ordinary insert.
   */
  it("treats the newest release as live, so a rollback is just another insert", async () => {
    const v1 = await createPrompt("support", 1, "first");
    const v2 = await createPrompt("support", 2, "second");

    await postRelease(releaseRequest({ promptId: v1.id }));
    await postRelease(releaseRequest({ promptId: v2.id }));
    await postRelease(releaseRequest({ promptId: v1.id, source: "ROLLBACK" }));

    const [live] = await liveReleases("support");
    expect(live.version).toBe(1);
    // The history is intact: nothing was mutated to move the pointer.
    expect(await prisma.promptRelease.count()).toBe(3);
  });

  it("refuses to release the version that is already live", async () => {
    const v1 = await createPrompt("support", 1);
    await postRelease(releaseRequest({ promptId: v1.id }));

    const res = await postRelease(releaseRequest({ promptId: v1.id }));

    expect(res.status).toBe(409);
    expect(await prisma.promptRelease.count()).toBe(1);
  });

  it("keeps releases independent per prompt", async () => {
    const support = await createPrompt("support", 1, "s");
    const sales = await createPrompt("sales", 1, "x");
    await postRelease(releaseRequest({ promptId: support.id }));
    await postRelease(releaseRequest({ promptId: sales.id }));

    const served = await (await published()).json();
    expect(served.map((r: { promptName: string }) => r.promptName).sort()).toEqual([
      "sales",
      "support",
    ]);
  });

  it("rejects a version that does not exist", async () => {
    expect((await postRelease(releaseRequest({ promptId: 999999 }))).status).toBe(400);
  });

  it("refuses to fake an A/B-test justification", async () => {
    const v1 = await createPrompt("support", 1);
    const res = await postRelease(releaseRequest({ promptId: v1.id, source: "AB_TEST_WINNER" }));

    // That source is a claim about evidence this endpoint does not have.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/promote/);
  });

  it("returns history newest first with the live one marked", async () => {
    const v1 = await createPrompt("support", 1);
    const v2 = await createPrompt("support", 2);
    await postRelease(releaseRequest({ promptId: v1.id }));
    await postRelease(releaseRequest({ promptId: v2.id }));

    const body = await (
      await getReleases(new NextRequest("http://localhost:3000/api/releases?name=support"))
    ).json();

    expect(body.releases.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(body.releases[0].id).toBe(body.liveReleaseId);
  });
});

describe("PATCH /api/ab-tests/[id]/promote", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  async function seedTestWithTraffic() {
    const a = await createPrompt("support", 1, "formal");
    const b = await createPrompt("support", 2, "friendly");
    const test = await prisma.aBTest.create({
      data: {
        name: "tone",
        promptName: "support",
        variantAId: a.id,
        variantBId: b.id,
        splitPercent: 50,
      },
    });

    await postTraces(
      post("http://localhost:3000/api/traces", [
        {
          promptId: a.id,
          abTestId: test.id,
          variant: "A",
          latencyMs: 100,
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          status: "SUCCESS",
          clientTraceId: "a1",
        },
        {
          promptId: b.id,
          abTestId: test.id,
          variant: "B",
          latencyMs: 100,
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          status: "SUCCESS",
          clientTraceId: "b1",
        },
      ])
    );
    await postOutcomes(
      post("http://localhost:3000/api/outcomes", [
        { traceId: "a1", score: 0 },
        { traceId: "b1", score: 1 },
      ])
    );
    return { a, b, test };
  }

  it("releases the winning variant and stops the test", async () => {
    const { b, test } = await seedTestWithTraffic();
    const { request, context } = promoteRequest(test.id, { variant: "B" });

    const res = await promote(request, context);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.testStopped).toBe(true);
    expect(body.release.promptId).toBe(b.id);
    expect(body.release.source).toBe("AB_TEST_WINNER");
    expect((await prisma.aBTest.findUnique({ where: { id: test.id } }))?.status).toBe("STOPPED");
  });

  /**
   * Retention will eventually delete the traces these numbers came from, so the
   * release has to keep explaining itself without them.
   */
  it("snapshots the comparison as evidence", async () => {
    const { test } = await seedTestWithTraffic();
    const { request, context } = promoteRequest(test.id, { variant: "B" });

    const body = await (await promote(request, context)).json();
    const evidence = body.release.evidence;

    expect(evidence.abTestId).toBe(test.id);
    expect(evidence.promotedVariant).toBe("B");
    expect(evidence.variants).toHaveLength(2);
    const b = evidence.variants.find((v: { variant: string }) => v.variant === "B");
    expect(b.avgScore).toBe(1);
    expect(b.scored).toBe(1);
  });

  it("computes the evidence server-side rather than trusting the caller", async () => {
    const { test } = await seedTestWithTraffic();
    const { request, context } = promoteRequest(test.id, {
      variant: "B",
      evidence: { variants: [{ variant: "B", avgScore: 0.999 }] },
      reason: "custom reason",
    });

    const body = await (await promote(request, context)).json();

    expect(body.release.reason).toBe("custom reason");
    // The fabricated evidence in the body was ignored.
    expect(body.release.evidence.variants).toHaveLength(2);
  });

  it("makes the promoted version immediately servable", async () => {
    const { b, test } = await seedTestWithTraffic();
    const { request, context } = promoteRequest(test.id, { variant: "B" });
    await promote(request, context);

    const served = await (await published()).json();
    expect(served[0].promptId).toBe(b.id);
    expect(served[0].promptText).toBe("friendly");
  });

  it("frees the prompt so a follow-up test can be created", async () => {
    const { test } = await seedTestWithTraffic();
    const { request, context } = promoteRequest(test.id, { variant: "B" });
    await promote(request, context);

    expect(
      await prisma.aBTest.count({ where: { promptName: "support", status: "ACTIVE" } })
    ).toBe(0);
  });

  it("rejects an unknown variant or test", async () => {
    const { test } = await seedTestWithTraffic();

    const bad = promoteRequest(test.id, { variant: "C" });
    expect((await promote(bad.request, bad.context)).status).toBe(400);

    const missing = promoteRequest(999999, { variant: "A" });
    expect((await promote(missing.request, missing.context)).status).toBe(404);
  });

  it("refuses to promote a variant that is already live", async () => {
    const { b, test } = await seedTestWithTraffic();
    await postRelease(releaseRequest({ promptId: b.id }));

    const { request, context } = promoteRequest(test.id, { variant: "B" });
    const res = await promote(request, context);

    expect(res.status).toBe(409);
    // The test must not have been stopped by a promotion that did not happen.
    expect((await prisma.aBTest.findUnique({ where: { id: test.id } }))?.status).toBe("ACTIVE");
  });
});
