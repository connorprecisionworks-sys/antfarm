import { Link } from "react-router-dom";
import { ProjectUsage } from "../types";
import { fmtTokens, fmtDollars } from "../lib/relativeTime";

interface Props {
  projects: ProjectUsage[];
  compact?: boolean;
}

export function ProjectBreakdown({ projects, compact = false }: Props) {
  const shown = compact ? projects.slice(0, 5) : projects;
  const maxTokens = Math.max(...shown.map((p) => p.total_tokens), 1);

  return (
    <div className="space-y-2">
      {shown.map((p) => (
        <div key={p.slug} className="group">
          <div className="flex items-center justify-between mb-0.5">
            {p.slug !== "unfiled" ? (
              <Link
                to={`/projects/${p.slug}`}
                className="text-sm text-zinc-300 hover:text-zinc-100 transition-colors"
              >
                {p.name}
              </Link>
            ) : (
              <span className="text-sm text-zinc-500">{p.name}</span>
            )}
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500 font-mono">{fmtTokens(p.total_tokens)}</span>
              <span className="text-xs text-zinc-400 font-mono w-14 text-right">
                {fmtDollars(p.est_dollars)} <span className="text-zinc-600">est.</span>
              </span>
            </div>
          </div>
          {/* Progress bar */}
          <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-indigo-600 rounded-full"
              style={{ width: `${(p.total_tokens / maxTokens) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
