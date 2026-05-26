import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cleanPaths, scanAiCaches, type AiCacheEntry } from "../lib/ipc";
import { formatBytes } from "../lib/format";
import { CacheRow } from "./CacheRow";

export function AiCachesPanel() {
  const [entries, setEntries] = useState<AiCacheEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string | null>(null);
  // Monotonically increasing refresh id used to drop stale results when the
  // user triggers a re-scan while one is already in flight.
  const refreshIdRef = useRef(0);

  // Aggregate found caches by id with totals — drives the filter chips.
  const cacheStats = useMemo(() => {
    const map = new Map<string, { name: string; count: number; bytes: number }>();
    for (const e of entries) {
      if (!e.exists) continue;
      const v = map.get(e.id) ?? { name: e.name, count: 0, bytes: 0 };
      v.count += 1;
      v.bytes += e.size_bytes;
      map.set(e.id, v);
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [entries]);

  const existing = useMemo(() => entries.filter((e) => e.exists), [entries]);
  const missing = useMemo(() => entries.filter((e) => !e.exists), [entries]);

  const visible = useMemo(
    () => (filter ? existing.filter((e) => e.id === filter) : existing),
    [existing, filter],
  );

  const sizeByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) map.set(e.path, e.size_bytes);
    return map;
  }, [entries]);

  const totalSelectedBytes = useMemo(() => {
    let total = 0;
    for (const path of selected) total += sizeByPath.get(path) ?? 0;
    return total;
  }, [selected, sizeByPath]);

  const totalVisibleBytes = useMemo(
    () => visible.reduce((acc, e) => acc + e.size_bytes, 0),
    [visible],
  );

  const refresh = useCallback(async () => {
    const myId = ++refreshIdRef.current;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await scanAiCaches();
      if (refreshIdRef.current !== myId) return;
      result.sort((a, b) => Number(b.exists) - Number(a.exists) || b.size_bytes - a.size_bytes);
      setEntries(result);
      setSelected(new Set());
      setFilter(null);
    } catch (e) {
      if (refreshIdRef.current !== myId) return;
      setError(String(e));
    } finally {
      if (refreshIdRef.current === myId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAll = () => setSelected(new Set(visible.map((e) => e.path)));
  const selectNone = () => setSelected(new Set());

  const handleClean = async () => {
    if (selected.size === 0) return;
    const paths = Array.from(selected);
    const ok = window.confirm(
      `Move ${paths.length} AI cache location(s) to the Recycle Bin / Trash?`,
    );
    if (!ok) return;

    setCleaning(true);
    setError(null);
    setSuccess(null);
    try {
      const results = await cleanPaths(paths);
      const failures = results.filter((r) => !r.ok);
      const succeeded = results.filter((r) => r.ok);
      const freed = succeeded.reduce((acc, r) => acc + (sizeByPath.get(r.path) ?? 0), 0);

      await refresh();

      if (succeeded.length > 0) {
        setSuccess(`Freed ${formatBytes(freed)} across ${succeeded.length} cache(s).`);
      }
      if (failures.length > 0) {
        setError(`${failures.length} failed: ${failures.map((f) => f.path).join(", ")}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setCleaning(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-bar">
        <button className="btn primary" onClick={() => void refresh()} disabled={loading}>
          Re-scan
        </button>
        <span className="folder-path">
          Scanning home directory for known AI cache locations
        </span>
      </div>

      {success && <div className="success">{success}</div>}
      {error && <div className="error">{error}</div>}

      {cacheStats.length > 0 && (
        <div className="stack-filters">
          <button
            className={filter === null ? "filter-chip active" : "filter-chip"}
            onClick={() => {
              setFilter(null);
              setSelected(new Set());
            }}
          >
            All <span className="filter-count">{existing.length}</span>
          </button>
          {cacheStats.map((s) => (
            <button
              key={s.id}
              className={filter === s.id ? "filter-chip active" : "filter-chip"}
              onClick={() => {
                setFilter(s.id);
                setSelected(new Set());
              }}
              title={`${formatBytes(s.bytes)} across ${s.count} location(s)`}
            >
              {s.name} <span className="filter-count">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <div className="summary">
          <div>
            <strong>{visible.length}</strong> location(s)
            {filter ? ` (${cacheStats.find((s) => s.id === filter)?.name})` : ""}, total{" "}
            <strong>{formatBytes(totalVisibleBytes)}</strong>
          </div>
          <div className="summary-actions">
            <button className="btn small" onClick={selectAll}>
              Select all
            </button>
            <button className="btn small" onClick={selectNone}>
              Select none
            </button>
            <button
              className="btn danger"
              disabled={selected.size === 0 || cleaning}
              onClick={handleClean}
            >
              {cleaning
                ? "Cleaning…"
                : `Clean ${selected.size} item(s) — ${formatBytes(totalSelectedBytes)}`}
            </button>
          </div>
        </div>
      )}

      {loading && visible.length === 0 && (
        <div className="empty-state">Scanning…</div>
      )}

      {!loading && existing.length === 0 && (
        <div className="empty-state">No AI caches found on this system.</div>
      )}

      <ul className="cache-list">
        {visible.map((e) => (
          <CacheRow
            key={e.path}
            entry={e}
            checked={selected.has(e.path)}
            onToggle={toggle}
          />
        ))}
      </ul>

      {missing.length > 0 && (
        <details className="missing">
          <summary>{missing.length} location(s) not present on this system</summary>
          <ul>
            {missing.map((e) => (
              <li key={e.path}>
                <span className="cache-name">{e.name}</span>
                <span className="cache-path">{e.path}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
