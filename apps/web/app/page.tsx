"use client";

import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import EmptyState from "./components/EmptyState";

interface SummaryRow {
  day: string;
  totalCost: number;
  total: number;
  errors: number;
}

interface ChartRow {
  day: string;
  totalCost: number;
  errorRate: number;
}

const DAYS = 7;

const axisTick = { fill: "var(--pw-text-muted)", fontSize: 12, fontFamily: "var(--pw-font-mono)" };

export default function Home() {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/metrics/summary?days=${DAYS}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SummaryRow[]) => {
        if (!cancelled) {
          setRows(
            data.map((r) => ({
              ...r,
              day: new Date(r.day).toLocaleDateString(),
            }))
          );
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="pw-loading">Loading metrics…</div>;
  }

  if (failed) {
    return (
      <EmptyState
        icon="⚠"
        title="Couldn't load metrics"
        body="The dashboard API returned an error. Make sure the backend is running (docker compose up -d) and refresh this page."
      />
    );
  }

  if (!rows.length) {
    return (
      <EmptyState
        icon="▾"
        title="No telemetry yet"
        body="Run the demo to generate versioning, A/B test and cost data, then reload this page:"
        action="npm run demo"
      />
    );
  }

  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);
  const totalRequests = rows.reduce((s, r) => s + r.total, 0);
  const totalErrors = rows.reduce((s, r) => s + r.errors, 0);
  const errorRate = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;

  const chartRows: ChartRow[] = rows.map((r) => ({
    day: r.day,
    totalCost: r.totalCost,
    errorRate: r.total > 0 ? Math.round((r.errors / r.total) * 100) : 0,
  }));

  return (
    <>
      <div className="pw-page-head">
        <div>
          <h1 className="pw-h1">Dashboard</h1>
          <p className="pw-page-head__desc">
            Aggregate cost, request volume and error rate across all versioned prompts tracked
            by the SDK.
          </p>
        </div>
        <span className="pw-chip">Last {DAYS} days</span>
      </div>

      <div className="pw-kpis">
        <div className="pw-kpi pw-kpi--primary">
          <span className="pw-label">Total Cost</span>
          <span className="pw-kpi__value">${totalCost.toFixed(4)}</span>
          <span className="pw-subtle">USD, last {DAYS} days</span>
        </div>
        <div className="pw-kpi">
          <span className="pw-label">Total Requests</span>
          <span className="pw-kpi__value">{totalRequests.toLocaleString()}</span>
          <span className="pw-subtle">calls across all prompts</span>
        </div>
        <div className="pw-kpi pw-kpi--danger">
          <span className="pw-label">Error Rate</span>
          <span className="pw-kpi__value">{errorRate.toFixed(1)}%</span>
          <span className="pw-subtle">of all requests</span>
        </div>
      </div>

      <section className="pw-card">
        <div className="pw-card__head">
          <h2 className="pw-h2">Daily Cost</h2>
          <span className="pw-chip">USD</span>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartRows}>
            <CartesianGrid stroke="var(--pw-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={axisTick} stroke="var(--pw-border)" tickLine={false} />
            <YAxis
              tick={axisTick}
              stroke="var(--pw-border)"
              tickLine={false}
              tickFormatter={(v: number) => `$${v.toFixed(4)}`}
            />
            <Tooltip
              cursor={{ fill: "rgba(90,162,255,0.06)" }}
              contentStyle={{
                background: "var(--pw-surface-2)",
                border: "1px solid var(--pw-border)",
                borderRadius: 8,
                fontSize: 13,
              }}
              labelStyle={{ color: "var(--pw-text-muted)" }}
            />
            <Bar dataKey="totalCost" fill="var(--pw-primary)" radius={[4, 4, 0, 0]} name="Cost" />
          </BarChart>
        </ResponsiveContainer>
      </section>

      <section className="pw-card">
        <div className="pw-card__head">
          <h2 className="pw-h2">Daily Error Rate</h2>
          <span className="pw-chip">% of requests</span>
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartRows}>
            <CartesianGrid stroke="var(--pw-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={axisTick} stroke="var(--pw-border)" tickLine={false} />
            <YAxis
              tick={axisTick}
              stroke="var(--pw-border)"
              tickLine={false}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              contentStyle={{
                background: "var(--pw-surface-2)",
                border: "1px solid var(--pw-border)",
                borderRadius: 8,
                fontSize: 13,
              }}
              labelStyle={{ color: "var(--pw-text-muted)" }}
            />
            <Line
              type="monotone"
              dataKey="errorRate"
              stroke="var(--pw-danger)"
              strokeWidth={2}
              dot={{ fill: "var(--pw-danger)", r: 3 }}
              name="Error rate"
            />
          </LineChart>
        </ResponsiveContainer>
      </section>
    </>
  );
}