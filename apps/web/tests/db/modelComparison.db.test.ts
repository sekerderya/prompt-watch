import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { GET as listTraces, POST as postTraces } from "@/app/api/traces/route";
import { POST as postOutcomes } from "@/app/api/outcomes/route";
import { GET as compare } from "@/app/api/metrics/model-comparison/route";
import { compareModels } from "@/lib/modelComparison";
import { assertTestDatabase, createPrompt, resetDatabase } from "./helpers";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

/** A batch of identical calls for one model, optionally each carrying an id. */
function batch(
  promptId: number,
  model: string,
  count: number,
  overrides: Record<string, unknown> = {},
  idPrefix?: string
) {
  return Array.from({ length: count }, (_, i) => ({
    ...trace(promptId, { model, ...overrides }),
    ...(idPrefix ? { clientTraceId: `${idPrefix}-${i}` } : {}),
  }));
}

async function send(rows: unknown[]) {
  // The route caps a batch at 500, which these fixtures stay well inside.
  const res = await postTraces(post("http://localhost:3000/api/traces", rows));
  expect(res.status).toBe(201);
}

describe("model comparison", () => {
  beforeAll(assertTestDatabase);
  beforeEach(resetDatabase);

  it("records which model served each call", async () => {
    const p = await createPrompt("support", 1);
    await send([trace(p.id, { model: "gpt-4o-mini" })]);

    const body = await (
      await listTraces(new NextRequest("http://localhost:3000/api/traces?promptName=support"))
    ).json();

    expect(body.traces[0].model).toBe("gpt-4o-mini");
  });

  it("filters the call list by model", async () => {
    const p = await createPrompt("support", 1);
    await send([
      trace(p.id, { model: "gpt-4o", latencyMs: 1 }),
      trace(p.id, { model: "gpt-4o-mini", latencyMs: 2 }),
    ]);

    const body = await (
      await listTraces(
        new NextRequest("http://localhost:3000/api/traces?promptName=support&model=gpt-4o-mini")
      )
    ).json();

    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].latencyMs).toBe(2);
  });

  it("leaves calls with no recorded model out rather than bucketing them", async () => {
    // Traces written by an SDK build from before the column existed. Folding
    // them into a named model would attribute calls to a model that may not
    // have served them.
    const p = await createPrompt("support", 1);
    await send([...batch(p.id, "gpt-4o", 3), ...Array.from({ length: 5 }, () => trace(p.id))]);

    const result = await compareModels("support");

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ model: "gpt-4o", total: 3 });
  });

  it("aggregates each model separately", async () => {
    const p = await createPrompt("support", 1);
    await send([
      ...batch(p.id, "gpt-4o", 4, { latencyMs: 200 }),
      ...batch(p.id, "gpt-4o-mini", 6, { latencyMs: 50 }),
    ]);

    const result = await compareModels("support");
    const byName = Object.fromEntries(result.models.map((m) => [m.model, m]));

    expect(byName["gpt-4o"].total).toBe(4);
    expect(byName["gpt-4o"].avgLatency).toBe(200);
    expect(byName["gpt-4o-mini"].total).toBe(6);
    expect(byName["gpt-4o-mini"].avgLatency).toBe(50);
    // Busiest first, so the default pair is the one anyone asking this means.
    expect(result.a).toBe("gpt-4o-mini");
    expect(result.b).toBe("gpt-4o");
  });

  it("refuses a verdict below the minimum sample size", async () => {
    // Three calls each is exactly the situation ADR-6 was written after: a
    // confident-looking badge on noise.
    const p = await createPrompt("support", 1);
    await send([
      ...batch(p.id, "gpt-4o", 3, { latencyMs: 900 }),
      ...batch(p.id, "gpt-4o-mini", 3, { latencyMs: 50 }),
    ]);

    const result = await compareModels("support");
    const latency = result.metrics.find((m) => m.metric === "latency")!;

    expect(latency.verdict.kind).toBe("insufficient-data");
    expect(result.metrics.some((m) => m.verdict.kind === "winner")).toBe(false);
  });

  it("names the better model once there is enough evidence", async () => {
    const p = await createPrompt("support", 1);
    // A little spread on each side: identical values give a zero standard
    // deviation, which is not a sample any real traffic produces.
    await send([
      ...batch(p.id, "gpt-4o", 20, { latencyMs: 900 }),
      ...batch(p.id, "gpt-4o", 20, { latencyMs: 940 }),
      ...batch(p.id, "gpt-4o-mini", 20, { latencyMs: 100 }),
      ...batch(p.id, "gpt-4o-mini", 20, { latencyMs: 140 }),
    ]);

    const result = await compareModels("support", { a: "gpt-4o-mini", b: "gpt-4o" });
    const latency = result.metrics.find((m) => m.metric === "latency")!;

    expect(latency.verdict).toMatchObject({ kind: "winner", winner: "A" });
    expect(result.a).toBe("gpt-4o-mini");
  });

  it("compares quality on the outcomes the host application reported", async () => {
    const p = await createPrompt("support", 1);
    await send([
      ...batch(p.id, "gpt-4o", 40, {}, "good"),
      ...batch(p.id, "gpt-4o-mini", 40, {}, "bad"),
    ]);
    for (let i = 0; i < 40; i++) {
      await postOutcomes(
        post("http://localhost:3000/api/outcomes", {
          traceId: `good-${i}`,
          score: i % 2 === 0 ? 0.9 : 1,
        })
      );
      await postOutcomes(
        post("http://localhost:3000/api/outcomes", {
          traceId: `bad-${i}`,
          score: i % 2 === 0 ? 0.2 : 0.3,
        })
      );
    }

    const result = await compareModels("support", { a: "gpt-4o", b: "gpt-4o-mini" });
    const quality = result.metrics.find((m) => m.metric === "quality")!;

    expect(quality.verdict).toMatchObject({ kind: "winner", winner: "A" });
  });

  it("will not compare cost when either model is priced by estimate", async () => {
    // ADR-7: the fallback rate is the same constant for every unknown model, so
    // testing two guesses against each other would produce a confident result
    // about nothing. The other metrics are unaffected.
    const p = await createPrompt("support", 1);
    await send([
      ...batch(p.id, "gpt-4o", 40, { latencyMs: 900, costUsd: 0.01 }),
      ...batch(p.id, "brand-new-model", 40, {
        latencyMs: 100,
        costUsd: 0.002,
        pricingUnknown: true,
      }),
    ]);

    const result = await compareModels("support", { a: "brand-new-model", b: "gpt-4o" });
    const cost = result.metrics.find((m) => m.metric === "cost")!;
    const latency = result.metrics.find((m) => m.metric === "latency")!;

    expect(cost.verdict).toMatchObject({ kind: "estimated", unpricedA: 40, unpricedB: 0 });
    // The absence of a cost verdict must not suppress the ones that are measured.
    expect(latency.verdict).toMatchObject({ kind: "winner", winner: "A" });
  });

  it("answers with nothing to compare when only one model has served the prompt", async () => {
    const p = await createPrompt("support", 1);
    await send(batch(p.id, "gpt-4o", 5));

    const result = await compareModels("support");

    expect(result.a).toBe("gpt-4o");
    expect(result.b).toBeNull();
    expect(result.metrics).toEqual([]);
  });

  it("requires a prompt name and rejects an overlong model filter", async () => {
    const missing = await compare(
      new NextRequest("http://localhost:3000/api/metrics/model-comparison")
    );
    expect(missing.status).toBe(400);

    const tooLong = await compare(
      new NextRequest(
        `http://localhost:3000/api/metrics/model-comparison?promptName=support&a=${"x".repeat(129)}`
      )
    );
    expect(tooLong.status).toBe(400);
  });
});
