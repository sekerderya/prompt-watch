"use client";

import { useCallback, useEffect, useState } from "react";

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

const pageStyle: React.CSSProperties = { padding: 24, fontFamily: "system-ui, sans-serif" };
const formStyle: React.CSSProperties = { display: "grid", gap: 8, maxWidth: 420 };

export default function ABTestsPage() {
  const [tests, setTests] = useState<ABTest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<VariantMetrics[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const [name, setName] = useState("");
  const [promptName, setPromptName] = useState("");
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [variantAId, setVariantAId] = useState<number | null>(null);
  const [variantBId, setVariantBId] = useState<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [formMsg, setFormMsg] = useState<string | null>(null);

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
      return;
    }
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
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [promptName]);

  const selected = tests.find((t) => t.id === selectedId) ?? null;
  const metricsA = metrics.find((m) => m.variant === "A");
  const metricsB = metrics.find((m) => m.variant === "B");

  function fmt(v: number | null | undefined, digits = 2): string {
    return v == null || Number.isNaN(v) ? "-" : v.toFixed(digits);
  }

  function rate(m: VariantMetrics | undefined): string {
    return m && m.total > 0 ? ((m.errors / m.total) * 100).toFixed(1) : "0.0";
  }

  async function createTest() {
    setFormMsg(null);
    if (!name.trim() || !promptName.trim() || variantAId === null || variantBId === null) {
      setFormMsg("Please fill in all fields");
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
        setFormMsg(body.error ?? "Could not create test");
        return;
      }
      setFormMsg("Test created");
      setName("");
      setPromptName("");
      setVersions([]);
      setVariantAId(null);
      setVariantBId(null);
      void loadTests();
    } catch {
      setFormMsg("Could not create test");
    }
  }

  return (
    <main style={pageStyle}>
      <h1>A/B Test Comparison</h1>

      <section>
        <h2>Test List</h2>
        {tests.length === 0 ? (
          <p>No tests yet</p>
        ) : (
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            style={{ minWidth: 300 }}
          >
            {tests.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.status}) - {new Date(t.createdAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        )}
      </section>

      {selected && (
        <section>
          <h2>{selected.name}</h2>
          <p>
            Prompt: {selected.promptName} · Split: %{selected.splitPercent}
          </p>
          {metricsLoading ? (
            <p>Loading...</p>
          ) : metrics.length === 0 ? (
            <p>No data yet</p>
          ) : (
            <table border={1} cellPadding={8} style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>A: {(selected.variantA?.promptText ?? "").slice(0, 60)}</th>
                  <th>B: {(selected.variantB?.promptText ?? "").slice(0, 60)}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Avg. Latency (ms)</td>
                  <td>{fmt(metricsA?.avgLatency, 0)}</td>
                  <td>{fmt(metricsB?.avgLatency, 0)}</td>
                </tr>
                <tr>
                  <td>Avg. Cost (USD)</td>
                  <td>{fmt(metricsA?.avgCost)}</td>
                  <td>{fmt(metricsB?.avgCost)}</td>
                </tr>
                <tr>
                  <td>Error Rate (%)</td>
                  <td>{rate(metricsA)}</td>
                  <td>{rate(metricsB)}</td>
                </tr>
                <tr>
                  <td>Request Count</td>
                  <td>{metricsA?.total ?? 0}</td>
                  <td>{metricsB?.total ?? 0}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
      )}

      <section>
        <h2>Create New A/B Test</h2>
        <div style={formStyle}>
          <label>
            Test Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Prompt Name
            <input
              value={promptName}
              onChange={(e) => setPromptName(e.target.value)}
              placeholder="e.g. support-bot"
            />
          </label>
          {versions.length > 0 && (
            <>
              <label>
                Variant A (version)
                <select
                  value={variantAId ?? ""}
                  onChange={(e) => setVariantAId(Number(e.target.value))}
                >
                  {versions.map((v) => (
                    <option key={`a-${v.id}`} value={v.id}>
                      v{v.version} (id {v.id})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Variant B (version)
                <select
                  value={variantBId ?? ""}
                  onChange={(e) => setVariantBId(Number(e.target.value))}
                >
                  {versions.map((v) => (
                    <option key={`b-${v.id}`} value={v.id}>
                      v{v.version} (id {v.id})
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            Split % (Variant A)
            <input
              type="number"
              min={0}
              max={100}
              value={splitPercent}
              onChange={(e) => setSplitPercent(Number(e.target.value))}
            />
          </label>
          <button onClick={createTest}>Create</button>
          {formMsg && <p>{formMsg}</p>}
        </div>
      </section>
    </main>
  );
}