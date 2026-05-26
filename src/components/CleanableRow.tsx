import { memo } from "react";
import type { CleanableDir } from "../lib/ipc";
import { formatBytes } from "../lib/format";

interface Props {
  cleanable: CleanableDir;
  checked: boolean;
  onToggle: (path: string) => void;
}

function CleanableRowImpl({ cleanable, checked, onToggle }: Props) {
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(cleanable.path)}
        />
        <span className="cleanable-label">{cleanable.label}</span>
        <span className="cleanable-path" title={cleanable.path}>
          {cleanable.path}
        </span>
        <span className="cleanable-size">
          {formatBytes(cleanable.size_bytes)}
        </span>
      </label>
    </li>
  );
}

export const CleanableRow = memo(CleanableRowImpl);
