import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import type { Update } from "@tauri-apps/plugin-updater";

// Only the fields the banner reads; cast keeps us off the full plugin type.
const sampleUpdate = {
  version: "0.4.1",
  body: "Fixes and improvements.",
} as unknown as Update;

const baseProps = {
  update: sampleUpdate,
  downloaded: 0,
  contentLength: null,
  error: null,
  onInstall: vi.fn(),
  onDismiss: vi.fn(),
};

describe("UpdateBanner", () => {
  it("renders nothing when there is no update", () => {
    const { container } = render(
      <UpdateBanner {...baseProps} status="idle" update={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the target version and notes when an update is available", () => {
    render(<UpdateBanner {...baseProps} status="available" />);
    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("v0.4.1")).toBeInTheDocument();
    expect(screen.getByText("Fixes and improvements.")).toBeInTheDocument();
  });

  it("triggers install when 'Update now' is clicked", () => {
    const onInstall = vi.fn();
    render(
      <UpdateBanner {...baseProps} status="available" onInstall={onInstall} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /update now/i }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("shows a progress bar while downloading", () => {
    render(
      <UpdateBanner
        {...baseProps}
        status="downloading"
        downloaded={512}
        contentLength={1024}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    // Action buttons are disabled mid-download.
    expect(screen.getByRole("button", { name: /updating/i })).toBeDisabled();
  });

  it("shows a restarting state when ready", () => {
    render(<UpdateBanner {...baseProps} status="ready" />);
    expect(screen.getByText("Restarting…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
