import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";

interface MorningHealth {
  recovery: number;
  sleep_hours: number;
  sleep_perf: number;
  hrv: number;
  rhr: number;
  strain: number;
  read: string;
}

interface MorningTask {
  id: string;
  text: string;
  detail: string;
}

interface MorningBriefing {
  greeting: string;
  date_label: string;
  health: MorningHealth;
  day_line: string;
  commitments: string[];
  tasks: MorningTask[];
  agent_note?: string;
}

function recoveryColor(pct: number): string {
  if (pct >= 67) return "#3a9e62";
  if (pct >= 34) return "#d4a04d";
  return "#d65b48";
}

function RecoveryRing({ pct }: { pct: number }) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const color = recoveryColor(pct);
  const clamped = Math.min(100, Math.max(0, pct));
  const offset = circ * (1 - clamped / 100);

  return (
    <svg width="88" height="88" viewBox="0 0 88 88" className="shrink-0">
      <circle cx="44" cy="44" r={r} fill="none" stroke="#27272a" strokeWidth="7" />
      <circle
        cx="44"
        cy="44"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 44 44)"
      />
      <text
        x="44"
        y="49"
        textAnchor="middle"
        fill={color}
        fontSize="20"
        fontWeight="700"
      >
        {pct}
      </text>
    </svg>
  );
}

function parseBriefing(raw: string): MorningBriefing | null {
  const stripped = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/\s*```$/im, "")
    .trim();
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  if (s === -1 || e < s) return null;
  try {
    return JSON.parse(stripped.slice(s, e + 1)) as MorningBriefing;
  } catch {
    return null;
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; briefing: MorningBriefing }
  | { kind: "raw"; text: string }
  | { kind: "error"; message: string };

export function Morning() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [done, setDone] = useState<Set<string>>(new Set());

  function toggleDone(id: string) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run() {
    setPhase({ kind: "loading" });
    setDone(new Set());
    invoke<string>("generate_morning_briefing")
      .then((raw) => {
        const b = parseBriefing(raw);
        if (b) setPhase({ kind: "done", briefing: b });
        else setPhase({ kind: "raw", text: raw });
      })
      .catch((e) => setPhase({ kind: "error", message: String(e) }));
  }

  useEffect(() => {
    run();
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
        <h1 className="text-base font-semibold text-zinc-100">Morning</h1>
        {phase.kind !== "loading" && (
          <button
            onClick={run}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <RefreshCw size={13} strokeWidth={1.75} />
            Refresh
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {phase.kind === "loading" && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-zinc-400">
            <svg
              className="animate-spin"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <p className="text-sm">Pulling your Whoop and your day...</p>
          </div>
        )}

        {phase.kind === "done" && (
          <BriefingView
            briefing={phase.briefing}
            done={done}
            onToggle={toggleDone}
          />
        )}

        {phase.kind === "raw" && (
          <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono leading-relaxed">
            {phase.text}
          </pre>
        )}

        {phase.kind === "error" && (
          <div className="max-w-lg mx-auto mt-8 rounded-xl border border-red-900/50 bg-red-950/20 p-4">
            <p className="text-sm font-medium text-red-400 mb-1">Briefing failed</p>
            <p className="text-xs text-red-300/70 font-mono break-all">{phase.message}</p>
            <button
              onClick={run}
              className="mt-3 text-xs text-red-400 hover:text-red-200 underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface BriefingViewProps {
  briefing: MorningBriefing;
  done: Set<string>;
  onToggle: (id: string) => void;
}

function BriefingView({ briefing, done, onToggle }: BriefingViewProps) {
  const { health } = briefing;
  const rColor = recoveryColor(health.recovery);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Date + greeting */}
      <div>
        <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-widest">
          {briefing.date_label}
        </p>
        <h2 className="text-xl font-semibold text-zinc-100 mt-1">{briefing.greeting}</h2>
      </div>

      {/* Health card */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-start gap-5">
          <RecoveryRing pct={health.recovery} />
          <div className="flex-1 space-y-3">
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: "Sleep", value: `${health.sleep_hours}h · ${health.sleep_perf}%` },
                { label: "HRV", value: `${health.hrv}ms` },
                { label: "RHR", value: `${health.rhr}bpm` },
                { label: "Strain", value: String(health.strain) },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
                  <p className="text-xs font-semibold text-zinc-200 mt-0.5 tabular-nums">
                    {value}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">{health.read}</p>
          </div>
        </div>
      </div>

      {/* Day shape + commitments */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 space-y-2">
        <p className="text-sm text-zinc-200">{briefing.day_line}</p>
        {briefing.commitments.length > 0 && (
          <ul className="space-y-1.5">
            {briefing.commitments.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                {c}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Task list */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
        <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 pt-3 pb-2">
          The Plan
        </p>
        <div className="divide-y divide-zinc-800/50">
          {briefing.tasks.map((task) => {
            const isDone = done.has(task.id);
            return (
              <div key={task.id} className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() => onToggle(task.id)}
                  className="shrink-0 w-4 h-4 rounded-full border-2 transition-all"
                  style={{
                    borderColor: isDone ? "#52525b" : rColor,
                    backgroundColor: isDone ? "#3f3f46" : "transparent",
                  }}
                  aria-label={isDone ? "Mark undone" : "Mark done"}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-sm transition-colors ${
                      isDone ? "text-zinc-600 line-through" : "text-zinc-200"
                    }`}
                  >
                    {task.text}
                  </p>
                  {task.detail && (
                    <p className="text-xs text-zinc-500 mt-0.5">{task.detail}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Agent note */}
      {briefing.agent_note && (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
          <p className="text-xs text-zinc-400">{briefing.agent_note}</p>
        </div>
      )}
    </div>
  );
}
