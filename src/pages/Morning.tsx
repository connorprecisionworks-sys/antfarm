import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, RefreshCw, Send } from "lucide-react";
import { Project, RepoPath } from "../types";

// ── Animation styles (injected once) ─────────────────────────────────────────

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
  }
  @media (prefers-reduced-motion: reduce) {
    .typing-shimmer { background: #27272a; }
  }
`;

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

let _chatSeq = 0;
function newChatId() {
  return `cm-${++_chatSeq}`;
}

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
  isExpanded: boolean;
  onExpand: (id: string | null) => void;
  projects: Project[];
  recovColor: string;
}

function TaskRow({ task, isDone, onToggleDone, isExpanded, onExpand, projects, recovColor }: TaskRowProps) {
  const [scope, setScope] = useState("");
  const [selectedSlug, setSelectedSlug] = useState("");
  const [handoff, setHandoff] = useState<HandoffState>({ kind: "idle" });

  const dispatched = handoff.kind === "sent" || handoff.kind === "proposal";
  const dotBorder = dispatched ? "#6366f1" : isDone ? "#52525b" : recovColor;
  const dotFill   = dispatched ? "#4f46e5" : isDone ? "#3f3f46" : "transparent";

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
      <div className={`flex items-center gap-3 px-4 py-3 transition-colors ${isExpanded ? "bg-zinc-900/80" : ""}`}>
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
              <button onClick={() => setHandoff({ kind: "idle" })} className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2 shrink-0">Reset</button>
            </div>
          )}
          {handoff.kind === "working" && <p className="text-xs text-zinc-500 animate-pulse">{handoff.label}</p>}
          {handoff.kind === "sent"    && <p className="text-xs text-emerald-400">{handoff.label}, it'll report back.</p>}
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
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div>
        <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-widest">{briefing.date_label}</p>
        <h2 className="text-xl font-semibold text-zinc-100 mt-1">{briefing.greeting}</h2>
      </div>

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

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
        <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-4 pt-3 pb-2">The Plan</p>
        <div className="divide-y divide-zinc-800/50">
          {briefing.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              isDone={done.has(task.id)}
              onToggleDone={() => onToggle(task.id)}
              isExpanded={expandedId === task.id}
              onExpand={setExpandedId}
              projects={projects}
              recovColor={rColor}
            />
          ))}
        </div>
      </div>

      {briefing.agent_note && (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
          <p className="text-xs text-zinc-400">{briefing.agent_note}</p>
        </div>
      )}
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMsg }) {
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
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput]       = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    setInput("");
    setThinking(true);
    setMessages((prev) => [...prev, { id: newChatId(), role: "user", text }]);
    try {
      const reply = await invoke<string>("morning_chat_send", {
        dateKey,
        briefingJson,
        message: text,
      });
      setMessages((prev) => [...prev, { id: newChatId(), role: "agent", text: reply }]);
    } catch (e) {
      setMessages((prev) => [...prev, { id: newChatId(), role: "error", text: String(e) }]);
    } finally {
      setThinking(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  return (
    <div className="shrink-0 flex flex-col border-t border-zinc-800 bg-zinc-950/80" style={{ maxHeight: "280px" }}>
      <style>{CHAT_STYLES}</style>

      {/* Message thread */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {messages.length === 0 && !thinking && (
          <p className="text-xs text-zinc-600 text-center py-3 select-none">Ask Jarvis a follow-up...</p>
        )}
        {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
        {thinking && <TypingIndicator />}
      </div>

      {/* Input row */}
      <div className="shrink-0 flex gap-2 items-center px-4 py-2.5 border-t border-zinc-800/50">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={thinking}
          placeholder={thinking ? "Thinking..." : "Ask Jarvis..."}
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
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; briefing: MorningBriefing }
  | { kind: "raw"; text: string }
  | { kind: "error"; message: string };

export function Morning() {
  const [phase, setPhase]           = useState<Phase>({ kind: "idle" });
  const [done, setDone]             = useState<Set<string>>(new Set());
  const [projects, setProjects]     = useState<Project[]>([]);
  const [briefingJson, setBriefingJson] = useState<string>("");

  const dateKey = useMemo(() => new Date().toISOString().slice(0, 10), []);

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

  function run() {
    setPhase({ kind: "loading" });
    setDone(new Set());
    invoke<string>("generate_morning_briefing")
      .then((raw) => {
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

  useEffect(() => { run(); }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
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

      {/* Cards area — scrollable */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {phase.kind === "loading" && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-zinc-400">
            <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

      {/* Docked chat — always mounted once briefing has succeeded at least once */}
      {briefingJson && (
        <MorningChat briefingJson={briefingJson} dateKey={dateKey} />
      )}
    </div>
  );
}
