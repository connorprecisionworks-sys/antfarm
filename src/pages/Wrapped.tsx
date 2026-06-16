import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toPng } from "html-to-image";
import { Gift, Download } from "lucide-react";
import type { DailyTokenPoint, WrappedStats } from "../types";
import {
  fmtDate,
  fmtK,
  linesToHours,
  Period,
  PERIOD_LABELS,
  runsToAgentHours,
  tokensToWords,
  vsHistory,
  wordsToNovels,
} from "../lib/wrapped";

// ── Count-up hook ─────────────────────────────────────────────────────────────

function useCountUp(target: number, active: boolean, ms = 1100): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!active) {
      setVal(0);
      return;
    }
    const t0 = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / ms, 1);
      setVal(Math.round((1 - Math.pow(1 - p, 3)) * target));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setVal(target);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, ms]);
  return val;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function HookPill({ text }: { text: string }) {
  return (
    <span className="inline-block bg-[#d4a04d]/15 text-[#d4a04d] text-xs font-mono px-3 py-1.5 rounded-full border border-[#d4a04d]/25">
      {text}
    </span>
  );
}

function Sparkline({ points }: { points: DailyTokenPoint[] }) {
  const max = Math.max(...points.map((p) => p.tokens), 1);
  const W = 168, H = 36, barW = 18, gap = 6;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      {points.map((p, i) => {
        const h = Math.max(2, (p.tokens / max) * H);
        return (
          <rect
            key={p.date}
            x={i * (barW + gap)}
            y={H - h}
            width={barW}
            height={h}
            rx="3"
            fill={p.tokens > 0 ? "#7c97e8" : "#1a212c"}
            opacity={p.tokens > 0 ? 0.85 : 0.3}
          />
        );
      })}
    </svg>
  );
}

function ProgressBars({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex-1 h-0.5 bg-zinc-800 rounded-full overflow-hidden">
          {i < current && <div className="h-full w-full bg-[#7c97e8]" />}
          {i === current && (
            <div
              key={`fill-${current}`}
              className="h-full bg-[#7c97e8] animate-progress-fill"
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Slides ────────────────────────────────────────────────────────────────────

function NumberSlide({
  eyebrow,
  value,
  format,
  unit,
  hookLine,
  factLine,
}: {
  eyebrow: string;
  value: number;
  format?: (n: number) => string;
  unit?: string;
  hookLine: string | null;
  factLine: string;
}) {
  const count = useCountUp(value, true);
  const display = format ? format(count) : count.toLocaleString();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-4">
      <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">
        {eyebrow}
      </p>
      <p className="text-[clamp(3.5rem,12vw,5.5rem)] font-black text-[#7c97e8] leading-none tabular-nums">
        {display}
        {unit}
      </p>
      {hookLine && <HookPill text={hookLine} />}
      <p className="text-zinc-500 text-sm max-w-sm leading-relaxed">{factLine}</p>
    </div>
  );
}

function SummaryCard({
  stats,
  period,
  cardRef,
  exporting,
  onExport,
}: {
  stats: WrappedStats;
  period: Period;
  cardRef: React.RefObject<HTMLDivElement>;
  exporting: boolean;
  onExport: () => void;
}) {
  const periodLabel = PERIOD_LABELS[period].toUpperCase();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5">
      {/* Exportable card */}
      <div
        ref={cardRef}
        className="bg-[#1a212c] rounded-2xl p-7 w-full max-w-xs"
      >
        <p className="font-mono text-[9px] text-zinc-500 tracking-widest uppercase mb-5">
          ANT FARM · {periodLabel}
        </p>
        <p className="text-[3.25rem] font-black text-[#7c97e8] tabular-nums leading-none">
          {fmtK(stats.totalTokens)}
        </p>
        <p className="font-mono text-[10px] text-zinc-600 mb-5">tokens</p>

        <Sparkline points={stats.dailyTokens} />

        <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-zinc-700/50">
          <div>
            <p className="font-mono text-[8px] text-zinc-600 uppercase tracking-wider mb-1">
              LINES
            </p>
            <p className="text-sm font-bold text-zinc-100">
              +{fmtK(stats.linesAdded)}
            </p>
          </div>
          <div>
            <p className="font-mono text-[8px] text-zinc-600 uppercase tracking-wider mb-1">
              RUNS
            </p>
            <p className="text-sm font-bold text-zinc-100">{stats.runCount}</p>
          </div>
          <div>
            <p className="font-mono text-[8px] text-zinc-600 uppercase tracking-wider mb-1">
              SPEND
            </p>
            <p className="text-sm font-bold text-zinc-100">
              ${stats.totalCost.toFixed(2)}
            </p>
          </div>
        </div>
      </div>

      {/* Export button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onExport();
        }}
        disabled={exporting}
        className="flex items-center gap-2 font-mono text-xs text-zinc-400 border border-zinc-700
          px-4 py-2 rounded-lg hover:border-zinc-500 hover:text-zinc-200 transition-colors
          disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download size={12} />
        {exporting ? "saving…" : "save as PNG"}
      </button>
    </div>
  );
}

// ── Slide definitions ─────────────────────────────────────────────────────────

const SLIDES = ["tokens", "cost", "lines", "runs", "streak", "card"] as const;
type SlideId = (typeof SLIDES)[number];
const N_SLIDES = SLIDES.length;
const ADVANCE_MS = 5000;
const PERIODS: Period[] = ["week", "month", "all_time"];

// ── Page ──────────────────────────────────────────────────────────────────────

export function Wrapped() {
  const [period, setPeriod] = useState<Period>("month");
  const [stats, setStats] = useState<WrappedStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slide, setSlide] = useState(0);
  const [exporting, setExporting] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSlide(0);
    invoke<WrappedStats>("wrapped_stats", { period })
      .then(setStats)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [period]);

  // Auto-advance (skip on last slide)
  useEffect(() => {
    if (slide >= N_SLIDES - 1) return;
    const t = setTimeout(() => setSlide((s) => s + 1), ADVANCE_MS);
    return () => clearTimeout(t);
  }, [slide]);

  const nav = useCallback(
    (dir: 1 | -1) =>
      setSlide((s) => Math.max(0, Math.min(N_SLIDES - 1, s + dir))),
    [],
  );

  const exportPng = async () => {
    if (!cardRef.current || exporting) return;
    setExporting(true);
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: "#1a212c",
      });
      const base64 = dataUrl.split(",")[1];
      const filename = `antfarm-wrapped-${period}.png`;
      await invoke<string>("save_png_to_desktop", {
        filename,
        dataBase64: base64,
      });
    } catch (e) {
      console.error("export:", e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0d1117] text-white select-none overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-3 shrink-0">
        <div className="flex items-center gap-2">
          <Gift size={13} className="text-zinc-600" />
          <span className="font-mono text-[10px] text-zinc-600 uppercase tracking-wider">
            Wrapped
          </span>
        </div>
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={(e) => {
                e.stopPropagation();
                setPeriod(p);
              }}
              className={[
                "text-[10px] font-mono px-2.5 py-1 rounded-full border transition-colors",
                period === p
                  ? "border-[#7c97e8] text-[#7c97e8] bg-[#7c97e8]/10"
                  : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300",
              ].join(" ")}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Progress bars */}
      <div className="px-6 pb-4 shrink-0">
        <ProgressBars current={slide} total={N_SLIDES} />
      </div>

      {/* Slide area — click left/right half to navigate */}
      <div
        className="flex-1 relative overflow-hidden"
        onClick={(e) => {
          if ((e.target as Element).closest("button")) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          nav(e.clientX - rect.left > rect.width / 2 ? 1 : -1);
        }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full">
            <p className="font-mono text-xs text-zinc-700 animate-pulse">
              computing…
            </p>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full px-8">
            <p className="font-mono text-xs text-red-500/70 text-center">{error}</p>
          </div>
        )}
        {!loading && !error && stats && (
          <SlideView
            key={`${period}-${slide}`}
            slideId={SLIDES[slide]}
            stats={stats}
            period={period}
            cardRef={cardRef}
            exporting={exporting}
            onExport={exportPng}
          />
        )}
      </div>

      {/* Slide counter */}
      <div className="pb-4 flex justify-center shrink-0">
        <span className="font-mono text-[9px] text-zinc-800">
          {slide + 1} / {N_SLIDES}
        </span>
      </div>
    </div>
  );
}

// ── Slide renderer ────────────────────────────────────────────────────────────

function SlideView({
  slideId,
  stats,
  period,
  cardRef,
  exporting,
  onExport,
}: {
  slideId: SlideId;
  stats: WrappedStats;
  period: Period;
  cardRef: React.RefObject<HTMLDivElement>;
  exporting: boolean;
  onExport: () => void;
}) {
  const hook = vsHistory(stats.totalTokens, stats.prevPeriodTokens, period);

  switch (slideId) {
    case "tokens": {
      const words = tokensToWords(stats.totalTokens);
      const novels = wordsToNovels(words);
      return (
        <NumberSlide
          eyebrow={`TOKENS · ${PERIOD_LABELS[period].toUpperCase()}`}
          value={stats.totalTokens}
          format={fmtK}
          hookLine={hook}
          factLine={`≈ ${fmtK(words)} words · ${novels >= 1 ? novels.toFixed(1) : "<1"} novels`}
        />
      );
    }
    case "cost":
      return (
        <NumberSlide
          eyebrow="SPEND (EST.)"
          value={Math.round(stats.totalCost * 100)}
          format={(n) => `$${(n / 100).toFixed(2)}`}
          hookLine={null}
          factLine="est. from real Claude token prices"
        />
      );
    case "lines": {
      const hours = linesToHours(stats.linesAdded + stats.linesRemoved);
      return (
        <NumberSlide
          eyebrow="CODE CHANGED"
          value={stats.linesAdded}
          format={(n) => `+${fmtK(n)}`}
          hookLine={null}
          factLine={`−${fmtK(stats.linesRemoved)} removed · ${stats.commits} commits · ≈ ${hours < 1 ? "<1" : Math.round(hours)} focused hrs`}
        />
      );
    }
    case "runs": {
      const agentHrs = runsToAgentHours(stats.runCount);
      return (
        <NumberSlide
          eyebrow="AGENT RUNS"
          value={stats.runCount}
          format={(n) => n.toLocaleString()}
          hookLine={null}
          factLine={`done ${stats.runDone} · failed ${stats.runFailed} · killed ${stats.runKilled} · ≈ ${agentHrs < 1 ? "<1" : agentHrs.toFixed(1)} agent-hrs`}
        />
      );
    }
    case "streak": {
      const busiest = stats.busiestDay ? fmtDate(stats.busiestDay) : null;
      return (
        <NumberSlide
          eyebrow="BUILD STREAK"
          value={stats.currentStreak}
          unit=" days"
          hookLine={null}
          factLine={[
            `best run: ${stats.longestStreak} days`,
            busiest
              ? `busiest: ${busiest} (${fmtK(stats.busiestDayTokens)} tok)`
              : null,
            stats.topProjectName ? `top project: ${stats.topProjectName}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      );
    }
    case "card":
      return (
        <SummaryCard
          stats={stats}
          period={period}
          cardRef={cardRef}
          exporting={exporting}
          onExport={onExport}
        />
      );
  }
}
