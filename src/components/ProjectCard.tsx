import { Link } from "react-router-dom";
import { Project } from "../types";
import { relativeTime } from "../lib/relativeTime";

interface Props {
  project: Project;
}

function StatusBadge({ status }: { status: string }) {
  // Truncate long status strings for the card badge
  const display = status.length > 40 ? status.slice(0, 40) + "…" : status;
  const lower = status.toLowerCase();
  let dot = "bg-zinc-500";
  if (lower.includes("live") || lower.includes("active")) dot = "bg-emerald-400";
  else if (lower.includes("sprint") || lower.includes("build")) dot = "bg-amber-400";
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-800 text-xs text-zinc-300 font-medium shrink-0 max-w-[180px] truncate">
      <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
      <span className="truncate">{display}</span>
    </span>
  );
}

export function ProjectCard({ project }: Props) {
  return (
    <Link
      to={`/projects/${project.slug}`}
      className="flex flex-col gap-3 p-4 rounded-xl bg-surface-2 border border-zinc-800 hover:border-zinc-600 hover:bg-surface-3 transition-colors duration-150 cursor-pointer select-none no-underline"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100 leading-snug">{project.name}</h2>
        {project.status && <StatusBadge status={project.status} />}
      </div>

      <div className="flex flex-wrap gap-2 mt-auto">
        {project.idea_count > 0 && (
          <Pill
            icon="💡"
            label={`${project.idea_count} idea${project.idea_count !== 1 ? "s" : ""}`}
          />
        )}
        {project.decision_count > 0 && (
          <Pill
            icon="⚡"
            label={`${project.decision_count} decision${project.decision_count !== 1 ? "s" : ""}`}
          />
        )}
        {project.repos.map((repo) => (
          <Pill key={repo} icon="⌥" label={repo} mono />
        ))}
      </div>

      <div className="text-xs text-zinc-500">{relativeTime(project.last_activity)}</div>
    </Link>
  );
}

function Pill({
  icon,
  label,
  mono,
}: {
  icon: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800 text-xs text-zinc-400 ${mono ? "font-mono" : ""}`}
    >
      <span>{icon}</span>
      {label}
    </span>
  );
}
