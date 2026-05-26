use rayon::prelude::*;
use serde::Serialize;
use std::path::PathBuf;

use super::dir_size;

#[derive(Debug, Clone, Serialize)]
pub struct AiCacheEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub size_bytes: u64,
    /// Short note shown in the UI explaining what this is.
    pub note: String,
}

struct CacheSpec {
    id: &'static str,
    name: &'static str,
    note: &'static str,
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

const SPECS: &[CacheSpec] = &[
    CacheSpec {
        id: "huggingface",
        name: "HuggingFace cache",
        note: "Downloaded models, datasets, and hub cache.",
        paths: huggingface_paths,
    },
    CacheSpec {
        id: "ollama",
        name: "Ollama models",
        note: "Locally pulled LLM weights.",
        paths: ollama_paths,
    },
    CacheSpec {
        id: "torch",
        name: "PyTorch cache",
        note: "Downloaded pretrained model checkpoints.",
        paths: torch_paths,
    },
    CacheSpec {
        id: "tensorflow",
        name: "TensorFlow / Keras cache",
        note: "Keras model and TF dataset caches.",
        paths: tensorflow_paths,
    },
    CacheSpec {
        id: "lmstudio",
        name: "LM Studio models",
        note: "GGUF model files downloaded via LM Studio.",
        paths: lmstudio_paths,
    },
    CacheSpec {
        id: "jan",
        name: "Jan models",
        note: "Local model store for Jan.",
        paths: jan_paths,
    },
    CacheSpec {
        id: "gpt4all",
        name: "GPT4All cache",
        note: "GPT4All downloaded models.",
        paths: gpt4all_paths,
    },
    CacheSpec {
        id: "cursor",
        name: "Cursor IDE caches",
        note: "Volatile Electron caches and logs (safe to clean).",
        paths: cursor_paths,
    },
    CacheSpec {
        id: "claude-desktop",
        name: "Claude Desktop caches",
        note: "Electron caches and logs (safe to clean).",
        paths: claude_desktop_paths,
    },
    CacheSpec {
        id: "claude-code",
        name: "Claude Code transient data",
        note: "Shell snapshots, todos, and statsig cache. Excludes ~/.claude/projects.",
        paths: claude_code_paths,
    },
];

pub fn list_ai_caches() -> Vec<AiCacheEntry> {
    // Flatten (spec, path) pairs to a single granular parallel layer rather
    // than nesting rayon. Each unit is one `dir_size` walk.
    let units: Vec<(&'static CacheSpec, PathBuf)> = SPECS
        .iter()
        .flat_map(|spec| (spec.paths)().into_iter().map(move |p| (spec, p)))
        .collect();

    units
        .into_par_iter()
        .map(|(spec, p)| {
            let exists = p.exists();
            let size = if exists { dir_size(&p) } else { 0 };
            AiCacheEntry {
                id: spec.id.to_string(),
                name: spec.name.to_string(),
                path: p.to_string_lossy().into_owned(),
                exists,
                size_bytes: size,
                note: spec.note.to_string(),
            }
        })
        .collect()
}
