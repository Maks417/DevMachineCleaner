import { useCallback, useEffect, useMemo, useState } from "react";
import { scanProjects, type DetectedProject } from "../lib/ipc";
import { useCleanPanel, type NormalizedScan } from "../lib/useCleanPanel";
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

const DEPTH_OPTIONS = [
  { value: "4", label: "Depth 4 (shallow)" },
  { value: "6", label: "Depth 6 (default)" },
  { value: "8", label: "Depth 8" },
  { value: "10", label: "Depth 10" },
  { value: "12", label: "Depth 12 (deep)" },
] as const;

const DEFAULT_DEPTH = 6;

interface Props {
  root: string | null;
  onPickFolder: () => void;
}

type SortMode = "size_desc" | "size_asc" | "name_asc";

// Filter zero-byte cleanables/projects (Rust returns them; the UI hides them)
// and sort by reclaimable size descending.
function normalizeProjects(result: {
  scan_id: number;
  projects: DetectedProject[];
  scan_errors: number;
  cancelled: boolean;
}): NormalizedScan<DetectedProject> {
  const items = result.projects
    .map((p) => ({
      ...p,
      cleanable: p.cleanable.filter((c) => c.size_bytes > 0),
    }))
    .filter((p) => p.cleanable.length > 0 && p.total_cleanable_bytes > 0)
    .sort((a, b) => b.total_cleanable_bytes - a.total_cleanable_bytes);
  return {
    scanId: result.scan_id,
    items,
    scanErrors: result.scan_errors,
    cancelled: result.cancelled,
  };
}

const sizeByPathFn = (projects: DetectedProject[]) => {
  const map = new Map<string, number>();
  for (const p of projects) for (const c of p.cleanable) map.set(c.path, c.size_bytes);
  return map;
};

export function ProjectsPanel({ root, onPickFolder }: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("size_desc");
  const [depth, setDepth] = useState<number>(DEFAULT_DEPTH);
  const [stackFilter, setStackFilter] = useState<string | null>(null);

  const onScanStart = useCallback(() => setStackFilter(null), []);

  const {
    items: projects,
    scanId,
    scanErrors,
    scanning,
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
    resetScan,
    cancel,
    toggle,
    setSelected,
    selectNone,
    setConfirmOpen,
    setResults,
    performClean,
  } = useCleanPanel<DetectedProject>({
    kind: "projects",
    sizeByPath: sizeByPathFn,
    cleanedNoun: "location",
    onScanStart,
  });

  const makeScan = useCallback(
    (target: string, scanDepth: number) => async () =>
      normalizeProjects(await scanProjects(target, scanDepth)),
    [],
  );

  // Aggregate stacks across all scanned projects. `bytes` is the reclaimable
  // total of projects that include the stack; for polyglot/monorepo projects a
  // single project counts toward each of its stacks, so these per-stack totals
  // can overlap and are not additive — the chip tooltip says so explicitly.
  const stackStats = useMemo(() => {
    const map = new Map<string, { count: number; bytes: number }>();
    for (const p of projects) {
      for (const s of p.stacks) {
        const entry = map.get(s) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += p.total_cleanable_bytes;
        map.set(s, entry);
      }
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.count - a.count || b.bytes - a.bytes);
  }, [projects]);

  const visibleProjects = useMemo(() => {
    const lowered = search.trim().toLowerCase();
    let list = projects.filter((p) => {
      if (stackFilter && !p.stacks.includes(stackFilter)) return false;
      if (!lowered) return true;
      return (
        p.name.toLowerCase().includes(lowered) ||
        p.path.toLowerCase().includes(lowered) ||
        p.cleanable.some((c) => c.label.toLowerCase().includes(lowered))
      );
    });
    list = [...list];
    list.sort((a, b) => {
      if (sort === "size_desc") return b.total_cleanable_bytes - a.total_cleanable_bytes;
      if (sort === "size_asc") return a.total_cleanable_bytes - b.total_cleanable_bytes;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [projects, stackFilter, search, sort]);

  const visibleCleanableCount = useMemo(
    () => visibleProjects.reduce((acc, p) => acc + p.cleanable.length, 0),
    [visibleProjects],
  );

  const grandTotal = useMemo(
    () => visibleProjects.reduce((acc, p) => acc + p.total_cleanable_bytes, 0),
    [visibleProjects],
  );

  // Auto-scan whenever the selected root or scan depth changes.
  useEffect(() => {
    if (root) void runScan(makeScan(root, depth));
    else resetScan();
  }, [root, depth, runScan, resetScan, makeScan]);

  const selectAll = () => {
    setSelected(new Set(visibleProjects.flatMap((p) => p.cleanable.map((c) => c.path))));
  };

  // Items shown in the confirm dialog, indexed back to their project for context.
  const confirmItems = useMemo<CleanItem[]>(() => {
    const items: CleanItem[] = [];
    for (const p of projects) {
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
  }, [projects, selected]);

  const onConfirmClean = () => {
    if (root) void performClean(makeScan(root, depth));
  };

  const stackFilterCleared = (next: string | null) => {
    if (selected.size > 0 && next !== stackFilter) selectNone();
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
          onClick={() => root && void runScan(makeScan(root, depth))}
          disabled={!root || scanning}
        >
          {scanning ? "Scanning…" : "Re-scan"}
        </button>
        {scanning && (
          <button className="btn small" onClick={() => void cancel()} type="button">
            Cancel
          </button>
        )}
        {root && (
          <div className="sort-control">
            <span className="sort-label">Depth</span>
            <Dropdown
              value={String(depth)}
              options={DEPTH_OPTIONS}
              onChange={(next) => setDepth(Number(next))}
              aria-label="Scan depth"
            />
          </div>
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
        {!scanning && scanId != null && !success && !error
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
          Some folders couldn’t be inspected ({scanErrors} entr{scanErrors === 1 ? "y" : "ies"} skipped). Totals may be conservative.
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
            All <span className="filter-count">{projects.length}</span>
          </button>
          {stackStats.map((s) => (
            <button
              key={s.name}
              className={stackFilter === s.name ? "filter-chip active" : "filter-chip"}
              onClick={() => stackFilterCleared(s.name)}
              title={`${s.count} project${s.count === 1 ? "" : "s"} include ${s.name} • ${formatBytes(s.bytes)} reclaimable in them (may overlap other stacks)`}
              aria-pressed={stackFilter === s.name}
            >
              {s.name} <span className="filter-count">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {projects.length > 0 && (
        <div className="controls-row">
          <input
            type="search"
            className="search-input"
            placeholder="Filter by name, path, or folder"
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

      {!scanning && root && projects.length === 0 && (
        <div className="empty-state">
          <p>Nothing cleanable found in this folder.</p>
          <p className="empty-hint">
            We look for build artifacts, dependency installs, and tool caches inside known
            stacks (Node, Rust, Python, Go, .NET, and more). If your stack is supported but
            nothing turned up, try increasing the scan depth above.
          </p>
        </div>
      )}

      {!scanning && root && projects.length > 0 && visibleProjects.length === 0 && (
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
        onConfirm={onConfirmClean}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}
