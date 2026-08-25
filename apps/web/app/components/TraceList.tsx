"use client";

import { useCallback, useEffect, useState } from "react";

interface TraceRow {
  id: number;
  createdAt: string;
  promptId: number;
  version: number;
  variant: string | null;
  abTestId: number | null;
  status: string;
  errorType: string | null;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  pricingUnknown: boolean;
  score: number | null;
  label: string | null;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

/**
 * Individual calls for one prompt.
 *
 * Everything else on this page aggregates, which answers "how is this prompt
 * doing" and cannot answer "what happened to the request that took four
 * seconds". Rows are the smallest thing the privacy model permits: timing,
 * tokens, cost, which version ran, and the reported outcome — never content
 * (ADR-2), which is also why there is nothing further to drill into.
 */
export default function TraceList({ promptName }: { promptName: string }) {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const load = useCallback(
    async (before: number | null, onlyErrors: boolean): Promise<void> => {
      const params = new URLSearchParams({ promptName, limit: "25" });
      if (before !== null) params.set("before", String(before));
      if (onlyErrors) params.set("status", "ERROR");

      const res = await fetch(`/api/traces/list?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();

      setTraces((current) => (before === null ? body.traces : [...current, ...body.traces]));
      setCursor(body.nextCursor);
    },
    [promptName]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setTraces([]);
    setCursor(null);
    load(null, errorsOnly)
      .catch(() => {
        if (!cancelled) setTraces([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, errorsOnly]);

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      await load(cursor, errorsOnly);
    } catch {
      /* the button stays available for a retry */
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="pw-diff-block">
      <div className="pw-card__head">
        <h3 className="pw-h2">Recent calls</h3>
        <button
          type="button"
          className={`pw-btn pw-btn--ghost pw-btn--sm${errorsOnly ? " pw-btn--on" : ""}`}
          aria-pressed={errorsOnly}
          onClick={() => setErrorsOnly((v) => !v)}
        >
          {errorsOnly ? "Showing failures only" : "Failures only"}
        </button>
      </div>

      {loading ? (
        <div className="pw-loading">Loading calls…</div>
      ) : traces.length === 0 ? (
        <p className="pw-subtle">
          {errorsOnly ? "No failed calls in the record." : "No calls recorded for this prompt."}
        </p>
      ) : (
        <>
          <div className="pw-table-scroll">
            <table className="pw-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Version</th>
                  <th>Result</th>
                  <th className="pw-num">Latency</th>
                  <th className="pw-num">Tokens</th>
                  <th className="pw-num">Cost</th>
                  <th className="pw-num">Score</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t) => (
                  <tr key={t.id}>
                    <td className="pw-subtle">{timeOf(t.createdAt)}</td>
                    <td>
                      <span className="pw-badge pw-badge--a">v{t.version}</span>
                      {t.variant && (
                        <span className={`pw-badge pw-badge--${t.variant.toLowerCase()}`}>
                          {t.variant}
                        </span>
                      )}
                    </td>
                    <td>
                      {t.status === "ERROR" ? (
                        <span className="pw-chip pw-chip--danger">
                          {(t.errorType ?? "UNKNOWN").toLowerCase().replace(/_/g, " ")}
                        </span>
                      ) : (
                        <span className="pw-subtle">ok</span>
                      )}
                    </td>
                    <td className="pw-num">{t.latencyMs} ms</td>
                    <td className="pw-num">
                      {t.promptTokens.toLocaleString()} / {t.completionTokens.toLocaleString()}
                    </td>
                    <td className="pw-num">
                      {t.pricingUnknown ? "~" : ""}${t.costUsd.toFixed(6)}
                    </td>
                    <td className="pw-num">
                      {t.score === null ? "—" : `${(t.score * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {cursor !== null && (
            <div className="pw-form__actions">
              <button
                type="button"
                className="pw-btn pw-btn--ghost"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
