import { invoke } from "@tauri-apps/api/core";

export interface CleanableDir {
  path: string;
  label: string;
  size_bytes: number;
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
}

export interface CleanResult {
  path: string;
  ok: boolean;
  error: string | null;
}

export const scanProjects = (root: string, maxDepth = 6) =>
  invoke<DetectedProject[]>("scan_projects", { root, maxDepth });

export const scanAiCaches = () => invoke<AiCacheEntry[]>("scan_ai_caches");

export const cleanPaths = (paths: string[]) =>
  invoke<CleanResult[]>("clean_paths", { paths });
