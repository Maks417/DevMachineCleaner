import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { AiCachesPanel } from "./components/AiCachesPanel";
import "./App.css";

type Tab = "projects" | "ai";

export default function App() {
  const [tab, setTab] = useState<Tab>("projects");
  const [root, setRoot] = useState<string | null>(null);

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setRoot(selected);
  };

  const tabs = useMemo(
    () => [
      { id: "projects" as const, label: "Projects" },
      { id: "ai" as const, label: "AI caches" },
    ],
    [],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <nav className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="content">
        <main className="app-main">
          {tab === "projects" ? (
            <ProjectsPanel root={root} onPickFolder={pickFolder} />
          ) : (
            <AiCachesPanel />
          )}
        </main>

        <footer className="app-footer">
          Cleaned items are moved to your OS Recycle Bin / Trash — you can restore them.
        </footer>
      </div>
    </div>
  );
}
