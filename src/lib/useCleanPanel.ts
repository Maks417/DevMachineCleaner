import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelScan,
  cleanPaths,
  onScanProgress,
  type CleanResult,
  type ScanProgress,
} from "./ipc";
import { formatBytes } from "./format";

/**
 * Result of a scan after the panel has normalized it (filtered, sorted, and
 * mapped to the item type the panel renders). The hook stores this verbatim.
 */
export interface NormalizedScan<T> {
  scanId: number;
  items: T[];
  scanErrors: number;
  cancelled: boolean;
}

interface ScanState<T> {
  scanId: number | null;
  items: T[];
  scanErrors: number;
}

interface Options<T> {
  /** Progress event channel — `"projects"` or `"ai"`. */
  kind: "projects" | "ai";
  /** Build the `path -> bytes` map used for selection totals and freed calc. */
  sizeByPath: (items: T[]) => Map<string, number>;
  /** Singular noun used in the success banner, e.g. `"location"` / `"cache"`. */
  cleanedNoun: string;
  /** Optional side effect run when a scan starts (e.g. reset a stack filter). */
  onScanStart?: () => void;
}

/**
 * Shared scan/select/clean state machine for the Projects and AI caches panels.
 * Owns the loading lifecycle (with stale-result guard), progress subscription,
 * selection set, and the clean flow (confirm -> cleanPaths -> re-scan ->
 * success/partial-failure banners). Panel-specific concerns (filters, search,
 * sort, rendering, item-to-CleanItem mapping) stay in the components.
 */
export function useCleanPanel<T>({
  kind,
  sizeByPath: sizeByPathFn,
  cleanedNoun,
  onScanStart,
}: Options<T>) {
  const [scan, setScan] = useState<ScanState<T>>({
    scanId: null,
    items: [],
    scanErrors: 0,
  });
  const [scanning, setScanning] = useState(false);
  const [scanElapsedMs, setScanElapsedMs] = useState(0);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [results, setResults] = useState<CleanResult[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Monotonically increasing scan id used to drop stale results when the user
  // rescans rapidly or switches inputs mid-scan.
  const scanIdRef = useRef(0);

  const sizeByPath = useMemo(
    () => sizeByPathFn(scan.items),
    [scan.items, sizeByPathFn],
  );

  const totalSelectedBytes = useMemo(() => {
    let total = 0;
    for (const path of selected) total += sizeByPath.get(path) ?? 0;
    return total;
  }, [selected, sizeByPath]);

  const runScan = useCallback(
    async (doScan: () => Promise<NormalizedScan<T>>) => {
      const myId = ++scanIdRef.current;
      setScanning(true);
      setError(null);
      setWarning(null);
      setSuccess(null);
      setResults(null);
      setSelected(new Set());
      setProgress(null);
      onScanStart?.();
      const startedAt = performance.now();
      setScanElapsedMs(0);
      try {
        const result = await doScan();
        if (scanIdRef.current !== myId) return;
        setScan({
          scanId: result.scanId,
          items: result.items,
          scanErrors: result.scanErrors,
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
    },
    [onScanStart],
  );

  // Drop any in-flight scan result and clear state (used when the input that
  // drives scanning goes away, e.g. the picked folder is cleared).
  const resetScan = useCallback(() => {
    scanIdRef.current++;
    setScan({ scanId: null, items: [], scanErrors: 0 });
  }, []);

  // Subscribe to scanner progress events once; the unlisten function is
  // returned asynchronously by listen() after the channel is registered.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onScanProgress(kind, (p) => {
      if (!cancelled) setProgress(p);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [kind]);

  const cancel = useCallback(async () => {
    try {
      await cancelScan();
    } catch {
      // Cancel is best-effort; the in-flight scan will still finish and the
      // result handler refreshes state.
    }
  }, []);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectNone = useCallback(() => setSelected(new Set()), []);

  const performClean = useCallback(
    async (rescan: () => Promise<NormalizedScan<T>>) => {
      if (selected.size === 0) return;
      if (scan.scanId == null) {
        setError("Scan results are stale; please re-scan before cleaning.");
        return;
      }
      setConfirmOpen(false);
      setCleaning(true);
      setError(null);
      setWarning(null);
      setSuccess(null);
      setResults(null);
      const paths = Array.from(selected);
      try {
        const res = await cleanPaths(scan.scanId, paths);
        const failures = res.filter((r) => !r.ok);
        const succeeded = res.filter((r) => r.ok);
        const freed = succeeded.reduce(
          (acc, r) => acc + (sizeByPath.get(r.path) ?? 0),
          0,
        );

        // Refresh first — runScan clears banners — then set status to survive.
        await runScan(rescan);

        setResults(res);
        if (succeeded.length > 0) {
          setSuccess(
            `Freed ${formatBytes(freed)} across ${succeeded.length} ${cleanedNoun}${succeeded.length === 1 ? "" : "s"}.`,
          );
        }
        if (failures.length > 0) {
          const msg = `${failures.length} item${failures.length === 1 ? "" : "s"} failed; expand the report below.`;
          // All-failure is an error; a mix is a warning beside the success.
          if (succeeded.length === 0) setError(msg);
          else setWarning(msg);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setCleaning(false);
      }
    },
    [selected, scan.scanId, sizeByPath, runScan, cleanedNoun],
  );

  return {
    // state
    scanId: scan.scanId,
    items: scan.items,
    scanErrors: scan.scanErrors,
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
    // actions
    runScan,
    resetScan,
    cancel,
    toggle,
    setSelected,
    selectNone,
    setConfirmOpen,
    setResults,
    performClean,
  };
}
