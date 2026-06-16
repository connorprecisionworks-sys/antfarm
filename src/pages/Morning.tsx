import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Moon, RefreshCw, Send, X } from "lucide-react";
import { useVoice } from "../lib/useVoice";
import { Project, RepoPath } from "../types";

// ── Animation styles ──────────────────────────────────────────────────────────

const CHAT_STYLES = `
  @keyframes msgIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes dotBounce {
    0%, 80%, 100% { transform: translateY(0); }
    40%           { transform: translateY(-4px); }
  }
  @keyframes chatShimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @keyframes insightIn {
    from { opacity: 0; transform: translateY(3px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: no-preference) {
    .msg-enter { animation: msgIn 0.25s ease-out both; }
    .dot-b1 { animation: dotBounce 1.2s ease-in-out infinite 0ms; }
    .dot-b2 { animation: dotBounce 1.2s ease-in-out infinite 160ms; }
    .dot-b3 { animation: dotBounce 1.2s ease-in-out infinite 320ms; }
    .typing-shimmer {
      background: linear-gradient(90deg, #27272a 25%, #3f3f46 50%, #27272a 75%);
      background-size: 200% 100%;
      animation: chatShimmer 1.5s linear infinite;
    }
    .insight-in { animation: insightIn 0.3s ease-out both; }
    .insight-bar {
      background: linear-gradient(90deg, transparent 0%, #6366f1 50%, transparent 100%);
      background-size: 200% 100%;
      animation: chatShimmer 1.6s linear infinite;
    }
    .insight-shimmer-line {
      background: linear-gradient(90deg, #27272a 25%, #3f3f46 50%, #27272a 75%);
      background-size: 200% 100%;
      animation: chatShimmer 1.5s linear infinite;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .typing-shimmer { background: #27272a; }
    .insight-in { opacity: 1; }
    .insight-bar { background: #6366f1; opacity: 0.4; }
    .insight-shimmer-line { background: #27272a; }
  }
`;

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch {}
}

// ── Routine checklist storage ─────────────────────────────────────────────────

const ROUTINE_ITEMS_KEY = "antfarm-routine-items";
const ROUTINE_DEFAULT   = [
  "Coffee",
  "Breakfast / fuel",
  "Plan / review the day",
  "Reading (20 min)",
  "Workout",
  "Work block",
];

function routineChecksKey(dateKey: string) {
  return `antfarm-routine-checks-${dateKey}`;
}

function loadRoutineItems(): string[] {
  const raw = lsGet(ROUTINE_ITEMS_KEY);
  if (raw === null) {
    lsSet(ROUTINE_ITEMS_KEY, JSON.stringify(ROUTINE_DEFAULT));
    return [...ROUTINE_DEFAULT];
  }
  try { return JSON.parse(raw) as string[]; } catch { return [...ROUTINE_DEFAULT]; }
}

function loadRoutineChecks(dateKey: string): Set<string> {
  const raw = lsGet(routineChecksKey(dateKey));
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw) as string[]); } catch { return new Set(); }
}

// ── Chat storage ──────────────────────────────────────────────────────────────

const CHAT_EXPANDED_KEY = "antfarm-chat-expanded";

// ── Domain types ──────────────────────────────────────────────────────────────

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
  auto_planned?: boolean;
}

interface AuthorResult {
  planPath: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
}

interface ProposalOption {
  id: string;
  title: string;
  summary: string;
  tradeoff: string;
}

interface ProposalResult {
  scope: string;
  options: ProposalOption[];
  questions: string[];
}

interface ChatMsg {
  id: string;
  role: "user" | "agent" | "error";
  text: string;
}

type HandoffState =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "sent"; label: string }
  | { kind: "proposal"; result: ProposalResult }
  | { kind: "error"; message: string };

// ── Misc helpers ──────────────────────────────────────────────────────────────

function recoveryColor(pct: number): string {
  if (pct >= 67) return "#3a9e62";
  if (pct >= 34) return "#d4a04d";
  return "#d65b48";
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

function buildDoneSummary(
  routineItems: string[],
  routineChecks: Set<string>,
  tasks: MorningTask[],
  doneTasks: Set<string>,
  removedTasks: Set<string>,
): string {
  const hour = new Date().getHours();
  const timeLabel =
    hour < 10 ? "early morning"
    : hour < 12 ? "mid-morning"
    : hour < 15 ? "afternoon"
    : "late afternoon";

  const doneRoutine    = routineItems.filter((i) => routineChecks.has(i));
  const pendingRoutine = routineItems.filter((i) => !routineChecks.has(i));
  const visibleTasks   = tasks.filter((t) => !removedTasks.has(t.id));
  const doneWork       = visibleTasks.filter((t) => doneTasks.has(t.id));
  const pendingWork    = visibleTasks.filter((t) => !doneTasks.has(t.id));

  const parts: string[] = [];
  parts.push(doneRoutine.length > 0
    ? `Routine done: ${doneRoutine.join(", ")}`
    : "Routine: none started yet");
  if (pendingRoutine.length > 0)
    parts.push(`Routine pending: ${pendingRoutine.join(", ")}`);
  parts.push(doneWork.length > 0
    ? `Work tasks done: ${doneWork.map((t) => t.text).join(", ")}`
    : "Work tasks: none done yet");
  if (pendingWork.length > 0)
    parts.push(`Work tasks pending: ${pendingWork.map((t) => t.text).join(", ")}`);
  parts.push(`Time: ${timeLabel}`);
  return parts.join(". ") + ".";
}

function nowString(): string {
  return new Date().toLocaleString();
}

let _chatSeq = 0;
function newChatId() { return `cm-${++_chatSeq}`; }

// ── Recovery ring ─────────────────────────────────────────────────────────────

function RecoveryRing({ pct }: { pct: number }) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const color = recoveryColor(pct);
  const offset = circ * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <svg width="88" height="88" viewBox="0 0 88 88" className="shrink-0">
      <circle cx="44" cy="44" r={r} fill="none" stroke="#27272a" strokeWidth="7" />
      <circle
        cx="44" cy="44" r={r}
        fill="none" stroke={color} strokeWidth="7"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform="rotate(-90 44 44)"
      />
      <text x="44" y="49" textAnchor="middle" fill={color} fontSize="20" fontWeight="700">
        {pct}
      </text>
    </svg>
  );
}

// ── Insight card ──────────────────────────────────────────────────────────────

function InsightCard({ doneSummary }: { doneSummary: string }) {
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [text, setText]       = useState("");
  const [loading, setLoading] = useState(false);
  const [revKey, setRevKey]   = useState(0);
  const isFirstRun   = useRef(true);
  const summaryRef   = useRef(doneSummary);
  summaryRef.current = doneSummary;

  async function fetchInsight(summary: string) {
    setLoading(true);
    try {
      const result = await invoke<string>("morning_insight", {
        doneSummary: summary,
        now: nowString(),
      });
      setText(result);
      setRevKey((k) => k + 1);
    } catch {
      // keep last text on error
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchInsight(summaryRef.current);
  }, []);

  useEffect(() => {
    if (isFirstRun.current) { isFirstRun.current = false; return; }
    const t = setTimeout(() => fetchInsight(doneSummary), 1500);
    return () => clearTimeout(t);
  }, [doneSummary]);

  const hasSkeleton = loading && !text;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden relative">
      {loading && (
        <div className="absolute inset-x-0 top-0 h-0.5">
          <div className="h-full insight-bar" />
        </div>
      )}
      <div className="px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0">
              {!loading && !reducedMotion && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-60 animate-ping" />
              )}
              <span className={`relative inline-flex rounded-full h-2 w-2 transition-colors ${loading ? "bg-zinc-600" : "bg-indigo-500"}`} />
            </span>
            <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Right now</p>
          </div>
          <button
            onClick={() => fetchInsight(doneSummary)}
            disabled={loading}
            className="text-zinc-600 hover:text-zinc-400 disabled:opacity-30 transition-colors"
            aria-label="Refresh insight"
          >
            <RefreshCw size={11} strokeWidth={2} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {hasSkeleton ? (
          <div className="space-y-1.5">
            <div className="h-4 rounded-md insight-shimmer-line" />
            <div className="h-4 rounded-md w-4/5 insight-shimmer-line" />
          </div>
        ) : (
          <p
            key={revKey}
            className={`text-sm text-zinc-200 leading-relaxed ${revKey > 0 && !reducedMotion ? "insight-in" : ""}`}
          >
            {text || <span className="text-zinc-500">Generating your insight...</span>}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Routine checklist (controlled) ────────────────────────────────────────────

interface RoutineChecklistProps {
  items: string[];
  onItemsChange: (items: string[]) => void;
  checks: Set<string>;
  onChecksChange: (checks: Set<string>) => void;
  dateKey: string;
}

function RoutineChecklist({ items, onItemsChange, checks, onChecksChange, dateKey }: RoutineChecklistProps) {
  const [addText, setAddText] = useState("");
  const addRef = useRef<HTMLInputElement>(null);

  function toggleCheck(text: string) {
    const next = new Set(checks);
    if (next.has(text)) next.delete(text);
    else next.add(text);
    lsSet(routineChecksKey(dateKey), JSON.stringify([...next]));
    onChecksChange(next);
  }

  function removeItem(text: string) {
    const nextItems = items.filter((i) => i !== text);
    lsSet(ROUTINE_ITEMS_KEY, JSON.stringify(nextItems));
    onItemsChange(nextItems);
    const nextChecks = new Set(checks);
    nextChecks.delete(text);
    lsSet(routineChecksKey(dateKey), JSON.stringify([...nextChecks]));
    onChecksChange(nextChecks);
  }

  function addItem() {
    const text = addText.trim();
    if (!text || items.includes(text)) return;
    const next = [...items, text];
    lsSet(ROUTINE_ITEMS_KEY, JSON.stringify(next));
    onItemsChange(next);
    setAddText("");
    setTimeout(() => addRef.current?.focus(), 0);
  }

  const checkedCount = items.filter((i) => checks.has(i)).length;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Morning routine</p>
        <p className="text-[10px] text-zinc-600 tabular-nums">{checkedCount}/{items.length}</p>
      </div>

      <div className="divide-y divide-zinc-800/40">
        {items.map((item) => {
          const isDone = checks.has(item);
          return (
            <div key={item} className="flex items-center gap-3 px-4 py-2.5 group/routine">
              <button
                onClick={() => toggleCheck(item)}
                className="shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all"
                style={{
                  borderColor: isDone ? "#52525b" : "#71717a",
                  backgroundColor: isDone ? "#3f3f46" : "transparent",
                }}
                aria-label={isDone ? "Uncheck" : "Check"}
              >
                {isDone && (
                  <svg width="7" height="7" viewBox="0 0 7 7" fill="none">
                    <path d="M1 3.5L2.8 5.5L6 1.5" stroke="#a1a1aa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
              <span
                className={`flex-1 text-sm select-none transition-colors cursor-default ${
                  isDone ? "text-zinc-600 line-through" : "text-zinc-300"
                }`}
                onClick={() => toggleCheck(item)}
              >
                {item}
              </span>
              <button
                onClick={() => removeItem(item)}
                className="shrink-0 opacity-0 group-hover/routine:opacity-100 transition-opacity text-zinc-600 hover:text-zinc-400"
                aria-label={`Remove ${item}`}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-zinc-800/40">
        <input
          ref={addRef}
          type="text"
          placeholder="+ add item"
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addItem(); }}
          className="flex-1 text-xs bg-transparent text-zinc-400 placeholder-zinc-600 focus:outline-none focus:text-zinc-200 transition-colors"
        />
        {addText.trim() && (
          <button
            onClick={addItem}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Add
          </button>
        )}
      </div>
    </div>
  );
}

// ── Proposal view ─────────────────────────────────────────────────────────────

function ProposalView({ result }: { result: ProposalResult }) {
  return (
    <div className="space-y-2.5 pt-1">
      {result.scope && <p className="text-xs text-zinc-400 italic">{result.scope}</p>}
      {result.options.map((opt) => (
        <div key={opt.id} className="rounded-lg border border-zinc-700/40 bg-zinc-800/40 px-3 py-2.5">
          <p className="text-xs font-semibold text-zinc-200">{opt.title}</p>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{opt.summary}</p>
          {opt.tradeoff && (
            <p className="text-[11px] text-zinc-500 mt-1">Tradeoff: {opt.tradeoff}</p>
          )}
        </div>
      ))}
      {result.questions.length > 0 && (
        <div className="space-y-1 pt-0.5">
          {result.questions.map((q, i) => (
            <p key={i} className="text-[11px] text-zinc-500">· {q}</p>
          ))}
        </div>
      )}
      <p className="text-[11px] text-zinc-600">Review above, then arm a plan manually.</p>
    </div>
  );
}

// ── Task row ──────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: MorningTask;
  isDone: boolean;
  onToggleDone: () => void;
  onRemove: () => void;
  isExpanded: boolean;
  onExpand: (id: string | null) => void;
  projects: Project[];
  recovColor: string;
}

function TaskRow({ task, isDone, onToggleDone, onRemove, isExpanded, onExpand, projects, recovColor }: TaskRowProps) {
  const [scope, setScope]           = useState("");
  const [selectedSlug, setSelectedSlug] = useState("");
  const [handoff, setHandoff]       = useState<HandoffState>({ kind: "idle" });

  const dispatched = handoff.kind === "sent" || handoff.kind === "proposal";
  const dotBorder  = dispatched ? "#6366f1" : isDone ? "#52525b" : recovColor;
  const dotFill    = dispatched ? "#4f46e5" : isDone ? "#3f3f46" : "transparent";

  async function dispatch(mode: "single" | "swarm" | "orchestrate") {
    if (!selectedSlug) return;
    setHandoff({
      kind: "working",
      label: mode === "single" ? "Authoring plan..." : mode === "swarm" ? "Authoring swarm..." : "Proposing options...",
    });
    try {
      const paths = await invoke<RepoPath[]>("get_project_paths", { slug: selectedSlug });
      const projectPath = paths[0]?.path ?? "";
      if (!projectPath) {
        setHandoff({ kind: "error", message: `No repo path for "${selectedSlug}". Add one in ant-farm-registry.json.` });
        return;
      }
      if (mode === "orchestrate") {
        const description = [task.text, scope].filter(Boolean).join(". ");
        const result = await invoke<ProposalResult>("propose_plan", { description, projectPath });
        setHandoff({ kind: "proposal", result });
      } else {
        const constraint = mode === "single"
          ? "Constraint: implement as a single run."
          : "Decompose into multiple small independent parallel runs.";
        const description = [task.text, scope, constraint].filter(Boolean).join(". ");
        const authored = await invoke<AuthorResult>("author_plan", { description, projectPath });
        setHandoff({ kind: "working", label: "Arming plan..." });
        await invoke<string>("arm_night_plan", { planPath: authored.planPath });
        setHandoff({ kind: "sent", label: mode === "single" ? "Sent to 1 agent" : "Sent to a swarm" });
      }
    } catch (e) {
      setHandoff({ kind: "error", message: String(e) });
    }
  }

  return (
    <>
      <div className={`flex items-center gap-3 px-4 py-3 group/task transition-colors ${isExpanded ? "bg-zinc-900/80" : ""}`}>
        <button
          onClick={onToggleDone}
          className="shrink-0 w-4 h-4 rounded-full border-2 transition-all"
          style={{ borderColor: dotBorder, backgroundColor: dotFill }}
          aria-label={isDone ? "Mark undone" : "Mark done"}
        />
        <button className="flex-1 min-w-0 text-left" onClick={() => onExpand(isExpanded ? null : task.id)}>
          <p className={`text-sm transition-colors ${isDone ? "text-zinc-600 line-through" : "text-zinc-200"}`}>
            {task.text}
          </p>
          {task.detail && <p className="text-xs text-zinc-500 mt-0.5">{task.detail}</p>}
        </button>
        <button
          onClick={onRemove}
          className="shrink-0 opacity-0 group-hover/task:opacity-100 transition-opacity text-zinc-600 hover:text-zinc-400"
          aria-label="Remove task"
        >
          <X size={12} strokeWidth={2} />
        </button>
        <ChevronRight
          size={14} strokeWidth={1.75}
          className={`text-zinc-600 shrink-0 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
        />
      </div>

      {isExpanded && (
        <div className="border-t border-zinc-800/50 bg-zinc-950/50 px-4 py-3 space-y-2.5">
          <input
            type="text"
            placeholder="Add scope or detail (optional)"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="w-full text-xs bg-zinc-800/60 border border-zinc-700/40 rounded-lg px-3 py-2 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <select
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            className="w-full text-xs bg-zinc-800/60 border border-zinc-700/40 rounded-lg px-3 py-2 text-zinc-300 focus:outline-none focus:border-zinc-500 transition-colors"
          >
            <option value="">Select project...</option>
            {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>

          {(handoff.kind === "idle" || handoff.kind === "error") && (
            <div className="flex gap-2 flex-wrap">
              {(["single", "swarm", "orchestrate"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => dispatch(mode)}
                  disabled={!selectedSlug}
                  className="text-xs px-3 py-1.5 rounded-lg border border-zinc-700/60 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  {mode === "single" ? "Send 1 agent" : mode === "swarm" ? "Plan a swarm" : "Send to orchestrator"}
                </button>
              ))}
            </div>
          )}
          {handoff.kind === "error" && (
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-red-400 leading-relaxed">{handoff.message}</p>
              <button
                onClick={() => setHandoff({ kind: "idle" })}
                className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 shrink-0"
              >
                Reset
              </button>
            </div>
          )}
          {handoff.kind === "working"  && <p className="text-xs text-zinc-500 animate-pulse">{handoff.label}</p>}
          {handoff.kind === "sent"     && <p className="text-xs text-emerald-400">{handoff.label}, it'll report back.</p>}
          {handoff.kind === "proposal" && <ProposalView result={handoff.result} />}
        </div>
      )}
    </>
  );
}

// ── Briefing cards ────────────────────────────────────────────────────────────

interface BriefingViewProps {
  briefing: MorningBriefing;
  done: Set<string>;
  onToggle: (id: string) => void;
  projects: Project[];
}

function BriefingView({ briefing, done, onToggle, projects }: BriefingViewProps) {
  const { health } = briefing;
  const rColor = recoveryColor(health.recovery);

  const routineDateKey = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [routineItems, setRoutineItems]   = useState<string[]>(() => loadRoutineItems());
  const [routineChecks, setRoutineChecks] = useState<Set<string>>(() => loadRoutineChecks(routineDateKey));

  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [removedTasks, setRemovedTasks] = useState<Set<string>>(new Set());

  function removeTask(id: string) {
    setRemovedTasks((prev) => new Set([...prev, id]));
  }

  function clearDone() {
    setRemovedTasks((prev) => {
      const next = new Set(prev);
      briefing.tasks.forEach((t) => { if (done.has(t.id)) next.add(t.id); });
      return next;
    });
  }

  const visibleTasks = briefing.tasks.filter((t) => !removedTasks.has(t.id));
  const doneVisible  = visibleTasks.filter((t) => done.has(t.id)).length;

  const doneSummary = useMemo(
    () => buildDoneSummary(routineItems, routineChecks, briefing.tasks, done, removedTasks),
    [routineItems, routineChecks, briefing.tasks, done, removedTasks]
  );

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Auto-planned note */}
      {briefing.auto_planned && (
        <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 flex items-center gap-2">
          <Moon size={12} strokeWidth={1.75} className="text-amber-400 shrink-0" />
          <p className="text-xs text-amber-400">
            Auto-planned from yesterday. You didn't lock a plan last night.
          </p>
        </div>
      )}

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
                { label: "Sleep",  value: `${health.sleep_hours}h · ${health.sleep_perf}%` },
                { label: "HRV",    value: `${health.hrv}ms` },
                { label: "RHR",    value: `${health.rhr}bpm` },
                { label: "Strain", value: String(health.strain) },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                  <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</p>
                  <p className="text-xs font-semibold text-zinc-200 mt-0.5 tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">{health.read}</p>
          </div>
        </div>
      </div>

      {/* Right now */}
      <InsightCard doneSummary={doneSummary} />

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

      {/* Morning routine */}
      <RoutineChecklist
        items={routineItems}
        onItemsChange={setRoutineItems}
        checks={routineChecks}
        onChecksChange={setRoutineChecks}
        dateKey={routineDateKey}
      />

      {/* Work tasks */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">The Plan</p>
          {doneVisible > 0 && (
            <button
              onClick={clearDone}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Clear done
            </button>
          )}
        </div>

        {visibleTasks.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-zinc-600">All tasks cleared.</p>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {visibleTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                isDone={done.has(task.id)}
                onToggleDone={() => onToggle(task.id)}
                onRemove={() => removeTask(task.id)}
                isExpanded={expandedId === task.id}
                onExpand={setExpandedId}
                projects={projects}
                recovColor={rColor}
              />
            ))}
          </div>
        )}
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

// ── Chat panel ────────────────────────────────────────────────────────────────

function MessageBubble({ msg, speaking }: { msg: ChatMsg; speaking?: boolean }) {
  const isUser  = msg.role === "user";
  const isError = msg.role === "error";
  return (
    <div className={`flex msg-enter ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-indigo-600 text-white rounded-br-sm"
            : isError
            ? "bg-red-950/20 border border-red-900/30 text-red-300 rounded-bl-sm"
            : "bg-zinc-800 text-zinc-200 rounded-bl-sm"
        }`}
      >
        {msg.text}
        {speaking && (
          <span className="inline-flex items-center gap-0.5 ml-1.5 align-middle">
            <span className="dot-b1 w-1 h-1 rounded-full bg-indigo-400 inline-block" />
            <span className="dot-b2 w-1 h-1 rounded-full bg-indigo-400 inline-block" />
            <span className="dot-b3 w-1 h-1 rounded-full bg-indigo-400 inline-block" />
          </span>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start msg-enter">
      <div className="typing-shimmer rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
        <span className="dot-b1 w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block" />
        <span className="dot-b2 w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block" />
        <span className="dot-b3 w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block" />
      </div>
    </div>
  );
}

interface MorningChatProps {
  briefingJson: string;
  dateKey: string;
}

function MorningChat({ briefingJson, dateKey }: MorningChatProps) {
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [expanded, setExpanded] = useState<boolean>(() => {
    const raw = lsGet(CHAT_EXPANDED_KEY);
    return raw === null ? true : raw === "true";
  });
  const [messages, setMessages]     = useState<ChatMsg[]>([]);
  const [input, setInput]           = useState("");
  const [thinking, setThinking]     = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const thinkingRef = useRef(false);

  useEffect(() => { thinkingRef.current = thinking; }, [thinking]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      lsSet(CHAT_EXPANDED_KEY, String(next));
      return next;
    });
  }

  async function sendText(text: string, agentMsgId?: string): Promise<string | null> {
    if (!text || thinkingRef.current) return null;
    setThinking(true);
    thinkingRef.current = true;
    if (!expanded) { setExpanded(true); lsSet(CHAT_EXPANDED_KEY, "true"); }
    setMessages((prev) => [...prev, { id: newChatId(), role: "user", text }]);
    const replyId = agentMsgId ?? newChatId();
    try {
      const reply = await invoke<string>("morning_chat_send", {
        dateKey,
        briefingJson,
        message: text,
        now: nowString(),
      });
      setMessages((prev) => [...prev, { id: replyId, role: "agent", text: reply }]);
      return reply;
    } catch (e) {
      setMessages((prev) => [...prev, { id: replyId, role: "error", text: String(e) }]);
      return null;
    } finally {
      setThinking(false);
      thinkingRef.current = false;
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    setInput("");
    await sendText(text);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  const onTranscript = useCallback(async (transcript: string) => {
    setInput("");
    const msgId = newChatId();
    const reply = await sendText(transcript, msgId);
    if (reply) {
      setSpeakingId(msgId);
      await speak(reply);
      setSpeakingId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefingJson, dateKey, expanded]);

  const { state: voiceState, isSupported: voiceSupported, startRecording, stopRecording, speak, stopAll } =
    useVoice({ voice: "ash", onTranscript });

  const isMicActive = voiceState === "recording" || voiceState === "transcribing" || voiceState === "speaking";

  const bodyTransition = reducedMotion
    ? "none"
    : "max-height 0.25s ease, opacity 0.2s ease";

  return (
    <div className="shrink-0 flex flex-col border-t border-zinc-800 bg-zinc-950/80">
      <style>{CHAT_STYLES}</style>

      <button
        onClick={toggleExpanded}
        className="flex items-center justify-between px-4 py-2.5 w-full hover:bg-zinc-900/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-400">Morning agent</span>
          {messages.length > 0 && !expanded && (
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />
          )}
        </div>
        <ChevronRight
          size={13} strokeWidth={1.75}
          className={`text-zinc-600 transition-transform ${reducedMotion ? "" : "duration-200"} ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      <div
        style={{
          maxHeight: expanded ? "240px" : "0",
          opacity: expanded ? 1 : 0,
          overflow: "hidden",
          transition: bodyTransition,
        }}
      >
        <div
          ref={scrollRef}
          className="overflow-y-auto px-4 py-3 space-y-2"
          style={{ maxHeight: "192px" }}
        >
          {messages.length === 0 && !thinking && (
            <p className="text-xs text-zinc-600 text-center py-3 select-none">
              Ask Jarvis a follow-up...
            </p>
          )}
          {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} speaking={msg.id === speakingId} />)}
          {thinking && <TypingIndicator />}
        </div>

        <div className="flex gap-2 items-center px-4 py-2.5 border-t border-zinc-800/50">
          {voiceSupported && (
            <button
              onMouseDown={() => { if (voiceState === "speaking") { stopAll(); setSpeakingId(null); } else startRecording(); }}
              onMouseUp={() => { if (voiceState === "recording") stopRecording(); }}
              onTouchStart={(e) => { e.preventDefault(); if (voiceState === "speaking") { stopAll(); setSpeakingId(null); } else startRecording(); }}
              onTouchEnd={() => { if (voiceState === "recording") stopRecording(); }}
              disabled={thinking && !isMicActive}
              className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                voiceState === "recording"
                  ? "bg-red-600 hover:bg-red-500"
                  : voiceState === "speaking"
                  ? "bg-indigo-700 hover:bg-indigo-600"
                  : voiceState === "transcribing"
                  ? "bg-zinc-700 cursor-wait"
                  : "bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
              }`}
              aria-label={voiceState === "recording" ? "Recording…" : voiceState === "speaking" ? "Speaking…" : "Voice input"}
            >
              {voiceState === "speaking" ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              ) : voiceState === "transcribing" ? (
                <svg className="animate-spin w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={voiceState === "recording" ? "text-white" : "text-zinc-300"}>
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={thinking}
            placeholder={
              voiceState === "recording" ? "Recording…"
              : voiceState === "transcribing" ? "Transcribing…"
              : voiceState === "speaking" ? "Speaking…"
              : thinking ? "Thinking…"
              : "Ask Jarvis…"
            }
            className="flex-1 text-xs bg-transparent border border-zinc-700/50 rounded-lg px-3 py-2 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/60 disabled:opacity-50 transition-colors"
          />
          <button
            onClick={send}
            disabled={thinking || !input.trim()}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {thinking ? (
              <svg className="animate-spin w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <Send size={13} strokeWidth={2} className="text-white" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

type Phase =
  | { kind: "idle" }
  | { kind: "loading"; label?: string }
  | { kind: "done"; briefing: MorningBriefing }
  | { kind: "needs_plan" }
  | { kind: "raw"; text: string }
  | { kind: "error"; message: string };

type WhoopState = "idle" | "loading" | "done";

export function Morning() {
  const [phase, setPhase]               = useState<Phase>({ kind: "idle" });
  const [done, setDone]                 = useState<Set<string>>(new Set());
  const [projects, setProjects]         = useState<Project[]>([]);
  const [briefingJson, setBriefingJson] = useState<string>("");
  const [whoopState, setWhoopState]     = useState<WhoopState>("idle");
  const [showPlanNudge, setShowPlanNudge] = useState(false);
  const navigate = useNavigate();

  const dateKey = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // After 20:00, check if tomorrow's plan is locked; nudge if not
  useEffect(() => {
    if (new Date().getHours() < 20) return;
    invoke<{ locked: boolean }>("get_tomorrow_plan")
      .then((p) => setShowPlanNudge(!p.locked))
      .catch(() => {});
  }, []);

  useEffect(() => {
    invoke<Project[]>("list_projects").then(setProjects).catch(() => {});
  }, []);

  function toggleDone(id: string) {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function generate(force = false) {
    invoke<string>("generate_morning_briefing", { now: nowString(), force })
      .then((raw) => {
        try {
          const quick = JSON.parse(raw.trim());
          if (quick && quick.needs_plan) { setPhase({ kind: "needs_plan" }); return; }
        } catch {}
        const b = parseBriefing(raw);
        if (b) {
          setBriefingJson(JSON.stringify(b));
          setPhase({ kind: "done", briefing: b });
        } else {
          setPhase({ kind: "raw", text: raw });
        }
      })
      .catch((e) => setPhase({ kind: "error", message: String(e) }));
  }

  // Mount: fire-and-forget whoop refresh, read from cache (no force)
  useEffect(() => {
    invoke("refresh_whoop").catch(() => {});
    setPhase({ kind: "loading" });
    setDone(new Set());
    generate(false);
  }, []);

  // Explicit refresh: wait for fresh Whoop data, then force-regenerate
  async function run() {
    setPhase({ kind: "loading", label: "Refreshing Whoop data..." });
    setDone(new Set());
    try { await invoke("refresh_whoop"); } catch {}
    setPhase({ kind: "loading" });
    generate(true);
  }

  // Standalone Whoop refresh button (no regeneration)
  async function refreshWhoop() {
    if (whoopState === "loading") return;
    setWhoopState("loading");
    try {
      await invoke("refresh_whoop");
      setWhoopState("done");
      setTimeout(() => setWhoopState("idle"), 2000);
    } catch {
      setWhoopState("idle");
    }
  }

  const isLoading = phase.kind === "loading";
  const loadingLabel = phase.kind === "loading"
    ? (phase.label ?? "Pulling your Whoop and your day...")
    : "";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
        <h1 className="text-base font-semibold text-zinc-100">Morning</h1>
        <div className="flex items-center gap-3">
          {/* Whoop refresh button */}
          <button
            onClick={refreshWhoop}
            disabled={whoopState === "loading" || isLoading}
            className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-400 disabled:opacity-30 transition-colors"
            title="Refresh Whoop data"
          >
            <RefreshCw
              size={11} strokeWidth={2}
              className={whoopState === "loading" ? "animate-spin" : ""}
            />
            <span>{whoopState === "done" ? "Whoop ✓" : "Whoop"}</span>
          </button>
          {/* Main refresh */}
          {!isLoading && (
            <button
              onClick={run}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <RefreshCw size={13} strokeWidth={1.75} />
              Refresh
            </button>
          )}
        </div>
      </div>

      {/* Evening nudge: plan tomorrow before bed */}
      {showPlanNudge && (
        <button
          onClick={() => navigate("/tonight")}
          className="shrink-0 flex items-center gap-2 px-6 py-2 bg-amber-950/30 border-b border-amber-900/30 text-xs text-amber-400 hover:bg-amber-950/50 transition-colors text-left w-full"
        >
          <Moon size={12} strokeWidth={1.75} className="shrink-0" />
          <span>Plan tomorrow before bed</span>
          <span className="ml-auto text-amber-600">Tonight →</span>
        </button>
      )}

      {/* Cards area */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {isLoading && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-zinc-400">
            <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <p className="text-sm">{loadingLabel}</p>
          </div>
        )}

        {phase.kind === "needs_plan" && (
          <div className="max-w-2xl mx-auto">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-8 flex flex-col items-center text-center gap-4">
              <Moon size={32} strokeWidth={1} className="text-zinc-600" />
              <div>
                <h2 className="text-base font-semibold text-zinc-100 mb-2">No plan locked for today</h2>
                <p className="text-sm text-zinc-500 max-w-xs mx-auto">
                  Lock a plan the night before to get a focused morning briefing.
                </p>
              </div>
              <div className="flex gap-3 mt-1">
                <button
                  onClick={() => navigate("/tonight")}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                >
                  Plan with me
                </button>
                <button
                  onClick={() => { setPhase({ kind: "loading" }); generate(true); }}
                  className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium transition-colors"
                >
                  Auto-plan from yesterday
                </button>
              </div>
            </div>
          </div>
        )}

        {phase.kind === "done" && (
          <BriefingView
            briefing={phase.briefing}
            done={done}
            onToggle={toggleDone}
            projects={projects}
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
            <button onClick={run} className="mt-3 text-xs text-red-400 hover:text-red-200 underline underline-offset-2">
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Docked chat */}
      {briefingJson && (
        <MorningChat briefingJson={briefingJson} dateKey={dateKey} />
      )}
    </div>
  );
}
