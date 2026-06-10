import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UsageRollup, Settings } from "../types";
import { StatCard } from "../components/StatCard";
import { TokenChart } from "../components/TokenChart";
import { ProjectBreakdown } from "../components/ProjectBreakdown";
import { fmtTokens, fmtDollars, formatDate } from "../lib/relativeTime";

export function Usage() {
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
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

  const { week, days, by_project, cached_files, parsed_files } = rollup;
  const capPct = settings.weekly_cap_tokens > 0
    ? Math.min(100, (week.total_tokens / settings.weekly_cap_tokens) * 100)
    : 0;

  const resetLabel =
    week.days_until_reset === 0 ? "Today" : `${week.days_until_reset}d`;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold text-zinc-100">Usage</h1>
        <span className="text-xs text-zinc-500">
          {cached_files} cached · {parsed_files} parsed this run
        </span>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Week tokens"
          value={fmtTokens(week.total_tokens)}
          sub={`${fmtTokens(week.output)} output`}
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
          sub={`of ${fmtTokens(settings.weekly_cap_tokens)}`}
        />
        <StatCard
          label="Resets in"
          value={resetLabel}
          sub={`week start ${formatDate(week.week_start)}`}
        />
      </div>

      {/* Token chart (14 days) */}
      <div className="rounded-xl border border-zinc-800 bg-surface-2 p-4">
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Tokens — last 14 days
          </p>
          <span className="text-xs text-zinc-600">output · cache write · input</span>
        </div>
        <TokenChart days={days} weekStart={week.week_start} />
      </div>

      {/* Token breakdown table */}
      <div className="rounded-xl border border-zinc-800 bg-surface-2 p-4 overflow-x-auto">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-4">
          Week breakdown
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-500 text-left">
              <th className="pb-2 font-medium">Category</th>
              <th className="pb-2 font-mono text-right pr-4">Tokens</th>
              <th className="pb-2 font-mono text-right">Est. cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            <TRow label="Output" tokens={week.output} rate={15} />
            <TRow label="Cache write" tokens={week.cache_write} rate={3.75} />
            <TRow label="Input (direct)" tokens={week.input} rate={3} />
            <TRow label="Cache read" tokens={week.cache_read} rate={0.3} />
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-700">
              <td className="pt-2 font-semibold text-zinc-200">Total</td>
              <td className="pt-2 font-mono text-right pr-4 text-zinc-200">
                {fmtTokens(week.total_tokens)}
              </td>
              <td className="pt-2 font-mono text-right text-zinc-200">
                {fmtDollars(week.est_dollars)}{" "}
                <span className="text-zinc-500">est.</span>
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="text-xs text-zinc-600 mt-3">
          Rates: Sonnet 4.6 pricing. All dollar figures are estimates, not invoices.
        </p>
      </div>

      {/* Per-project breakdown */}
      {by_project.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-surface-2 p-4">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-4">
            By project (all time)
          </p>
          <ProjectBreakdown projects={by_project} />
        </div>
      )}
    </div>
  );
}

function TRow({ label, tokens, rate }: { label: string; tokens: number; rate: number }) {
  const est = (tokens / 1_000_000) * rate;
  return (
    <tr>
      <td className="py-1.5 text-zinc-400">{label}</td>
      <td className="py-1.5 font-mono text-right pr-4 text-zinc-300">{fmtTokens(tokens)}</td>
      <td className="py-1.5 font-mono text-right text-zinc-300">
        {fmtDollars(est)} <span className="text-zinc-600">est.</span>
      </td>
    </tr>
  );
}
