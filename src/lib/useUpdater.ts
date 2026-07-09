import { useCallback, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Update lifecycle status.
 * - `idle`        — nothing in flight, no update surfaced.
 * - `checking`    — a check is running.
 * - `uptodate`    — the last check found no newer version.
 * - `available`   — a newer signed release exists (see `update`).
 * - `downloading` — bundle is being fetched (see `downloaded` / `contentLength`).
 * - `ready`       — installed; relaunch pending.
 * - `error`       — the check or install failed (see `error`).
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface CheckOptions {
  /**
   * Silent checks (startup) swallow network errors and never surface an
   * "up to date" result — offline or same-version shouldn't nag the user.
   * Manual checks (`silent: false`) report both outcomes.
   */
  silent?: boolean;
}

export interface UpdaterState {
  status: UpdateStatus;
  /** The pending update once `status === "available"` (version, notes). */
  update: Update | null;
  /** Bytes downloaded so far during `downloading`. */
  downloaded: number;
  /** Total bytes to download, when the server reported a length. */
  contentLength: number | null;
  /** Human-readable error for the manual-check / install paths. */
  error: string | null;
  checkForUpdate: (opts?: CheckOptions) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  /** Dismiss the banner without installing; returns to `idle`. */
  dismiss: () => void;
}

/**
 * Drives the Tauri updater from the UI: check GitHub for a newer signed
 * release, download + install it, then relaunch. Mirrors the state-machine
 * style of {@link useCleanPanel}. The actual network + signature verification
 * happens in the Rust updater plugin; this hook only orchestrates the flow.
 */
export function useUpdater(): UpdaterState {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards against overlapping checks/installs (e.g. the startup check racing a
  // rapid manual click).
  const busyRef = useRef(false);

  const checkForUpdate = useCallback(async (opts?: CheckOptions) => {
    const silent = opts?.silent ?? false;
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setStatus("checking");
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setStatus("available");
      } else {
        setUpdate(null);
        // A silent (startup) "no update" returns quietly to idle so nothing is
        // shown; a manual check reports "up to date".
        setStatus(silent ? "idle" : "uptodate");
      }
    } catch (e) {
      // Startup checks fail quietly (offline is normal); manual checks surface it.
      if (silent) {
        setStatus("idle");
      } else {
        setError(String(e));
        setStatus("error");
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (busyRef.current) return;
    if (!update) return;
    busyRef.current = true;
    setError(null);
    setDownloaded(0);
    setContentLength(null);
    setStatus("downloading");
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setContentLength(event.data.contentLength ?? null);
            break;
          case "Progress":
            setDownloaded((d) => d + event.data.chunkLength);
            break;
          case "Finished":
            setStatus("ready");
            break;
        }
      });
      setStatus("ready");
      // Restart into the freshly installed version. On Windows the NSIS
      // installer may exit the app itself, so this is best-effort.
      await relaunch();
    } catch (e) {
      setError(String(e));
      setStatus("error");
    } finally {
      busyRef.current = false;
    }
  }, [update]);

  const dismiss = useCallback(() => {
    // Don't yank the UI out from under an in-progress download/install.
    if (busyRef.current) return;
    setUpdate(null);
    setError(null);
    setStatus("idle");
  }, []);

  return {
    status,
    update,
    downloaded,
    contentLength,
    error,
    checkForUpdate,
    downloadAndInstall,
    dismiss,
  };
}
