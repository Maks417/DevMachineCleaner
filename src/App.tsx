import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { AiCachesPanel } from "./components/AiCachesPanel";
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
          {tab === "projects" ? (
            <ProjectsPanel root={root} onPickFolder={pickFolder} />
          ) : (
            <AiCachesPanel />
          )}
        </main>

        <footer className="app-footer">
          <span className="app-footer-note">
            Cleaned items are moved to your OS Recycle Bin / Trash — you can restore them.
          </span>
          {version && (
            <span className="app-version" title="Developer Machine Cleaner version">
              v{version}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
