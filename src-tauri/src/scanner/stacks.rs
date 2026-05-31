use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use walkdir::WalkDir;

use super::{dir_size, SizeStats};

/// Progress event payload emitted while a scan is in flight. The frontend
/// listens to `scan-projects:progress` / `scan-ai:progress` to surface
/// counters and the current phase without blocking on the full result.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub phase: &'static str,
    pub scanned: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanableDir {
    pub path: String,
    pub label: String,
    pub size_bytes: u64,
    /// Coarse classification used by the UI to explain what will be reclaimed.
    pub category: String,
    /// Short one-liner describing what regenerates the path. Helps users
    /// decide whether to clean it.
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedProject {
    pub path: String,
    pub name: String,
    pub stacks: Vec<String>,
    pub cleanable: Vec<CleanableDir>,
    pub total_cleanable_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProjectsScan {
    pub projects: Vec<DetectedProject>,
    /// Count of entries skipped due to I/O or permission errors during
    /// discovery and sizing. Surfaced so the UI can warn that totals may be
    /// conservative.
    pub scan_errors: u64,
    /// True when the scan was cancelled before finishing. Results returned
    /// alongside this flag are partial.
    pub cancelled: bool,
}

/// Type-erased progress callback. Boxed so the scanner can accept any closure
/// that captures the Tauri `AppHandle` for emitting events, while tests pass a
/// no-op.
pub type ProgressFn = Arc<dyn Fn(ScanProgress) + Send + Sync>;

#[cfg(test)]
pub fn no_progress() -> ProgressFn {
    Arc::new(|_| {})
}

#[cfg(test)]
pub fn never_cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

/// Raw TOML source for the project cleanup rules. Bundled into the binary so
/// the file does not need to ship alongside the executable; rebuild after
/// editing it. The single source of truth for what the scanner detects and
/// what it offers to reclaim — add a new stack or cleanable there, not here.
const PROJECT_RULES_TOML: &str = include_str!("project_rules.toml");

/// A cleanable subdirectory pattern for a stack. Deserialized from
/// `project_rules.toml` and held for the lifetime of the process via
/// [`project_rules`].
#[derive(Debug, Clone, Deserialize)]
struct Cleanable {
    name: String,
    category: String,
    note: String,
}

/// One project stack definition loaded from `project_rules.toml`.
#[derive(Debug, Clone, Deserialize)]
struct StackRule {
    name: String,
    /// Marker files that, when present in a directory, identify the stack.
    #[serde(default)]
    markers: Vec<String>,
    /// File-name suffixes (extensions); any file matching identifies the stack.
    #[serde(default)]
    marker_exts: Vec<String>,
    /// Subdirs (relative to project root) that are safe to clean.
    #[serde(default)]
    cleanable: Vec<Cleanable>,
}

/// Top-level structure of `project_rules.toml`. See the file for the schema.
#[derive(Debug, Deserialize)]
struct ProjectRules {
    /// Directories the discovery walker never descends into (either we'd be
    /// re-scanning what we already classify, or it's noise like `.git`).
    skip_dir_names: Vec<String>,
    stacks: Vec<StackRule>,
}

/// Parse `project_rules.toml` once and return the cached result. A malformed
/// rules file is a build/config bug — fail loudly rather than fall back to
/// a silently-empty rule set.
fn project_rules() -> &'static ProjectRules {
    static RULES: OnceLock<ProjectRules> = OnceLock::new();
    RULES.get_or_init(|| {
        toml::from_str(PROJECT_RULES_TOML)
            .expect("project_rules.toml is malformed; fix the file and rebuild")
    })
}

fn detect_stacks_in(dir: &Path) -> (Vec<&'static StackRule>, bool) {
    let mut found: Vec<&'static StackRule> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (found, true),
    };
    let names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    for rule in &project_rules().stacks {
        let marker_hit = rule.markers.iter().any(|m| names.iter().any(|n| n == m));
        let ext_hit = rule
            .marker_exts
            .iter()
            .any(|ext| names.iter().any(|n| n.ends_with(ext.as_str())));
        if marker_hit || ext_hit {
            found.push(rule);
        }
    }
    (found, false)
}

/// Format a path relative to `root` using forward slashes for cross-platform UI.
fn relative_path_display(root: &Path, child: &Path) -> String {
    match child.strip_prefix(root) {
        Ok(rel) => {
            let rel_str = rel.to_string_lossy();
            let trimmed = rel_str.trim_start_matches(['/', '\\']);
            if trimmed.is_empty() {
                String::new()
            } else {
                trimmed.replace('\\', "/")
            }
        }
        Err(_) => child.to_string_lossy().into_owned(),
    }
}

/// Fold detected projects nested inside another into the topmost ancestor.
fn group_nested_projects(
    hits: &[(PathBuf, Vec<&'static StackRule>)],
    buckets: Vec<Vec<CleanableDir>>,
) -> Vec<DetectedProject> {
    let hit_count = hits.len();
    if hit_count == 0 {
        return Vec::new();
    }

    let mut roots: Vec<usize> = Vec::new();
    let mut group_of: Vec<usize> = vec![0; hit_count];

    let mut indices: Vec<usize> = (0..hit_count).collect();
    indices.sort_by_key(|&i| hits[i].0.components().count());

    for &idx in &indices {
        let hit_path = &hits[idx].0;
        let mut assigned = false;
        for &root_idx in &roots {
            if hit_path.starts_with(&hits[root_idx].0) {
                group_of[idx] = root_idx;
                assigned = true;
                break;
            }
        }
        if !assigned {
            group_of[idx] = idx;
            roots.push(idx);
        }
    }

    roots.sort_by_key(|&root_idx| hits[root_idx].0.components().count());

    roots
        .into_iter()
        .map(|root_idx| {
            let (root_dir, _root_rules) = &hits[root_idx];
            let root_path = std::path::absolute(root_dir).unwrap_or_else(|_| root_dir.clone());

            let members: Vec<usize> = (0..hit_count)
                .filter(|&i| group_of[i] == root_idx)
                .collect();

            let mut stacks: Vec<String> = Vec::new();
            for &mi in &members {
                for rule in &hits[mi].1 {
                    if !stacks.contains(&rule.name) {
                        stacks.push(rule.name.clone());
                    }
                }
            }

            let mut cleanable: Vec<CleanableDir> = Vec::new();
            for &mi in &members {
                let prefix = if mi == root_idx {
                    String::new()
                } else {
                    relative_path_display(root_dir, &hits[mi].0)
                };

                for mut c in buckets[mi].clone() {
                    if !prefix.is_empty() {
                        c.label = format!("{prefix}/{}", c.label);
                    }
                    cleanable.push(c);
                }
            }

            cleanable.sort_by_key(|c| std::cmp::Reverse(c.size_bytes));
            let total_cleanable_bytes: u64 = cleanable.iter().map(|c| c.size_bytes).sum();
            let name = root_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_path.to_string_lossy().into_owned());

            DetectedProject {
                path: root_path.to_string_lossy().into_owned(),
                name,
                stacks,
                cleanable,
                total_cleanable_bytes,
            }
        })
        .collect()
}

/// Emit progress at most every PROGRESS_STRIDE discovery iterations to keep
/// IPC noise low. Tuned so even a million-file root only emits a few hundred
/// events.
const PROGRESS_STRIDE: u64 = 64;

/// Walk `root` looking for project markers. Returns one entry per project dir;
/// a dir matching multiple stacks (e.g. a polyglot repo) collapses to one entry
/// listing all matching stacks and the union of their cleanable dirs. The
/// caller passes a cancel flag (polled during discovery and sizing) and a
/// progress callback (called periodically with the current phase and counter).
pub fn scan_projects(
    root: &Path,
    max_depth: usize,
    cancel: Arc<AtomicBool>,
    progress: ProgressFn,
) -> ProjectsScan {
    let discovery_errors = AtomicU64::new(0);
    let mut hits: Vec<(PathBuf, Vec<&'static StackRule>)> = Vec::new();

    let skip_dir_names = &project_rules().skip_dir_names;
    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(max_depth)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !skip_dir_names.iter().any(|s| s == name.as_ref())
        });

    progress(ScanProgress {
        phase: "discovery",
        scanned: 0,
        total: None,
    });
    let mut visited: u64 = 0;
    let mut cancelled = false;
    for entry_result in walker {
        visited = visited.saturating_add(1);
        if visited.is_multiple_of(PROGRESS_STRIDE) {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            progress(ScanProgress {
                phase: "discovery",
                scanned: visited,
                total: None,
            });
        }
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => {
                discovery_errors.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        if !entry.file_type().is_dir() {
            continue;
        }
        let (rules, read_err) = detect_stacks_in(entry.path());
        if read_err {
            discovery_errors.fetch_add(1, Ordering::Relaxed);
        }
        if !rules.is_empty() {
            hits.push((entry.path().to_path_buf(), rules));
        }
    }

    // Flatten to one granular parallel layer keyed by cleanable directory.
    // Each unit of work is one `dir_size` walk; rayon's work-stealing
    // scheduler decides how to spread them across the thread pool.
    let units: Vec<(usize, &'static Cleanable)> = hits
        .iter()
        .enumerate()
        .flat_map(|(idx, (_, rules))| {
            // Union of cleanable subdir descriptors across the matched stacks,
            // deduplicated by name (first occurrence wins).
            let mut seen: Vec<&str> = Vec::new();
            let mut chosen: Vec<&'static Cleanable> = Vec::new();
            for c in rules.iter().flat_map(|r| r.cleanable.iter()) {
                if !seen.contains(&c.name.as_str()) {
                    seen.push(c.name.as_str());
                    chosen.push(c);
                }
            }
            chosen.into_iter().map(move |c| (idx, c))
        })
        .collect();

    let total_units = units.len() as u64;
    let sized_counter = AtomicU64::new(0);
    progress(ScanProgress {
        phase: "sizing",
        scanned: 0,
        total: Some(total_units),
    });

    let sized: Vec<(usize, CleanableDir, SizeStats)> = units
        .into_par_iter()
        .filter_map(|(idx, c)| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let p = hits[idx].0.join(&c.name);
            if !p.exists() {
                let done = sized_counter.fetch_add(1, Ordering::Relaxed) + 1;
                progress(ScanProgress {
                    phase: "sizing",
                    scanned: done,
                    total: Some(total_units),
                });
                return None;
            }
            if crate::cleaner::is_reparse_or_symlink(&p) {
                let done = sized_counter.fetch_add(1, Ordering::Relaxed) + 1;
                progress(ScanProgress {
                    phase: "sizing",
                    scanned: done,
                    total: Some(total_units),
                });
                return None;
            }
            let stats = dir_size(&p);
            let done = sized_counter.fetch_add(1, Ordering::Relaxed) + 1;
            progress(ScanProgress {
                phase: "sizing",
                scanned: done,
                total: Some(total_units),
            });
            let normalized = std::path::absolute(&p).unwrap_or(p.clone());
            Some((
                idx,
                CleanableDir {
                    path: normalized.to_string_lossy().into_owned(),
                    label: c.name.clone(),
                    size_bytes: stats.bytes,
                    category: c.category.clone(),
                    note: c.note.clone(),
                },
                stats,
            ))
        })
        .collect();

    if cancel.load(Ordering::Relaxed) {
        cancelled = true;
    }

    let mut sizing_errors: u64 = 0;
    let mut buckets: Vec<Vec<CleanableDir>> = hits.iter().map(|_| Vec::new()).collect();
    for (idx, c, stats) in sized {
        sizing_errors = sizing_errors.saturating_add(stats.errors);
        buckets[idx].push(c);
    }

    let projects = group_nested_projects(&hits, buckets);

    ProjectsScan {
        projects,
        scan_errors: discovery_errors
            .load(Ordering::Relaxed)
            .saturating_add(sizing_errors),
        cancelled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, b"").unwrap();
    }

    fn mkdir(p: &Path) {
        fs::create_dir_all(p).unwrap();
    }

    fn run_scan(root: &Path, depth: usize) -> ProjectsScan {
        scan_projects(root, depth, never_cancel(), no_progress())
    }

    #[test]
    fn groups_monorepo_into_single_project() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("FlexibleHoursTracker");
        mkdir(&root);
        touch(&root.join("package.json"));
        mkdir(&root.join("node_modules/pkg"));
        fs::write(root.join("node_modules/pkg/index.js"), b"x").unwrap();
        mkdir(&root.join(".turbo"));
        fs::write(root.join(".turbo/cache"), b"x").unwrap();

        let web = root.join("apps/web");
        mkdir(&web);
        touch(&web.join("package.json"));
        mkdir(&web.join("node_modules/foo"));
        fs::write(web.join("node_modules/foo/index.js"), b"x").unwrap();
        mkdir(&web.join(".next"));
        fs::write(web.join(".next/build"), b"x").unwrap();
        mkdir(&web.join(".turbo"));
        fs::write(web.join(".turbo/cache"), b"x").unwrap();

        let scan = run_scan(tmp.path(), 6);
        assert_eq!(
            scan.projects.len(),
            1,
            "expected nested workspaces to fold into one project"
        );
        let p = &scan.projects[0];
        assert_eq!(p.name, "FlexibleHoursTracker");
        let labels: Vec<&str> = p.cleanable.iter().map(|c| c.label.as_str()).collect();
        assert!(labels.contains(&"node_modules"), "labels: {labels:?}");
        assert!(
            labels.contains(&"apps/web/node_modules"),
            "labels: {labels:?}"
        );
        assert!(labels.contains(&"apps/web/.next"), "labels: {labels:?}");
        assert!(
            p.total_cleanable_bytes > 0,
            "expected non-zero total across grouped cleanables"
        );
        let sum: u64 = p.cleanable.iter().map(|c| c.size_bytes).sum();
        assert_eq!(p.total_cleanable_bytes, sum);
    }

    #[test]
    fn detects_node_project_with_node_modules() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("myapp");
        mkdir(&proj);
        touch(&proj.join("package.json"));
        mkdir(&proj.join("node_modules/foo"));
        fs::write(proj.join("node_modules/foo/index.js"), b"console.log('hi')").unwrap();

        let scan = run_scan(tmp.path(), 4);
        assert_eq!(scan.projects.len(), 1);
        let p = &scan.projects[0];
        assert!(p.stacks.contains(&"Node.js".to_string()));
        assert!(p.cleanable.iter().any(|c| c.label == "node_modules"));
        assert!(p.total_cleanable_bytes > 0);
        assert!(!scan.cancelled);
    }

    #[test]
    fn detects_polyglot_project_with_union_of_cleanables() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("poly");
        mkdir(&proj);
        touch(&proj.join("package.json"));
        touch(&proj.join("Cargo.toml"));
        mkdir(&proj.join("node_modules"));
        mkdir(&proj.join("target"));

        let scan = run_scan(tmp.path(), 4);
        assert_eq!(scan.projects.len(), 1);
        let p = &scan.projects[0];
        assert!(p.stacks.contains(&"Node.js".to_string()));
        assert!(p.stacks.contains(&"Rust".to_string()));
        let labels: Vec<&str> = p.cleanable.iter().map(|c| c.label.as_str()).collect();
        assert!(labels.contains(&"node_modules"));
        assert!(labels.contains(&"target"));
    }

    #[test]
    fn detects_composer_and_swiftpm() {
        let tmp = tempfile::tempdir().unwrap();
        let php = tmp.path().join("php-app");
        mkdir(&php);
        touch(&php.join("composer.json"));
        mkdir(&php.join("vendor/whatever"));
        fs::write(php.join("vendor/whatever/f.php"), b"<?php").unwrap();

        let spm = tmp.path().join("swift-app");
        mkdir(&spm);
        touch(&spm.join("Package.swift"));
        mkdir(&spm.join(".build"));
        fs::write(spm.join(".build/out.o"), b"binary").unwrap();

        let scan = run_scan(tmp.path(), 4);
        let mut found_php = false;
        let mut found_spm = false;
        for p in &scan.projects {
            if p.stacks.iter().any(|s| s == "PHP/Composer") {
                assert!(p.cleanable.iter().any(|c| c.label == "vendor"));
                found_php = true;
            }
            if p.stacks.iter().any(|s| s == "Swift/SPM") {
                assert!(p.cleanable.iter().any(|c| c.label == ".build"));
                found_spm = true;
            }
        }
        assert!(found_php, "expected PHP/Composer detection");
        assert!(found_spm, "expected Swift/SPM detection");
    }

    #[test]
    fn skips_recursion_into_known_artifact_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("outer");
        mkdir(&proj);
        touch(&proj.join("package.json"));
        let inner_dir = proj.join("node_modules/pkg");
        mkdir(&inner_dir);
        touch(&inner_dir.join("package.json"));

        let scan = run_scan(tmp.path(), 6);
        assert_eq!(scan.projects.len(), 1);
        assert_eq!(scan.projects[0].name, "outer");
    }

    #[test]
    fn paths_are_absolute_and_normalized() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("app");
        mkdir(&proj);
        touch(&proj.join("Cargo.toml"));
        mkdir(&proj.join("target"));
        fs::write(proj.join("target/out"), b"x").unwrap();

        let scan = run_scan(tmp.path(), 4);
        let p = &scan.projects[0];
        let target = &p.cleanable[0];
        let path = PathBuf::from(&target.path);
        assert!(path.is_absolute(), "advertised path should be absolute");
        assert!(target.path.ends_with("target"));
    }

    #[test]
    fn cleanables_include_category_and_note() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("app");
        mkdir(&proj);
        touch(&proj.join("package.json"));
        mkdir(&proj.join("node_modules"));
        fs::write(proj.join("node_modules/file"), b"x").unwrap();

        let scan = run_scan(tmp.path(), 4);
        let c = &scan.projects[0].cleanable[0];
        assert_eq!(c.category, "dependencies");
        assert!(!c.note.is_empty());
    }

    #[test]
    fn project_rules_toml_parses_and_is_non_empty() {
        let rules = project_rules();
        assert!(
            !rules.skip_dir_names.is_empty(),
            "project_rules.toml must declare at least one skip dir name",
        );
        assert!(
            !rules.stacks.is_empty(),
            "project_rules.toml must declare at least one stack",
        );

        for stack in &rules.stacks {
            assert!(!stack.name.is_empty(), "stack name must not be empty");
            assert!(
                !stack.markers.is_empty() || !stack.marker_exts.is_empty(),
                "stack {} must declare markers or marker_exts",
                stack.name,
            );
            for c in &stack.cleanable {
                assert!(
                    !c.name.is_empty(),
                    "cleanable in {} has empty name",
                    stack.name
                );
                assert!(
                    matches!(
                        c.category.as_str(),
                        "dependencies" | "build output" | "cache"
                    ),
                    "stack {} cleanable {} has unknown category {}",
                    stack.name,
                    c.name,
                    c.category,
                );
                assert!(
                    !c.note.is_empty(),
                    "cleanable {} in {} must have a note",
                    c.name,
                    stack.name,
                );
            }
        }
    }

    #[test]
    fn detects_ruby_terraform_cmake_and_bun() {
        let tmp = tempfile::tempdir().unwrap();

        let ruby = tmp.path().join("ruby-app");
        mkdir(&ruby);
        touch(&ruby.join("Gemfile"));
        mkdir(&ruby.join(".bundle"));
        fs::write(ruby.join(".bundle/config"), b"x").unwrap();

        let tf = tmp.path().join("infra");
        mkdir(&tf);
        touch(&tf.join("main.tf"));
        mkdir(&tf.join(".terraform"));
        fs::write(tf.join(".terraform/providers"), b"x").unwrap();

        let cmake = tmp.path().join("c-app");
        mkdir(&cmake);
        touch(&cmake.join("CMakeLists.txt"));
        mkdir(&cmake.join("build"));
        fs::write(cmake.join("build/out"), b"x").unwrap();

        let bun = tmp.path().join("bun-app");
        mkdir(&bun);
        touch(&bun.join("bun.lockb"));
        mkdir(&bun.join("node_modules"));
        fs::write(bun.join("node_modules/x"), b"x").unwrap();

        let scan = run_scan(tmp.path(), 4);
        let mut seen = std::collections::HashSet::new();
        for p in &scan.projects {
            for s in &p.stacks {
                seen.insert(s.clone());
            }
        }
        assert!(seen.contains("Ruby/Bundler"), "stacks found: {seen:?}");
        assert!(seen.contains("Terraform"), "stacks found: {seen:?}");
        assert!(seen.contains("CMake"), "stacks found: {seen:?}");
        assert!(seen.contains("Bun"), "stacks found: {seen:?}");
    }

    #[test]
    fn pre_cancelled_scan_returns_cancelled_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("app");
        mkdir(&proj);
        touch(&proj.join("Cargo.toml"));
        mkdir(&proj.join("target"));
        let cancel = Arc::new(AtomicBool::new(true));
        let scan = scan_projects(tmp.path(), 4, cancel, no_progress());
        assert!(scan.cancelled, "expected scan to be marked cancelled");
    }

    #[test]
    fn progress_callback_is_invoked() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("app");
        mkdir(&proj);
        touch(&proj.join("package.json"));
        mkdir(&proj.join("node_modules"));
        fs::write(proj.join("node_modules/file"), b"x").unwrap();

        let phases = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
        let phases_clone = Arc::clone(&phases);
        let progress: ProgressFn = Arc::new(move |p| {
            phases_clone.lock().unwrap().push(p.phase);
        });
        let _ = scan_projects(tmp.path(), 4, never_cancel(), progress);
        let phases = phases.lock().unwrap();
        assert!(phases.contains(&"discovery"));
        assert!(phases.contains(&"sizing"));
    }
}
