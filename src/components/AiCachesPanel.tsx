import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanAiCaches, type AiCacheEntry } from "../lib/ipc";
import { useCleanPanel, type NormalizedScan } from "../lib/useCleanPanel";
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

interface Props {
  /** True when the AI caches tab is visible. Drives the lazy initial scan. */
  active: boolean;
}

const sizeByPathFn = (entries: AiCacheEntry[]) => {
  const map = new Map<string, number>();
  for (const e of entries) map.set(e.path, e.size_bytes);
  return map;
};

export function AiCachesPanel({ active }: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("size_desc");
  const [filter, setFilter] = useState<string | null>(null);
  // Guards the one-time auto-scan so it runs only the first time the tab is
  // shown, not on app mount (the panel is always mounted).
  const hasScannedRef = useRef(false);

  const onScanStart = useCallback(() => setFilter(null), []);

  const {
    items: entries,
    scanId,
    scanErrors,
    scanning: loading,
    scanElapsedMs,
    progress,
    cleaning,
    error,
    warning,
    success,
    results,
    confirmOpen,
    selected,
    sizeByPath,
    totalSelectedBytes,
    runScan,
    cancel,
    toggle,
    setSelected,
    selectNone,
    setConfirmOpen,
    setResults,
    performClean,
  } = useCleanPanel<AiCacheEntry>({
    kind: "ai",
    sizeByPath: sizeByPathFn,
    cleanedNoun: "cache",
    onScanStart,
  });

  // Existing entries first, then by size descending.
  const doScan = useCallback(async (): Promise<NormalizedScan<AiCacheEntry>> => {
    const result = await scanAiCaches();
    const items = [...result.entries].sort(
      (a, b) => Number(b.exists) - Number(a.exists) || b.size_bytes - a.size_bytes,
    );
    return {
      scanId: result.scan_id,
      items,
      scanErrors: result.scan_errors,
      cancelled: result.cancelled,
    };
  }, []);

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

  const totalVisibleBytes = useMemo(
    () => visible.reduce((acc, e) => acc + e.size_bytes, 0),
    [visible],
  );

  // Lazy initial scan: scan the first time this tab becomes active.
  useEffect(() => {
    if (active && !hasScannedRef.current) {
      hasScannedRef.current = true;
      void runScan(doScan);
    }
  }, [active, runScan, doScan]);

  const selectAll = () => setSelected(new Set(visible.map((e) => e.path)));

  const confirmItems = useMemo<CleanItem[]>(() => {
    const items: CleanItem[] = [];
    for (const e of entries) {
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
  }, [entries, selected]);

  const filterCleared = (next: string | null) => {
    if (selected.size > 0 && next !== filter) selectNone();
    setFilter(next);
  };

  return (
    <section className="panel" aria-busy={loading || cleaning}>
      <div className="panel-bar">
        <button className="btn primary" onClick={() => void runScan(doScan)} disabled={loading}>
          {loading ? "Scanning…" : "Re-scan"}
        </button>
        {loading && (
          <button className="btn small" onClick={() => void cancel()} type="button">
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
        {!loading && scanId != null && !success && !error
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
      {warning && (
        <div className="warning" role="status">
          {warning}
        </div>
      )}
      {scanErrors > 0 && (
        <div className="warning" role="status">
          Some cache folders couldn’t be inspected ({scanErrors} entr{scanErrors === 1 ? "y" : "ies"} skipped). Totals may be conservative.
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
        onConfirm={() => void performClean(doScan)}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
