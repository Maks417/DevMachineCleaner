import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CleanResultsBanner } from "./CleanResultsBanner";
import type { CleanResult } from "../lib/ipc";

const sizeByPath = new Map<string, number>([
  ["/a", 1024],
  ["/b", 2048],
  ["/c", 4096],
]);

const results: CleanResult[] = [
  { path: "/a", ok: true, error: null },
  { path: "/b", ok: true, error: null },
  { path: "/c", ok: false, error: "Permission denied" },
];

describe("CleanResultsBanner", () => {
  it("summarizes successes and failures", () => {
    render(
      <CleanResultsBanner
        results={results}
        sizeByPath={sizeByPath}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/cleaned/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it("hides detail rows by default and reveals them on toggle", () => {
    render(
      <CleanResultsBanner
        results={results}
        sizeByPath={sizeByPath}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByText("/a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText("/a")).toBeInTheDocument();
    expect(screen.getByText("/c")).toBeInTheDocument();
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
  });

  it("calls onDismiss when Dismiss is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <CleanResultsBanner
        results={results}
        sizeByPath={sizeByPath}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders nothing for an empty result set", () => {
    const { container } = render(
      <CleanResultsBanner
        results={[]}
        sizeByPath={sizeByPath}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
