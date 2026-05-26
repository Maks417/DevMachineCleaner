import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmCleanDialog, type CleanItem } from "./ConfirmCleanDialog";

const items: CleanItem[] = [
  {
    path: "/proj/a/node_modules",
    label: "node_modules",
    context: "proj-a",
    size_bytes: 100 * 1024 * 1024,
    category: "dependencies",
    note: "Regenerated when you next install dependencies.",
  },
  {
    path: "/proj/b/target",
    label: "target",
    context: "proj-b",
    size_bytes: 2 * 1024 * 1024 * 1024,
    category: "build output",
    note: "Regenerated on the next build.",
  },
];

describe("ConfirmCleanDialog", () => {
  it("does not render when closed", () => {
    render(
      <ConfirmCleanDialog
        open={false}
        title="Clean?"
        items={items}
        totalBytes={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders title, total, and per-item paths when open", () => {
    render(
      <ConfirmCleanDialog
        open
        title="Clean selected items?"
        items={items}
        totalBytes={items[0].size_bytes + items[1].size_bytes}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Clean selected items?")).toBeInTheDocument();
    expect(screen.getByText("/proj/a/node_modules")).toBeInTheDocument();
    expect(screen.getByText("/proj/b/target")).toBeInTheDocument();
    expect(screen.getByText("node_modules")).toBeInTheDocument();
    expect(screen.getByText("target")).toBeInTheDocument();
  });

  it("groups items into category buckets", () => {
    render(
      <ConfirmCleanDialog
        open
        title="Clean?"
        items={items}
        totalBytes={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("dependencies");
    expect(dialog.textContent).toContain("build output");
  });

  it("calls onConfirm when the danger button is clicked", () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(
      <ConfirmCleanDialog
        open
        title="Clean?"
        items={items}
        totalBytes={items[0].size_bytes + items[1].size_bytes}
        onConfirm={confirm}
        onCancel={cancel}
      />,
    );
    const buttons = screen.getAllByRole("button");
    const move = buttons.find((b) => /Move \d+ to Trash/.test(b.textContent ?? ""));
    expect(move).toBeTruthy();
    fireEvent.click(move!);
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels via the footer button, the close button, and a backdrop click", () => {
    const cancel = vi.fn();
    const { rerender } = render(
      <ConfirmCleanDialog
        open
        title="Clean?"
        items={items}
        totalBytes={0}
        onConfirm={vi.fn()}
        onCancel={cancel}
      />,
    );
    // Footer button has the text "Cancel"; close button is aria-labeled "Cancel".
    const buttons = screen
      .getAllByRole("button")
      .filter((b) => b.textContent === "Cancel");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(cancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Cancel"));
    expect(cancel).toHaveBeenCalledTimes(2);

    // Click on the backdrop itself should also cancel.
    fireEvent.click(screen.getByRole("dialog"));
    expect(cancel).toHaveBeenCalledTimes(3);

    rerender(
      <ConfirmCleanDialog
        open={false}
        title="Clean?"
        items={items}
        totalBytes={0}
        onConfirm={vi.fn()}
        onCancel={cancel}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("truncates the item list past 50 entries", () => {
    const many: CleanItem[] = Array.from({ length: 60 }, (_, i) => ({
      path: `/p/${i}`,
      label: `dir-${i}`,
      context: "proj",
      size_bytes: 1024,
      category: "cache",
      note: "",
    }));
    render(
      <ConfirmCleanDialog
        open
        title="Clean?"
        items={many}
        totalBytes={many.length * 1024}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/and 10 more\./i)).toBeInTheDocument();
  });
});
