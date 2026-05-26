use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::dir_size;

#[derive(Debug, Clone, Serialize)]
pub struct CleanableDir {
    pub path: String,
    pub label: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedProject {
    pub path: String,
    pub name: String,
    pub stacks: Vec<String>,
    pub cleanable: Vec<CleanableDir>,
    pub total_cleanable_bytes: u64,
}

/// Directories we never descend into (either we'd be re-scanning what we
/// already classify, or it's noise like `.git`).
const SKIP_DIR_NAMES: &[&str] = &[
    ".git", ".hg", ".svn",
    "node_modules", "target", ".venv", "venv", "__pycache__",
    ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
    ".svelte-kit", ".dart_tool", ".gradle",
    "bin", "obj",
    "DerivedData",
];

struct StackRule {
    name: &'static str,
    /// Marker files that, when present in a directory, identify the stack.
    markers: &'static [&'static str],
    /// File-name globs (extensions); any file matching identifies the stack.
    marker_exts: &'static [&'static str],
    /// Subdirs (relative to project root) that are safe to clean.
    cleanable: &'static [&'static str],
}

const STACK_RULES: &[StackRule] = &[
    StackRule {
        name: "Node.js",
        markers: &["package.json"],
        marker_exts: &[],
        cleanable: &[
            "node_modules",
            ".next",
            ".nuxt",
            ".turbo",
            ".cache",
            ".parcel-cache",
            ".svelte-kit",
            "dist",
            "build",
            "out",
            ".vite",
        ],
    },
    StackRule {
        name: "Rust",
        markers: &["Cargo.toml"],
        marker_exts: &[],
        cleanable: &["target"],
    },
    StackRule {
        name: "Python",
        markers: &["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
        marker_exts: &[],
        cleanable: &[
            ".venv",
            "venv",
            "env",
            ".pytest_cache",
            ".mypy_cache",
            ".ruff_cache",
            ".tox",
            "build",
            "dist",
            ".eggs",
        ],
    },
    StackRule {
        name: "Go",
        markers: &["go.mod"],
        marker_exts: &[],
        cleanable: &["bin", "vendor"],
    },
    StackRule {
        name: "Java/Maven",
        markers: &["pom.xml"],
        marker_exts: &[],
        cleanable: &["target"],
    },
    StackRule {
        name: "Java/Gradle",
        markers: &["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
        marker_exts: &[],
        cleanable: &["build", ".gradle"],
    },
    StackRule {
        name: ".NET",
        markers: &[],
        marker_exts: &[".csproj", ".fsproj", ".vbproj", ".sln"],
        cleanable: &["bin", "obj"],
    },
    StackRule {
        name: "Flutter/Dart",
        markers: &["pubspec.yaml"],
        marker_exts: &[],
        cleanable: &["build", ".dart_tool"],
    },
    StackRule {
        name: "Xcode",
        markers: &[],
        marker_exts: &[".xcodeproj", ".xcworkspace"],
        cleanable: &["build", "DerivedData"],
    },
];

fn detect_stacks_in(dir: &Path) -> Vec<&'static StackRule> {
    let mut found: Vec<&StackRule> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return found,
    };
    let names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    for rule in STACK_RULES {
        let marker_hit = rule.markers.iter().any(|m| names.iter().any(|n| n == m));
        let ext_hit = rule
            .marker_exts
            .iter()
            .any(|ext| names.iter().any(|n| n.ends_with(ext)));
        if marker_hit || ext_hit {
            found.push(rule);
        }
    }
    found
}

/// Walk `root` looking for project markers. Returns one entry per project dir;
/// a dir matching multiple stacks (e.g. a polyglot repo) collapses to one entry
/// listing all matching stacks and the union of their cleanable dirs.
pub fn scan_projects(root: &Path, max_depth: usize) -> Vec<DetectedProject> {
    let mut project_dirs: Vec<PathBuf> = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|e| {
            // Skip noisy / already-cleanable directories so we don't recurse into them.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !SKIP_DIR_NAMES.iter().any(|s| *s == name.as_ref())
        });

    for entry in walker.filter_map(|e| e.ok()) {
        if !entry.file_type().is_dir() {
            continue;
        }
        if !detect_stacks_in(entry.path()).is_empty() {
            project_dirs.push(entry.path().to_path_buf());
        }
    }

    // For each project dir, compute cleanable dirs + sizes in parallel.
    project_dirs
        .par_iter()
        .map(|dir| build_project(dir))
        .collect()
}

fn build_project(dir: &Path) -> DetectedProject {
    let rules = detect_stacks_in(dir);
    let stacks: Vec<String> = rules.iter().map(|r| r.name.to_string()).collect();

    // Union of cleanable dir names across all matched stacks, deduplicated.
    let mut names: Vec<&str> = rules.iter().flat_map(|r| r.cleanable.iter().copied()).collect();
    names.sort();
    names.dedup();

    let cleanable: Vec<CleanableDir> = names
        .par_iter()
        .filter_map(|name| {
            let p = dir.join(name);
            if !p.exists() {
                return None;
            }
            let size = dir_size(&p);
            Some(CleanableDir {
                path: p.to_string_lossy().into_owned(),
                label: name.to_string(),
                size_bytes: size,
            })
        })
        .collect();

    let total: u64 = cleanable.iter().map(|c| c.size_bytes).sum();
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned());

    DetectedProject {
        path: dir.to_string_lossy().into_owned(),
        name,
        stacks,
        cleanable,
        total_cleanable_bytes: total,
    }
}
