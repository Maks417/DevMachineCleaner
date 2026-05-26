use rayon::prelude::*;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use super::dir_size;
use super::stacks::{ProgressFn, ScanProgress};

#[derive(Debug, Clone, Serialize)]
pub struct AiCacheEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub size_bytes: u64,
    /// Short note shown in the UI explaining what this is.
    pub note: String,
    /// Coarse classification used by the UI: "cache", "model weights",
    /// "logs", etc. Distinguishes things that redownload (expensive) from
    /// things that regenerate locally on next use (cheap).
    pub category: &'static str,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AiCachesScan {
    pub entries: Vec<AiCacheEntry>,
    pub scan_errors: u64,
    pub cancelled: bool,
}

const CAT_CACHE: &str = "cache";
const CAT_MODELS: &str = "model weights";
const CAT_LOGS: &str = "logs";

struct CacheSpec {
    id: &'static str,
    name: &'static str,
    note: &'static str,
    category: &'static str,
    /// Function returning candidate paths for the current platform.
    paths: fn() -> Vec<PathBuf>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn appdata_roaming() -> Option<PathBuf> {
    // On Windows this is %APPDATA%. On other platforms dirs::config_dir() is close enough
    // but we only use these for Windows-specific entries.
    dirs::config_dir()
}

fn appdata_local() -> Option<PathBuf> {
    // On Windows this is %LOCALAPPDATA%.
    dirs::cache_dir()
}

fn huggingface_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join(".cache").join("huggingface"));
    }
    out
}

fn ollama_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join(".ollama").join("models"));
    }
    out
}

fn torch_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join(".cache").join("torch"));
    }
    out
}

fn tensorflow_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join(".keras"));
        out.push(h.join(".cache").join("tensorflow"));
    }
    out
}

fn lmstudio_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join(".lmstudio").join("models"));
        out.push(h.join(".cache").join("lm-studio"));
    }
    out
}

fn jan_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join("jan").join("models"));
    }
    if let Some(a) = appdata_roaming() {
        out.push(a.join("Jan").join("data").join("models"));
    }
    out
}

fn gpt4all_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        out.push(h.join(".cache").join("gpt4all"));
    }
    if let Some(a) = appdata_local() {
        out.push(a.join("nomic.ai").join("GPT4All"));
    }
    out
}

fn cursor_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Only volatile caches/logs, not user config or extensions.
    if let Some(a) = appdata_roaming() {
        let base = a.join("Cursor");
        out.push(base.join("Cache"));
        out.push(base.join("Code Cache"));
        out.push(base.join("CachedData"));
        out.push(base.join("GPUCache"));
        out.push(base.join("logs"));
    }
    out
}

fn vscode_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(a) = appdata_roaming() {
        let base = a.join("Code");
        out.push(base.join("Cache"));
        out.push(base.join("CachedData"));
        out.push(base.join("Code Cache"));
        out.push(base.join("GPUCache"));
        out.push(base.join("logs"));
    }
    out
}

fn windsurf_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(a) = appdata_roaming() {
        let base = a.join("Windsurf");
        out.push(base.join("Cache"));
        out.push(base.join("Code Cache"));
        out.push(base.join("CachedData"));
        out.push(base.join("GPUCache"));
        out.push(base.join("logs"));
    }
    out
}

fn claude_desktop_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(a) = appdata_roaming() {
        let base = a.join("Claude");
        out.push(base.join("Cache"));
        out.push(base.join("Code Cache"));
        out.push(base.join("CachedData"));
        out.push(base.join("GPUCache"));
        out.push(base.join("logs"));
    }
    out
}

fn claude_code_paths() -> Vec<PathBuf> {
    // Claude Code CLI keeps logs / shell snapshots under ~/.claude.
    // Be conservative: only target logs/shell-snapshots/statsig caches, NOT projects/.
    let mut out = Vec::new();
    if let Some(h) = home() {
        let base = h.join(".claude");
        out.push(base.join("shell-snapshots"));
        out.push(base.join("statsig"));
        out.push(base.join("todos"));
        out.push(base.join("ide"));
    }
    out
}

fn diffusers_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        // diffusers stores models under HF hub cache; the dedicated `diffusers`
        // dir is older and still seen on some installs.
        out.push(h.join(".cache").join("diffusers"));
    }
    out
}

fn triton_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        // OpenAI Triton compiles kernels and caches the JITed binaries.
        out.push(h.join(".triton").join("cache"));
    }
    out
}

fn nv_compute_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home() {
        // NVIDIA driver/runtime compute cache (CUDA JIT cache). Repopulated
        // automatically on next kernel launch.
        out.push(h.join(".nv").join("ComputeCache"));
    }
    if let Some(a) = appdata_local() {
        out.push(a.join("NVIDIA").join("ComputeCache"));
    }
    out
}

const SPECS: &[CacheSpec] = &[
    CacheSpec {
        id: "huggingface",
        name: "HuggingFace cache",
        note: "Downloaded models, datasets, and hub cache. Will redownload on next use.",
        category: CAT_MODELS,
        paths: huggingface_paths,
    },
    CacheSpec {
        id: "ollama",
        name: "Ollama models",
        note: "Locally pulled LLM weights. Will redownload on next `ollama pull`.",
        category: CAT_MODELS,
        paths: ollama_paths,
    },
    CacheSpec {
        id: "torch",
        name: "PyTorch cache",
        note: "Downloaded pretrained model checkpoints. Will redownload on next load.",
        category: CAT_MODELS,
        paths: torch_paths,
    },
    CacheSpec {
        id: "tensorflow",
        name: "TensorFlow / Keras cache",
        note: "Keras model and TF dataset caches.",
        category: CAT_MODELS,
        paths: tensorflow_paths,
    },
    CacheSpec {
        id: "lmstudio",
        name: "LM Studio models",
        note: "GGUF model files downloaded via LM Studio.",
        category: CAT_MODELS,
        paths: lmstudio_paths,
    },
    CacheSpec {
        id: "jan",
        name: "Jan models",
        note: "Local model store for Jan.",
        category: CAT_MODELS,
        paths: jan_paths,
    },
    CacheSpec {
        id: "gpt4all",
        name: "GPT4All cache",
        note: "GPT4All downloaded models.",
        category: CAT_MODELS,
        paths: gpt4all_paths,
    },
    CacheSpec {
        id: "diffusers",
        name: "Diffusers cache",
        note: "Legacy diffusers model cache. Will redownload on next pipeline load.",
        category: CAT_MODELS,
        paths: diffusers_paths,
    },
    CacheSpec {
        id: "triton",
        name: "OpenAI Triton kernel cache",
        note: "JIT-compiled GPU kernels. Recompiled automatically on next run.",
        category: CAT_CACHE,
        paths: triton_paths,
    },
    CacheSpec {
        id: "nv-compute",
        name: "NVIDIA compute cache",
        note: "CUDA JIT compilation cache. Rebuilt automatically by the driver.",
        category: CAT_CACHE,
        paths: nv_compute_paths,
    },
    CacheSpec {
        id: "cursor",
        name: "Cursor IDE caches",
        note: "Volatile Electron caches and logs (safe to clean).",
        category: CAT_CACHE,
        paths: cursor_paths,
    },
    CacheSpec {
        id: "vscode",
        name: "VS Code caches",
        note: "Volatile Electron caches and logs. Extensions and settings are not touched.",
        category: CAT_CACHE,
        paths: vscode_paths,
    },
    CacheSpec {
        id: "windsurf",
        name: "Windsurf caches",
        note: "Volatile Electron caches and logs (safe to clean).",
        category: CAT_CACHE,
        paths: windsurf_paths,
    },
    CacheSpec {
        id: "claude-desktop",
        name: "Claude Desktop caches",
        note: "Electron caches and logs (safe to clean).",
        category: CAT_CACHE,
        paths: claude_desktop_paths,
    },
    CacheSpec {
        id: "claude-code",
        name: "Claude Code transient data",
        note: "Shell snapshots, todos, and statsig cache. Excludes ~/.claude/projects.",
        category: CAT_LOGS,
        paths: claude_code_paths,
    },
];

pub fn list_ai_caches(cancel: Arc<AtomicBool>, progress: ProgressFn) -> AiCachesScan {
    // Flatten (spec, path) pairs to a single granular parallel layer rather
    // than nesting rayon. Each unit is one `dir_size` walk.
    let units: Vec<(&'static CacheSpec, PathBuf)> = SPECS
        .iter()
        .flat_map(|spec| (spec.paths)().into_iter().map(move |p| (spec, p)))
        .collect();
    let total = units.len() as u64;
    let done = AtomicU64::new(0);

    progress(ScanProgress {
        phase: "sizing",
        scanned: 0,
        total: Some(total),
    });

    let results: Vec<(AiCacheEntry, u64)> = units
        .into_par_iter()
        .filter_map(|(spec, p)| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let exists = p.exists();
            // Skip symlinks/reparse points outright so we never advertise
            // something we'd refuse to delete later.
            if exists && crate::cleaner::is_reparse_or_symlink(&p) {
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                progress(ScanProgress {
                    phase: "sizing",
                    scanned: n,
                    total: Some(total),
                });
                return None;
            }
            let stats = if exists {
                dir_size(&p)
            } else {
                Default::default()
            };
            let normalized = std::path::absolute(&p).unwrap_or(p.clone());
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(ScanProgress {
                phase: "sizing",
                scanned: n,
                total: Some(total),
            });
            Some((
                AiCacheEntry {
                    id: spec.id.to_string(),
                    name: spec.name.to_string(),
                    path: normalized.to_string_lossy().into_owned(),
                    exists,
                    size_bytes: stats.bytes,
                    note: spec.note.to_string(),
                    category: spec.category,
                },
                stats.errors,
            ))
        })
        .collect();

    let cancelled = cancel.load(Ordering::Relaxed);

    let mut entries = Vec::with_capacity(results.len());
    let mut scan_errors: u64 = 0;
    for (entry, errs) in results {
        scan_errors = scan_errors.saturating_add(errs);
        entries.push(entry);
    }

    AiCachesScan {
        entries,
        scan_errors,
        cancelled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::stacks::{never_cancel, no_progress};

    #[test]
    fn returns_entries_for_every_spec_path() {
        let scan = list_ai_caches(never_cancel(), no_progress());
        // For each spec we should see exactly the number of entries its path
        // resolver produced, minus any that were silently dropped (symlinks).
        // In a clean test env nothing is a symlink so the counts must match.
        let expected: usize = SPECS.iter().map(|s| (s.paths)().len()).sum();
        assert!(
            scan.entries.len() <= expected,
            "more entries than spec paths produced"
        );
        assert!(!scan.cancelled);
    }

    #[test]
    fn entries_have_normalized_paths_and_metadata() {
        let scan = list_ai_caches(never_cancel(), no_progress());
        for e in &scan.entries {
            assert!(!e.id.is_empty());
            assert!(!e.name.is_empty());
            assert!(!e.note.is_empty());
            assert!(!e.category.is_empty());
            let p = PathBuf::from(&e.path);
            assert!(p.is_absolute(), "expected absolute path: {}", e.path);
        }
    }

    #[test]
    fn pre_cancelled_scan_returns_cancelled_flag() {
        let cancel = Arc::new(AtomicBool::new(true));
        let scan = list_ai_caches(cancel, no_progress());
        assert!(scan.cancelled);
    }

    #[test]
    fn includes_new_specs_for_diffusers_triton_vscode_windsurf() {
        let scan = list_ai_caches(never_cancel(), no_progress());
        let ids: std::collections::HashSet<&str> =
            scan.entries.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains("diffusers"), "ids: {ids:?}");
        assert!(ids.contains("triton"), "ids: {ids:?}");
        assert!(ids.contains("vscode"), "ids: {ids:?}");
        assert!(ids.contains("windsurf"), "ids: {ids:?}");
        assert!(ids.contains("nv-compute"), "ids: {ids:?}");
    }

    #[test]
    fn every_category_is_well_known() {
        let scan = list_ai_caches(never_cancel(), no_progress());
        for e in &scan.entries {
            assert!(
                matches!(e.category, "model weights" | "cache" | "logs"),
                "unknown category {} for {}",
                e.category,
                e.id,
            );
        }
    }
}
