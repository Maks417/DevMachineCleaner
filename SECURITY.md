# Security Policy

## Threat Model

Developer Machine Cleaner deletes files from disk. The single largest risk is
deleting something the user did not intend to delete. The app is designed
around that risk:

- **Everything goes through the OS trash.** The app moves items to the Recycle
  Bin / Trash via the [`trash`](https://crates.io/crates/trash) crate. It never
  calls `std::fs::remove_*` or platform equivalents directly. Mistakes are
  recoverable by restoring from trash.
- **Scan-session scoped authorization.** Every scan command produces a
  `scan_id` and records the list of cleanable paths it advertised in
  backend-only state. `clean_paths` accepts only paths from the specific
  session id the frontend echoes back. Stale, forged, or otherwise unknown
  paths are rejected.
- **Symlinks and reparse points are rejected by the cleaner.** Following a
  symlink during deletion would risk trashing the link's target instead of the
  link itself, so the cleaner refuses such inputs even when they are in the
  allowlist.
- **No silent escalation.** All deletions require the user to (a) pick a
  scope, (b) select specific items, and (c) confirm an in-app dialog that
  shows the total bytes, categorized paths, and recovery note.
- **WebView CSP is restricted.** The Tauri config locks `script-src` to
  `'self'` and disables remote origins (see
  [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)). The Tauri
  capability surface is limited to `core:default` plus the dialog plugin (see
  [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json));
  no shell, fs, or http plugins are exposed.

## What Is Never Deleted

The app's stack and cache rule tables are intentionally narrow:

- **AI tools** target volatile cache directories only. Conversations, settings,
  and extensions are never touched. For example, the Claude Code spec
  explicitly excludes `~/.claude/projects/`, and the Cursor / VS Code specs
  cover only Electron `Cache`, `Code Cache`, `CachedData`, `GPUCache`, and
  `logs` — never `extensions`, settings, or workspace state.
- **Project scanning** only deletes well-known build artifacts, dependency
  installs, and tool caches (`node_modules`, `target`, `.venv`, `build`,
  `dist`, etc.). Source files, lock files, env files, and the project root
  itself are never touched.
- **Symlinks and Windows junctions** at the cleanable root are skipped during
  scanning and refused during cleaning.

## Reporting Vulnerabilities

If you discover a vulnerability, please report it privately rather than
opening a public issue:

1. Use GitHub's
   [private vulnerability reporting](https://github.com/Maks417/dev-cleanup/security/advisories/new)
   on this repository, or
2. Email the maintainer through the contact listed on their GitHub profile.

We will acknowledge receipt within a few days and aim to publish a fix and
advisory within 30 days of confirmation, depending on severity.

## Build Provenance

Release bundles are produced by
[`.github/workflows/release.yml`](.github/workflows/release.yml) on
GitHub-hosted runners from tagged commits, and the workflow refuses to build
if `package.json`, `Cargo.toml`, and `tauri.conf.json` disagree with the tag.
Each release also gets a `SHA256SUMS-<platform>.txt` asset so users can verify
artifacts after download:

```bash
shasum -a 256 -c SHA256SUMS-linux.txt
# or
Get-FileHash <file>.exe -Algorithm SHA256
```

Code signing for Windows and macOS notarization are not yet configured;
on first launch users will see SmartScreen / Gatekeeper warnings.
