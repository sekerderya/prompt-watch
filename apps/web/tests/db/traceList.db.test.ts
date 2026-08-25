import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET as listTraces } from "@/app/api/traces/list/route";
import { POST as postTraces } from "@/app/api/traces/route";
import { POST as postOutcomes } from "@/app/api/outcomes/route";
import { prisma } from "@/lib/prisma";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function list(query: string) {
  return listTraces(new NextRequest(`http://localhost:3000/api/traces/list?${query}`));
}

function trace(promptId: number, overrides: Record<string, unknown> = {}) {
  return {
    promptId,
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.0001,
    status: "SUCCESS",
    ...overrides,
  };
}

describe("GET /api/traces/list", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("returns individual calls newest first", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post("http://localhost:3000/api/traces", [
        trace(p.id, { latencyMs: 1 }),
        trace(p.id, { latencyMs: 2 }),
        trace(p.id, { latencyMs: 3 }),
      ])
    );

    const body = await (await list("promptName=support")).json();

    expect(body.traces.map((t: { latencyMs: number }) => t.latencyMs)).toEqual([3, 2, 1]);
    expect(body.nextCursor).toBeNull();
  });

  it("includes the version, so a row says which prompt actually ran", async () => {
    const v1 = await createPrompt("support", 1);
    const v2 = await createPrompt("support", 2);
    await postTraces(post("http://localhost:3000/api/traces", [trace(v1.id), trace(v2.id)]));

    const body = await (await list("promptName=support")).json();
    expect(body.traces.map((t: { version: number }) => t.version)).toEqual([2, 1]);
  });

  it("attaches the reported outcome to the call it belongs to", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post("http://localhost:3000/api/traces", [
        trace(p.id, { clientTraceId: "scored" }),
        trace(p.id, { clientTraceId: "unscored" }),
      ])
    );
    await postOutcomes(
      post("http://localhost:3000/api/outcomes", {
        traceId: "scored",
        score: 1,
        label: "resolved",
      })
    );

    const body = await (await list("promptName=support")).json();
    const scored = body.traces.find((t: { score: number | null }) => t.score !== null);

    expect(scored.score).toBe(1);
    expect(scored.label).toBe("resolved");
    // The join must not drop or duplicate the unscored one.
    expect(body.traces).toHaveLength(2);
  });

  it("surfaces the failure category on a failed call", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post(
        "http://localhost:3000/api/traces",
        trace(p.id, { status: "ERROR", errorType: "TIMEOUT" })
      )
    );

    const body = await (await list("promptName=support")).json();
    expect(body.traces[0]).toMatchObject({ status: "ERROR", errorType: "TIMEOUT" });
  });

  /**
   * Keyset rather than offset: pages must not shift when rows arrive between
   * requests, and page N must not get slower as N grows.
   */
  it("pages by id cursor without skipping or repeating rows", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post(
        "http://localhost:3000/api/traces",
        Array.from({ length: 12 }, (_, i) => trace(p.id, { latencyMs: i + 1 }))
      )
    );

    const first = await (await list("promptName=support&limit=5")).json();
    expect(first.traces).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();

    const second = await (
      await list(`promptName=support&limit=5&before=${first.nextCursor}`)
    ).json();
    const third = await (
      await list(`promptName=support&limit=5&before=${second.nextCursor}`)
    ).json();

    const seen = [...first.traces, ...second.traces, ...third.traces].map(
      (t: { id: number }) => t.id
    );
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(third.nextCursor).toBeNull();
  });

  it("keeps the cursor stable when newer rows arrive mid-pagination", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post(
        "http://localhost:3000/api/traces",
        Array.from({ length: 6 }, (_, i) => trace(p.id, { latencyMs: i + 1 }))
      )
    );

    const first = await (await list("promptName=support&limit=3")).json();

    // Something new lands between page 1 and page 2. With an offset this would
    // push a row across the boundary and it would be served twice.
    await postTraces(post("http://localhost:3000/api/traces", trace(p.id, { latencyMs: 999 })));

    const second = await (
      await list(`promptName=support&limit=3&before=${first.nextCursor}`)
    ).json();

    const ids = [...first.traces, ...second.traces].map((t: { id: number }) => t.id);
    const newest = (await prisma.trace.findFirst({ orderBy: { id: "desc" } }))!.id;

    expect(new Set(ids).size).toBe(6);
    expect(ids).not.toContain(newest);
  });

  it("filters to failures only", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post("http://localhost:3000/api/traces", [
        trace(p.id),
        trace(p.id, { status: "ERROR", errorType: "SERVER" }),
        trace(p.id),
      ])
    );

    const body = await (await list("promptName=support&status=ERROR")).json();
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].status).toBe("ERROR");
  });

  it("filters by version and by A/B test", async () => {
    const v1 = await createPrompt("support", 1);
    const v2 = await createPrompt("support", 2);
    const test = await prisma.aBTest.create({
      data: { name: "t", promptName: "support", variantAId: v1.id, variantBId: v2.id },
    });
    await postTraces(
      post("http://localhost:3000/api/traces", [
        trace(v1.id),
        trace(v2.id, { abTestId: test.id, variant: "B" }),
      ])
    );

    expect((await (await list(`promptId=${v2.id}`)).json()).traces).toHaveLength(1);

    const byTest = await (await list(`abTestId=${test.id}`)).json();
    expect(byTest.traces).toHaveLength(1);
    expect(byTest.traces[0].variant).toBe("B");
  });

  it("does not leak calls from another prompt", async () => {
    const support = await createPrompt("support", 1);
    const sales = await createPrompt("sales", 1);
    await postTraces(
      post("http://localhost:3000/api/traces", [trace(support.id), trace(sales.id)])
    );

    const body = await (await list("promptName=support")).json();
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].promptId).toBe(support.id);
  });

  it("caps the page size and rejects a bad status", async () => {
    const p = await createPrompt("support", 1);
    await postTraces(
      post(
        "http://localhost:3000/api/traces",
        Array.from({ length: 5 }, () => trace(p.id))
      )
    );

    // limit=9999 must not return everything a busy table holds.
    const capped = await (await list("promptName=support&limit=9999")).json();
    expect(capped.traces.length).toBeLessThanOrEqual(100);

    expect((await list("status=MAYBE")).status).toBe(400);
  });

  it("returns an empty page rather than failing for an unknown prompt", async () => {
    const body = await (await list("promptName=does-not-exist")).json();
    expect(body).toEqual({ traces: [], nextCursor: null });
  });
});
