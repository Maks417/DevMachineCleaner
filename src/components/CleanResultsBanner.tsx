import { useMemo, useState } from "react";
import type { CleanResult } from "../lib/ipc";
import { formatBytes } from "../lib/format";

interface Props {
  results: CleanResult[];
  sizeByPath: Map<string, number>;
  onDismiss: () => void;
}

/**
 * Post-clean detail view. Lists per-path outcomes so users can verify what
 * actually happened, especially when some items succeeded and others failed.
 */
export function CleanResultsBanner({ results, sizeByPath, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false);
  const stats = useMemo(() => {
    let ok = 0;
    let failed = 0;
    let freed = 0;
    for (const r of results) {
      if (r.ok) {
        ok += 1;
        freed += sizeByPath.get(r.path) ?? 0;
      } else {
        failed += 1;
      }
    }
    return { ok, failed, freed };
  }, [results, sizeByPath]);

  if (results.length === 0) return null;

  const isMixed = stats.ok > 0 && stats.failed > 0;
  const isAllFail = stats.ok === 0 && stats.failed > 0;
  const klass = isAllFail ? "report report-fail" : isMixed ? "report report-mixed" : "report report-ok";

  return (
    <div className={klass} role="status">
      <div className="report-head">
        <span>
          {stats.ok > 0 && (
            <>
              <strong>{stats.ok}</strong> cleaned ({formatBytes(stats.freed)})
            </>
          )}
          {stats.ok > 0 && stats.failed > 0 && " • "}
          {stats.failed > 0 && (
            <>
              <strong>{stats.failed}</strong> failed
            </>
          )}
        </span>
        <div className="report-actions">
          <button
            className="btn small"
            onClick={() => setExpanded((v) => !v)}
            type="button"
            aria-expanded={expanded}
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
          <button
            className="btn small"
            onClick={onDismiss}
            type="button"
            aria-label="Dismiss report"
          >
            Dismiss
          </button>
        </div>
      </div>
      {expanded && (
        <ul className="report-list">
          {results.map((r) => (
            <li key={r.path} className={r.ok ? "report-row ok" : "report-row fail"}>
              <span className="report-icon" aria-hidden="true">
                {r.ok ? "✓" : "✕"}
              </span>
              <span className="report-path" title={r.path}>
                {r.path}
              </span>
              <span className="report-detail">
                {r.ok ? formatBytes(sizeByPath.get(r.path) ?? 0) : r.error ?? "Failed"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
