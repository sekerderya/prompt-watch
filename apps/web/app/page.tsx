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

export default function Home() {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/metrics/summary?days=7")
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

  if (loading) return <main style={{ padding: 24 }}>Loading...</main>;
  if (failed) return <main style={{ padding: 24 }}>Failed to load data</main>;
  if (!rows.length) return <main style={{ padding: 24 }}>No data yet</main>;

  const chartRows: ChartRow[] = rows.map((r) => ({
    day: r.day,
    totalCost: r.totalCost,
    errorRate: r.total > 0 ? Math.round((r.errors / r.total) * 100) : 0,
  }));

  return (
    <main style={{ padding: 24 }}>
      <h1>PromptWatch</h1>

      <h2>Daily Cost (USD)</h2>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={chartRows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="totalCost" fill="#8884d8" name="Cost (USD)" />
        </BarChart>
      </ResponsiveContainer>

      <h2>Daily Error Rate (%)</h2>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartRows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="errorRate" stroke="#ff7300" name="Error Rate (%)" />
        </LineChart>
      </ResponsiveContainer>
    </main>
  );
}