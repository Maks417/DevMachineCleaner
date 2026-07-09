import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Update } from "@tauri-apps/plugin-updater";

const mockCheck = vi.fn<() => Promise<Update | null>>();
const mockRelaunch = vi.fn<() => Promise<void>>();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => mockCheck(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => mockRelaunch(),
}));

// Imported after the mocks so the hook binds to them.
import { useUpdater } from "./useUpdater";

function makeUpdate(overrides: Partial<Update> = {}): Update {
  return {
    version: "0.4.1",
    body: "Notes",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Update;
}

describe("useUpdater", () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockRelaunch.mockReset();
    mockRelaunch.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces an available update", async () => {
    mockCheck.mockResolvedValue(makeUpdate());
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate({ silent: false });
    });

    expect(result.current.status).toBe("available");
    expect(result.current.update?.version).toBe("0.4.1");
  });

  it("reports 'up to date' on a manual check with no update", async () => {
    mockCheck.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate({ silent: false });
    });

    expect(result.current.status).toBe("uptodate");
    expect(result.current.update).toBeNull();
  });

  it("stays idle when a silent check finds no update", async () => {
    mockCheck.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate({ silent: true });
    });

    expect(result.current.status).toBe("idle");
  });

  it("swallows errors on a silent check but reports them on a manual one", async () => {
    mockCheck.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate({ silent: true });
    });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      await result.current.checkForUpdate({ silent: false });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("offline");
  });

  it("downloads, installs, and relaunches", async () => {
    const update = makeUpdate();
    mockCheck.mockResolvedValue(update);
    const { result } = renderHook(() => useUpdater());

    await act(async () => {
      await result.current.checkForUpdate({ silent: false });
    });
    await act(async () => {
      await result.current.downloadAndInstall();
    });

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockRelaunch).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe("ready");
  });
});
