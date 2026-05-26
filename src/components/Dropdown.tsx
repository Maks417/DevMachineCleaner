import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (next: T) => void;
  "aria-label"?: string;
  className?: string;
}

/**
 * Themed select replacement. The native `<select>` popup is rendered by the
 * OS in WebView2 and ignores our dark-glass styling; this component is fully
 * CSS-controlled and supports keyboard navigation (Enter/Space to open,
 * arrows to move, Enter to choose, Esc to close).
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  className,
  ...rest
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(() => {
    const i = options.findIndex((o) => o.value === value);
    return i === -1 ? 0 : i;
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  // Re-sync active item to the current value whenever it changes externally.
  useEffect(() => {
    const i = options.findIndex((o) => o.value === value);
    if (i !== -1) setActiveIdx(i);
  }, [value, options]);

  // Close on outside click; do not interfere with clicks inside the popup or
  // on the trigger button itself.
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        buttonRef.current?.contains(t) ||
        popupRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  const commit = useCallback(
    (idx: number) => {
      const next = options[idx];
      if (next && next.value !== value) {
        onChange(next.value);
      }
      setOpen(false);
      buttonRef.current?.focus();
    },
    [options, onChange, value],
  );

  const onButtonKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopupKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + options.length) % options.length);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(options.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(activeIdx);
    }
  };

  // Focus the popup once it opens so keyboard navigation works without an
  // extra click.
  useEffect(() => {
    if (open) {
      popupRef.current?.focus();
    }
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className={`dropdown${className ? ` ${className}` : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={rest["aria-label"]}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKey}
      >
        <span className="dropdown-value">{current?.label}</span>
        <span className="dropdown-chevron" aria-hidden="true">
          <svg width="10" height="8" viewBox="0 0 12 8">
            <path
              d="M1.5 1.5 6 6l4.5-4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {open && (
        <ul
          ref={popupRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className="dropdown-menu"
          aria-activedescendant={`${listboxId}-${activeIdx}`}
          onKeyDown={onPopupKey}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={opt.value === value}
              className={`dropdown-option${
                i === activeIdx ? " active" : ""
              }${opt.value === value ? " selected" : ""}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                // mousedown so we beat the outside-click handler closing the menu
                e.preventDefault();
                commit(i);
              }}
            >
              <span className="dropdown-option-label">{opt.label}</span>
              {opt.value === value && (
                <span className="dropdown-option-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
