import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelScan,
  cleanPaths,
  onScanProgress,
  scanProjects,
  type CleanResult,
  type DetectedProject,
  type ScanProgress,
} from "../lib/ipc";
import { formatBytes } from "../lib/format";
import { CleanableRow } from "./CleanableRow";
import { ConfirmCleanDialog, type CleanItem } from "./ConfirmCleanDialog";
import { CleanResultsBanner } from "./CleanResultsBanner";
import { Dropdown } from "./Dropdown";

const SORT_OPTIONS = [
  { value: "size_desc", label: "Largest first" },
  { value: "size_asc", label: "Smallest first" },
  { value: "name_asc", label: "Name (A→Z)" },
] as const;

interface Props {
  root: string | null;
  onPickFolder: () => void;
}

type SortMode = "size_desc" | "size_asc" | "name_asc";

interface ScanState {
  scanId: number | null;
  projects: DetectedProject[];
  scanErrors: number;
}

const INITIAL_SCAN: ScanState = { scanId: null, projects: [], scanErrors: 0 };

export function ProjectsPanel({ root, onPickFolder }: Props) {
  const [scan, setScan] = useState<ScanState>(INITIAL_SCAN);
  const [scanning, setScanning] = useState(false);
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
  const [stackFilter, setStackFilter] = useState<string | null>(null);
  // Monotonically increasing scan id used to drop stale results when the user
  // rescans rapidly or switches roots mid-scan.
  const scanIdRef = useRef(0);

  // Aggregate stacks across all scanned projects with counts and totals.
  const stackStats = useMemo(() => {
    const map = new Map<string, { count: number; bytes: number }>();
    for (const p of scan.projects) {
      for (const s of p.stacks) {
        const entry = map.get(s) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += p.total_cleanable_bytes;
        map.set(s, entry);
      }
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [scan.projects]);

  const visibleProjects = useMemo(() => {
    const lowered = search.trim().toLowerCase();
    let list = scan.projects.filter((p) => {
      if (stackFilter && !p.stacks.includes(stackFilter)) return false;
      if (!lowered) return true;
      return (
        p.name.toLowerCase().includes(lowered) ||
        p.path.toLowerCase().includes(lowered)
      );
    });
    list = [...list];
    list.sort((a, b) => {
      if (sort === "size_desc") return b.total_cleanable_bytes - a.total_cleanable_bytes;
      if (sort === "size_asc") return a.total_cleanable_bytes - b.total_cleanable_bytes;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [scan.projects, stackFilter, search, sort]);

  // Sum of `size_bytes` per cleanable path across all loaded projects. Cached
  // so totalSelectedBytes can be computed in O(selected) instead of scanning
  // every visible row on every selection change.
  const sizeByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of scan.projects) {
      for (const c of p.cleanable) map.set(c.path, c.size_bytes);
    }
    return map;
  }, [scan.projects]);

  const totalSelectedBytes = useMemo(() => {
    let total = 0;
    for (const path of selected) total += sizeByPath.get(path) ?? 0;
    return total;
  }, [selected, sizeByPath]);

  const visibleCleanableCount = useMemo(
    () => visibleProjects.reduce((acc, p) => acc + p.cleanable.length, 0),
    [visibleProjects],
  );

  const grandTotal = useMemo(
    () => visibleProjects.reduce((acc, p) => acc + p.total_cleanable_bytes, 0),
    [visibleProjects],
  );

  const runScan = useCallback(async (target: string) => {
    const myId = ++scanIdRef.current;
    setScanning(true);
    setError(null);
    setSuccess(null);
    setResults(null);
    setSelected(new Set());
    setStackFilter(null);
    setProgress(null);
    const startedAt = performance.now();
    setScanElapsedMs(0);
    try {
      const result = await scanProjects(target);
      if (scanIdRef.current !== myId) return;
      // Hide projects with nothing to reclaim, sort by size desc.
      const filtered = result.projects
        .map((p) => ({
          ...p,
          cleanable: p.cleanable.filter((c) => c.size_bytes > 0),
        }))
        .filter((p) => p.cleanable.length > 0 && p.total_cleanable_bytes > 0)
        .sort((a, b) => b.total_cleanable_bytes - a.total_cleanable_bytes);
      setScan({
        scanId: result.scan_id,
        projects: filtered,
        scanErrors: result.scan_errors,
      });
      setScanElapsedMs(Math.round(performance.now() - startedAt));
      if (result.cancelled) {
        setError("Scan was cancelled; showing partial results.");
      }
    } catch (e) {
      if (scanIdRef.current !== myId) return;
      setError(String(e));
    } finally {
      if (scanIdRef.current === myId) {
        setScanning(false);
        setProgress(null);
      }
    }
  }, []);

  // Subscribe to scanner progress events once on mount; the unlisten function
  // is returned synchronously by listen() once the channel is registered.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onScanProgress("projects", (p) => {
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
      // Cancel is best-effort; if it failed, the in-flight scan will still
      // finish normally and the result handler will refresh state.
    }
  };

  // Auto-scan whenever the selected root changes.
  useEffect(() => {
    if (root) {
      void runScan(root);
    } else {
      scanIdRef.current++;
      setScan(INITIAL_SCAN);
    }
  }, [root, runScan]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAll = () => {
    setSelected(new Set(visibleProjects.flatMap((p) => p.cleanable.map((c) => c.path))));
  };

  const selectNone = () => setSelected(new Set());

  // Items shown in the confirm dialog, indexed back to their project for context.
  const confirmItems = useMemo<CleanItem[]>(() => {
    const items: CleanItem[] = [];
    for (const p of scan.projects) {
      for (const c of p.cleanable) {
        if (!selected.has(c.path)) continue;
        items.push({
          path: c.path,
          label: c.label,
          context: p.name,
          size_bytes: c.size_bytes,
          category: c.category,
          note: c.note,
        });
      }
    }
    items.sort((a, b) => b.size_bytes - a.size_bytes);
    return items;
  }, [scan.projects, selected]);

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

      // Refresh first — runScan clears banners — then set status so they survive.
      if (root) await runScan(root);

      setResults(results);
      if (succeeded.length > 0) {
        setSuccess(
          `Freed ${formatBytes(freed)} across ${succeeded.length} location${succeeded.length === 1 ? "" : "s"}.`,
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

  const stackFilterCleared = (next: string | null) => {
    if (selected.size > 0 && next !== stackFilter) {
      setSelected(new Set());
    }
    setStackFilter(next);
  };

  return (
    <section className="panel" aria-busy={scanning || cleaning}>
      <div className="panel-bar">
        <button className="btn primary" onClick={onPickFolder}>
          {root ? "Change folder" : "Pick a folder"}
        </button>
        <button
          className="btn"
          onClick={() => root && void runScan(root)}
          disabled={!root || scanning}
        >
          {scanning ? "Scanning…" : "Re-scan"}
        </button>
        {scanning && (
          <button
            className="btn small"
            onClick={() => void handleCancel()}
            type="button"
          >
            Cancel
          </button>
        )}
        <span className="folder-path" title={root ?? ""}>
          {root ?? "No folder selected"}
        </span>
      </div>

      <div className="status-live" aria-live="polite" role="status">
        {scanning && root
          ? progress
            ? progress.phase === "sizing" && progress.total
              ? `Measuring ${progress.scanned}/${progress.total} cleanable folders…`
              : `Scanning ${root}… (${progress.scanned.toLocaleString()} entries)`
            : `Scanning ${root}…`
          : ""}
        {!scanning && scan.scanId != null && !success && !error
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
          Some folders couldn’t be inspected ({scan.scanErrors} entr{scan.scanErrors === 1 ? "y" : "ies"} skipped). Totals may be conservative.
        </div>
      )}

      {results && (
        <CleanResultsBanner
          results={results}
          sizeByPath={sizeByPath}
          onDismiss={() => setResults(null)}
        />
      )}

      {stackStats.length > 0 && (
        <div className="stack-filters" role="toolbar" aria-label="Filter projects by stack">
          <button
            className={stackFilter === null ? "filter-chip active" : "filter-chip"}
            onClick={() => stackFilterCleared(null)}
            aria-pressed={stackFilter === null}
          >
            All <span className="filter-count">{scan.projects.length}</span>
          </button>
          {stackStats.map((s) => (
            <button
              key={s.name}
              className={stackFilter === s.name ? "filter-chip active" : "filter-chip"}
              onClick={() => stackFilterCleared(s.name)}
              title={`${formatBytes(s.bytes)} across ${s.count} project(s)`}
              aria-pressed={stackFilter === s.name}
            >
              {s.name} <span className="filter-count">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {scan.projects.length > 0 && (
        <div className="controls-row">
          <input
            type="search"
            className="search-input"
            placeholder="Filter by name or path"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search projects"
          />
          <div className="sort-control">
            <span className="sort-label">Sort</span>
            <Dropdown
              value={sort}
              options={SORT_OPTIONS}
              onChange={(next) => setSort(next as SortMode)}
              aria-label="Sort projects"
            />
          </div>
        </div>
      )}

      {visibleProjects.length > 0 && (
        <div className="summary">
          <div>
            <strong>{visibleProjects.length}</strong> project{visibleProjects.length === 1 ? "" : "s"}
            {stackFilter ? ` (${stackFilter})` : ""} •{" "}
            <strong>{visibleCleanableCount}</strong> cleanable location{visibleCleanableCount === 1 ? "" : "s"} •{" "}
            total <strong>{formatBytes(grandTotal)}</strong>
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

      <div className="project-list">
        {visibleProjects.map((p) => (
          <article key={p.path} className="project-card">
            <header className="project-head">
              <div>
                <h3>{p.name}</h3>
                <div className="project-path" title={p.path}>
                  {p.path}
                </div>
              </div>
              <div className="project-meta">
                <div className="stacks">
                  {p.stacks.map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
                <div className="size">{formatBytes(p.total_cleanable_bytes)}</div>
              </div>
            </header>
            <ul className="cleanable-list">
              {p.cleanable.map((c) => (
                <CleanableRow
                  key={c.path}
                  cleanable={c}
                  checked={selected.has(c.path)}
                  onToggle={toggle}
                />
              ))}
            </ul>
          </article>
        ))}
      </div>

      {!scanning && root && scan.projects.length === 0 && (
        <div className="empty-state">
          <p>Nothing cleanable found in this folder.</p>
          <p className="empty-hint">
            We look for build artifacts, dependency installs, and tool caches inside known
            stacks (Node, Rust, Python, Go, .NET, and more). If your stack is supported but
            nothing turned up, the folder may be deeper than the scan depth.
          </p>
        </div>
      )}

      {!scanning && root && scan.projects.length > 0 && visibleProjects.length === 0 && (
        <div className="empty-state">
          <p>No projects match the current filter or search.</p>
        </div>
      )}

      {!root && !scanning && (
        <div className="empty-state">
          Pick a folder to scan for cleanable build artifacts.
        </div>
      )}

      <ConfirmCleanDialog
        open={confirmOpen}
        title="Clean selected project artifacts?"
        items={confirmItems}
        totalBytes={totalSelectedBytes}
        onConfirm={performClean}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
