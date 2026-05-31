import { useEffect, useMemo, useRef } from "react";
import { formatBytes } from "../lib/format";

export interface CleanItem {
  path: string;
  /** Short label like a directory name (e.g. `node_modules`). */
  label: string;
  /** Where this lives — project name or cache tool id. */
  context: string;
  size_bytes: number;
  /** "dependencies", "build output", "cache", "model weights", "logs". */
  category: string;
  /** One-liner explaining what regenerates the path. */
  note: string;
}

interface Props {
  open: boolean;
  title: string;
  items: CleanItem[];
  totalBytes: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app cleaning confirmation dialog. Replaces `window.confirm` so we can
 * surface total bytes, per-item paths/sizes, and category breakdown before the
 * user commits to a destructive action.
 *
 * Items are moved to the OS Recycle Bin / Trash so the user can restore them,
 * which is the core reason this app is safe to use. The dialog repeats that
 * promise prominently next to the danger button.
 */
export function ConfirmCleanDialog({
  open,
  title,
  items,
  totalBytes,
  onConfirm,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the non-destructive Cancel button first so an accidental Enter
    // does not immediately trash files. Deferred until the dialog has mounted.
    const t = setTimeout(() => cancelRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Lock background scroll while the modal is open so the page behind the
  // backdrop cannot move under the dialog.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Bucket items by category so users see "this much is rebuildable" vs "this
  // much will redownload" at a glance.
  const buckets = useMemo(() => {
    const map = new Map<string, { count: number; bytes: number }>();
    for (const it of items) {
      const v = map.get(it.category) ?? { count: 0, bytes: 0 };
      v.count += 1;
      v.bytes += it.size_bytes;
      map.set(it.category, v);
    }
    return Array.from(map.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [items]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    // Trap focus inside the dialog so Tab/Shift+Tab cycles only its controls.
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-clean-title"
      onClick={onCancel}
      onKeyDown={onKeyDown}
    >
      <div className="dialog" ref={dialogRef} onClick={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <h2 id="confirm-clean-title">{title}</h2>
          <button
            className="dialog-close"
            onClick={onCancel}
            aria-label="Cancel"
            type="button"
          >
            ×
          </button>
        </header>

        <div className="dialog-summary">
          <div>
            <span className="dialog-summary-count">
              {items.length} location{items.length === 1 ? "" : "s"}
            </span>{" "}
            • total <strong>{formatBytes(totalBytes)}</strong>
          </div>
          {buckets.length > 0 && (
            <ul className="dialog-buckets">
              {buckets.map((b) => (
                <li key={b.category}>
                  <span className={`bucket-tag bucket-${b.category.replace(/\s+/g, "-")}`}>
                    {b.category}
                  </span>{" "}
                  <span className="bucket-count">{b.count}</span>{" "}
                  <span className="bucket-bytes">{formatBytes(b.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="dialog-note">
          Items are moved to your OS Recycle Bin / Trash — nothing is permanently
          deleted by the app, and you can restore them at any time.
        </p>

        <ul className="dialog-items">
          {items.slice(0, 50).map((it) => (
            <li key={it.path} className="dialog-item">
              <div className="dialog-item-head">
                <span className="dialog-item-label">{it.label}</span>
                <span className="dialog-item-context">{it.context}</span>
                <span className="dialog-item-size">{formatBytes(it.size_bytes)}</span>
              </div>
              <div className="dialog-item-path" title={it.path}>
                {it.path}
              </div>
              {it.note && <div className="dialog-item-note">{it.note}</div>}
            </li>
          ))}
          {items.length > 50 && (
            <li className="dialog-item dialog-item-overflow">
              …and {items.length - 50} more.
            </li>
          )}
        </ul>

        <footer className="dialog-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} type="button">
            Move {items.length} to Trash — {formatBytes(totalBytes)}
          </button>
        </footer>
      </div>
    </div>
  );
}
