import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { GET as health } from "@/app/api/health/route";
import { GET as overview } from "@/app/api/prompts/overview/route";
import { GET as promptMetrics } from "@/app/api/metrics/prompt/route";
import { POST as postTraces } from "@/app/api/traces/route";
import { POST as postOutcomes } from "@/app/api/outcomes/route";
import { prisma } from "@/lib/prisma";
import { applyRetention, retentionDays } from "@/lib/retention";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const traceRequest = (b: unknown) => post("http://localhost:3000/api/traces", b);
const outcomeRequest = (b: unknown) => post("http://localhost:3000/api/outcomes", b);

function trace(promptId: number, overrides: Record<string, unknown> = {}) {
  return {
    promptId,
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.001,
    status: "SUCCESS",
    ...overrides,
  };
}

describe("GET /api/health", () => {
  beforeAll(assertTestDatabase);

  it("reports ok while the database is reachable", async () => {
    const res = await health();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.database).toBe("up");
    expect(typeof body.latencyMs).toBe("number");
  });
});

describe("GET /api/prompts/overview", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("lists every prompt with its version count and traffic", async () => {
    const supportV1 = await createPrompt("support", 1);
    await createPrompt("support", 2);
    const sales = await createPrompt("sales", 1);

    await postTraces(
      traceRequest([
        trace(supportV1.id, { clientTraceId: "s1" }),
        trace(supportV1.id, { status: "ERROR", errorType: "RATE_LIMIT" }),
        trace(sales.id),
      ])
    );
    await postOutcomes(outcomeRequest({ traceId: "s1", score: 1 }));

    const rows = await (
      await overview(new NextRequest("http://localhost:3000/api/prompts/overview?days=30"))
    ).json();

    const support = rows.find((r: { name: string }) => r.name === "support");
    expect(support.versions).toBe(2);
    expect(support.latestVersion).toBe(2);
    expect(support.total).toBe(2);
    expect(support.errors).toBe(1);
    expect(support.scored).toBe(1);
    expect(support.avgScore).toBe(1);
  });

  it("includes a prompt that has never been called", async () => {
    await createPrompt("unused", 1);

    const rows = await (
      await overview(new NextRequest("http://localhost:3000/api/prompts/overview"))
    ).json();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "unused", total: 0, lastSeen: null });
  });

  it("does not multiply rows when a prompt has both versions and outcomes", async () => {
    const v1 = await createPrompt("p", 1);
    const v2 = await createPrompt("p", 2);
    await postTraces(
      traceRequest([
        trace(v1.id, { clientTraceId: "a" }),
        trace(v2.id, { clientTraceId: "b" }),
      ])
    );
    await postOutcomes(
      outcomeRequest([
        { traceId: "a", score: 1 },
        { traceId: "b", score: 0 },
      ])
    );

    const rows = await (
      await overview(new NextRequest("http://localhost:3000/api/prompts/overview"))
    ).json();

    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(2);
    expect(rows[0].avgScore).toBe(0.5);
  });
});

describe("GET /api/metrics/prompt", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("breaks metrics down per version", async () => {
    const v1 = await createPrompt("support", 1);
    const v2 = await createPrompt("support", 2);

    await postTraces(
      traceRequest([
        trace(v1.id, { latencyMs: 400 }),
        trace(v1.id, { latencyMs: 200 }),
        trace(v2.id, { latencyMs: 100, clientTraceId: "fast" }),
      ])
    );
    await postOutcomes(outcomeRequest({ traceId: "fast", score: 1 }));

    const body = await (
      await promptMetrics(
        new NextRequest("http://localhost:3000/api/metrics/prompt?name=support")
      )
    ).json();

    const byVersion = Object.fromEntries(
      body.versions.map((v: { version: number }) => [v.version, v])
    );
    expect(byVersion[1].total).toBe(2);
    expect(byVersion[1].avgLatency).toBe(300);
    expect(byVersion[2].scored).toBe(1);
    expect(byVersion[2].avgScore).toBe(1);
  });

  it("groups failures by cause, which an error rate alone cannot show", async () => {
    const v1 = await createPrompt("support", 1);

    await postTraces(
      traceRequest([
        trace(v1.id, { status: "ERROR", errorType: "RATE_LIMIT" }),
        trace(v1.id, { status: "ERROR", errorType: "RATE_LIMIT" }),
        trace(v1.id, { status: "ERROR", errorType: "SERVER" }),
        trace(v1.id),
      ])
    );

    const body = await (
      await promptMetrics(
        new NextRequest("http://localhost:3000/api/metrics/prompt?name=support")
      )
    ).json();

    expect(body.errorBreakdown).toEqual([
      { errorType: "RATE_LIMIT", count: 2 },
      { errorType: "SERVER", count: 1 },
    ]);
  });

  it("coerces an unrecognised error category instead of rejecting the batch", async () => {
    const v1 = await createPrompt("support", 1);

    const res = await postTraces(
      traceRequest(trace(v1.id, { status: "ERROR", errorType: "SOMETHING_NEW" }))
    );

    expect(res.status).toBe(201);
    const stored = await prisma.trace.findFirst();
    expect(stored?.errorType).toBe("UNKNOWN");
  });

  it("leaves errorType null on a successful call", async () => {
    const v1 = await createPrompt("support", 1);
    await postTraces(traceRequest(trace(v1.id, { errorType: "RATE_LIMIT" })));

    const stored = await prisma.trace.findFirst();
    expect(stored?.errorType).toBeNull();
  });

  it("requires a name", async () => {
    const res = await promptMetrics(
      new NextRequest("http://localhost:3000/api/metrics/prompt")
    );
    expect(res.status).toBe(400);
  });
});

describe("retention", () => {
  const ORIGINAL_ENV = process.env;

  beforeAll(assertTestDatabase);
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await resetDatabase();
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function seedAged() {
    const prompt = await createPrompt("p", 1);
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

    await prisma.trace.createMany({
      data: [
        {
          promptId: prompt.id,
          latencyMs: 1,
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          status: "SUCCESS",
          clientTraceId: "old-1",
          createdAt: old,
        },
        {
          promptId: prompt.id,
          latencyMs: 1,
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
          status: "SUCCESS",
          clientTraceId: "new-1",
        },
      ],
    });
    await prisma.outcome.createMany({
      data: [
        { clientTraceId: "old-1", score: 1, createdAt: old, updatedAt: old },
        { clientTraceId: "new-1", score: 1 },
      ],
    });
    return prompt;
  }

  it("deletes telemetry past the window and keeps the rest", async () => {
    await seedAged();

    const result = await applyRetention(90);

    expect(result?.tracesDeleted).toBe(1);
    expect(await prisma.trace.count()).toBe(1);
    expect((await prisma.trace.findFirst())?.clientTraceId).toBe("new-1");
  });

  it("sweeps outcomes orphaned by the deletion, since there is no foreign key", async () => {
    await seedAged();

    const result = await applyRetention(90);

    expect(result?.orphanOutcomesDeleted).toBe(1);
    const remaining = await prisma.outcome.findMany();
    expect(remaining.map((o) => o.clientTraceId)).toEqual(["new-1"]);
  });

  it("never deletes prompts, which are configuration rather than telemetry", async () => {
    const prompt = await createPrompt("config", 1);
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await prisma.trace.create({
      data: {
        promptId: prompt.id,
        latencyMs: 1,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        status: "SUCCESS",
        createdAt: old,
      },
    });

    await applyRetention(90);

    // Every trace for this prompt aged out, and the prompt itself stayed —
    // a version is the thing a future trace refers to.
    expect(await prisma.trace.count()).toBe(0);
    expect(await prisma.prompt.count()).toBe(1);
  });

  it("does nothing when retention is disabled", async () => {
    await seedAged();

    expect(await applyRetention(null)).toBeNull();
    expect(await prisma.trace.count()).toBe(2);
  });

  it("reads the window from the environment and treats 0 as unlimited", () => {
    delete process.env.PROMPTWATCH_RETENTION_DAYS;
    expect(retentionDays()).toBe(90);

    process.env.PROMPTWATCH_RETENTION_DAYS = "30";
    expect(retentionDays()).toBe(30);

    process.env.PROMPTWATCH_RETENTION_DAYS = "0";
    expect(retentionDays()).toBeNull();

    process.env.PROMPTWATCH_RETENTION_DAYS = "not-a-number";
    expect(retentionDays()).toBeNull();
  });

  it("deletes in batches so a large purge is not one long transaction", async () => {
    const prompt = await createPrompt("bulk", 1);
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await prisma.trace.createMany({
      data: Array.from({ length: 120 }, () => ({
        promptId: prompt.id,
        latencyMs: 1,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        status: "SUCCESS" as const,
        createdAt: old,
      })),
    });

    const result = await applyRetention(90);

    expect(result?.tracesDeleted).toBe(120);
    expect(await prisma.trace.count()).toBe(0);
  });
});
