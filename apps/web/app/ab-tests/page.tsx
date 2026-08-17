"use client";

import { useCallback, useEffect, useState } from "react";
import { VariantBadge, StatusBadge } from "../components/Badge";
import EmptyState from "../components/EmptyState";

interface ABTest {
  id: number;
  name: string;
  promptName: string;
  variantAId: number;
  variantBId: number;
  splitPercent: number;
  status: string;
  createdAt: string;
  variantA?: { promptText: string };
  variantB?: { promptText: string };
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
  avgCost: number | null;
  total: number;
  errors: number;
}

const lowerIsBetter: Record<string, (a: VariantMetrics | undefined, b: VariantMetrics | undefined) => boolean> = {
  latency: (a, b) => (a?.avgLatency ?? Infinity) <= (b?.avgLatency ?? Infinity),
  cost: (a, b) => (a?.avgCost ?? Infinity) <= (b?.avgCost ?? Infinity),
  errors: (a, b) => errorRate(a) <= errorRate(b),
};

function fmt(v: number | null | undefined, digits = 2): string {
  return v == null || Number.isNaN(v) ? "-" : v.toFixed(digits);
}

function errorRate(m: VariantMetrics | undefined): number {
  return m && m.total > 0 ? (m.errors / m.total) * 100 : 0;
}

export default function ABTestsPage() {
  const [tests, setTests] = useState<ABTest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<VariantMetrics[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const [name, setName] = useState("");
  const [promptName, setPromptName] = useState("");
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [variantAId, setVariantAId] = useState<number | null>(null);
  const [variantBId, setVariantBId] = useState<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [formMsg, setFormMsg] = useState<{ kind: "error" | "success"; text: string } | null>(
    null
  );

  const loadTests = useCallback(async () => {
    try {
      const res = await fetch("/api/ab-tests");
      if (res.ok) setTests(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

  useEffect(() => {
    if (tests.length > 0 && selectedId === null) setSelectedId(tests[0].id);
  }, [tests, selectedId]);

  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    setMetricsLoading(true);
    fetch(`/api/metrics/ab-test-comparison?id=${selectedId}`)
      .then((r) => r.json())
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
          const data = await res.json();
          setVersions(data);
          setVariantAId(data[0]?.id ?? null);
          setVariantBId(data[0]?.id ?? null);
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

  async function createTest() {
    setFormMsg(null);
    if (!name.trim() || !promptName.trim()) {
      setFormMsg({ kind: "error", text: "Please fill in all fields" });
      return;
    }
    if (variantAId === null || variantBId === null) {
      setFormMsg({
        kind: "error",
        text: `No prompt versions found for "${promptName.trim()}". Create the prompt first (e.g. via npm run demo) and check the exact name.`,
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
      void loadTests();
    } catch {
      setFormMsg({ kind: "error", text: "Could not create test" });
    }
  }

  function WinnerCell({
    a,
    b,
    winA,
    valueA,
    valueB,
  }: {
    a: VariantMetrics | undefined;
    b: VariantMetrics | undefined;
    winA: boolean;
    valueA: string;
    valueB: string;
  }) {
    return (
      <>
        <td className="pw-variant-head">
          <span className={`pw-value ${winA ? "pw-value--winner" : a ? "pw-value--loser" : ""}`}>
            {valueA}
          </span>
            {winA ? <span className="pw-badge pw-badge--winner">winner</span> : null}
        </td>
        <td className="pw-variant-head">
          <span className={`pw-value ${!winA ? "pw-value--winner" : b ? "pw-value--loser" : ""}`}>
            {valueB}
          </span>
          {!winA ? <span className="pw-badge pw-badge--winner">winner</span> : null}
        </td>
      </>
    );
  }

  return (
    <>
      <div className="pw-page-head">
        <div>
          <h1 className="pw-h1">A/B Tests</h1>
          <p className="pw-page-head__desc">
            Compare two prompt versions side by side. The winner of each metric is highlighted
            automatically.
          </p>
        </div>
      </div>

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
                <div
                  className="pw-card__head"
                  style={{ marginBottom: "var(--pw-space-3)" }}
                >
                  <h2 className="pw-h2">{selected.name}</h2>
                  <span className="pw-chip">
                    {selected.promptName} · {selected.createdAt.slice(0, 10)}
                  </span>
                </div>

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
                  <table className="pw-compare">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th className="pw-variant-head pw-variant-head--a">
                          <VariantBadge variant="a">
                            A · v{selected.variantAId}
                          </VariantBadge>
                        </th>
                        <th className="pw-variant-head pw-variant-head--b">
                          <VariantBadge variant="b">
                            B · v{selected.variantBId}
                          </VariantBadge>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="pw-compare__metric">Avg. Latency</td>
                        <WinnerCell
                          a={metricsA}
                          b={metricsB}
                          winA={lowerIsBetter.latency(metricsA, metricsB)}
                          valueA={`${fmt(metricsA?.avgLatency, 0)} ms`}
                          valueB={`${fmt(metricsB?.avgLatency, 0)} ms`}
                        />
                      </tr>
                      <tr>
                        <td className="pw-compare__metric">Avg. Cost</td>
                        <WinnerCell
                          a={metricsA}
                          b={metricsB}
                          winA={lowerIsBetter.cost(metricsA, metricsB)}
                          valueA={`$${fmt(metricsA?.avgCost)}`}
                          valueB={`$${fmt(metricsB?.avgCost)}`}
                        />
                      </tr>
                      <tr>
                        <td className="pw-compare__metric">Error Rate</td>
                        <WinnerCell
                          a={metricsA}
                          b={metricsB}
                          winA={lowerIsBetter.errors(metricsA, metricsB)}
                          valueA={`${fmt(errorRate(metricsA), 1)}%`}
                          valueB={`${fmt(errorRate(metricsB), 1)}%`}
                        />
                      </tr>
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
          </div>
          {versions.length > 0 && (
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
        </div>
        <div className="pw-form__actions">
          <button className="pw-btn" onClick={createTest}>
            Create Test
          </button>
          {formMsg && (
            <span className={`pw-alert pw-alert--${formMsg.kind}`}>{formMsg.text}</span>
          )}
        </div>
      </section>
    </>
  );
}