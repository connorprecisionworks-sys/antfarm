import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Project } from "../types";
import { ProjectCard } from "../components/ProjectCard";

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    invoke<Project[]>("list_projects")
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, []);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-base font-semibold text-zinc-100">Projects</h1>
        {!loading && !error && (
          <span className="text-xs text-zinc-500">
            {projects.length} project{projects.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {loading && (
        <p className="text-sm text-zinc-500 animate-pulse">Scanning brain…</p>
      )}

      {error && (
        <div className="rounded-lg border border-red-800/40 bg-red-950/20 p-4">
          <p className="text-sm text-red-400">Failed to load projects</p>
          <p className="text-xs text-zinc-600 font-mono mt-1">{error}</p>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <p className="text-sm text-zinc-500">No projects found in tools-built/</p>
      )}

      {!loading && !error && projects.length > 0 && (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
        >
          {projects.map((p) => (
            <ProjectCard key={p.slug} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
