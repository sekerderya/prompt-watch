import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { POST as postTraces } from "@/app/api/traces/route";
import { POST as postOutcomes } from "@/app/api/outcomes/route";
import { GET as comparison } from "@/app/api/metrics/ab-test-comparison/route";
import { GET as summary } from "@/app/api/metrics/summary/route";
import { prisma } from "@/lib/prisma";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const traceRequest = (body: unknown) => post("http://localhost:3000/api/traces", body);
const outcomeRequest = (body: unknown) => post("http://localhost:3000/api/outcomes", body);

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

describe("POST /api/traces", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("stores a single trace", async () => {
    const prompt = await createPrompt("p", 1);

    const res = await postTraces(traceRequest(trace(prompt.id)));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: 1 });
    expect(await prisma.trace.count()).toBe(1);
  });

  it("stores a batch in one round trip", async () => {
    const prompt = await createPrompt("p", 1);

    const res = await postTraces(
      traceRequest([trace(prompt.id), trace(prompt.id), trace(prompt.id)])
    );

    expect(await res.json()).toEqual({ created: 3 });
    expect(await prisma.trace.count()).toBe(3);
  });

  it("rejects the whole batch when one entry is invalid", async () => {
    const prompt = await createPrompt("p", 1);

    const res = await postTraces(
      traceRequest([trace(prompt.id), trace(prompt.id, { status: "MAYBE" })])
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/trace\[1\]/);
    // Nothing partially written.
    expect(await prisma.trace.count()).toBe(0);
  });

  it("answers 400, not 500, for a promptId that does not exist", async () => {
    const res = await postTraces(traceRequest(trace(999999)));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not reference an existing row/);
  });

  it("records an ERROR trace, which the dashboard's error rate depends on", async () => {
    const prompt = await createPrompt("p", 1);

    await postTraces(traceRequest(trace(prompt.id, { status: "ERROR" })));

    expect(await prisma.trace.count({ where: { status: "ERROR" } })).toBe(1);
  });

  it("persists clientTraceId so an outcome can be joined to it later", async () => {
    const prompt = await createPrompt("p", 1);

    await postTraces(traceRequest(trace(prompt.id, { clientTraceId: "abc-123" })));

    const stored = await prisma.trace.findFirst();
    expect(stored?.clientTraceId).toBe("abc-123");
  });

  it("ignores a replayed batch instead of failing on the duplicate id", async () => {
    const prompt = await createPrompt("p", 1);
    const payload = [trace(prompt.id, { clientTraceId: "dup-1" })];

    await postTraces(traceRequest(payload));
    const replay = await postTraces(traceRequest(payload));

    // A retry after a timeout must not blow up or double-count.
    expect(replay.status).toBe(201);
    expect(await prisma.trace.count()).toBe(1);
  });

  it("refuses an oversized batch", async () => {
    const prompt = await createPrompt("p", 1);
    const huge = Array.from({ length: 501 }, () => trace(prompt.id));

    expect((await postTraces(traceRequest(huge))).status).toBe(413);
  });

  it("marks pricingUnknown when the SDK could not price the model", async () => {
    const prompt = await createPrompt("p", 1);

    await postTraces(traceRequest(trace(prompt.id, { pricingUnknown: true })));

    expect(await prisma.trace.count({ where: { pricingUnknown: true } })).toBe(1);
  });
});

describe("POST /api/outcomes", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("records a score against a trace id", async () => {
    const res = await postOutcomes(
      outcomeRequest({ traceId: "t-1", score: 1, label: "thumbs_up" })
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ recorded: 1 });
  });

  it("accepts an outcome that arrives before its trace", async () => {
    // The SDK batches traces but sends outcomes directly, so this ordering is
    // normal rather than exceptional.
    await postOutcomes(outcomeRequest({ traceId: "early", score: 1 }));

    const prompt = await createPrompt("p", 1);
    await postTraces(traceRequest(trace(prompt.id, { clientTraceId: "early" })));

    const joined = await prisma.$queryRaw<{ score: number }[]>`
      SELECT o.score FROM traces t
      JOIN outcomes o ON o.client_trace_id = t.client_trace_id
    `;
    expect(joined).toHaveLength(1);
    expect(Number(joined[0].score)).toBe(1);
  });

  it("replaces the previous score rather than adding a second row", async () => {
    await postOutcomes(outcomeRequest({ traceId: "t-1", score: 0 }));
    await postOutcomes(outcomeRequest({ traceId: "t-1", score: 1, label: "revised" }));

    const rows = await prisma.outcome.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(1);
    expect(rows[0].label).toBe("revised");
  });

  it("collapses a repeated trace id inside one batch", async () => {
    const res = await postOutcomes(
      outcomeRequest([
        { traceId: "t-1", score: 0 },
        { traceId: "t-1", score: 1 },
      ])
    );

    expect(await res.json()).toEqual({ recorded: 1 });
    expect((await prisma.outcome.findMany())[0].score).toBe(1);
  });

  it("rejects a score outside 0..1 and writes nothing", async () => {
    const res = await postOutcomes(outcomeRequest({ traceId: "t-1", score: 7 }));

    expect(res.status).toBe(400);
    expect(await prisma.outcome.count()).toBe(0);
  });

  it("rejects a missing trace id and an over-long label", async () => {
    expect((await postOutcomes(outcomeRequest({ score: 1 }))).status).toBe(400);
    expect(
      (await postOutcomes(outcomeRequest({ traceId: "t", score: 1, label: "x".repeat(65) })))
        .status
    ).toBe(400);
  });
});

describe("GET /api/metrics/ab-test-comparison", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  async function seedTest() {
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
    return { a, b, test };
  }

  it("aggregates per variant with spread and counts", async () => {
    const { a, b, test } = await seedTest();

    await postTraces(
      traceRequest([
        trace(a.id, { abTestId: test.id, variant: "A", latencyMs: 100 }),
        trace(a.id, { abTestId: test.id, variant: "A", latencyMs: 300 }),
        trace(b.id, { abTestId: test.id, variant: "B", latencyMs: 200, status: "ERROR" }),
      ])
    );

    const rows = await (
      await comparison(
        new NextRequest(
          `http://localhost:3000/api/metrics/ab-test-comparison?id=${test.id}`
        )
      )
    ).json();

    const A = rows.find((r: { variant: string }) => r.variant === "A");
    const B = rows.find((r: { variant: string }) => r.variant === "B");

    expect(A.total).toBe(2);
    expect(A.avgLatency).toBe(200);
    expect(A.sdLatency).toBeCloseTo(141.42, 1);
    expect(B.errors).toBe(1);
    // A single row has no sample standard deviation.
    expect(B.sdLatency).toBeNull();
  });

  it("joins outcomes without multiplying the operational rows", async () => {
    const { a, b, test } = await seedTest();

    await postTraces(
      traceRequest([
        trace(a.id, { abTestId: test.id, variant: "A", clientTraceId: "a1" }),
        trace(a.id, { abTestId: test.id, variant: "A", clientTraceId: "a2" }),
        trace(b.id, { abTestId: test.id, variant: "B", clientTraceId: "b1" }),
      ])
    );
    await postOutcomes(
      outcomeRequest([
        { traceId: "a1", score: 0 },
        { traceId: "a2", score: 0 },
        { traceId: "b1", score: 1 },
      ])
    );

    const rows = await (
      await comparison(
        new NextRequest(
          `http://localhost:3000/api/metrics/ab-test-comparison?id=${test.id}`
        )
      )
    ).json();

    const A = rows.find((r: { variant: string }) => r.variant === "A");
    const B = rows.find((r: { variant: string }) => r.variant === "B");

    // The left join must not inflate `total`.
    expect(A.total).toBe(2);
    expect(A.scored).toBe(2);
    expect(A.avgScore).toBe(0);
    expect(B.avgScore).toBe(1);
  });

  it("reports zero scored when no outcomes exist", async () => {
    const { a, test } = await seedTest();
    await postTraces(traceRequest(trace(a.id, { abTestId: test.id, variant: "A" })));

    const rows = await (
      await comparison(
        new NextRequest(
          `http://localhost:3000/api/metrics/ab-test-comparison?id=${test.id}`
        )
      )
    ).json();

    expect(rows[0].scored).toBe(0);
    expect(rows[0].avgScore).toBeNull();
  });

  it("rejects a non-numeric id", async () => {
    const res = await comparison(
      new NextRequest("http://localhost:3000/api/metrics/ab-test-comparison?id=abc")
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/metrics/summary", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("rolls up cost, errors, unpriced traces and quality per day", async () => {
    const prompt = await createPrompt("p", 1);

    await postTraces(
      traceRequest([
        trace(prompt.id, { costUsd: 0.001, clientTraceId: "s1" }),
        trace(prompt.id, { costUsd: 0.002, status: "ERROR" }),
        trace(prompt.id, { costUsd: 0.003, pricingUnknown: true }),
      ])
    );
    await postOutcomes(outcomeRequest({ traceId: "s1", score: 1 }));

    const [today] = await (
      await summary(new NextRequest("http://localhost:3000/api/metrics/summary?days=7"))
    ).json();

    expect(today.total).toBe(3);
    expect(today.errors).toBe(1);
    expect(today.unpriced).toBe(1);
    expect(today.totalCost).toBeCloseTo(0.006, 6);
    expect(today.scored).toBe(1);
    expect(today.avgScore).toBe(1);
  });

  it("clamps an absurd or negative window instead of passing it through", async () => {
    const prompt = await createPrompt("p", 1);
    await postTraces(traceRequest(trace(prompt.id)));

    for (const days of ["999999", "-5", "abc", ""]) {
      const res = await summary(
        new NextRequest(`http://localhost:3000/api/metrics/summary?days=${days}`)
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
    }
  });
});
