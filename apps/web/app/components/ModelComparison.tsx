"use client";

import { useEffect, useState } from "react";

type Metric = "quality" | "errorRate" | "latency" | "cost";

type Verdict =
  | { kind: "insufficient-data"; needed: number; haveA: number; haveB: number }
  | { kind: "inconclusive"; pValue: number }
  | { kind: "winner"; winner: "A" | "B"; pValue: number }
  | { kind: "estimated"; unpricedA: number; unpricedB: number };

interface MetricComparison {
  metric: Metric;
  valueA: number | null;
  valueB: number | null;
  verdict: Verdict;
}

interface ModelMetrics {
  model: string;
  total: number;
  errors: number;
  unpriced: number;
  avgLatency: number | null;
  avgCost: number | null;
  avgScore: number | null;
  scored: number;
}

interface Comparison {
  models: ModelMetrics[];
  a: string | null;
  b: string | null;
  metrics: MetricComparison[];
}

const LABEL: Record<Metric, string> = {
  quality: "Quality score",
  errorRate: "Error rate",
  latency: "Avg. latency",
  cost: "Avg. cost / call",
};

function show(metric: Metric, v: number | null, estimated: boolean): string {
  if (v === null) return "—";
  if (metric === "latency") return `${Math.round(v)} ms`;
  if (metric === "cost") return `${estimated ? "~" : ""}$${v.toFixed(6)}`;
  return `${(v * 100).toFixed(1)}%`;
}

function verdictText(v: Verdict, a: string, b: string): string {
  switch (v.kind) {
    case "insufficient-data":
      return `Not enough data — ${v.needed} needed per model, have ${v.haveA} and ${v.haveB}`;
    case "inconclusive":
      return `No significant difference (p = ${v.pValue.toFixed(3)})`;
    case "winner":
      return `${v.winner === "A" ? a : b} is better (p = ${v.pValue.toFixed(3)})`;
    case "estimated":
      // ADR-7: a guessed price is the same constant for every unknown model, so
      // testing two guesses against each other would produce a confident result
      // about nothing. No verdict is the honest output.
      return "One or both models are priced by estimate — not compared";
  }
}

/**
 * How the models serving one prompt compare.
 *
 * The statistics are the same ones ADR-6 applies to variants and ADR-14 to
 * releases; only the axis differs. What differs materially is the evidence:
 * an A/B test randomises which call goes where, and this does not. The two
 * populations are whatever traffic happened to use each model, so the caveat
 * below is part of the result rather than a footnote to it.
 */
export default function ModelComparison({
  promptName,
  days,
}: {
  promptName: string;
  days: number;
}) {
  const [data, setData] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ promptName, days: String(days) });
    if (pair) {
      params.set("a", pair.a);
      params.set("b", pair.b);
    }
    fetch(`/api/metrics/model-comparison?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [promptName, days, pair]);

  if (loading) return <div className="pw-loading">Comparing models…</div>;
  if (!data || data.models.length === 0) {
    return (
      <div className="pw-diff-block">
        <div className="pw-card__head">
          <h3 className="pw-h2">Models</h3>
        </div>
        <p className="pw-subtle">
          No calls in this window record which model served them. Traces written before model
          recording existed are left out rather than guessed.
        </p>
      </div>
    );
  }

  const single = data.models.length < 2 || data.a === null || data.b === null;

  return (
    <div className="pw-diff-block">
      <div className="pw-card__head">
        <h3 className="pw-h2">Models</h3>
        <span className="pw-chip">{data.models.length} in the last {days} days</span>
      </div>

      <div className="pw-table-scroll">
        <table className="pw-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="pw-num">Calls</th>
              <th className="pw-num">Errors</th>
              <th className="pw-num">Avg latency</th>
              <th className="pw-num">Avg cost</th>
              <th className="pw-num">Quality</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.model}>
                <td>
                  <span className="pw-chip">{m.model}</span>
                </td>
                <td className="pw-num">{m.total.toLocaleString()}</td>
                <td className="pw-num">
                  {m.total > 0 ? `${((m.errors / m.total) * 100).toFixed(1)}%` : "—"}
                </td>
                <td className="pw-num">
                  {m.avgLatency === null ? "—" : `${Math.round(m.avgLatency)} ms`}
                </td>
                <td className="pw-num">
                  {m.unpriced ? "~" : ""}${(m.avgCost ?? 0).toFixed(6)}
                </td>
                <td className="pw-num">
                  {m.scored > 0 ? `${((m.avgScore ?? 0) * 100).toFixed(1)}% (n=${m.scored})` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {single ? (
        <p className="pw-subtle pw-release-note">
          Only one model has served this prompt in this window, so there is nothing to compare it
          against.
        </p>
      ) : (
        <>
          <div className="pw-card__head">
            <h3 className="pw-h2">
              {data.a} vs {data.b}
            </h3>
            {data.models.length > 2 && (
              <span className="pw-chip">
                <select
                  className="pw-select"
                  value={data.a ?? ""}
                  onChange={(e) => setPair({ a: e.target.value, b: data.b! })}
                >
                  {data.models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.model}
                    </option>
                  ))}
                </select>
                {" vs "}
                <select
                  className="pw-select"
                  value={data.b ?? ""}
                  onChange={(e) => setPair({ a: data.a!, b: e.target.value })}
                >
                  {data.models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.model}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </div>

          <p className="pw-alert">
            Nothing randomised which call went to which model, so this compares whatever traffic
            each one happened to receive. A difference here is a reason to run a controlled test,
            not a result on its own.
          </p>

          <div className="pw-table-scroll">
            <table className="pw-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th className="pw-num">{data.a}</th>
                  <th className="pw-num">{data.b}</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => {
                  const estimated = m.verdict.kind === "estimated";
                  const won = m.verdict.kind === "winner" ? m.verdict.winner : null;
                  return (
                    <tr key={m.metric}>
                      <td>{LABEL[m.metric]}</td>
                      <td className={`pw-num${won === "A" ? " pw-value--winner" : ""}`}>
                        {show(m.metric, m.valueA, estimated)}
                      </td>
                      <td className={`pw-num${won === "B" ? " pw-value--winner" : ""}`}>
                        {show(m.metric, m.valueB, estimated)}
                      </td>
                      <td className="pw-subtle">{verdictText(m.verdict, data.a!, data.b!)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
