import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UsageRollup, Settings, GitMetricsRollup, WorkingTreeRollup } from "../types";
import { StatCard } from "../components/StatCard";
import { TokenChart } from "../components/TokenChart";
import { ProjectBreakdown } from "../components/ProjectBreakdown";
import { fmtTokens, fmtDollars, fmtNet, formatDate } from "../lib/relativeTime";

export function Home() {
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [gitMetrics, setGitMetrics] = useState<GitMetricsRollup | null>(null);
  const [wtData, setWtData] = useState<WorkingTreeRollup | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      invoke<UsageRollup>("usage_rollup"),
      invoke<Settings>("get_settings"),
    ]).then(([r, s]) => {
      setRollup(r);
      setSettings(s);
      setLoading(false);
    }).catch(() => setLoading(false));
    invoke<GitMetricsRollup>("git_metrics_rollup")
      .then(setGitMetrics)
      .catch(() => {});
    invoke<WorkingTreeRollup>("working_tree_rollup")
      .then(setWtData)
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500 animate-pulse">Computing usage…</p>
      </div>
    );
  }

  if (!rollup || !settings) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-400">Details unavailable.</p>
      </div>
    );
  }

  const { week, days, by_project } = rollup;
  const capPct = settings.weekly_cap_tokens > 0
    ? Math.min(100, (week.total_tokens / settings.weekly_cap_tokens) * 100)
    : 0;

  const resetLabel =
    week.days_until_reset === 0
      ? "Today"
      : `${week.days_until_reset}d`;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold text-zinc-100">Home</h1>
        <span className="text-xs text-zinc-500">
          Week of {formatDate(week.week_start)} — {formatDate(week.today)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4 xl:grid-cols-4">
        {/* Chart: 2/3 width */}
        <div className="col-span-2 xl:col-span-3 rounded-xl border border-zinc-800 bg-surface-2 p-4">
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Tokens this week
            </p>
            <span className="text-xs text-zinc-600">output · cache write · input</span>
          </div>
          <TokenChart days={days} weekStart={week.week_start} weekOnly />
        </div>

        {/* Stat cards */}
        <div className="col-span-1 flex flex-col gap-3">
          <StatCard
            label="Week tokens"
            value={fmtTokens(week.total_tokens)}
            sub={`${week.output.toLocaleString()} output`}
          />
          <StatCard
            label="Est. cost"
            value={fmtDollars(week.est_dollars)}
            sub="est. — labeled, not exact"
            accent
          />
          <StatCard
            label="Cap used"
            value={`${capPct.toFixed(1)}%`}
            sub={`of ${fmtTokens(settings.weekly_cap_tokens)} cap`}
          />
          <StatCard
            label="Resets in"
            value={resetLabel}
            sub="until next week"
          />
          {gitMetrics && gitMetrics.week_total.commits > 0 && (
            <>
              <div className="border-t border-zinc-800 pt-1">
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Git this week</p>
              </div>
              <StatCard
                label="Commits"
                value={String(gitMetrics.week_total.commits)}
                sub="this week"
              />
              <StatCard
                label="Net lines"
                value={fmtNet(gitMetrics.week_total.lines_added - gitMetrics.week_total.lines_removed)}
                sub={`+${gitMetrics.week_total.lines_added.toLocaleString()} / −${gitMetrics.week_total.lines_removed.toLocaleString()}`}
              />
              <StatCard
                label="Files touched"
                value={gitMetrics.week_total.files_changed.toLocaleString()}
                sub="this week"
              />
            </>
          )}
        </div>
      </div>

      {/* Project breakdown */}
      {by_project.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-surface-2 p-4">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-4">
            By project (all time)
          </p>
          <ProjectBreakdown
            projects={by_project}
            compact
            dirtyBySlug={
              wtData
                ? Object.fromEntries(
                    wtData.by_project
                      .filter((p) => !p.no_data && p.dirty_count > 0)
                      .map((p) => [p.slug, p.dirty_count])
                  )
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
