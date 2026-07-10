import { useEffect, useMemo, useState } from "react";
import type { UserAliasRecord } from "../lib/idb";

export interface AliasProposal {
  match: string;
  canonical: string;        // may be "UNKNOWN"
  evidence: string[];
  reasoning?: string;
  confidence: number;       // 1-10
  occurrences?: number;
}

export interface AliasProposalsFile {
  schema: "vn-reader-aliases";
  schema_version: number;
  generated_at_utc?: string;
  source?: string;
  proposals: AliasProposal[];
}

interface AliasReviewProps {
  proposals: AliasProposal[] | null;
  existingAliases: UserAliasRecord[];
  onLoadFile: () => void;
  onApply: (accepted: Array<{ match: string; canonical: string }>) => void;
  onClear: () => void;
  onDeleteExisting: (match: string) => void;
  onUpdateExisting: (match: string, canonical: string) => void;
}

interface RowState {
  accepted: boolean;
  canonical: string; // editable; pre-filled with proposal.canonical, empty if UNKNOWN
}

export default function AliasReview({
  proposals,
  existingAliases,
  onLoadFile,
  onApply,
  onClear,
  onDeleteExisting,
  onUpdateExisting
}: AliasReviewProps) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [showExisting, setShowExisting] = useState(false);

  useEffect(() => {
    if (!proposals) {
      setRows({});
      return;
    }
    const next: Record<string, RowState> = {};
    for (const p of proposals) {
      const isUnknown = p.canonical === "UNKNOWN" || !p.canonical.trim();
      next[p.match] = {
        accepted: !isUnknown && p.confidence >= 8,
        canonical: isUnknown ? "" : p.canonical
      };
    }
    setRows(next);
  }, [proposals]);

  const stats = useMemo(() => {
    if (!proposals) return null;
    const total = proposals.length;
    const accepted = Object.values(rows).filter((r) => r.accepted).length;
    const ready = Object.entries(rows).filter(
      ([, r]) => r.accepted && r.canonical.trim().length > 0
    ).length;
    return { total, accepted, ready };
  }, [proposals, rows]);

  const onToggle = (match: string) => {
    setRows((prev) => {
      const cur = prev[match] ?? { accepted: false, canonical: "" };
      return { ...prev, [match]: { ...cur, accepted: !cur.accepted } };
    });
  };

  const onCanonicalEdit = (match: string, value: string) => {
    setRows((prev) => {
      const cur = prev[match] ?? { accepted: true, canonical: "" };
      return { ...prev, [match]: { ...cur, canonical: value, accepted: true } };
    });
  };

  const handleApply = () => {
    if (!proposals) return;
    const accepted: Array<{ match: string; canonical: string }> = [];
    for (const p of proposals) {
      const r = rows[p.match];
      if (!r?.accepted) continue;
      const canonical = r.canonical.trim();
      if (!canonical) continue;
      accepted.push({ match: p.match, canonical });
    }
    onApply(accepted);
  };

  return (
    <div className="alias-review-stage">
      <div className="reading-header">
        <p className="eyebrow">Alias review</p>
        <h2>
          {proposals
            ? `${proposals.length.toLocaleString()} proposals from your AI run`
            : "Import alias proposals"}
        </h2>
        <p>
          Aliases turn coded references like "Natwarlal" into a canonical name like
          "Arvind Kejriwal" — the graph and search use the canonical name everywhere.
        </p>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
          <button type="button" onClick={onLoadFile}>
            {proposals ? "Load a different file" : "Load proposals JSON"}
          </button>
          {proposals ? (
            <button type="button" className="btn-ghost" onClick={onClear}>
              Discard proposals
            </button>
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setShowExisting((v) => !v)}
          >
            {showExisting ? "Hide" : "Show"} active aliases ({existingAliases.length})
          </button>
        </div>
      </div>

      {showExisting ? (
        <section className="alias-existing">
          <h3>Active user aliases</h3>
          {existingAliases.length === 0 ? (
            <p className="empty-panel" style={{ padding: "1rem 0" }}>
              No user aliases yet. Built-in aliases live in <code>src/lib/aliases.ts</code>.
            </p>
          ) : (
            <table className="alias-table">
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Canonical</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {existingAliases.map((a) => (
                  <tr key={a.match}>
                    <td className="mono">{a.match}</td>
                    <td>
                      <input
                        type="text"
                        defaultValue={a.canonical}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && v !== a.canonical) onUpdateExisting(a.match, v);
                        }}
                      />
                    </td>
                    <td className="mono dim">{a.created_at_utc?.slice(0, 10) ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost btn-danger"
                        onClick={() => onDeleteExisting(a.match)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {!proposals ? (
        <div className="empty-panel">
          Run the Colab notebook (or paste the prompt into Claude.ai), download the
          resulting <code>vn-reader-aliases.json</code>, then click "Load proposals JSON"
          above.
        </div>
      ) : (
        <>
          <div className="alias-action-bar">
            <span>
              {stats?.ready ?? 0} of {stats?.total ?? 0} ready to apply
            </span>
            <button
              type="button"
              className="btn-primary"
              onClick={handleApply}
              disabled={!stats || stats.ready === 0}
            >
              Apply {stats?.ready ?? 0} alias{(stats?.ready ?? 0) === 1 ? "" : "es"}
            </button>
          </div>

          <table className="alias-table">
            <thead>
              <tr>
                <th style={{ width: "32px" }}></th>
                <th>Match</th>
                <th>Canonical</th>
                <th>Evidence</th>
                <th style={{ width: "60px" }}>Conf.</th>
                <th style={{ width: "60px" }}>Mentions</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => {
                const row = rows[p.match] ?? { accepted: false, canonical: "" };
                const isUnknown = !row.canonical.trim();
                const isAlreadyAdded = existingAliases.some(
                  (a) => a.match.toLowerCase() === p.match.toLowerCase()
                );
                return (
                  <tr
                    key={p.match}
                    className={[
                      row.accepted ? "is-accepted" : "",
                      isUnknown ? "is-unknown" : "",
                      isAlreadyAdded ? "is-already-added" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={row.accepted}
                        onChange={() => onToggle(p.match)}
                        aria-label={`Accept alias ${p.match}`}
                      />
                    </td>
                    <td className="mono">{p.match}</td>
                    <td>
                      <input
                        type="text"
                        value={row.canonical}
                        placeholder={isUnknown ? "Type the real name…" : ""}
                        onChange={(e) => onCanonicalEdit(p.match, e.target.value)}
                      />
                      {p.reasoning ? (
                        <details className="alias-reasoning">
                          <summary>Why?</summary>
                          <p>{p.reasoning}</p>
                        </details>
                      ) : null}
                      {isAlreadyAdded ? (
                        <span className="alias-already-added">Already in active aliases</span>
                      ) : null}
                    </td>
                    <td className="alias-evidence">
                      <ul>
                        {p.evidence.slice(0, 3).map((ev, idx) => (
                          <li key={idx}>{ev}</li>
                        ))}
                      </ul>
                    </td>
                    <td className="mono">
                      <span
                        className={
                          p.confidence >= 9
                            ? "conf-high"
                            : p.confidence >= 7
                              ? "conf-med"
                              : "conf-low"
                        }
                      >
                        {p.confidence}/10
                      </span>
                    </td>
                    <td className="mono dim">{p.occurrences ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
