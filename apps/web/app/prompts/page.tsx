"use client";

import { useCallback, useEffect, useState } from "react";
import EmptyState from "../components/EmptyState";
import PromptDiff from "../components/PromptDiff";
import RangePicker, { DEFAULT_RANGE_DAYS } from "../components/RangePicker";

interface PromptSummary {
  name: string;
  versions: number;
  latestVersion: number;
  lastSeen: string | null;
  total: number;
  errors: number;
  totalCost: number;
  avgLatency: number | null;
  avgScore: number | null;
  scored: number;
}

interface PromptVersion {
  id: number;
  name: string;
  version: number;
  promptText: string;
  createdAt: string;
}

interface VersionMetrics {
  promptId: number;
  version: number;
  total: number;
  errors: number;
  avgLatency: number | null;
  totalCost: number;
  avgScore: number | null;
  scored: number;
  unpriced: number;
  lastSeen: string | null;
}

interface ErrorBucket {
  errorType: string;
  count: number;
}

function fmt(v: number | null | undefined, digits = 0, suffix = ""): string {
  return v == null || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}${suffix}`;
}

function percent(v: number | null): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

export default function PromptsPage() {
  const [days, setDays] = useState(DEFAULT_RANGE_DAYS);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [metrics, setMetrics] = useState<VersionMetrics[]>([]);
  const [errorBreakdown, setErrorBreakdown] = useState<ErrorBucket[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [diffPair, setDiffPair] = useState<{ before: number; after: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetch(`/api/prompts/overview?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data: PromptSummary[]) => {
        if (cancelled) return;
        setPrompts(data);
        setSelected((current) => current ?? data[0]?.name ?? null);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const loadDetail = useCallback(
    (name: string, windowDays: number) => {
      let cancelled = false;
      setDetailLoading(true);
      Promise.all([
        fetch(`/api/prompts?name=${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : [])),
        fetch(`/api/metrics/prompt?name=${encodeURIComponent(name)}&days=${windowDays}`).then((r) =>
          r.ok ? r.json() : { versions: [], errorBreakdown: [] }
        ),
      ])
        .then(([versionList, promptMetrics]) => {
          if (cancelled) return;
          setVersions(versionList);
          setMetrics(promptMetrics.versions ?? []);
          setErrorBreakdown(promptMetrics.errorBreakdown ?? []);
          // Default to comparing the two most recent versions, which is the
          // comparison anyone opening this page is here to make.
          setDiffPair(
            versionList.length >= 2
              ? { before: versionList[1].id, after: versionList[0].id }
              : null
          );
        })
        .catch(() => {
          if (cancelled) return;
          setVersions([]);
          setMetrics([]);
          setErrorBreakdown([]);
        })
        .finally(() => !cancelled && setDetailLoading(false));
      return () => {
        cancelled = true;
      };
    },
    []
  );

  useEffect(() => {
    if (!selected) return;
    return loadDetail(selected, days);
  }, [selected, days, loadDetail]);

  const metricsFor = (promptId: number) => metrics.find((m) => m.promptId === promptId);
  const before = versions.find((v) => v.id === diffPair?.before);
  const after = versions.find((v) => v.id === diffPair?.after);

  if (loading) return <div className="pw-loading">Loading prompts…</div>;

  if (failed) {
    return (
      <EmptyState
        icon="⚠"
        title="Couldn't load prompts"
        body="The dashboard API returned an error. Make sure the backend is running (docker compose up -d) and refresh this page."
      />
    );
  }

  if (prompts.length === 0) {
    return (
      <EmptyState
        icon="▾"
        title="No prompts tracked yet"
        body="The SDK versions a system prompt the first time it sees one. Run the demo to create some:"
        action="npm run demo"
      />
    );
  }

  return (
    <>
      <div className="pw-page-head">
        <div>
          <h1 className="pw-h1">Prompts</h1>
          <p className="pw-page-head__desc">
            Every system prompt the SDK has seen, versioned automatically by content hash.
            Pick one to compare versions and see how each performed.
          </p>
        </div>
        <RangePicker days={days} onChange={setDays} />
      </div>

      <section className="pw-card">
        <div className="pw-card__head">
          <h2 className="pw-h2">Tracked prompts</h2>
          <span className="pw-chip">{prompts.length}</span>
        </div>
        <div className="pw-table-scroll">
          <table className="pw-table">
            <thead>
              <tr>
                <th>Prompt</th>
                <th className="pw-num">Versions</th>
                <th className="pw-num">Requests</th>
                <th className="pw-num">Errors</th>
                <th className="pw-num">Avg latency</th>
                <th className="pw-num">Cost</th>
                <th className="pw-num">Quality</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p) => (
                <tr
                  key={p.name}
                  className={`pw-table__row${selected === p.name ? " pw-table__row--active" : ""}`}
                  onClick={() => setSelected(p.name)}
                >
                  <td>
                    <button className="pw-linkish" type="button">
                      {p.name}
                    </button>
                    <div className="pw-subtle">
                      latest v{p.latestVersion}
                      {p.lastSeen ? ` · last call ${p.lastSeen.slice(0, 10)}` : " · no traffic"}
                    </div>
                  </td>
                  <td className="pw-num">{p.versions}</td>
                  <td className="pw-num">{p.total.toLocaleString()}</td>
                  <td className="pw-num">
                    {p.total > 0 ? `${((p.errors / p.total) * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="pw-num">{fmt(p.avgLatency, 0, " ms")}</td>
                  <td className="pw-num">${p.totalCost.toFixed(4)}</td>
                  <td className="pw-num">
                    {p.scored > 0 ? `${percent(p.avgScore)} (n=${p.scored})` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section className="pw-card">
          <div className="pw-card__head">
            <h2 className="pw-h2">{selected}</h2>
            <span className="pw-chip">{versions.length} version(s)</span>
          </div>

          {detailLoading ? (
            <div className="pw-loading">Loading versions…</div>
          ) : (
            <>
              <div className="pw-table-scroll">
                <table className="pw-table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th className="pw-num">Requests</th>
                      <th className="pw-num">Errors</th>
                      <th className="pw-num">Avg latency</th>
                      <th className="pw-num">Cost</th>
                      <th className="pw-num">Quality</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => {
                      const m = metricsFor(v.id);
                      return (
                        <tr key={v.id}>
                          <td>
                            <span className="pw-badge pw-badge--a">v{v.version}</span>
                          </td>
                          <td className="pw-num">{(m?.total ?? 0).toLocaleString()}</td>
                          <td className="pw-num">
                            {m && m.total > 0 ? `${((m.errors / m.total) * 100).toFixed(1)}%` : "—"}
                          </td>
                          <td className="pw-num">{fmt(m?.avgLatency, 0, " ms")}</td>
                          <td className="pw-num">
                            {m?.unpriced ? "~" : ""}${(m?.totalCost ?? 0).toFixed(4)}
                          </td>
                          <td className="pw-num">
                            {m && m.scored > 0 ? `${percent(m.avgScore)} (n=${m.scored})` : "—"}
                          </td>
                          <td className="pw-subtle">{v.createdAt.slice(0, 10)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {errorBreakdown.length > 0 && (
                <div className="pw-error-breakdown">
                  <span className="pw-label">Failures by cause</span>
                  <div className="pw-chips">
                    {errorBreakdown.map((bucket) => (
                      <span key={bucket.errorType} className="pw-chip pw-chip--danger">
                        {bucket.errorType.toLowerCase().replace(/_/g, " ")} · {bucket.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {versions.length >= 2 && diffPair && (
                <div className="pw-diff-block">
                  <div className="pw-card__head">
                    <h3 className="pw-h2">What changed</h3>
                    <span className="pw-actions">
                      <select
                        className="pw-select"
                        aria-label="Compare from version"
                        value={diffPair.before}
                        onChange={(e) =>
                          setDiffPair({ ...diffPair, before: Number(e.target.value) })
                        }
                      >
                        {versions.map((v) => (
                          <option key={`from-${v.id}`} value={v.id}>
                            v{v.version}
                          </option>
                        ))}
                      </select>
                      <span className="pw-subtle">→</span>
                      <select
                        className="pw-select"
                        aria-label="Compare to version"
                        value={diffPair.after}
                        onChange={(e) =>
                          setDiffPair({ ...diffPair, after: Number(e.target.value) })
                        }
                      >
                        {versions.map((v) => (
                          <option key={`to-${v.id}`} value={v.id}>
                            v{v.version}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
                  {before && after ? (
                    <PromptDiff before={before.promptText} after={after.promptText} />
                  ) : null}
                </div>
              )}

              {versions.length === 1 && (
                <>
                  <span className="pw-label">Prompt text</span>
                  <pre className="pw-diff">{versions[0].promptText}</pre>
                </>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
