import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { AiCachesPanel } from "./components/AiCachesPanel";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdater } from "./lib/useUpdater";
import "./App.css";

type Tab = "projects" | "ai";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "ai", label: "AI caches" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("projects");
  const [root, setRoot] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const updater = useUpdater();

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        // Non-fatal: footer just omits the version chip.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Silently check for a newer release once on launch; offline / same-version
  // outcomes stay quiet (see useUpdater). Runs once — the checkForUpdate
  // identity is stable across renders.
  useEffect(() => {
    void updater.checkForUpdate({ silent: true });
  }, [updater.checkForUpdate]);

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setRoot(selected);
  };

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-brand">Dev Cleanup</div>
        <nav className="tabs" role="tablist" aria-label="Cleanup category">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-current={tab === t.id ? "page" : undefined}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="content">
        <main className="app-main" role="main">
          {/* Both panels stay mounted so switching tabs never aborts an
              in-flight scan or discards results; the inactive one is hidden. */}
          <div hidden={tab !== "projects"}>
            <ProjectsPanel root={root} onPickFolder={pickFolder} />
          </div>
          <div hidden={tab !== "ai"}>
            <AiCachesPanel active={tab === "ai"} />
          </div>
        </main>

        <footer className="app-footer">
          <span className="app-footer-note">
            Cleaned items are moved to your OS Recycle Bin / Trash — you can restore them.
          </span>
          <div className="app-footer-update">
            {updater.status === "checking" && (
              <span className="app-update-status">Checking…</span>
            )}
            {updater.status === "uptodate" && (
              <span className="app-update-status">Up to date</span>
            )}
            {updater.status === "error" && !updater.update && (
              <span className="app-update-status app-update-status-error">
                Check failed
              </span>
            )}
            <button
              className="btn small"
              type="button"
              onClick={() => void updater.checkForUpdate({ silent: false })}
              disabled={
                updater.status === "checking" ||
                updater.status === "downloading" ||
                updater.status === "ready"
              }
            >
              Check for updates
            </button>
          </div>
          {version && (
            <span className="app-version" title="Developer Machine Cleaner version">
              v{version}
            </span>
          )}
        </footer>
      </div>

      <UpdateBanner
        status={updater.status}
        update={updater.update}
        downloaded={updater.downloaded}
        contentLength={updater.contentLength}
        error={updater.error}
        onInstall={() => void updater.downloadAndInstall()}
        onDismiss={updater.dismiss}
      />
    </div>
  );
}
