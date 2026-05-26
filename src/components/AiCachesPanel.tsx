import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelScan,
  cleanPaths,
  onScanProgress,
  scanAiCaches,
  type AiCacheEntry,
  type CleanResult,
  type ScanProgress,
} from "../lib/ipc";
import { formatBytes } from "../lib/format";
import { CacheRow } from "./CacheRow";
import { ConfirmCleanDialog, type CleanItem } from "./ConfirmCleanDialog";
import { CleanResultsBanner } from "./CleanResultsBanner";
import { Dropdown } from "./Dropdown";

const SORT_OPTIONS = [
  { value: "size_desc", label: "Largest first" },
  { value: "size_asc", label: "Smallest first" },
  { value: "name_asc", label: "Name (A→Z)" },
] as const;

type SortMode = "size_desc" | "size_asc" | "name_asc";

interface ScanState {
  scanId: number | null;
  entries: AiCacheEntry[];
  scanErrors: number;
}

const INITIAL_SCAN: ScanState = { scanId: null, entries: [], scanErrors: 0 };

export function AiCachesPanel() {
  const [scan, setScan] = useState<ScanState>(INITIAL_SCAN);
  const [loading, setLoading] = useState(false);
  const [scanElapsedMs, setScanElapsedMs] = useState(0);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [results, setResults] = useState<CleanResult[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("size_desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string | null>(null);
  // Monotonically increasing refresh id used to drop stale results when the
  // user triggers a re-scan while one is already in flight.
  const refreshIdRef = useRef(0);

  // Aggregate found caches by id with totals — drives the filter chips.
  const cacheStats = useMemo(() => {
    const map = new Map<string, { name: string; count: number; bytes: number }>();
    for (const e of scan.entries) {
      if (!e.exists) continue;
      const v = map.get(e.id) ?? { name: e.name, count: 0, bytes: 0 };
      v.count += 1;
      v.bytes += e.size_bytes;
      map.set(e.id, v);
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [scan.entries]);

  const existing = useMemo(() => scan.entries.filter((e) => e.exists), [scan.entries]);
  const missing = useMemo(() => scan.entries.filter((e) => !e.exists), [scan.entries]);

  const visible = useMemo(() => {
    const lowered = search.trim().toLowerCase();
    let list = existing.filter((e) => {
      if (filter && e.id !== filter) return false;
      if (!lowered) return true;
      return (
        e.name.toLowerCase().includes(lowered) ||
        e.path.toLowerCase().includes(lowered)
      );
    });
    list = [...list];
    list.sort((a, b) => {
      if (sort === "size_desc") return b.size_bytes - a.size_bytes;
      if (sort === "size_asc") return a.size_bytes - b.size_bytes;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [existing, filter, search, sort]);

  const sizeByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of scan.entries) map.set(e.path, e.size_bytes);
    return map;
  }, [scan.entries]);

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
    setResults(null);
    setProgress(null);
    const startedAt = performance.now();
    setScanElapsedMs(0);
    try {
      const result = await scanAiCaches();
      if (refreshIdRef.current !== myId) return;
      result.entries.sort(
        (a, b) => Number(b.exists) - Number(a.exists) || b.size_bytes - a.size_bytes,
      );
      setScan({
        scanId: result.scan_id,
        entries: result.entries,
        scanErrors: result.scan_errors,
      });
      setSelected(new Set());
      setFilter(null);
      setScanElapsedMs(Math.round(performance.now() - startedAt));
      if (result.cancelled) {
        setError("Scan was cancelled; showing partial results.");
      }
    } catch (e) {
      if (refreshIdRef.current !== myId) return;
      setError(String(e));
    } finally {
      if (refreshIdRef.current === myId) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onScanProgress("ai", (p) => {
      if (!cancelled) setProgress(p);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleCancel = async () => {
    try {
      await cancelScan();
    } catch {
      // best-effort
    }
  };

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

  const confirmItems = useMemo<CleanItem[]>(() => {
    const items: CleanItem[] = [];
    for (const e of scan.entries) {
      if (!selected.has(e.path)) continue;
      items.push({
        path: e.path,
        label: e.name,
        context: e.id,
        size_bytes: e.size_bytes,
        category: e.category,
        note: e.note,
      });
    }
    items.sort((a, b) => b.size_bytes - a.size_bytes);
    return items;
  }, [scan.entries, selected]);

  const performClean = async () => {
    if (selected.size === 0) return;
    if (scan.scanId == null) {
      setError("Scan results are stale; please re-scan before cleaning.");
      return;
    }
    setConfirmOpen(false);
    setCleaning(true);
    setError(null);
    setSuccess(null);
    setResults(null);
    const paths = Array.from(selected);
    try {
      const results = await cleanPaths(scan.scanId, paths);
      const failures = results.filter((r) => !r.ok);
      const succeeded = results.filter((r) => r.ok);
      const freed = succeeded.reduce((acc, r) => acc + (sizeByPath.get(r.path) ?? 0), 0);

      await refresh();

      setResults(results);
      if (succeeded.length > 0) {
        setSuccess(
          `Freed ${formatBytes(freed)} across ${succeeded.length} cache${succeeded.length === 1 ? "" : "s"}.`,
        );
      }
      if (failures.length > 0 && succeeded.length === 0) {
        setError(`${failures.length} item(s) failed; expand the report below.`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setCleaning(false);
    }
  };

  const filterCleared = (next: string | null) => {
    if (selected.size > 0 && next !== filter) {
      setSelected(new Set());
    }
    setFilter(next);
  };

  return (
    <section className="panel" aria-busy={loading || cleaning}>
      <div className="panel-bar">
        <button className="btn primary" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Scanning…" : "Re-scan"}
        </button>
        {loading && (
          <button
            className="btn small"
            onClick={() => void handleCancel()}
            type="button"
          >
            Cancel
          </button>
        )}
        <span className="folder-path">
          Scanning home directory for known AI cache locations
        </span>
      </div>

      <div className="status-live" aria-live="polite" role="status">
        {loading
          ? progress && progress.total
            ? `Measuring ${progress.scanned}/${progress.total} known cache locations…`
            : "Looking for AI/LLM caches…"
          : ""}
        {!loading && scan.scanId != null && !success && !error
          ? `Scan complete in ${(scanElapsedMs / 1000).toFixed(1)}s.`
          : ""}
      </div>

      {success && (
        <div className="success" role="status">
          {success}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {scan.scanErrors > 0 && (
        <div className="warning" role="status">
          Some cache folders couldn’t be inspected ({scan.scanErrors} entr{scan.scanErrors === 1 ? "y" : "ies"} skipped). Totals may be conservative.
        </div>
      )}

      {results && (
        <CleanResultsBanner
          results={results}
          sizeByPath={sizeByPath}
          onDismiss={() => setResults(null)}
        />
      )}

      {cacheStats.length > 0 && (
        <div className="stack-filters" role="toolbar" aria-label="Filter caches by tool">
          <button
            className={filter === null ? "filter-chip active" : "filter-chip"}
            onClick={() => filterCleared(null)}
            aria-pressed={filter === null}
          >
            All <span className="filter-count">{existing.length}</span>
          </button>
          {cacheStats.map((s) => (
            <button
              key={s.id}
              className={filter === s.id ? "filter-chip active" : "filter-chip"}
              onClick={() => filterCleared(s.id)}
              title={`${formatBytes(s.bytes)} across ${s.count} location(s)`}
              aria-pressed={filter === s.id}
            >
              {s.name} <span className="filter-count">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {existing.length > 0 && (
        <div className="controls-row">
          <input
            type="search"
            className="search-input"
            placeholder="Filter by name or path"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search caches"
          />
          <div className="sort-control">
            <span className="sort-label">Sort</span>
            <Dropdown
              value={sort}
              options={SORT_OPTIONS}
              onChange={(next) => setSort(next as SortMode)}
              aria-label="Sort caches"
            />
          </div>
        </div>
      )}

      {visible.length > 0 && (
        <div className="summary">
          <div>
            <strong>{visible.length}</strong> location{visible.length === 1 ? "" : "s"}
            {filter ? ` (${cacheStats.find((s) => s.id === filter)?.name})` : ""} • total{" "}
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
              onClick={() => setConfirmOpen(true)}
            >
              {cleaning
                ? "Cleaning…"
                : `Clean ${selected.size} location${selected.size === 1 ? "" : "s"} — ${formatBytes(totalSelectedBytes)}`}
            </button>
          </div>
        </div>
      )}

      {loading && visible.length === 0 && (
        <div className="empty-state">Scanning…</div>
      )}

      {!loading && existing.length === 0 && missing.length === 0 && (
        <div className="empty-state">No AI tools detected on this system.</div>
      )}

      {!loading && existing.length === 0 && missing.length > 0 && (
        <div className="empty-state">
          <p>AI tools are installed, but their caches are empty or already cleared.</p>
        </div>
      )}

      {!loading && existing.length > 0 && visible.length === 0 && (
        <div className="empty-state">
          <p>No caches match the current filter or search.</p>
        </div>
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

      <ConfirmCleanDialog
        open={confirmOpen}
        title="Clean selected AI caches?"
        items={confirmItems}
        totalBytes={totalSelectedBytes}
        onConfirm={performClean}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
