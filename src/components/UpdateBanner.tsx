import { formatBytes } from "../lib/format";
import type { UpdaterState } from "../lib/useUpdater";

type Props = Pick<
  UpdaterState,
  "status" | "update" | "downloaded" | "contentLength" | "error"
> & {
  onInstall: () => void;
  onDismiss: () => void;
};

/**
 * Bottom-anchored toast shown once the updater has found a newer signed
 * release. Presents the target version + release notes and lets the user
 * install (download → verify → relaunch) or defer. Manual "up to date" /
 * check-error feedback lives inline in the footer instead — this card only
 * appears when there's an actual update to act on.
 */
export function UpdateBanner({
  status,
  update,
  downloaded,
  contentLength,
  error,
  onInstall,
  onDismiss,
}: Props) {
  // Only surface once an update has been found; check/idle/uptodate states show
  // nothing here.
  if (!update) return null;

  const downloading = status === "downloading";
  const ready = status === "ready";
  const failed = status === "error";
  const busy = downloading || ready;
  const pct =
    contentLength && contentLength > 0
      ? Math.min(100, Math.round((downloaded / contentLength) * 100))
      : null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-toast-head">
        <span className="update-toast-title">
          {ready ? "Restarting…" : "Update available"}
        </span>
        <span className="update-toast-version">v{update.version}</span>
      </div>

      {update.body && !downloading && !ready && (
        <p className="update-toast-notes">{update.body}</p>
      )}

      {downloading && (
        <div className="update-toast-progress">
          <div
            className="update-toast-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <span
              className={pct == null ? "update-toast-fill indeterminate" : "update-toast-fill"}
              style={pct == null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <span className="update-toast-progress-label">
            {pct != null
              ? `${pct}% • ${formatBytes(downloaded)} / ${formatBytes(contentLength!)}`
              : `Downloading… ${formatBytes(downloaded)}`}
          </span>
        </div>
      )}

      {failed && error && <p className="update-toast-error">{error}</p>}

      {!ready && (
        <div className="update-toast-actions">
          <button
            className="btn small"
            type="button"
            onClick={onDismiss}
            disabled={busy}
          >
            Later
          </button>
          <button
            className="btn primary small"
            type="button"
            onClick={onInstall}
            disabled={busy}
          >
            {downloading ? "Updating…" : failed ? "Retry" : "Update now"}
          </button>
        </div>
      )}
    </div>
  );
}
