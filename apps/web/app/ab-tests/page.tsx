"use client";

import { useCallback, useEffect, useState } from "react";
import { VariantBadge, StatusBadge } from "../components/Badge";
import EmptyState from "../components/EmptyState";
import {
  MIN_SAMPLES_PER_VARIANT,
  decideVerdict,
  twoProportionZTest,
  welchTTest,
  type SampleSummary,
  type Verdict,
} from "@/lib/stats";

interface ABTest {
  id: number;
  name: string;
  promptName: string;
  variantAId: number;
  variantBId: number;
  splitPercent: number;
  status: "ACTIVE" | "STOPPED";
  createdAt: string;
  endedAt: string | null;
  variantA?: { promptText: string; version: number };
  variantB?: { promptText: string; version: number };
}

interface PromptVersion {
  id: number;
  name: string;
  version: number;
  promptText: string;
}

interface VariantMetrics {
  variant: string | null;
  avgLatency: number | null;
  sdLatency: number | null;
  avgCost: number | null;
  sdCost: number | null;
  total: number;
  errors: number;
  unpriced: number;
}

function fmt(v: number | null | undefined, digits = 2): string {
  return v == null || Number.isNaN(v) ? "-" : v.toFixed(digits);
}

function errorRate(m: VariantMetrics | undefined): number {
  return m && m.total > 0 ? (m.errors / m.total) * 100 : 0;
}

function sample(mean: number | null, sd: number | null, n: number): SampleSummary {
  return { mean, sd, n };
}

/** Latency and cost are continuous; error rate is a proportion. */
function latencyVerdict(a?: VariantMetrics, b?: VariantMetrics): Verdict {
  if (!a || !b) return { kind: "insufficient-data", needed: MIN_SAMPLES_PER_VARIANT, haveA: a?.total ?? 0, haveB: b?.total ?? 0 };
  return decideVerdict(
    welchTTest(sample(a.avgLatency, a.sdLatency, a.total), sample(b.avgLatency, b.sdLatency, b.total)),
    a.total,
    b.total
  );
}

function costVerdict(a?: VariantMetrics, b?: VariantMetrics): Verdict {
  if (!a || !b) return { kind: "insufficient-data", needed: MIN_SAMPLES_PER_VARIANT, haveA: a?.total ?? 0, haveB: b?.total ?? 0 };
  return decideVerdict(
    welchTTest(sample(a.avgCost, a.sdCost, a.total), sample(b.avgCost, b.sdCost, b.total)),
    a.total,
    b.total
  );
}

function errorVerdict(a?: VariantMetrics, b?: VariantMetrics): Verdict {
  if (!a || !b) return { kind: "insufficient-data", needed: MIN_SAMPLES_PER_VARIANT, haveA: a?.total ?? 0, haveB: b?.total ?? 0 };
  return decideVerdict(
    twoProportionZTest(a.errors, a.total, b.errors, b.total),
    a.total,
    b.total
  );
}

function VerdictNote({ verdict }: { verdict: Verdict }) {
  if (verdict.kind === "insufficient-data") {
    return (
      <span className="pw-subtle">
        needs {verdict.needed}/variant — have {verdict.haveA} vs {verdict.haveB}
      </span>
    );
  }
  if (verdict.kind === "inconclusive") {
    return <span className="pw-subtle">no significant difference (p = {verdict.pValue.toFixed(3)})</span>;
  }
  return <span className="pw-subtle">p = {verdict.pValue.toFixed(3)}</span>;
}

/**
 * Renders one metric row.
 *
 * A "winner" badge appears only when both arms cleared the minimum sample size
 * and the difference passed a significance test. Before that the numbers are
 * still shown, but neither side is styled as winning — the earlier version
 * crowned whichever average was lower, which with a handful of requests per arm
 * meant crowning noise.
 */
function MetricRow({
  label,
  verdict,
  valueA,
  valueB,
}: {
  label: string;
  verdict: Verdict;
  valueA: string;
  valueB: string;
}) {
  const winner = verdict.kind === "winner" ? verdict.winner : null;
  const cellClass = (side: "A" | "B") =>
    winner === null ? "pw-value" : winner === side ? "pw-value pw-value--winner" : "pw-value pw-value--loser";

  return (
    <tr>
      <td className="pw-compare__metric">
        {label}
        <div>
          <VerdictNote verdict={verdict} />
        </div>
      </td>
      <td className="pw-variant-head">
        <span className={cellClass("A")}>{valueA}</span>
        {winner === "A" && <span className="pw-badge pw-badge--winner">winner</span>}
      </td>
      <td className="pw-variant-head">
        <span className={cellClass("B")}>{valueB}</span>
        {winner === "B" && <span className="pw-badge pw-badge--winner">winner</span>}
      </td>
    </tr>
  );
}

export default function ABTestsPage() {
  const [tests, setTests] = useState<ABTest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<VariantMetrics[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [statusPending, setStatusPending] = useState(false);

  const [name, setName] = useState("");
  const [promptName, setPromptName] = useState("");
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [variantAId, setVariantAId] = useState<number | null>(null);
  const [variantBId, setVariantBId] = useState<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [formMsg, setFormMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const loadTests = useCallback(async () => {
    try {
      const res = await fetch("/api/ab-tests");
      if (res.ok) setTests(await res.json());
    } catch {
      /* the empty state already covers an unreachable backend */
    }
  }, []);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

  useEffect(() => {
    if (tests.length > 0 && selectedId === null) setSelectedId(tests[0].id);
  }, [tests, selectedId]);

  const loadMetrics = useCallback((testId: number) => {
    setMetricsLoading(true);
    return fetch(`/api/metrics/ab-test-comparison?id=${testId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: VariantMetrics[]) => setMetrics(data))
      .catch(() => setMetrics([]))
      .finally(() => setMetricsLoading(false));
  }, []);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    setMetricsLoading(true);
    fetch(`/api/metrics/ab-test-comparison?id=${selectedId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: VariantMetrics[]) => {
        if (!cancelled) setMetrics(data);
      })
      .catch(() => {
        if (!cancelled) setMetrics([]);
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!promptName.trim()) {
      setVersions([]);
      setVersionsLoading(false);
      return;
    }
    setVersionsLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/prompts?name=${encodeURIComponent(promptName)}`);
        if (res.ok) {
          const data: PromptVersion[] = await res.json();
          setVersions(data);
          // Default the two arms to *different* versions. Defaulting both to
          // data[0] meant the obvious path was comparing a prompt with itself.
          setVariantAId(data[0]?.id ?? null);
          setVariantBId(data[1]?.id ?? null);
        } else {
          setVersions([]);
        }
      } catch {
        setVersions([]);
      } finally {
        setVersionsLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [promptName]);

  const selected = tests.find((t) => t.id === selectedId) ?? null;
  const metricsA = metrics.find((m) => m.variant === "A");
  const metricsB = metrics.find((m) => m.variant === "B");
  const unpricedTotal = (metricsA?.unpriced ?? 0) + (metricsB?.unpriced ?? 0);

  // Creating a second active test for one prompt is rejected now, but rows
  // predating that rule can still be in the table. The SDK caches one test per
  // prompt name, so while this holds, which variant a user sees depends on
  // response ordering.
  const duplicateActivePrompts = Object.entries(
    tests
      .filter((t) => t.status === "ACTIVE")
      .reduce<Record<string, number>>((acc, t) => {
        acc[t.promptName] = (acc[t.promptName] ?? 0) + 1;
        return acc;
      }, {})
  )
    .filter(([, count]) => count > 1)
    .map(([prompt]) => prompt);

  async function setStatus(test: ABTest, status: "ACTIVE" | "STOPPED") {
    setStatusPending(true);
    setFormMsg(null);
    try {
      const res = await fetch(`/api/ab-tests/${test.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormMsg({ kind: "error", text: body.error ?? "Could not update the test" });
        return;
      }
      await loadTests();
      await loadMetrics(test.id);
    } catch {
      setFormMsg({ kind: "error", text: "Could not update the test" });
    } finally {
      setStatusPending(false);
    }
  }

  async function createTest() {
    setFormMsg(null);
    if (!name.trim() || !promptName.trim()) {
      setFormMsg({ kind: "error", text: "Please fill in all fields" });
      return;
    }
    if (versions.length < 2) {
      setFormMsg({
        kind: "error",
        text: `"${promptName.trim()}" needs at least two versions to run a test. Change the prompt text and send it again to create a second version.`,
      });
      return;
    }
    if (variantAId === null || variantBId === null) {
      setFormMsg({ kind: "error", text: "Pick a version for both variants" });
      return;
    }
    if (variantAId === variantBId) {
      setFormMsg({
        kind: "error",
        text: "Variant A and B must be different versions — comparing a prompt with itself has no winner.",
      });
      return;
    }
    try {
      const res = await fetch("/api/ab-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, promptName, variantAId, variantBId, splitPercent }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormMsg({ kind: "error", text: body.error ?? "Could not create test" });
        return;
      }
      setFormMsg({ kind: "success", text: "Test created" });
      setName("");
      setPromptName("");
      setVersions([]);
      setVariantAId(null);
      setVariantBId(null);
      setSelectedId(body.id ?? null);
      void loadTests();
    } catch {
      setFormMsg({ kind: "error", text: "Could not create test" });
    }
  }

  return (
    <>
      <div className="pw-page-head">
        <div>
          <h1 className="pw-h1">A/B Tests</h1>
          <p className="pw-page-head__desc">
            Compare two prompt versions side by side. A winner is declared only once both
            variants have enough traffic for the difference to be statistically significant.
          </p>
        </div>
      </div>

      {duplicateActivePrompts.length > 0 && (
        <p className="pw-alert pw-alert--warn">
          More than one test is active for {duplicateActivePrompts.join(", ")}. The SDK keeps one
          active test per prompt name, so it will use the most recently created one and ignore the
          rest. Stop the stale tests to make the behaviour unambiguous.
        </p>
      )}

      <div className="pw-card">
        <div className="pw-card__head">
          <h2 className="pw-h2">Tests</h2>
        </div>
        {tests.length === 0 ? (
          <EmptyState
            icon="⊙"
            title="No tests yet"
            body="Run the demo to generate an A/B test, or create one with the form below. Once prompts exist, pick the same prompt name you used."
            action="npm run demo"
          />
        ) : (
          <>
            <div className="pw-list">
              {tests.map((t) => (
                <button
                  key={t.id}
                  className={`pw-list__item${selectedId === t.id ? " pw-list__item--active" : ""}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className="pw-list__meta">
                    <span className="pw-list__name">{t.name}</span>
                    <span className="pw-list__date">
                      {t.promptName} · split {t.splitPercent}%
                    </span>
                  </span>
                  <StatusBadge status={t.status} />
                </button>
              ))}
            </div>

            {selected && (
              <div style={{ marginTop: "var(--pw-space-5)" }}>
                <div className="pw-card__head" style={{ marginBottom: "var(--pw-space-3)" }}>
                  <h2 className="pw-h2">{selected.name}</h2>
                  <span className="pw-actions">
                    <span className="pw-chip">
                      {selected.promptName} · {selected.createdAt.slice(0, 10)}
                    </span>
                    {selected.status === "ACTIVE" ? (
                      <button
                        className="pw-btn pw-btn--ghost"
                        disabled={statusPending}
                        onClick={() => setStatus(selected, "STOPPED")}
                      >
                        {statusPending ? "Stopping…" : "Stop test"}
                      </button>
                    ) : (
                      <button
                        className="pw-btn pw-btn--ghost"
                        disabled={statusPending}
                        onClick={() => setStatus(selected, "ACTIVE")}
                      >
                        {statusPending ? "Restarting…" : "Restart test"}
                      </button>
                    )}
                  </span>
                </div>

                {selected.status === "ACTIVE" && (
                  <p className="pw-subtle">
                    SDK instances pick this up within one polling interval (~30s).
                  </p>
                )}
                {selected.status === "STOPPED" && selected.endedAt && (
                  <p className="pw-subtle">Stopped on {selected.endedAt.slice(0, 10)}.</p>
                )}

                {metricsLoading ? (
                  <div className="pw-loading">Loading comparison…</div>
                ) : metrics.length === 0 ? (
                  <EmptyState
                    icon="⊙"
                    title="No metrics yet"
                    body="No requests have been bucketed to this test yet. Run the demo so the SDK sends traffic to both variants."
                    action="npm run demo"
                  />
                ) : (
                  <>
                    <table className="pw-compare">
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th className="pw-variant-head pw-variant-head--a">
                            <VariantBadge variant="a">
                              A · v{selected.variantA?.version ?? selected.variantAId}
                            </VariantBadge>
                          </th>
                          <th className="pw-variant-head pw-variant-head--b">
                            <VariantBadge variant="b">
                              B · v{selected.variantB?.version ?? selected.variantBId}
                            </VariantBadge>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <MetricRow
                          label="Avg. Latency"
                          verdict={latencyVerdict(metricsA, metricsB)}
                          valueA={`${fmt(metricsA?.avgLatency, 0)} ms`}
                          valueB={`${fmt(metricsB?.avgLatency, 0)} ms`}
                        />
                        <MetricRow
                          label="Avg. Cost"
                          verdict={costVerdict(metricsA, metricsB)}
                          valueA={`$${fmt(metricsA?.avgCost, 6)}`}
                          valueB={`$${fmt(metricsB?.avgCost, 6)}`}
                        />
                        <MetricRow
                          label="Error Rate"
                          verdict={errorVerdict(metricsA, metricsB)}
                          valueA={`${fmt(errorRate(metricsA), 1)}%`}
                          valueB={`${fmt(errorRate(metricsB), 1)}%`}
                        />
                        <tr>
                          <td className="pw-compare__metric">Requests</td>
                          <td className="pw-variant-head">
                            <span className="pw-value">{metricsA?.total ?? 0}</span>
                          </td>
                          <td className="pw-variant-head">
                            <span className="pw-value">{metricsB?.total ?? 0}</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    {unpricedTotal > 0 && (
                      <p className="pw-alert pw-alert--warn">
                        {unpricedTotal} of these traces used a model missing from the SDK&apos;s
                        pricing table, so their cost is an estimate. Add the model to
                        packages/sdk/src/pricing.ts for exact figures.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <section className="pw-card">
        <div className="pw-card__head">
          <h2 className="pw-h2">Create New A/B Test</h2>
        </div>
        <div className="pw-form">
          <div className="pw-field pw-form__full">
            <label htmlFor="ab-name">Test Name</label>
            <input
              id="ab-name"
              className="pw-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. tone-test"
            />
          </div>
          <div className="pw-field pw-form__full">
            <label htmlFor="ab-prompt">Prompt Name</label>
            <input
              id="ab-prompt"
              className="pw-input"
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
              placeholder="e.g. support-bot"
            />
            {versionsLoading && <span className="pw-subtle">Loading versions…</span>}
            {!versionsLoading && promptName.trim() && versions.length === 0 && (
              <span className="pw-alert pw-alert--error">
                No prompt versions found for &quot;{promptName.trim()}&quot;. Create the prompt
                first (e.g. via npm run demo) and check the exact name.
              </span>
            )}
            {!versionsLoading && versions.length === 1 && (
              <span className="pw-alert pw-alert--warn">
                &quot;{promptName.trim()}&quot; only has one version. Edit the prompt text and
                send it again to create a second one to test against.
              </span>
            )}
          </div>
          {versions.length > 1 && (
            <>
              <div className="pw-field">
                <label htmlFor="ab-variant-a">
                  Variant A <VariantBadge variant="a">A</VariantBadge>
                </label>
                <select
                  id="ab-variant-a"
                  className="pw-select"
                  value={variantAId ?? ""}
                  onChange={(e) => setVariantAId(Number(e.target.value))}
                >
                  {versions.map((v) => (
                    <option key={`a-${v.id}`} value={v.id}>
                      v{v.version} (id {v.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="pw-field">
                <label htmlFor="ab-variant-b">
                  Variant B <VariantBadge variant="b">B</VariantBadge>
                </label>
                <select
                  id="ab-variant-b"
                  className="pw-select"
                  value={variantBId ?? ""}
                  onChange={(e) => setVariantBId(Number(e.target.value))}
                >
                  {versions.map((v) => (
                    <option key={`b-${v.id}`} value={v.id}>
                      v{v.version} (id {v.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="pw-field">
                <label htmlFor="ab-split">Split % (Variant A)</label>
                <input
                  id="ab-split"
                  className="pw-input"
                  type="number"
                  min={0}
                  max={100}
                  value={splitPercent}
                  onChange={(e) => setSplitPercent(Number(e.target.value))}
                />
              </div>
            </>
          )}
          {variantAId !== null && variantAId === variantBId && (
            <span className="pw-alert pw-alert--error pw-form__full">
              Variant A and B are the same version. Pick two different ones.
            </span>
          )}
        </div>
        <div className="pw-form__actions">
          <button className="pw-btn" onClick={createTest}>
            Create Test
          </button>
          {formMsg && <span className={`pw-alert pw-alert--${formMsg.kind}`}>{formMsg.text}</span>}
        </div>
      </section>
    </>
  );
}
