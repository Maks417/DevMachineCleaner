import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type {
  CleanResult,
  DetectedProject,
  ProjectsScanResponse,
} from "../lib/ipc";

const mockScanProjects = vi.fn<(root: string) => Promise<ProjectsScanResponse>>();
const mockCleanPaths = vi.fn<
  (scanId: number, paths: string[]) => Promise<CleanResult[]>
>();

vi.mock("../lib/ipc", () => ({
  scanProjects: (root: string) => mockScanProjects(root),
  cleanPaths: (scanId: number, paths: string[]) => mockCleanPaths(scanId, paths),
  cancelScan: () => Promise.resolve(),
  onScanProgress: () => Promise.resolve(() => {}),
}));

// Imported after the mock so the panel uses the mocked module.
import { ProjectsPanel } from "./ProjectsPanel";

const sampleProjects: DetectedProject[] = [
  {
    path: "C:/work/api",
    name: "api",
    stacks: ["Node.js"],
    total_cleanable_bytes: 100_000_000,
    cleanable: [
      {
        path: "C:/work/api/node_modules",
        label: "node_modules",
        size_bytes: 100_000_000,
        category: "dependencies",
        note: "Regenerated when you next install dependencies.",
      },
    ],
  },
  {
    path: "C:/work/cli",
    name: "cli",
    stacks: ["Rust"],
    total_cleanable_bytes: 1_500_000_000,
    cleanable: [
      {
        path: "C:/work/cli/target",
        label: "target",
        size_bytes: 1_500_000_000,
        category: "build output",
        note: "Regenerated on the next build.",
      },
    ],
  },
];

describe("ProjectsPanel", () => {
  beforeEach(() => {
    mockScanProjects.mockReset();
    mockCleanPaths.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-scans the root and renders detected projects sorted by size", async () => {
    mockScanProjects.mockResolvedValue({
      scan_id: 7,
      projects: sampleProjects,
      scan_errors: 0,
      cancelled: false,
    });

    render(<ProjectsPanel root="C:/work" onPickFolder={vi.fn()} />);

    await waitFor(() => {
      expect(mockScanProjects).toHaveBeenCalledWith("C:/work");
    });

    const headings = await screen.findAllByRole("heading", { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(["cli", "api"]);
  });

  it("surfaces scan errors with a warning banner", async () => {
    mockScanProjects.mockResolvedValue({
      scan_id: 7,
      projects: sampleProjects,
      scan_errors: 3,
      cancelled: false,
    });

    render(<ProjectsPanel root="C:/work" onPickFolder={vi.fn()} />);
    expect(
      await screen.findByText(/couldn’t be inspected.*3 entries skipped/i),
    ).toBeInTheDocument();
  });

  it("shows the empty state when no projects are returned", async () => {
    mockScanProjects.mockResolvedValue({
      scan_id: 9,
      projects: [],
      scan_errors: 0,
      cancelled: false,
    });

    render(<ProjectsPanel root="C:/work" onPickFolder={vi.fn()} />);
    expect(
      await screen.findByText(/Nothing cleanable found/i),
    ).toBeInTheDocument();
  });

  it("propagates scan_id to cleanPaths after confirmation and reports outcomes", async () => {
    mockScanProjects.mockResolvedValue({
      scan_id: 42,
      projects: sampleProjects,
      scan_errors: 0,
      cancelled: false,
    });
    mockCleanPaths.mockResolvedValue([
      { path: "C:/work/api/node_modules", ok: true, error: null },
    ]);

    render(<ProjectsPanel root="C:/work" onPickFolder={vi.fn()} />);

    const checkbox = await screen.findByRole("checkbox", {
      name: /Select node_modules at C:\/work\/api\/node_modules/i,
    });
    fireEvent.click(checkbox);

    const cleanBtn = await screen.findByRole("button", {
      name: /^Clean 1 location/i,
    });
    fireEvent.click(cleanBtn);

    const moveBtn = await screen.findByRole("button", {
      name: /^Move 1 to Trash/i,
    });
    fireEvent.click(moveBtn);

    await waitFor(() => {
      expect(mockCleanPaths).toHaveBeenCalledWith(42, [
        "C:/work/api/node_modules",
      ]);
    });

    // After the clean we re-scan; we want the success banner to survive.
    expect(await screen.findByText(/Freed/i)).toBeInTheDocument();
  });

  it("clears selection when a different stack filter is chosen", async () => {
    mockScanProjects.mockResolvedValue({
      scan_id: 1,
      projects: sampleProjects,
      scan_errors: 0,
      cancelled: false,
    });

    render(<ProjectsPanel root="C:/work" onPickFolder={vi.fn()} />);

    const checkbox = await screen.findByRole("checkbox", {
      name: /Select node_modules/i,
    });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    const rustChip = screen.getByRole("button", { name: /^Rust\s+1$/i });
    fireEvent.click(rustChip);

    // After switching to a different stack filter, selection resets.
    await waitFor(() => {
      const after = screen.queryByRole("checkbox", {
        name: /Select node_modules/i,
      });
      // node_modules row is no longer rendered, so the checkbox is gone.
      expect(after).toBeNull();
    });
  });
});
