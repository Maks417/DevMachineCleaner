# Developer Machine Cleaner

[![CI](https://github.com/Maks417/dev-cleanup/actions/workflows/ci.yml/badge.svg)](https://github.com/Maks417/dev-cleanup/actions/workflows/ci.yml)
[![Release](https://github.com/Maks417/dev-cleanup/actions/workflows/release.yml/badge.svg)](https://github.com/Maks417/dev-cleanup/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#download)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)

> A small cross-platform desktop app that reclaims disk space by cleaning developer build artifacts and AI/LLM caches. Everything goes to the OS Recycle Bin / Trash — fully recoverable.

---

## Why

Years of side projects, abandoned experiments, and shipped products leave a
trail of `node_modules`, `target/`, `.venv`, and gigabytes of HuggingFace /
Ollama / Cursor caches on your machine. Developer Machine Cleaner finds them,
shows you what they cost, and lets you wipe the ones you don't need with one
click.

## Features

- **Project scanning** — point it at any folder; it walks subdirectories and
  detects projects by their stack markers. Cleanable directories per stack
  (only those actually deleted by the app):
  - Node.js (`package.json`) → `node_modules`, `.next`, `.nuxt`, `.turbo`,
    `.cache`, `.parcel-cache`, `.svelte-kit`, `dist`, `build`, `out`, `.vite`
  - Rust (`Cargo.toml`) → `target`
  - Python (`pyproject.toml` / `requirements.txt` / `setup.py` / `Pipfile`) →
    `.venv`, `venv`, `env`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`,
    `.tox`, `build`, `dist`, `.eggs`
  - Go (`go.mod`) → `bin`, `vendor`
  - Java/Maven (`pom.xml`) → `target`
  - Java/Gradle (`build.gradle*`, `settings.gradle*`) → `build`, `.gradle`
  - .NET (`*.csproj` / `*.fsproj` / `*.vbproj` / `*.sln`) → `bin`, `obj`
  - Flutter/Dart (`pubspec.yaml`) → `build`, `.dart_tool`
  - Xcode (`*.xcodeproj` / `*.xcworkspace`) → `build`, `DerivedData`
- **AI cache scanning** — looks up known cache locations for:
  - HuggingFace, Ollama, PyTorch, TensorFlow
  - LM Studio, Jan, GPT4All
  - Cursor IDE (volatile caches only — extensions stay)
  - Claude Desktop, Claude Code (conversation history is never touched)
- **Filter chips** — slice results by stack or cache type before cleaning
- **Safe by default** — every delete request is checked against a
  backend-maintained allowlist of paths produced by the most recent scan, then
  moved to the OS trash via the
  [`trash`](https://crates.io/crates/trash) crate; you can restore them from
  the bin/trash any time
- **Liquid-glass UI** — translucent layered surfaces, backdrop blur, pill
  buttons, custom checkboxes; dark mode only (for now)

## Download

Bundles are published on the [Releases page](https://github.com/Maks417/dev-cleanup/releases).
Pick the one for your platform:

| Platform | Artifact |
|----------|----------|
| Windows  | `.msi` installer or `.exe` (NSIS) |
| macOS (Apple Silicon) | `.dmg` (`aarch64`) |
| Linux    | `.AppImage` or `.deb` |

> Intel Mac users: build from source — see below. GitHub retired the free Intel
> macOS runner in 2026, so we no longer ship a prebuilt Intel `.dmg`.

> Builds are currently **unsigned**, so on first launch Windows SmartScreen and
> macOS Gatekeeper will warn — right-click → Open (macOS) or "More info → Run
> anyway" (Windows). Code signing is on the roadmap.

## Build from source

Prerequisites:

- Node.js 20+
- Rust stable toolchain
- OS-specific deps for Tauri 2 — see the [Tauri prerequisites page](https://tauri.app/start/prerequisites/)

```bash
git clone https://github.com/Maks417/dev-cleanup.git
cd dev-cleanup
npm install
npm run tauri dev      # run in dev mode
npm run tauri build    # produce a release bundle for your OS
```

## Tech stack

- **Shell:** [Tauri 2](https://tauri.app/) — Rust backend, system WebView frontend
- **UI:** React 19 + TypeScript 5.8 + Vite 7
- **Rust crates:** `walkdir`, `rayon` (parallel sizing), `trash`, `dirs`, `serde`
- **Tauri plugins:** `tauri-plugin-dialog` (folder picker)

## Safety notes

- Nothing is ever permanently deleted by the app — everything goes through the
  OS Recycle Bin / Trash.
- The Tauri command that performs the delete (`clean_paths`) only accepts
  paths that the backend itself produced during a recent scan. Even if the
  WebView is compromised, it cannot request deletion of arbitrary user data.
- AI cache paths are conservative: only volatile cache directories are
  targeted, never configuration, extensions, or conversation history.
- Before cleaning, you'll always see a confirmation dialog with the list of
  paths and a total size.

## Cutting a release (maintainer)

1. Bump the version in three places so the release workflow's verification
   step passes: [`package.json`](package.json), [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml),
   and [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json).
2. Update [`package-lock.json`](package-lock.json) (`npm install --package-lock-only`)
   and [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) (`cargo update -p dev-cleanup`).
3. Commit and tag:

   ```bash
   git commit -am "Release v0.1.0"
   git tag v0.1.0
   git push origin main --tags
   ```

4. The `Release` workflow runs `verify` first (refuses to build if any of the
   three version values disagrees with the tag), then bundles `.dmg`,
   `.AppImage` + `.deb`, and `.msi` + NSIS `.exe`, attaching them to a draft
   release.
5. Review the draft on GitHub Releases, then publish.

## License

[MIT](LICENSE) © 2026 Max Davydov
