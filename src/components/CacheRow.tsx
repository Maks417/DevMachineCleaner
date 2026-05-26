import { memo } from "react";
import type { AiCacheEntry } from "../lib/ipc";
import { formatBytes } from "../lib/format";

interface Props {
  entry: AiCacheEntry;
  checked: boolean;
  onToggle: (path: string) => void;
}

function CacheRowImpl({ entry, checked, onToggle }: Props) {
  return (
    <li className="cache-row">
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(entry.path)}
          aria-label={`Select ${entry.name} at ${entry.path}`}
        />
        <div className="cache-text">
          <div className="cache-name">
            <span>
              {entry.name}{" "}
              <span
                className={`bucket-tag bucket-${entry.category.replace(/\s+/g, "-")}`}
                title={entry.note}
              >
                {entry.category}
              </span>
            </span>
            <span className="cache-size">{formatBytes(entry.size_bytes)}</span>
          </div>
          <div className="cache-note">{entry.note}</div>
          <div className="cache-path" title={entry.path}>
            {entry.path}
          </div>
        </div>
      </label>
    </li>
  );
}

export const CacheRow = memo(CacheRowImpl);
