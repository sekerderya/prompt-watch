"use client";

import { useEffect, useState } from "react";

interface MetricComparison {
  metric: "quality" | "errorRate" | "latency";
  before: number | null;
  after: number | null;
  delta: number | null;
  pValue: number | null;
  regressed: boolean;
  improved: boolean;
  note: string;
}

interface Report {
  releaseId: number;
  version: number;
  previousVersion: number | null;
  releasedAt: string;
  before: { n: number; scored: number };
  after: { n: number; scored: number };
  metrics: MetricComparison[];
  worst: MetricComparison | null;
}

const LABEL: Record<MetricComparison["metric"], string> = {
  quality: "Quality score",
  errorRate: "Error rate",
  latency: "Avg. latency",
};

function show(metric: MetricComparison["metric"], v: number | null): string {
  if (v === null) return "—";
  return metric === "latency" ? `${Math.round(v)} ms` : `${(v * 100).toFixed(1)}%`;
}

/**
 * How the live release is doing against the version it replaced.
 *
 * Promoting a prompt is the point where this tool stops observing and starts
 * changing things, so noticing a bad change is its job rather than the
 * operator's. The comparison is the same machinery the A/B page uses; only the
 * axis differs — before the release versus after, instead of variant A versus
 * variant B.
 */
export default function ReleaseHealth({ releaseId }: { releaseId: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [comparable, setComparable] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/releases/${releaseId}/assessment`)
      .then((r) => (r.ok ? r.json() : { comparable: false, report: null }))
      .then((body) => {
        if (cancelled) return;
        setComparable(body.comparable);
        setReport(body.report);
      })
      .catch(() => {
        if (!cancelled) setComparable(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [releaseId]);

  if (loading) return <div className="pw-loading">Checking the live release…</div>;

  if (!comparable || !report) {
    return (
      <p className="pw-subtle pw-release-note">
        Nothing to compare this release against yet — it is the first one for this prompt.
      </p>
    );
  }

  const regressed = report.worst !== null;

  return (
    <div className={`pw-health${regressed ? " pw-health--bad" : ""}`}>
      <div className="pw-card__head">
        <h3 className="pw-h2">
          {regressed
            ? `v${report.version} looks worse than v${report.previousVersion}`
            : `v${report.version} vs v${report.previousVersion}`}
        </h3>
        <span className="pw-chip">
          {report.after.n} calls since release · {report.before.n} before
        </span>
      </div>

      {regressed && (
        <p className="pw-alert pw-alert--error">
          {LABEL[report.worst!.metric]} moved {show(report.worst!.metric, report.worst!.before)} →{" "}
          {show(report.worst!.metric, report.worst!.after)} (p ={" "}
          {report.worst!.pValue?.toFixed(3)}). Roll back from the table above, or let{" "}
          <code>npm run watch:releases</code> do it on a schedule.
        </p>
      )}

      <div className="pw-table-scroll">
        <table className="pw-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="pw-num">Before</th>
              <th className="pw-num">After</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {report.metrics.map((m) => (
              <tr key={m.metric}>
                <td>{LABEL[m.metric]}</td>
                <td className="pw-num">{show(m.metric, m.before)}</td>
                <td
                  className={`pw-num${
                    m.regressed ? " pw-value--loser" : m.improved ? " pw-value--winner" : ""
                  }`}
                >
                  {show(m.metric, m.after)}
                </td>
                <td className="pw-subtle">{m.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
