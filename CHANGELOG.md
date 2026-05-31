# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-05-31

### Added

- **Scan depth control.** The Projects panel exposes a depth selector (4–12) so
  you can scan shallower for speed or deeper to reach nested projects.
- **Deno cleanables.** Deno projects now report `node_modules` and `vendor` as
  reclaimable.
- **Incremental sizing.** A process-lifetime size cache keyed on directory mtime
  lets repeat project scans skip re-walking unchanged trees (e.g. large
  `node_modules`).

### Changed

- **Tabs keep their state.** Both panels stay mounted when switching tabs, so an
  in-flight scan or its results are never discarded. The AI caches panel scans
  lazily the first time it is opened.
- **Project search** now also matches cleanable folder labels (e.g.
  `apps/web/node_modules`).
- **Stack filter chips** no longer imply additive per-stack byte totals; the
  tooltip clarifies that a polyglot project's bytes count toward each of its
  stacks.
- **Partial-clean feedback.** When some items succeed and others fail, the panel
  shows a success banner alongside a warning instead of only an error.
- **Confirm dialog accessibility.** The dialog focuses Cancel first, traps focus
  while open, and locks background scroll.

### Internal

- Shared `useCleanPanel` hook centralizes the scan/select/clean state machine
  used by both panels.

## [0.3.0] - 2026-05-31

### Added

- **Monorepo project grouping.** Nested detected projects (e.g. a Turborepo root
  plus `apps/web`) now fold into a single card under the topmost ancestor.
  Cleanable rows show paths relative to the project root (`apps/web/.next`).

### Changed

- **Confirm dialog readability.** Overlay surfaces use near-opaque backgrounds
  so modal content stays legible over busy scan results.

## [0.2.0] - 2026-05-26

### Added

- **Externalized project cleanup rules.** Project stack markers and cleanable
  subdirs now live in `src-tauri/src/scanner/project_rules.toml` instead of
  being hardcoded in `stacks.rs`. Adding a new stack or extending an existing
  one is a TOML edit plus a rebuild.
- **Scan-session scoped deletion authorization.** Each scan now produces a
  `scan_id` that the frontend echoes back when cleaning, replacing the
  process-wide grow-only allowlist. Stale or unknown sessions are rejected.
- **Symlink / Windows reparse-point protection.** The cleaner refuses
  symlinks and junctions even when they appear in the allowlist, and the
  scanner skips them at the cleanable root.
- **In-app confirmation dialog.** Replaces `window.confirm` with a dialog
  that shows total bytes, per-item paths and sizes, category buckets
  (dependencies / build output / cache / model weights / logs), and a
  prominent recoverability note.
- **Post-clean results report.** A dismissible inline report summarises
  successes and failures with expandable per-path detail.
- **Cancellable scans with progress.** Scans now emit phase + counter
  progress events and can be cancelled mid-run via a `cancel_scan` command.
  The UI shows live scan counters, elapsed time, and a Cancel button while a
  scan is in flight.
- **Broader stack detection:** PHP/Composer (`vendor`), Ruby/Bundler
  (`.bundle`, `vendor/bundle`), Swift/SPM (`.build`), Terraform
  (`.terraform`), CMake (`build`, `cmake-build-*`), Bun, and Deno markers.
- **Broader AI cache coverage:** Diffusers, OpenAI Triton kernel cache,
  NVIDIA CUDA compute cache, VS Code, and Windsurf.
- **Category metadata** on every cleanable and cache entry so the UI can
  show what regenerates versus what redownloads.
- **Scan error counters.** When `dir_size` or directory discovery hits
  permission / I/O errors, the count is surfaced as a warning banner so
  users know totals may be conservative.
- **Search + sort controls** on both panels.
- **Accessibility:** ARIA roles for tabs, filter toolbars, live status, and
  modal dialog; labeled checkboxes; keyboard-reachable cancel/close.
- **Responsive layout** for narrow windows.
- **CI quality gates:** `cargo fmt`, `cargo clippy -D warnings`, Rust unit
  tests, and frontend Vitest run on every PR before the cross-platform build
  matrix.
- **Release checksums.** `SHA256SUMS-<platform>.txt` is now attached to each
  release for manual artifact verification.
- **Dependabot** config for npm, cargo, and GitHub Actions.
- **`SECURITY.md`** documenting the threat model, what is never deleted, and
  how to report vulnerabilities.

### Changed

- `clean_paths` now requires `scanId` alongside `paths`. The frontend IPC
  wrapper is updated; external callers must echo back the scan id returned
  by the most recent scan.
- Scanner paths are now `std::path::absolute`-normalized (no symlink
  following) rather than canonicalized; the cleaner uses the same
  normalization, so symlinks no longer slip past the allowlist check.
- `package.json` gains description, license, repository, homepage, and
  scripts (`typecheck`, `test`, `test:watch`, `test:ui`).

### Tests

- Rust: 25 unit tests covering stack detection (incl. polyglot, Composer,
  SPM, Ruby/Terraform/CMake/Bun), AI cache resolution, scanner cancellation
  and progress callbacks, the deletion allowlist, symlink rejection, and
  scan-session eviction.
- Frontend: Vitest + React Testing Library suite covering `formatBytes`,
  the confirm dialog, the post-clean results banner, and the projects panel
  end-to-end flow (scan -> select -> confirm -> clean with scan id).

## [0.1.0] - 2026-05-26

Initial release: project artifact scanning, AI cache scanning, allowlisted
trash deletion, cross-platform bundles.
