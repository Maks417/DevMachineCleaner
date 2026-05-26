import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CleanableDir {
  path: string;
  label: string;
  size_bytes: number;
  /** Coarse classification: "dependencies", "build output", "cache". */
  category: string;
  /** One-line note shown next to the cleanable explaining what regenerates it. */
  note: string;
}

export interface DetectedProject {
  path: string;
  name: string;
  stacks: string[];
  cleanable: CleanableDir[];
  total_cleanable_bytes: number;
}

export interface AiCacheEntry {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  size_bytes: number;
  note: string;
  /** "model weights", "cache", "logs". */
  category: string;
}

export interface CleanResult {
  path: string;
  ok: boolean;
  error: string | null;
}

/**
 * Result of `scan_projects`. `scan_id` must be echoed back to `cleanPaths` so
 * the backend can validate that the paths came from this specific scan.
 * `cancelled` is true when the user cancelled the scan; the items list is
 * still partially valid in that case.
 */
export interface ProjectsScanResponse {
  scan_id: number;
  projects: DetectedProject[];
  scan_errors: number;
  cancelled: boolean;
}

export interface AiCachesScanResponse {
  scan_id: number;
  entries: AiCacheEntry[];
  scan_errors: number;
  cancelled: boolean;
}

export interface ScanProgress {
  /** "discovery" while walking dirs, "sizing" while measuring cleanable dirs. */
  phase: string;
  scanned: number;
  /** Total work units when known (e.g. during sizing). */
  total: number | null;
}

export const scanProjects = (root: string, maxDepth = 6) =>
  invoke<ProjectsScanResponse>("scan_projects", { root, maxDepth });

export const scanAiCaches = () =>
  invoke<AiCachesScanResponse>("scan_ai_caches");

export const cancelScan = () => invoke<void>("cancel_scan");

export const cleanPaths = (scanId: number, paths: string[]) =>
  invoke<CleanResult[]>("clean_paths", { scanId, paths });

/**
 * Subscribe to scanner progress events. Returns an unlisten function. Each
 * `kind` corresponds to a backend event channel (`scan-projects:progress` or
 * `scan-ai:progress`).
 */
export const onScanProgress = (
  kind: "projects" | "ai",
  handler: (p: ScanProgress) => void,
): Promise<UnlistenFn> => {
  const event = kind === "projects" ? "scan-projects:progress" : "scan-ai:progress";
  return listen<ScanProgress>(event, (e) => handler(e.payload));
};
