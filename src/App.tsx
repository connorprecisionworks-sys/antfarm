import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Project } from "./types";
import { ProjectCard } from "./components/ProjectCard";

type LoadState = "loading" | "ok" | "error";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    invoke<Project[]>("list_projects")
      .then((data) => {
        setProjects(data);
        setState("ok");
      })
      .catch((err) => {
        setError(String(err));
        setState("error");
      });
  }, []);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-lg">🐜</span>
          <span className="text-sm font-semibold text-zinc-100 tracking-tight">Ant Farm</span>
        </div>
        {state === "ok" && (
          <span className="text-xs text-zinc-500">{projects.length} project{projects.length !== 1 ? "s" : ""}</span>
        )}
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {state === "loading" && (
          <div className="flex items-center justify-center h-full">
            <span className="text-zinc-500 text-sm animate-pulse">Scanning brain…</span>
          </div>
        )}

        {state === "error" && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-red-400 text-sm font-medium">Failed to load projects</p>
              <p className="text-zinc-600 text-xs mt-1 font-mono">{error}</p>
            </div>
          </div>
        )}

        {state === "ok" && projects.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-zinc-500 text-sm">No projects found in tools-built/</p>
          </div>
        )}

        {state === "ok" && projects.length > 0 && (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {projects.map((p) => (
              <ProjectCard key={p.slug} project={p} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
