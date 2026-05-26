import { useEffect, useMemo, useState } from "react";
import {
  cleanPaths,
  scanProjects,
  type DetectedProject,
} from "../lib/ipc";
import { formatBytes } from "../lib/format";

interface Props {
  root: string | null;
  onPickFolder: () => void;
}

export function ProjectsPanel({ root, onPickFolder }: Props) {
  const [projects, setProjects] = useState<DetectedProject[]>([]);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stackFilter, setStackFilter] = useState<string | null>(null);

  // Aggregate stacks across all scanned projects with counts and totals.
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
      .sort((a, b) => b.bytes - a.bytes);
  }, [projects]);

  const visibleProjects = useMemo(
    () =>
      stackFilter
        ? projects.filter((p) => p.stacks.includes(stackFilter))
        : projects,
    [projects, stackFilter],
  );

  const totalSelectedBytes = useMemo(
    () =>
      visibleProjects
        .flatMap((p) => p.cleanable)
        .filter((c) => selected.has(c.path))
        .reduce((acc, c) => acc + c.size_bytes, 0),
    [visibleProjects, selected],
  );

  const grandTotal = useMemo(
    () => visibleProjects.reduce((acc, p) => acc + p.total_cleanable_bytes, 0),
    [visibleProjects],
  );

  const runScan = async (target: string) => {
    setScanning(true);
    setError(null);
    setSuccess(null);
    setSelected(new Set());
    setStackFilter(null);
    try {
      const result = await scanProjects(target);
      // Hide projects with nothing to reclaim, sort by size desc.
      const filtered = result
        .map((p) => ({
          ...p,
          cleanable: p.cleanable.filter((c) => c.size_bytes > 0),
        }))
        .filter((p) => p.cleanable.length > 0 && p.total_cleanable_bytes > 0)
        .sort((a, b) => b.total_cleanable_bytes - a.total_cleanable_bytes);
      setProjects(filtered);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  // Auto-scan whenever the selected root changes.
  useEffect(() => {
    if (root) runScan(root);
    else setProjects([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(visibleProjects.flatMap((p) => p.cleanable.map((c) => c.path))));
  };

  const selectNone = () => setSelected(new Set());

  const handleClean = async () => {
    if (selected.size === 0) return;
    const paths = Array.from(selected);
    const sample = paths.slice(0, 5).join("\n");
    const ok = window.confirm(
      `Move ${paths.length} item(s) to the Recycle Bin / Trash?\n\n${sample}${
        paths.length > 5 ? `\n…and ${paths.length - 5} more` : ""
      }`,
    );
    if (!ok) return;

    // Size lookup for each selected path — captured before refresh wipes state.
    const sizeByPath = new Map<string, number>();
    for (const p of projects) {
      for (const c of p.cleanable) sizeByPath.set(c.path, c.size_bytes);
    }

    setCleaning(true);
    setError(null);
    setSuccess(null);
    try {
      const results = await cleanPaths(paths);
      const failures = results.filter((r) => !r.ok);
      const succeeded = results.filter((r) => r.ok);
      const freed = succeeded.reduce((acc, r) => acc + (sizeByPath.get(r.path) ?? 0), 0);

      // Refresh first — runScan clears banners — then set the success/error so they survive.
      if (root) await runScan(root);

      if (succeeded.length > 0) {
        setSuccess(`Freed ${formatBytes(freed)} across ${succeeded.length} location(s).`);
      }
      if (failures.length > 0) {
        setError(
          `${failures.length} item(s) failed: ${failures
            .slice(0, 3)
            .map((f) => `${f.path}: ${f.error}`)
            .join("; ")}`,
        );
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
        <button className="btn primary" onClick={onPickFolder}>
          {root ? "Change folder" : "Pick a folder"}
        </button>
        <button
          className="btn"
          onClick={() => root && runScan(root)}
          disabled={!root || scanning}
        >
          {scanning ? "Scanning…" : "Re-scan"}
        </button>
        <span className="folder-path" title={root ?? ""}>
          {root ?? "No folder selected"}
        </span>
      </div>

      {success && <div className="success">{success}</div>}
      {error && <div className="error">{error}</div>}

      {stackStats.length > 0 && (
        <div className="stack-filters">
          <button
            className={stackFilter === null ? "filter-chip active" : "filter-chip"}
            onClick={() => {
              setStackFilter(null);
              setSelected(new Set());
            }}
          >
            All <span className="filter-count">{projects.length}</span>
          </button>
          {stackStats.map((s) => (
            <button
              key={s.name}
              className={stackFilter === s.name ? "filter-chip active" : "filter-chip"}
              onClick={() => {
                setStackFilter(s.name);
                setSelected(new Set());
              }}
              title={`${formatBytes(s.bytes)} across ${s.count} project(s)`}
            >
              {s.name} <span className="filter-count">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {visibleProjects.length > 0 && (
        <div className="summary">
          <div>
            <strong>{visibleProjects.length}</strong> project(s)
            {stackFilter ? ` (${stackFilter})` : ""}, total cleanable:{" "}
            <strong>{formatBytes(grandTotal)}</strong>
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
                <li key={c.path}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(c.path)}
                      onChange={() => toggle(c.path)}
                    />
                    <span className="cleanable-label">{c.label}</span>
                    <span className="cleanable-path" title={c.path}>
                      {c.path}
                    </span>
                    <span className="cleanable-size">
                      {formatBytes(c.size_bytes)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      {!scanning && root && projects.length === 0 && (
        <div className="empty-state">
          Nothing cleanable found in this folder.
        </div>
      )}

      {!root && !scanning && (
        <div className="empty-state">
          Pick a folder to scan for cleanable build artifacts.
        </div>
      )}
    </section>
  );
}
