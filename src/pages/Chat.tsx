import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AtSign, Bot, Calendar, Check, ChevronDown, ChevronRight,
  Clock, FileText, FolderOpen, GitMerge, Loader, Mic, Moon, Play, Send, Square, X, Zap,
} from "lucide-react";
import {
  type StreamEntry,
  type Msg,
  getSnapshot,
  subscribe as subscribeToChatStore,
  setStreamEntries,
  setMessages,
  setRunningAgents,
  setFannedIds,
  setChattersOpen,
  setDismissedBuilders,
} from "../lib/chatStore";
import { Settings as SettingsType } from "../types";
import {
  type PodRoleKey,
  type PodRoleState,
  type PodTerminal,
  POD_STEP_ROLE,
  emptyPodRoles,
  PodRoleTabs,
  PodDoneCard,
  PodNeedsYouCard,
} from "../components/ForgePodPanel";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  status: string;
  connectors: string[];
  schedule: string | null;
}

interface Project {
  slug: string;
  name: string;
  repos: string[];
}

interface AgentStreamPayload {
  runId: string;
  agentId: string;
  kind: string;   // "start" | "text" | "activity" | "done" | "error" | "timeout" | "stopped"
  text: string;
  parentRunId: string | null;
  inputTokens?: number;
  outputTokens?: number;
  usagePct?: number;
  outputs?: string[];
}

interface PlanState {
  date: string;
  today: string;
  stale: boolean;
  file_exists: boolean;
  days_old: number;
  focus: string | null;
  open_items: number | null;
}

type Filter = "needs-you" | "all";

interface TraceEntry {
  ts: string;
  elapsed_ms: number;
  kind: "init" | "tool_use" | "text" | "result" | "terminal" | "stderr";
  tool_name: string | null;
  input_summary: string;
  result_status?: string | null;
  // terminal-only fields
  reason?: string;
  last_event_elapsed_ms?: number;
  silence_secs?: number;
  total_events?: number;
}

// A parsed delegation task from Jack's ```delegate block
interface DelegationTask {
  agentId: string;
  task: string;
  after?: string;   // agentId this task must wait for before firing
  repoName?: string; // forge only: raw repo name/path to resolve at fanout time
}

// Inline forge pod state (not persisted to chatStore — local to Chat component)
interface ForgePodState {
  podId: string;
  repoPath: string;
  roles: Record<PodRoleKey, PodRoleState>;
  podStep: string;
  running: boolean;
  terminal: PodTerminal | null;
  pushed: boolean;
}

interface PodStreamPayload {
  podId: string;
  step: string;
  kind: string;
  text: string;
  commitMsg?: string;
  diff?: string;
  reviewerNote?: string;
}


// ── Parse helpers ─────────────────────────────────────────────────────────────

const KNOWN_AGENT_IDS = new Set(["scout", "scribe", "clerk", "builder", "planner", "reviewer", "forge"]);

/** Extract ```delegate\n...\n``` block from agent text. Returns null if absent. */
function parseDelegations(text: string): DelegationTask[] | null {
  const match = text.match(/```delegate\n([\s\S]*?)```/);
  if (!match) return null;
  const afterRe = /\(after:\s*([a-z]+)\)\s*$/i;
  const tasks = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return null;
      const agentId = line.slice(0, idx).trim().toLowerCase();
      let rawTask   = line.slice(idx + 1).trim();
      if (!agentId || !rawTask || !KNOWN_AGENT_IDS.has(agentId)) return null;

      // Extract and strip the (after: <id>) marker if present
      let after: string | undefined;
      const afterMatch = rawTask.match(afterRe);
      if (afterMatch) {
        rawTask = rawTask.replace(afterRe, "").trim();
        const dep = afterMatch[1].toLowerCase();
        if (KNOWN_AGENT_IDS.has(dep)) after = dep;
      }

      // For forge tasks: extract trailing "repo: <name>" from the task string.
      let repoName: string | undefined;
      if (agentId === "forge") {
        const repoIdx = rawTask.toLowerCase().lastIndexOf(" repo:");
        if (repoIdx !== -1) {
          repoName = rawTask.slice(repoIdx + " repo:".length).trim();
          rawTask  = rawTask.slice(0, repoIdx).trim();
        }
      }

      return { agentId, task: rawTask, after, repoName } as DelegationTask;
    })
    .filter(Boolean) as DelegationTask[];
  return tasks.length > 0 ? tasks : null;
}

/** Strip the ```delegate block from display text. */
function stripDelegateBlock(text: string): string {
  return text.replace(/```delegate[\s\S]*?```/g, "").trim();
}

/** Extract "NEEDS YOU: ..." from agent text. Returns the action string or null. */
function parseNeedsYou(text: string): string | null {
  const m = text.match(/NEEDS YOU:\s*(.+?)(?:\n|$)/i);
  return m ? m[1].trim() : null;
}

/** Strip "NEEDS YOU: ..." line from display text. */
function stripNeedsYouLine(text: string): string {
  return text.replace(/NEEDS YOU:.*$/im, "").trim();
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function shortModel(model: string): string {
  if (model.includes("opus"))   return "Opus 4.6";
  if (model.includes("sonnet")) return "Sonnet 4.6";
  if (model.includes("haiku"))  return "Haiku 4.5";
  return model;
}

function roleLabel(role: string): string {
  return role === "orchestrator" ? "Orchestrator" : "Subagent";
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Delegation card ───────────────────────────────────────────────────────────

function DelegationCard({
  tasks,
  agents,
  onFanout,
  fanned,
}: {
  tasks: DelegationTask[];
  agents: Agent[];
  onFanout: () => void;
  fanned: boolean;
}) {
  function agentName(id: string) {
    if (id === "forge") return "Forge";
    return agents.find((a) => a.id === id)?.name ?? id;
  }
  return (
    <div className="mt-3 border border-zinc-700/50 rounded-lg bg-zinc-800/30 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <Play size={11} className="text-zinc-400" />
        <span className="text-xs font-medium text-zinc-300">
          Delegation plan · {tasks.length} agent{tasks.length > 1 ? "s" : ""}
        </span>
      </div>
      <div className="space-y-1 mb-2.5">
        {tasks.map((t) => (
          <div key={t.agentId} className="flex items-start gap-2 text-xs">
            <span className="text-zinc-500 shrink-0 font-medium w-14 truncate">
              {agentName(t.agentId)}
            </span>
            <span className="text-zinc-400 leading-relaxed">
              {t.task}
              {t.repoName && (
                <span className="ml-1.5 text-zinc-600 font-mono">· {t.repoName}</span>
              )}
              {t.after && (
                <span className="ml-1.5 text-zinc-600">· after {agentName(t.after)}</span>
              )}
            </span>
          </div>
        ))}
      </div>
      {fanned ? (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <Check size={11} className="text-emerald-500" />
          Fanned out
        </div>
      ) : (
        <button
          onClick={onFanout}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/30 transition-colors"
        >
          <Play size={11} />
          Fan out · run all {tasks.length}
        </button>
      )}
    </div>
  );
}

// ── Needs-you inline action ───────────────────────────────────────────────────

function NeedsYouAction({
  actionText,
  onApprove,
  onReject,
}: {
  actionText: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="mt-3 border border-amber-500/20 rounded-lg bg-amber-500/5 px-3 py-2.5">
      <p className="text-xs text-amber-300/80 mb-2">{actionText}</p>
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/30 transition-colors"
        >
          <Check size={11} />
          Approve
        </button>
        <button
          onClick={onReject}
          className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 border border-zinc-700/50 transition-colors"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

// ── Builder done card ─────────────────────────────────────────────────────────

function BuilderDoneCard({ entry, onDismiss }: { entry: StreamEntry; onDismiss: () => void }) {
  const [pushing, setPushing]   = useState(false);
  const [pushed, setPushed]     = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const commitMatch = entry.builderWrite ? entry.text.match(/---COMMIT:\s*([\s\S]+?)---/) : null;
  const commitMsg   = commitMatch ? commitMatch[1].trim() : null;
  // repoPath is not required for detection — the COMMIT marker alone is sufficient evidence.
  // On warm resume the frontend entry may have repoPath=undefined even though the backend
  // ran correctly; we resolve it lazily from the persisted last_repo_path.txt at commit time.
  const isWriteMode = !!(entry.builderWrite && commitMsg);

  async function handleApprovePush() {
    if (!commitMsg) return;
    let repoPath = entry.repoPath;
    if (!repoPath) {
      try { repoPath = (await invoke<string | null>("get_builder_last_repo_path")) ?? undefined; } catch { /* ignore */ }
    }
    if (!repoPath) {
      setPushError("Repo path not found — re-select the repo in the picker.");
      return;
    }
    setPushing(true);
    setPushError(null);
    try {
      await invoke<string>("builder_commit_push", { repoPath, commitMessage: commitMsg });
      setPushed(true);
    } catch (e) {
      setPushError(String(e));
    } finally {
      setPushing(false);
    }
  }

  if (isWriteMode) {
    return (
      <div className="mt-3 border border-emerald-700/40 rounded-lg bg-emerald-950/20 px-3 py-2.5">
        <div className="flex items-center gap-2 mb-2">
          <GitMerge size={11} className="text-emerald-400" />
          <span className="text-xs font-medium text-zinc-300">Build green — ready to push</span>
        </div>
        <p className="text-[10px] text-zinc-400 font-mono mb-2.5 bg-zinc-900/60 rounded px-2 py-1.5 break-all">
          {commitMsg}
        </p>
        {pushError && (
          <p className="text-[10px] text-red-400 mb-2 break-all">{pushError}</p>
        )}
        <div className="flex gap-2 flex-wrap">
          {pushed ? (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <Check size={11} /> Committed and pushed
            </span>
          ) : (
            <button
              onClick={handleApprovePush}
              disabled={pushing}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-700/60 hover:bg-emerald-700 disabled:opacity-50 text-emerald-100 border border-emerald-600/50 transition-colors"
            >
              <GitMerge size={11} />
              {pushing ? "Pushing…" : "Approve & push"}
            </button>
          )}
          <button
            onClick={() => invoke("open_agent_log", { agentId: entry.agentId }).catch(() => {})}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700 border border-zinc-600/50 transition-colors"
          >
            <FileText size={11} />
            View log
          </button>
          <button onClick={onDismiss} className="ml-auto text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 border border-zinc-700/50 rounded-lg bg-zinc-800/30 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <FileText size={11} className="text-zinc-500" />
        <span className="text-xs font-medium text-zinc-300">Builder finished</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => invoke("open_agent_log", { agentId: entry.agentId }).catch((err) => console.error("open_agent_log failed", err))}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700 border border-zinc-600/50 transition-colors"
        >
          <FileText size={11} />
          View log
        </button>
        <button
          onClick={onDismiss}
          className="ml-auto text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ── Trace panel ───────────────────────────────────────────────────────────────

function TracePanel({ entries, runId }: { entries: TraceEntry[]; runId: string }) {
  const terminalEntry = entries.find(e => e.kind === "terminal");
  const lastEventMs   = terminalEntry?.last_event_elapsed_ms ?? null;
  const nonTerminal   = entries.filter(e => e.kind !== "terminal");

  // Find the index of the last event that matches last_event_elapsed_ms (last occurrence).
  const lastEventIdx = lastEventMs !== null
    ? nonTerminal.reduce((acc, e, i) => e.elapsed_ms === lastEventMs ? i : acc, -1)
    : -1;

  function fmtMs(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `+${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = (s % 60).toFixed(1);
    return `+${m}m ${rem}s`;
  }

  const kindColor: Record<string, string> = {
    init:     "text-zinc-500",
    tool_use: "text-blue-400/80",
    text:     "text-zinc-400",
    result:   "text-emerald-400/80",
    stderr:   "text-rose-400/70",
  };

  return (
    <div className="mt-2.5 rounded-lg border border-zinc-800/60 bg-zinc-950 p-2.5 font-mono">
      <div className="text-[9px] text-zinc-600 uppercase tracking-wide mb-1.5 font-sans">
        Step trace · {runId.slice(-10)}
      </div>
      {nonTerminal.length === 0 ? (
        <div className="text-[10px] text-zinc-600">No events recorded yet.</div>
      ) : (
        <div className="space-y-px">
          {nonTerminal.map((e, i) => {
            const isLast = i === lastEventIdx;
            return (
              <div key={i} className="flex gap-2 items-baseline text-[10px]">
                <span className="shrink-0 w-[50px] text-right tabular-nums text-zinc-600">
                  {fmtMs(e.elapsed_ms)}
                </span>
                <span className={`shrink-0 w-[70px] truncate ${kindColor[e.kind] ?? "text-zinc-500"}`}>
                  {e.kind === "tool_use" ? (e.tool_name ?? "tool_use") : e.kind}
                </span>
                <span className={`flex-1 truncate ${isLast ? "text-zinc-200" : "text-zinc-500"}`}>
                  {e.input_summary}
                </span>
                {isLast && terminalEntry?.reason === "timeout" && (
                  <span className="shrink-0 text-amber-500/80 text-[9px] pl-1">
                    ← last · {terminalEntry.silence_secs?.toFixed(1)}s silence
                  </span>
                )}
                {isLast && terminalEntry?.reason === "stopped" && (
                  <span className="shrink-0 text-zinc-500 text-[9px] pl-1">← stopped here</span>
                )}
              </div>
            );
          })}
          {terminalEntry && (
            <div className="flex gap-2 items-baseline text-[10px] pt-1.5 mt-1 border-t border-zinc-800/50">
              <span className="shrink-0 w-[50px]" />
              <span className={`shrink-0 w-[70px] ${
                terminalEntry.reason === "timeout" ? "text-amber-400/80" :
                terminalEntry.reason === "stopped" ? "text-zinc-500" :
                terminalEntry.reason === "error"   ? "text-red-400/80" :
                "text-emerald-400/70"
              }`}>
                {terminalEntry.reason}
              </span>
              <span className="text-zinc-600 truncate">
                {terminalEntry.reason === "timeout"
                  ? `${terminalEntry.silence_secs?.toFixed(1)}s silence · ${terminalEntry.total_events} steps total`
                  : `${terminalEntry.total_events} steps total`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stream bubble ─────────────────────────────────────────────────────────────

function StreamBubble({
  entry,
  agents,
  isChild,
  isFanned,
  onFanout,
  onApprove,
  onReject,
  onDismissBuilder,
}: {
  entry: StreamEntry;
  agents: Agent[];
  runningAgents?: Set<string>;
  isChild: boolean;
  isFanned: boolean;
  onFanout: (tasks: DelegationTask[]) => void;
  onApprove: () => void;
  onReject: () => void;
  onDismissBuilder: () => void;
}) {
  const [traceOpen,    setTraceOpen]    = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceEntries, setTraceEntries] = useState<TraceEntry[] | null>(null);

  async function toggleTrace() {
    if (traceOpen) { setTraceOpen(false); return; }
    setTraceOpen(true);
    // Always re-fetch for live runs; fetch once for completed runs.
    if (traceEntries === null || isLive) {
      setTraceLoading(true);
      try {
        const entries = await invoke<TraceEntry[]>("get_run_trace", { runId: entry.runId });
        setTraceEntries(entries);
      } catch {
        setTraceEntries([]);
      } finally {
        setTraceLoading(false);
      }
    }
  }

  const isLive    = entry.status === "thinking" || entry.status === "streaming";
  const isError   = entry.status === "error";
  const isDone    = entry.status === "done";
  const isTimeout = entry.status === "timeout";
  const isStopped = entry.status === "stopped";

  const delegations = isDone ? parseDelegations(entry.text) : null;
  const needsYou    = isDone ? parseNeedsYou(entry.text)    : null;
  const isBuilder   = entry.agentId === "builder";

  const displayText = entry.text
    ? stripNeedsYouLine(stripDelegateBlock(entry.text))
    : "";

  return (
    <div
      className={`border rounded-xl p-4 transition-colors ${
        isError
          ? "border-red-800/50 border-l-[3px] border-l-red-500/60 bg-zinc-900/70"
          : isTimeout
          ? "border-amber-800/40 border-l-[3px] border-l-amber-500/50 bg-zinc-900/70"
          : isStopped
          ? "border-zinc-800/40 border-l-[3px] border-l-zinc-600/40 bg-zinc-900/50"
          : isLive
          ? "border-zinc-700/60 border-l-[3px] border-l-blue-500/60 bg-zinc-900/70"
          : isChild
          ? "border-zinc-800/40 border-l-[3px] border-l-zinc-700/40 bg-zinc-900/30"
          : "border-zinc-800 border-l-[3px] border-l-zinc-600/60 bg-zinc-900/50"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2.5">
        {isLive ? (
          <Loader size={12} className="text-blue-400 shrink-0 animate-spin" />
        ) : isError ? (
          <Zap size={12} className="text-red-400 shrink-0" />
        ) : isTimeout ? (
          <Clock size={12} className="text-amber-400 shrink-0" />
        ) : isStopped ? (
          <Square size={12} className="text-zinc-500 shrink-0" />
        ) : (
          <Bot size={12} className="text-zinc-500 shrink-0" />
        )}
        <span className="text-xs font-medium text-zinc-200">{entry.agentName}</span>
        {isLive && (
          <span className="text-[10px] text-blue-400/70 bg-blue-500/10 px-1.5 py-0.5 rounded-full">
            {entry.activity ?? (entry.text ? "responding…" : "thinking…")}
          </span>
        )}
        {isTimeout && (
          <span className="text-[10px] text-amber-400/70 bg-amber-500/10 px-1.5 py-0.5 rounded-full">
            Timed out
          </span>
        )}
        {isStopped && (
          <span className="text-[10px] text-zinc-500 bg-zinc-800/60 px-1.5 py-0.5 rounded-full">
            Stopped
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500">{entry.time}</span>
        {isLive && (
          <button
            disabled={entry.runId === ""}
            onClick={() => invoke("stop_agent", { runId: entry.runId })}
            className="p-1 rounded text-zinc-600 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Stop this run"
          >
            <Square size={11} />
          </button>
        )}
      </div>

      {/* Body */}
      {!entry.text && isLive ? (
        <div className="flex gap-1 mt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:300ms]" />
        </div>
      ) : (
        <p className={`text-sm leading-relaxed whitespace-pre-wrap ${
          isError   ? "text-red-300"      :
          isTimeout ? "text-amber-300/70" :
          isStopped ? "text-zinc-500"     :
          "text-zinc-100"
        }`}>
          {displayText}
          {isLive && displayText && (
            <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 align-text-bottom animate-pulse" />
          )}
        </p>
      )}

      {/* Output file chips */}
      {(entry.outputs?.length ?? 0) > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {entry.outputs!.map((path) => {
            const basename = path.split("/").pop() ?? path;
            const isMd = path.endsWith(".md");
            return (
              <span key={path} className="flex items-center gap-1">
                <button
                  onClick={() => invoke("open_path", { path }).catch((err) => console.error("open_path failed", err))}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700/40 hover:border-zinc-600/50 px-2 py-0.5 rounded-full transition-colors"
                  title={path}
                >
                  <FileText size={9} className="shrink-0" />
                  {basename}
                </button>
                {isMd && (
                  <button
                    onClick={() =>
                      invoke<string>("render_report_pdf", { mdPath: path })
                        .then((pdf) => invoke("open_path", { path: pdf }))
                        .catch((err) => console.error("render_report_pdf failed", err))
                    }
                    className="text-[10px] text-blue-400/70 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 px-2 py-0.5 rounded-full transition-colors"
                    title="Export as branded PDF"
                  >
                    Export PDF
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Delegation card */}
      {delegations && (
        <DelegationCard
          tasks={delegations}
          agents={agents}
          onFanout={() => onFanout(delegations)}
          fanned={isFanned}
        />
      )}

      {/* Needs-you inline action */}
      {needsYou && (
        <NeedsYouAction
          actionText={needsYou}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}

      {/* Context meter — shown when done and usage data is available */}
      {isDone && (entry.usagePct ?? 0) > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-0.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                (entry.usagePct ?? 0) > 60
                  ? "bg-red-500/70"
                  : (entry.usagePct ?? 0) > 40
                  ? "bg-amber-500/70"
                  : "bg-emerald-500/60"
              }`}
              style={{ width: `${Math.min(entry.usagePct ?? 0, 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-zinc-700 shrink-0 tabular-nums">
            {Math.round(entry.usagePct ?? 0)}% ctx
          </span>
        </div>
      )}

      {/* Builder done card */}
      {isBuilder && isDone && !isError && (
        <BuilderDoneCard entry={entry} onDismiss={onDismissBuilder} />
      )}

      {/* Trace view — available on any run once a runId is assigned */}
      {entry.runId && (
        <div className="mt-2.5">
          <button
            onClick={toggleTrace}
            className="flex items-center gap-1 text-[10px] text-zinc-700 hover:text-zinc-500 transition-colors"
          >
            <Clock size={9} />
            {traceLoading ? "loading…" : traceOpen ? "hide trace" : isTimeout ? "view trace ←" : "trace"}
          </button>
          {traceOpen && !traceLoading && traceEntries !== null && (
            <TracePanel entries={traceEntries} runId={entry.runId} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Tabbed delegation panel (replaces ChatterGroup) ──────────────────────────

function defaultDelegationTab(entries: StreamEntry[]): string | null {
  if (entries.length === 0) return null;
  const needsYouEntry = entries.find(
    (e) => e.status === "done" && !!parseNeedsYou(e.text)
  );
  if (needsYouEntry) return needsYouEntry.id;
  const liveEntry = entries.find(
    (e) => e.status === "thinking" || e.status === "streaming"
  );
  if (liveEntry) return liveEntry.id;
  return entries[0].id;
}

function TabbedDelegation({
  children,
  collapsed,
  onToggle,
  agents,
  runningAgents,
  onApprove,
  onReject,
  onDismissBuilder,
}: {
  children: StreamEntry[];
  collapsed: boolean;
  onToggle: () => void;
  agents: Agent[];
  runningAgents: Set<string>;
  onApprove: (entry: StreamEntry) => void;
  onReject: (entry: StreamEntry) => void;
  onDismissBuilder: (id: string) => void;
}) {
  const liveCount = children.filter(
    (e) => e.status === "thinking" || e.status === "streaming"
  ).length;

  // Track explicit user tab click separately from derived active tab.
  const [userPickedId, setUserPickedId] = useState<string | null>(null);

  // Derived active tab: honour user pick if still present, else compute default.
  const activeId = (() => {
    if (userPickedId && children.some((e) => e.id === userPickedId)) return userPickedId;
    return defaultDelegationTab(children);
  })();

  const activeEntry = children.find((e) => e.id === activeId) ?? null;

  return (
    <div className="ml-5 border-l-2 border-zinc-800/60 pl-3">
      {/* Collapse toggle header */}
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-[11px] text-zinc-600 hover:text-zinc-400 py-1.5 transition-colors"
      >
        {collapsed ? (
          <ChevronRight size={11} className="shrink-0" />
        ) : (
          <ChevronDown size={11} className="shrink-0" />
        )}
        <span>Jack delegated</span>
        <span className="text-zinc-700">· {children.length} agent{children.length !== 1 ? "s" : ""}</span>
        {liveCount > 0 && (
          <span className="text-blue-400/60 ml-1">· {liveCount} running</span>
        )}
      </button>

      {!collapsed && children.length > 0 && (
        <div className="mb-3">
          {/* Tab bar */}
          <div className="flex gap-1 flex-wrap mt-1 mb-2">
            {children.map((entry) => {
              const isLive = entry.status === "thinking" || entry.status === "streaming";
              const hasNeedsYou = entry.status === "done" && !!parseNeedsYou(entry.text);
              const isActive = entry.id === activeId;
              return (
                <button
                  key={entry.id}
                  onClick={() => setUserPickedId(entry.id)}
                  className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                    isActive
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      isLive
                        ? "bg-blue-400 animate-pulse"
                        : hasNeedsYou
                        ? "bg-amber-400"
                        : entry.status === "done"
                        ? "bg-emerald-400"
                        : entry.status === "error"
                        ? "bg-red-400"
                        : entry.status === "timeout"
                        ? "bg-amber-500"
                        : "bg-zinc-500"
                    }`}
                  />
                  <span>{entry.agentName}</span>
                  {isLive && (
                    <span className="text-[10px] text-blue-400/60">
                      {entry.activity ?? "thinking"}
                    </span>
                  )}
                  {/* Amber badge for pending approval on inactive tabs */}
                  {hasNeedsYou && !isActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Active tab content */}
          {activeEntry && (
            <StreamBubble
              entry={activeEntry}
              agents={agents}
              runningAgents={runningAgents}
              isChild={true}
              isFanned={false}
              onFanout={() => {}}
              onApprove={() => onApprove(activeEntry)}
              onReject={() => onReject(activeEntry)}
              onDismissBuilder={() => onDismissBuilder(activeEntry.id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── InlineForgePod ────────────────────────────────────────────────────────────

function InlineForgePod({
  pod,
  onPush,
}: {
  pod: { podId: string; repoPath: string; roles: Record<PodRoleKey, PodRoleState>; podStep: string; running: boolean; terminal: PodTerminal | null; pushed: boolean };
  onPush: () => void;
}) {
  const [activeRole, setActiveRole] = useState<PodRoleKey>("planner");
  const textRef = useRef<HTMLPreElement>(null);
  const repoBase = pod.repoPath.split("/").pop() ?? pod.repoPath;

  // Auto-advance tab to the active step's role.
  useEffect(() => {
    const stepRole = POD_STEP_ROLE[pod.podStep] as PodRoleKey | undefined;
    if (stepRole) setActiveRole(stepRole);
  }, [pod.podStep]);

  // Auto-scroll text area.
  useEffect(() => {
    if (textRef.current) textRef.current.scrollTop = textRef.current.scrollHeight;
  }, [pod.roles[activeRole].text]);

  return (
    <div className="ml-5 border-l-2 border-blue-800/40 pl-3 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <Bot size={11} className="shrink-0" />
        <span className="text-zinc-400 font-medium">Forge</span>
        <span className="text-zinc-600">·</span>
        <code className="text-zinc-500">{repoBase}</code>
        {pod.running && <Loader size={9} className="animate-spin text-blue-400 ml-1 shrink-0" />}
      </div>
      <PodRoleTabs
        roles={pod.roles}
        activeRole={activeRole}
        onSetRole={setActiveRole}
        textRef={textRef}
        podStep={pod.podStep}
        running={pod.running}
      />
      {pod.terminal?.kind === "ready_to_push" && (
        <PodDoneCard
          repoPath={pod.repoPath}
          commitMsg={pod.terminal.commitMsg}
          diff={pod.terminal.diff}
          reviewerNote={pod.terminal.reviewerNote}
          pushed={pod.pushed}
          onPush={onPush}
        />
      )}
      {pod.terminal?.kind === "needs_you" && (
        <PodNeedsYouCard text={pod.terminal.text} />
      )}
    </div>
  );
}

// ── Seeded message components ─────────────────────────────────────────────────

function NeedsYouMsg({ msg, onDismiss }: { msg: Msg; onDismiss: (id: string) => void }) {
  return (
    <div className="border border-zinc-800 border-l-[3px] border-l-amber-500/70 rounded-xl bg-zinc-900/70 p-4">
      <div className="flex items-center gap-2 mb-2.5">
        {msg.fromRole === "orchestrator" ? (
          <Zap size={12} className="text-amber-400 shrink-0" />
        ) : (
          <Bot size={12} className="text-zinc-500 shrink-0" />
        )}
        <span className="text-xs font-medium text-zinc-200">{msg.from}</span>
        <span className="ml-auto text-[11px] text-zinc-500">{msg.time}</span>
      </div>
      <p className="text-sm text-zinc-100 leading-relaxed">{msg.content}</p>
      {msg.action && (
        <div className="flex gap-2 mt-3.5">
          <button className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/30 transition-colors">
            <Check size={11} />
            {msg.action}
          </button>
          <button
            onClick={() => onDismiss(msg.id)}
            className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 border border-zinc-700/50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function FyiMsg({ msg }: { msg: Msg }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-zinc-800/40 bg-zinc-900/25">
      <Bot size={11} className="text-zinc-700 shrink-0" />
      <span className="text-xs font-medium text-zinc-500">{msg.from}</span>
      <span className="text-xs text-zinc-600 flex-1 truncate">{msg.content}</span>
      <span className="text-[11px] text-zinc-700 shrink-0">{msg.time}</span>
    </div>
  );
}

function ChatterMsg({ msg, onToggle }: { msg: Msg; onToggle: (id: string) => void }) {
  return (
    <button
      onClick={() => onToggle(msg.id)}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800/25 hover:bg-zinc-900/20 transition-colors text-left"
    >
      {msg.collapsed ? (
        <ChevronRight size={11} className="text-zinc-700 shrink-0" />
      ) : (
        <ChevronDown size={11} className="text-zinc-700 shrink-0" />
      )}
      <span className="text-[11px] text-zinc-600 font-medium shrink-0">{msg.from}</span>
      <span className={`text-[11px] flex-1 truncate ${msg.collapsed ? "text-zinc-700" : "text-zinc-600"}`}>
        {msg.content}
      </span>
      <span className="text-[10px] text-zinc-700 shrink-0">{msg.time}</span>
    </button>
  );
}

// ── Agent crew card ───────────────────────────────────────────────────────────

function AgentCard({
  agent,
  isRunning,
  isSelected,
  onClick,
}: {
  agent: Agent;
  isRunning: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-3 transition-colors ${
        isSelected
          ? "border-zinc-600/80 bg-zinc-800/70"
          : "border-zinc-800/60 bg-zinc-900/50 hover:bg-zinc-900/80"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {isRunning ? (
          <Loader size={10} className="text-blue-400 shrink-0 animate-spin" />
        ) : (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              agent.status === "active" ? "bg-emerald-400" : "bg-zinc-600"
            }`}
          />
        )}
        <span className="text-[13px] font-medium text-zinc-200 truncate">{agent.name}</span>
        {agent.role === "orchestrator" && (
          <Zap size={10} className="text-amber-400 shrink-0" />
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-zinc-500 bg-zinc-800/70 px-1.5 py-0.5 rounded">
          {roleLabel(agent.role)}
        </span>
        <span className="text-[10px] text-zinc-600">{shortModel(agent.model)}</span>
      </div>
      {agent.connectors.length > 0 && (
        <div className="mt-1.5 flex gap-1 flex-wrap">
          {agent.connectors.map((c) => (
            <span key={c} className="text-[9px] text-zinc-600 bg-zinc-800/40 px-1 py-0.5 rounded">
              {c}
            </span>
          ))}
        </div>
      )}
      {isRunning && (
        <div className="mt-1.5 text-[10px] text-blue-400/70">running…</div>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          invoke("reset_agent_session", { agentId: agent.id });
        }}
        className="mt-1.5 text-[9px] text-zinc-700 hover:text-zinc-500 transition-colors w-full text-left"
        title="Start a new conversation with this agent"
      >
        ↺ new conversation
      </button>
    </button>
  );
}

// ── Plan banner ───────────────────────────────────────────────────────────────

function PlanBanner({
  plan,
  onAskClerk,
  clerkRunning,
}: {
  plan: PlanState | null;
  onAskClerk: (task: string) => void;
  clerkRunning: boolean;
}) {
  if (!plan) return null;

  if (!plan.file_exists) {
    return (
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-zinc-800/60 bg-zinc-950">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
        <span className="text-xs text-zinc-500">No plan for today</span>
        <button
          onClick={() => onAskClerk("Plan today: read yesterday's plan and the recent commits, carry forward open items, and write a fresh plan-" + plan.today + ".json to active/state/.")}
          disabled={clerkRunning}
          className="ml-auto flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border border-zinc-700/50 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 disabled:opacity-40 transition-colors"
        >
          {clerkRunning ? <Loader size={10} className="animate-spin" /> : <Calendar size={10} />}
          Ask Clerk to plan today
        </button>
      </div>
    );
  }

  if (plan.stale) {
    const noun = plan.days_old === 1 ? "day" : "days";
    const openNote = plan.open_items != null ? ` · ${plan.open_items} open` : "";
    return (
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-amber-900/30 bg-amber-950/10">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0 animate-pulse" />
        <span className="text-xs text-amber-400/80">
          Plan stale · from {plan.date} ({plan.days_old} {noun} ago{openNote})
        </span>
        <button
          onClick={() => onAskClerk("Reconcile the plan: the last plan is from " + plan.date + " and today is " + plan.today + ". Read what actually got done (git log, agent logs), carry forward open items, and write a fresh plan-" + plan.today + ".json to active/state/. Keep it tight.")}
          disabled={clerkRunning}
          className="ml-auto flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border border-amber-700/40 text-amber-400/80 hover:text-amber-300 hover:border-amber-600/50 disabled:opacity-40 transition-colors"
        >
          {clerkRunning ? <Loader size={10} className="animate-spin" /> : <Calendar size={10} />}
          Reconcile
        </button>
      </div>
    );
  }

  // Current plan
  const openNote = plan.open_items != null
    ? plan.open_items === 0 ? " · all done" : ` · ${plan.open_items} open`
    : "";
  return (
    <div className="flex items-center gap-2.5 px-4 py-2 border-b border-zinc-800/40 bg-zinc-950">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
      <span className="text-[11px] text-zinc-500">
        Plan: today{openNote}
        {plan.focus && <span className="text-zinc-600 ml-1.5">· {plan.focus}</span>}
      </span>
    </div>
  );
}

// ── User message bubble ───────────────────────────────────────────────────────

function UserMsgBubble({ text, time }: { text: string; time: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] bg-zinc-800 border border-zinc-700/50 rounded-xl px-4 py-2.5">
        <p className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap">{text}</p>
        <p className="text-[10px] text-zinc-600 mt-1 text-right">{time}</p>
      </div>
    </div>
  );
}

// ── @mention dropdown ─────────────────────────────────────────────────────────

function MentionDropdown({
  query,
  agents,
  onSelect,
}: {
  query: string;
  agents: Agent[];
  onSelect: (a: Agent) => void;
}) {
  const filtered = agents.filter(
    (a) =>
      a.name.toLowerCase().startsWith(query) ||
      a.id.startsWith(query)
  );
  if (!filtered.length) return null;
  return (
    <div className="absolute bottom-full mb-1 left-0 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 min-w-[180px] overflow-hidden">
      {filtered.map((a) => (
        <button
          key={a.id}
          onMouseDown={(e) => { e.preventDefault(); onSelect(a); }}
          className="w-full text-left px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700/80 flex items-center gap-2 transition-colors"
        >
          <Bot size={10} className="text-zinc-500 shrink-0" />
          <span className="flex-1">{a.name}</span>
          <span className="text-[10px] text-zinc-600">
            {a.role === "orchestrator" ? "Orch" : "Agent"}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Draft highlight renderer ───────────────────────────────────────────────────

function renderDraftHighlighted(text: string, agents: Agent[]) {
  const parts = text.split(/(@\S+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const slug = part.slice(1).toLowerCase();
      const matched = agents.find(
        (a) => a.name.toLowerCase() === slug || a.id === slug
      );
      if (matched) {
        return (
          <span key={i} className="bg-blue-500/25 text-blue-300 rounded px-0.5">
            {part}
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Chat() {
  const [agents, setAgents]             = useState<Agent[]>([]);
  const [planState, setPlanState]       = useState<PlanState | null>(null);
  const [repoProjects, setRepoProjects] = useState<Project[]>([]);
  const [selectedRepoSlug, setSelectedRepoSlug] = useState<string>("");
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(null);
  const [settings, setSettings]         = useState<SettingsType | null>(null);
  const { streamEntries, messages, runningAgents, fannedIds, chattersOpen } =
    useSyncExternalStore(subscribeToChatStore, getSnapshot);
  const [filter, setFilter]             = useState<Filter>("needs-you");
  const [draft, setDraft]               = useState("");
  const [overnight, setOvernight]       = useState(false);
  const [recipientId, setRecipientId]   = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [isListening, setIsListening]   = useState(false);
  const textareaRef         = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef    = useRef<MediaRecorder | null>(null);
  const audioChunksRef      = useRef<Blob[]>([]);
  const bottomRef           = useRef<HTMLDivElement>(null);
  const didInitRecipient    = useRef(false);
  // Stable ref to agents list — lets the stream listener resolve names without stale closure.
  const agentsRef = useRef<Agent[]>([]);
  // Pending dependent tasks waiting for their `after` agent to finish.
  const pendingDepsRef = useRef<Array<{
    childId: string;
    agentId: string;
    baseTask: string;
    after: string;
    parentEntryId: string;
  }>>([]);
  // Inline forge pod state (not in chatStore — local, not persisted).
  const [forgePods, setForgePods] = useState<Map<string, ForgePodState>>(new Map());
  // Stable ref so event listeners can read forgePods without stale closures.
  const forgePodsRef = useRef<Map<string, ForgePodState>>(new Map());

  // Keep agentsRef in sync so the stream listener can resolve names without a stale closure.
  useEffect(() => { agentsRef.current = agents; }, [agents]);
  useEffect(() => { forgePodsRef.current = forgePods; }, [forgePods]);

  // ── Load agents + plan state + settings ─────────────────────────────────────
  useEffect(() => {
    invoke<Agent[]>("list_agents")
      .then(setAgents)
      .catch(() => setAgents([]));
    invoke<PlanState>("get_plan_state")
      .then(setPlanState)
      .catch(() => {});
    invoke<Project[]>("list_projects")
      .then((ps) => setRepoProjects(ps.filter((p) => p.repos.length > 0)))
      .catch(() => {});
    invoke<SettingsType>("get_settings").then(setSettings).catch(() => {});

    // Drain any scheduled runs that fired while Chat was closed.
    invoke<Array<{ agentId: string; agentName: string; time: string }>>(
      "drain_scheduled_runs"
    ).then((runs) => {
      if (runs.length === 0) return;
      const injected: StreamEntry[] = runs.map((r) => ({
        id:        `sched-${r.agentId}-${r.time.replace(":", "")}`,
        runId:     "",
        agentId:   r.agentId,
        agentName: r.agentName,
        text:      `Scheduled run at ${r.time} — plan reconciled, daily recap written.`,
        status:    "done" as const,
        time:      r.time,
      }));
      setStreamEntries((prev) => [...injected, ...prev]);
    }).catch(() => {});

    function onSettingsSaved() { invoke<SettingsType>("get_settings").then(setSettings).catch(() => {}); }
    window.addEventListener("antfarm-settings-saved", onSettingsSaved);
    return () => window.removeEventListener("antfarm-settings-saved", onSettingsSaved);
  }, []);

  useEffect(() => {
    if (agents.length > 0 && !didInitRecipient.current) {
      didInitRecipient.current = true;
      const orch = agents.find((a) => a.role === "orchestrator");
      setRecipientId(orch?.id ?? agents[0]?.id ?? null);
    }
  }, [agents]);

  // Reset repo picker when switching away from Builder.
  useEffect(() => {
    if (recipientId !== "builder") {
      setSelectedRepoSlug("");
      setSelectedRepoPath(null);
    }
  }, [recipientId]);

  // Part B: on remount, reconcile entries stuck in thinking/streaming.
  // Ask the backend which run IDs are still alive; only mark the orphaned
  // ones as stopped.  Still-alive runs keep their status so the re-attached
  // stream listener receives completion events with no "stopped" flash.
  useEffect(() => {
    const stale = getSnapshot().streamEntries.filter(
      (e) => e.status === "thinking" || e.status === "streaming"
    );
    if (stale.length === 0) return;

    invoke<string[]>("get_active_run_ids")
      .then((activeIds) => {
        const active = new Set(activeIds);
        // Entries whose backend process is gone — we missed the completion event.
        const finished = stale.filter((e) => !e.runId || !active.has(e.runId));
        if (finished.length === 0) return; // all stale entries are still running

        const finishedIds      = new Set(finished.map((e) => e.id));
        const finishedAgentIds = new Set(finished.map((e) => e.agentId));
        // Agents that still have at least one live entry must NOT be removed from runningAgents.
        const stillLiveAgents  = new Set(
          stale.filter((e) => !finishedIds.has(e.id)).map((e) => e.agentId)
        );

        setStreamEntries((prev) =>
          prev.map((e) =>
            // Guard on current status: if the listener already received the done event
            // during the invoke round-trip, the entry is already "done" — leave it alone.
            finishedIds.has(e.id) && (e.status === "thinking" || e.status === "streaming")
              ? {
                  ...e,
                  status: "stopped" as const,
                  text: e.text || "Run completed while Chat was closed — view log for full output.",
                }
              : e
          )
        );
        setRunningAgents((prev) => {
          const s = new Set(prev);
          for (const id of finishedAgentIds) {
            if (!stillLiveAgents.has(id)) s.delete(id);
          }
          return s;
        });
      })
      .catch(() => {
        // Fallback: old behaviour — mark all stale as stopped.
        const staleAgentIds = new Set(stale.map((e) => e.agentId));
        setStreamEntries((prev) =>
          prev.map((e) =>
            e.status === "thinking" || e.status === "streaming"
              ? { ...e, status: "stopped" as const, text: e.text || "Run completed while Chat was closed." }
              : e
          )
        );
        setRunningAgents((prev) => {
          const s = new Set(prev);
          staleAgentIds.forEach((id) => s.delete(id));
          return s;
        });
      });
  }, []);

  // ── pod-stream listener (inline forge pods delegated from Jack) ──────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<PodStreamPayload>("pod-stream", (event) => {
      const p = event.payload;
      // Find which entry this pod belongs to via forgePodsRef.
      let matchedEntryId: string | null = null;
      for (const [entryId, pod] of forgePodsRef.current.entries()) {
        if (pod.podId === p.podId) { matchedEntryId = entryId; break; }
      }
      if (!matchedEntryId) return;
      const entryId = matchedEntryId;

      setForgePods((prev) => {
        const pod = prev.get(entryId);
        if (!pod) return prev;
        const next = new Map(prev);
        if (p.kind === "ready_to_push") {
          next.set(entryId, {
            ...pod,
            podStep: p.step,
            running: false,
            terminal: { kind: "ready_to_push", commitMsg: p.commitMsg ?? "", diff: p.diff ?? "", reviewerNote: p.reviewerNote },
          });
        } else if (p.kind === "needs_you") {
          next.set(entryId, { ...pod, running: false, terminal: { kind: "needs_you", text: p.text } });
        } else {
          next.set(entryId, { ...pod, podStep: p.step });
        }
        return next;
      });

      // Flip stream entry to "done" when terminal fires so the entry stops looking live.
      if (p.kind === "ready_to_push" || p.kind === "needs_you") {
        setStreamEntries((prev) =>
          prev.map((e) => e.id === entryId ? { ...e, status: "done" as const } : e)
        );
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  // ── agent-stream event listener ──────────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<AgentStreamPayload>("agent-stream", (event) => {
      const { runId, agentId, kind, text, inputTokens = 0, outputTokens = 0, usagePct = 0, outputs = [] } = event.payload;

      // Intercept events belonging to inline forge pod sub-agents (planner/builder/reviewer
      // whose parentRunId matches a forge pod ID). Handle separately; don't let them
      // accidentally update regular stream entries.
      const parentRunId = event.payload.parentRunId;
      const forgePodRole = parentRunId
        ? [...forgePodsRef.current.entries()].find(([, pod]) => pod.podId === parentRunId)
        : null;

      if (forgePodRole) {
        const [entryId] = forgePodRole;
        const role = agentId as PodRoleKey;
        if (["planner", "builder", "reviewer"].includes(role)) {
          setForgePods((prev) => {
            const pod = prev.get(entryId);
            if (!pod) return prev;
            const next = new Map(prev);
            const r = pod.roles[role];
            let newRoles = pod.roles;
            switch (kind) {
              case "start":    newRoles = { ...pod.roles, [role]: { status: "running" as const, activity: "", text: "" } }; break;
              case "text":     newRoles = { ...pod.roles, [role]: { ...r, text: r.text + text, status: "running" as const } }; break;
              case "activity": newRoles = { ...pod.roles, [role]: { ...r, activity: text } }; break;
              case "done":     newRoles = { ...pod.roles, [role]: { ...r, status: "done" as const, activity: "" } }; break;
              case "error": case "timeout": case "stopped":
                               newRoles = { ...pod.roles, [role]: { ...r, status: "error" as const, activity: "" } }; break;
            }
            next.set(entryId, { ...pod, roles: newRoles });
            return next;
          });
        }
        return; // don't fall through to the regular stream-entry updater
      }

      if (kind === "start") return;

      setStreamEntries((prev) =>
        prev.map((e) => {
          // Match by runId (precise) or agentId+live-status (before runId is assigned)
          const hit =
            (e.runId !== "" && e.runId === runId) ||
            (e.runId === "" &&
              e.agentId === agentId &&
              (e.status === "thinking" || e.status === "streaming"));
          if (!hit) return e;
          if (kind === "text")     return { ...e, text, status: "streaming" as const };
          if (kind === "activity") return { ...e, activity: text, status: "streaming" as const };
          if (kind === "done")     return { ...e, text: text || e.text, status: "done"    as const, inputTokens, outputTokens, usagePct, outputs };
          if (kind === "error")    return { ...e, text: text || e.text, status: "error"   as const, outputs };
          if (kind === "timeout")  return { ...e, text: text || e.text, status: "timeout" as const };
          if (kind === "stopped")  return { ...e, text: text || e.text, status: "stopped" as const };
          return e;
        })
      );

      if (kind === "done" || kind === "error" || kind === "timeout" || kind === "stopped") {
        setRunningAgents((prev) => {
          const s = new Set(prev);
          s.delete(agentId);
          return s;
        });
        // Clerk may have written a new plan — refresh plan state.
        if (agentId === "clerk" && kind === "done") {
          invoke<PlanState>("get_plan_state").then(setPlanState).catch(() => {});
        }

        // Fire any pending dependent tasks that were waiting for this agent.
        const ready = pendingDepsRef.current.filter((d) => d.after === agentId);
        if (ready.length > 0) {
          pendingDepsRef.current = pendingDepsRef.current.filter((d) => d.after !== agentId);
          const resolvedName = (id: string) =>
            agentsRef.current.find((a) => a.id === id)?.name ?? id;

          for (const dep of ready) {
            const upstreamNote =
              kind === "done"
                ? `\n\nContext from ${resolvedName(dep.after)} (just completed):\n${text}`
                : `\n\n[Note: ${resolvedName(dep.after)} did not finish cleanly (${kind}). Proceed with what you know.]`;
            const depTask = `${dep.baseTask}${upstreamNote}`;

            invoke<string>("run_agent", {
              agentId: dep.agentId,
              task: depTask,
              parentRunId: null,
              resumeSession: false,
              repoPath: null,
            })
              .then((runId) => {
                setStreamEntries((prev) =>
                  prev.map((e) =>
                    e.id === dep.childId
                      ? { ...e, runId, status: "streaming" as const, activity: undefined }
                      : e
                  )
                );
              })
              .catch((err) => {
                setStreamEntries((prev) =>
                  prev.map((e) =>
                    e.id === dep.childId
                      ? { ...e, text: `Failed: ${err}`, status: "error" as const, activity: undefined }
                      : e
                  )
                );
                setRunningAgents((prev) => {
                  const s = new Set(prev);
                  s.delete(dep.agentId);
                  return s;
                });
              });
          }
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => { unlisten?.(); };
  }, []);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [streamEntries]);

  // ── Ask Clerk handler (plan banner) ──────────────────────────────────────────
  async function handleAskClerk(task: string) {
    const clerk = agents.find((a) => a.id === "clerk");
    if (!clerk) return;
    const entryId = `stream-clerk-${Date.now()}`;
    setStreamEntries((prev) => [
      ...prev,
      { id: entryId, runId: "", agentId: "clerk", agentName: clerk.name, text: "", status: "thinking", time: nowTime() },
    ]);
    setRunningAgents((prev) => new Set([...prev, "clerk"]));
    try {
      const runId = await invoke<string>("run_agent", { agentId: "clerk", task, parentRunId: null, resumeSession: true, repoPath: null });
      setStreamEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, runId } : e)));
      // Refresh plan state after Clerk finishes (handled via done event)
    } catch (err) {
      setStreamEntries((prev) =>
        prev.map((e) => e.id === entryId ? { ...e, text: `Failed: ${err}`, status: "error" } : e)
      );
      setRunningAgents((prev) => { const s = new Set(prev); s.delete("clerk"); return s; });
    }
  }

  // ── Mic handler — MediaRecorder → voice_stt Tauri command ────────────────────
  async function handleMicClick() {
    // If already recording, stop and let onstop handle transcription.
    if (isListening) {
      mediaRecorderRef.current?.stop();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return; // mic denied — do nothing silently
    }

    audioChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const effectiveMime =
        (audioChunksRef.current[0]?.type) || mimeType || "audio/webm";
      const blob = new Blob(audioChunksRef.current, { type: effectiveMime });
      audioChunksRef.current = [];

      // Convert blob → base64 and invoke the Tauri STT command.
      try {
        const arrayBuf = await blob.arrayBuffer();
        const uint8    = new Uint8Array(arrayBuf);
        const binary   = uint8.reduce((s, b) => s + String.fromCharCode(b), "");
        const b64      = btoa(binary);
        const transcript = await invoke<string>("voice_stt", {
          audioBase64: b64,
          contentType: effectiveMime,
        });
        if (transcript.trim()) {
          setDraft((prev) => (prev ? prev + " " : "") + transcript.trim());
        }
      } catch {
        // STT failed — leave draft unchanged
      } finally {
        setIsListening(false);
      }
    };

    rec.start();
    mediaRecorderRef.current = rec;
    setIsListening(true);
  }

  // ── Send handler ──────────────────────────────────────────────────────────────
  async function handleSend() {
    const raw = draft.trim();
    if (!raw || !recipient) return;

    // Parse leading @mention to override recipient.
    // "@scout research X" → target scout, task = "research X"
    const mentionMatch = raw.match(/^@(\S+)\s*([\s\S]*)$/);
    let targetAgent = recipient;
    let task = raw;
    if (mentionMatch) {
      const slug  = mentionMatch[1].toLowerCase();
      const found = agents.find(
        (a) => a.name.toLowerCase() === slug || a.id === slug
      );
      if (found) {
        targetAgent = found;
        task = mentionMatch[2].trim() || raw;
      }
    }

    setDraft("");
    setMentionQuery(null);

    const entryId   = `stream-${Date.now()}`;
    const agentId   = targetAgent.id;
    const agentName = targetAgent.name;

    const isBuilderWrite = agentId === "builder" && (settings?.feature_builder_write ?? false);

    setStreamEntries((prev) => [
      ...prev,
      {
        id: entryId, runId: "", agentId, agentName, text: "", status: "thinking", time: nowTime(), userMsg: raw,
        repoPath: agentId === "builder" ? (selectedRepoPath ?? undefined) : undefined,
        builderWrite: isBuilderWrite || undefined,
      },
    ]);
    setRunningAgents((prev) => new Set([...prev, agentId]));

    try {
      const runId = await invoke<string>("run_agent", {
        agentId, task, parentRunId: null, resumeSession: true,
        repoPath: agentId === "builder" ? selectedRepoPath : null,
        builderWrite: isBuilderWrite,
      });
      setStreamEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, runId } : e))
      );
    } catch (err) {
      setStreamEntries((prev) =>
        prev.map((e) =>
          e.id === entryId ? { ...e, text: `Failed to start: ${err}`, status: "error" } : e
        )
      );
      setRunningAgents((prev) => {
        const s = new Set(prev);
        s.delete(agentId);
        return s;
      });
    }
  }

  // ── Forge repo resolution ─────────────────────────────────────────────────────
  function resolveForgeRepo(repoName: string): string | null {
    if (!repoName) return null;
    if (repoName.startsWith("/")) return repoName; // already absolute

    const lower = repoName.toLowerCase();
    const normalize = (s: string) => s.replace(/[.-]/g, "").toLowerCase();
    const normLower = normalize(lower);

    // 1. Match against known projects (name, slug, repo basenames)
    for (const p of repoProjects) {
      if (normalize(p.name) === normLower || normalize(p.slug) === normLower) {
        return p.repos[0] ?? null;
      }
      for (const repo of p.repos) {
        const base = repo.split("/").pop() ?? "";
        if (normalize(base) === normLower || repo.toLowerCase().includes(lower)) return repo;
      }
    }

    // 2. Match against Forge recents (localStorage)
    const recents: string[] = (() => {
      try { return JSON.parse(localStorage.getItem("forge:recentRepos") ?? "[]"); }
      catch { return []; }
    })();
    for (const r of recents) {
      const base = r.split("/").pop() ?? "";
      if (normalize(base) === normLower || r.toLowerCase().includes(lower)) return r;
    }

    return null;
  }

  // ── Fan-out handler ───────────────────────────────────────────────────────────
  async function handleFanout(parentEntryId: string, tasks: DelegationTask[]) {
    setFannedIds((prev) => new Set([...prev, parentEntryId]));
    setChattersOpen((prev) => new Set([...prev, parentEntryId]));

    const resolvedAgentName = (id: string) =>
      id === "forge" ? "Forge" : agents.find((a) => a.id === id)?.name ?? id;

    // Create placeholders for ALL tasks upfront (forge + regular).
    const childDefs = tasks.map((t) => ({
      id:        `child-${t.agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      runId:     "",
      agentId:   t.agentId,
      agentName: resolvedAgentName(t.agentId),
      text:      "",
      status:    "thinking" as const,
      activity:  t.after ? `waiting for ${resolvedAgentName(t.after)}` : undefined,
      time:      nowTime(),
      parentId:  parentEntryId,
    }));

    setStreamEntries((prev) => [...prev, ...childDefs]);
    // Don't add "forge" to runningAgents — it's not a regular agent.
    const regularAgentIds = tasks.filter((t) => t.agentId !== "forge").map((t) => t.agentId);
    setRunningAgents((prev) => new Set([...prev, ...regularAgentIds]));

    // For each task: fire immediately if independent, queue if it has a dep.
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const child = childDefs[i];

      // ── Forge delegation ────────────────────────────────────────────────────
      if (t.agentId === "forge") {
        const repoPath = t.repoName ? resolveForgeRepo(t.repoName) : null;
        if (!repoPath) {
          setStreamEntries((prev) =>
            prev.map((e) =>
              e.id === child.id
                ? { ...e, text: `Could not resolve repo "${t.repoName ?? "(none)"}". Please specify a full path.`, status: "error" as const }
                : e
            )
          );
          continue;
        }

        invoke<string>("run_pod", { repoPath, task: t.task, context: null })
          .then((podId) => {
            setForgePods((prev) => {
              const next = new Map(prev);
              next.set(child.id, {
                podId,
                repoPath,
                roles: emptyPodRoles(),
                podStep: "planning",
                running: true,
                terminal: null,
                pushed: false,
              });
              return next;
            });
          })
          .catch((err) => {
            setStreamEntries((prev) =>
              prev.map((e) =>
                e.id === child.id
                  ? { ...e, text: `Forge pod failed to start: ${err}`, status: "error" as const }
                  : e
              )
            );
          });
        continue;
      }

      // ── Regular agent delegation ─────────────────────────────────────────────
      if (t.after) {
        // Queue — will be fired in the stream listener when `after` completes.
        pendingDepsRef.current.push({
          childId:       child.id,
          agentId:       t.agentId,
          baseTask:      t.task,
          after:         t.after,
          parentEntryId,
        });
        continue;
      }

      invoke<string>("run_agent", {
        agentId: t.agentId,
        task: t.task,
        parentRunId: null,
        resumeSession: false,
        repoPath: null,
      })
        .then((runId) => {
          setStreamEntries((prev) =>
            prev.map((e) => (e.id === child.id ? { ...e, runId } : e))
          );
        })
        .catch((err) => {
          setStreamEntries((prev) =>
            prev.map((e) =>
              e.id === child.id
                ? { ...e, text: `Failed: ${err}`, status: "error" }
                : e
            )
          );
          setRunningAgents((prev) => {
            const s = new Set(prev);
            s.delete(t.agentId);
            return s;
          });
        });
    }
  }

  // ── Approve / Reject ──────────────────────────────────────────────────────────
  async function handleApprove(entry: StreamEntry) {
    const entryId   = `stream-approve-${entry.agentId}-${Date.now()}`;
    const agentName = entry.agentName;

    // Add new entry for the follow-up run; parent is the original entry
    setStreamEntries((prev) => [
      ...prev,
      {
        id: entryId, runId: "", agentId: entry.agentId, agentName,
        text: "", status: "thinking", time: nowTime(),
        parentId: entry.parentId, // same level as the approving entry
      },
    ]);
    setRunningAgents((prev) => new Set([...prev, entry.agentId]));

    try {
      const runId = await invoke<string>("run_agent", {
        agentId: entry.agentId,
        task:    "APPROVED — please proceed with the action you described.",
        parentRunId: null,
        resumeSession: true,
        repoPath: null,
      });
      setStreamEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, runId } : e))
      );
    } catch (err) {
      setStreamEntries((prev) =>
        prev.map((e) =>
          e.id === entryId ? { ...e, text: `Failed: ${err}`, status: "error" } : e
        )
      );
      setRunningAgents((prev) => {
        const s = new Set(prev);
        s.delete(entry.agentId);
        return s;
      });
    }
  }

  function handleReject(entry: StreamEntry) {
    // Mark the entry as resolved-rejected (change its status, clear needs-you)
    setStreamEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id ? { ...e, text: e.text + "\n\n[Rejected by Connor]", status: "done" } : e
      )
    );
  }

  // ── Derived values ────────────────────────────────────────────────────────────
  const recipient = agents.find((a) => a.id === recipientId) ?? null;

  const needsYouCount  = messages.filter((m) => m.tier === "needs-you").length;
  const visibleMsgs    = filter === "needs-you"
    ? messages.filter((m) => m.tier === "needs-you")
    : messages;

  // Root stream entries (no parentId)
  const rootEntries = streamEntries.filter((e) => !e.parentId);

  function childrenOf(parentId: string) {
    return streamEntries.filter((e) => e.parentId === parentId);
  }

  function dismissMsg(id: string) {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }

  function toggleChatterMsg(id: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, collapsed: !m.collapsed } : m))
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-zinc-950 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 h-14 border-b border-zinc-800 shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100 leading-none">Chat</h1>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {agents.length > 0
              ? `${agents.length} agents · ${agents.filter((a) => a.status === "active").length} active`
              : "Loading crew…"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
          <button
            onClick={() => setFilter("needs-you")}
            className={`relative text-xs px-3 py-1.5 rounded-md transition-colors ${
              filter === "needs-you"
                ? "bg-zinc-800 text-zinc-100 font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Needs you
            {needsYouCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-amber-500/20 text-amber-400 px-1 py-0.5 rounded-full leading-none">
                {needsYouCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setFilter("all")}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
              filter === "all"
                ? "bg-zinc-800 text-zinc-100 font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            All
          </button>
        </div>
      </div>

      {/* Plan banner */}
      <PlanBanner
        plan={planState}
        onAskClerk={handleAskClerk}
        clerkRunning={runningAgents.has("clerk")}
      />

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Thread */}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-2">
            {visibleMsgs.length === 0 && rootEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center pb-16">
                <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
                  <Zap size={16} className="text-zinc-600" />
                </div>
                <p className="text-sm text-zinc-500">Nothing needs your attention</p>
                <p className="text-xs text-zinc-600 mt-1">Switch to All to see the full thread</p>
              </div>
            ) : (
              <>
                {/* Seeded placeholder messages */}
                {visibleMsgs.map((msg) => {
                  if (msg.tier === "needs-you")
                    return <NeedsYouMsg key={msg.id} msg={msg} onDismiss={dismissMsg} />;
                  if (msg.tier === "chatter")
                    return <ChatterMsg key={msg.id} msg={msg} onToggle={toggleChatterMsg} />;
                  return <FyiMsg key={msg.id} msg={msg} />;
                })}

                {/* Live stream entries */}
                {rootEntries.map((entry) => {
                  const kids = childrenOf(entry.id);
                  const regularKids = kids.filter((k) => k.agentId !== "forge");
                  const forgePodKids = kids.filter((k) => k.agentId === "forge");
                  return (
                    <div key={entry.id} className="space-y-2">
                      {entry.userMsg && (
                        <UserMsgBubble text={entry.userMsg} time={entry.time} />
                      )}
                      <StreamBubble
                        entry={entry}
                        agents={agents}
                        runningAgents={runningAgents}
                        isChild={false}
                        isFanned={fannedIds.has(entry.id)}
                        onFanout={(tasks) => handleFanout(entry.id, tasks)}
                        onApprove={() => handleApprove(entry)}
                        onReject={() => handleReject(entry)}
                        onDismissBuilder={() =>
                          setDismissedBuilders((prev) => new Set([...prev, entry.id]))
                        }
                      />
                      {regularKids.length > 0 && (
                        <TabbedDelegation
                          children={regularKids}
                          collapsed={!chattersOpen.has(entry.id)}
                          onToggle={() =>
                            setChattersOpen((prev) => {
                              const s = new Set(prev);
                              s.has(entry.id) ? s.delete(entry.id) : s.add(entry.id);
                              return s;
                            })
                          }
                          agents={agents}
                          runningAgents={runningAgents}
                          onApprove={handleApprove}
                          onReject={handleReject}
                          onDismissBuilder={(id) =>
                            setDismissedBuilders((prev) => new Set([...prev, id]))
                          }
                        />
                      )}
                      {forgePodKids.map((kid) => {
                        const pod = forgePods.get(kid.id);
                        if (!pod) return null;
                        return (
                          <InlineForgePod
                            key={kid.id}
                            pod={pod}
                            onPush={() =>
                              setForgePods((prev) => {
                                const next = new Map(prev);
                                const p = next.get(kid.id);
                                if (p) next.set(kid.id, { ...p, pushed: true });
                                return next;
                              })
                            }
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-5 pt-4 pb-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-zinc-600">To:</span>
              {recipient ? (
                <div className="flex items-center gap-1.5 bg-zinc-800/60 border border-zinc-700/50 rounded-full px-2.5 py-1">
                  <span className="text-xs text-zinc-200">{recipient.name}</span>
                  <button
                    onClick={() => setRecipientId(null)}
                    className="text-zinc-500 hover:text-zinc-300 ml-0.5 transition-colors"
                  >
                    <X size={9} />
                  </button>
                </div>
              ) : (
                <span className="text-xs text-zinc-600 italic">no recipient</span>
              )}
              <button
                onClick={() => {
                  const t = textareaRef.current;
                  if (!t) return;
                  const pos = t.selectionStart ?? draft.length;
                  const before = draft.slice(0, pos);
                  const after  = draft.slice(pos);
                  const insert = before.endsWith("@") ? "" : "@";
                  setDraft(before + insert + after);
                  setMentionQuery("");
                  setTimeout(() => t.focus(), 0);
                }}
                className="flex items-center gap-1 text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <AtSign size={11} />
                mention
              </button>
            </div>

            {/* Builder repo picker */}
            {recipient?.id === "builder" && repoProjects.length > 0 && (
              <div className="flex items-center gap-2 mb-3">
                <FolderOpen size={10} className="text-zinc-600 shrink-0" />
                <select
                  value={selectedRepoSlug}
                  onChange={async (e) => {
                    const slug = e.target.value;
                    setSelectedRepoSlug(slug);
                    if (!slug) { setSelectedRepoPath(null); return; }
                    try {
                      const paths = await invoke<Array<{ repo: string; path: string }>>(
                        "get_project_paths", { slug }
                      );
                      setSelectedRepoPath(paths[0]?.path ?? null);
                    } catch {
                      setSelectedRepoPath(null);
                    }
                  }}
                  className="flex-1 text-xs bg-zinc-900 border border-zinc-700/50 rounded px-2 py-1 text-zinc-300 focus:outline-none focus:border-zinc-600 transition-colors"
                >
                  <option value="">No repo — answer from memory</option>
                  {repoProjects.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name || p.repos[0]}
                    </option>
                  ))}
                </select>
                {selectedRepoPath && (
                  <span className="text-[10px] text-zinc-600 truncate max-w-[120px]" title={selectedRepoPath}>
                    {selectedRepoPath.split("/").pop()}
                  </span>
                )}
              </div>
            )}

            <div className="relative">
              {/* @mention dropdown */}
              {mentionQuery !== null && (
                <MentionDropdown
                  query={mentionQuery}
                  agents={agents}
                  onSelect={(a) => {
                    // Replace the trailing @... with @AgentName<space>
                    const lastAt = draft.lastIndexOf("@");
                    const before = lastAt !== -1 ? draft.slice(0, lastAt) : draft;
                    setDraft(before + "@" + a.name + " ");
                    setRecipientId(a.id);
                    setMentionQuery(null);
                    setTimeout(() => textareaRef.current?.focus(), 0);
                  }}
                />
              )}

              {/* Highlight overlay — same font/padding as the textarea */}
              <div
                aria-hidden
                className="absolute inset-0 px-4 py-3 text-sm leading-6 whitespace-pre-wrap break-words pointer-events-none rounded-xl overflow-hidden pr-12"
                style={{ fontFamily: "inherit" }}
              >
                {draft
                  ? renderDraftHighlighted(draft, agents)
                  : <span className="text-zinc-600">{
                      recipient
                        ? `Message ${recipient.name}… type /dispatch or /plan to start a run`
                        : "Type a message…"
                    }</span>
                }
              </div>

              <textarea
                ref={textareaRef}
                rows={2}
                value={draft}
                onChange={(e) => {
                  const val = e.target.value;
                  setDraft(val);
                  // Detect live @mention query
                  const lastAt = val.lastIndexOf("@");
                  if (lastAt !== -1) {
                    const afterAt = val.slice(lastAt + 1);
                    if (!/\s/.test(afterAt)) {
                      setMentionQuery(afterAt.toLowerCase());
                    } else {
                      // Completed @Name — update recipient if matched
                      const m = val.match(/@(\S+)/);
                      if (m) {
                        const slug  = m[1].toLowerCase();
                        const found = agents.find(
                          (a) => a.name.toLowerCase() === slug || a.id === slug
                        );
                        if (found) setRecipientId(found.id);
                      }
                      setMentionQuery(null);
                    }
                  } else {
                    setMentionQuery(null);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                  if (e.key === "Escape" && mentionQuery !== null) {
                    setMentionQuery(null);
                  }
                }}
                style={{ color: "transparent", caretColor: "white" }}
                className="w-full relative resize-none bg-zinc-900/60 border border-zinc-700/60 rounded-xl px-4 py-3 text-sm leading-6 placeholder-transparent focus:outline-none focus:border-zinc-600 pr-12 transition-colors"
              />
              {(settings?.feature_voice ?? false) && (
                <button
                  onClick={handleMicClick}
                  className={`absolute right-3 top-3 transition-colors ${
                    isListening
                      ? "text-red-400 animate-pulse"
                      : "text-zinc-600 hover:text-zinc-400"
                  }`}
                  title={isListening ? "Stop listening" : "Dictate"}
                >
                  <Mic size={15} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={() => setOvernight((o) => !o)}
                className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                  overnight
                    ? "bg-indigo-900/30 border-indigo-600/40 text-indigo-400"
                    : "border-zinc-700/50 text-zinc-600 hover:text-zinc-400 hover:border-zinc-600/50"
                }`}
              >
                <Moon size={11} />
                Overnight
                <span
                  className={`relative inline-flex w-7 h-4 rounded-full transition-colors ${
                    overnight ? "bg-indigo-600" : "bg-zinc-700"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                      overnight ? "translate-x-3.5" : "translate-x-0.5"
                    }`}
                  />
                </span>
              </button>

              <div className="flex-1" />

              <div className="flex gap-1.5">
                {["/dispatch", "/plan"].map((cmd) => (
                  <button
                    key={cmd}
                    onClick={() => {
                      setDraft(cmd + " ");
                      textareaRef.current?.focus();
                    }}
                    className="text-[10px] text-zinc-600 hover:text-zinc-400 bg-zinc-800/50 border border-zinc-700/30 px-2 py-1 rounded font-mono transition-colors"
                  >
                    {cmd}
                  </button>
                ))}
              </div>

              <button
                onClick={handleSend}
                disabled={!draft.trim() || !recipient || runningAgents.has(recipient?.id ?? "")}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-zinc-700"
              >
                {recipient && runningAgents.has(recipient.id) ? (
                  <Loader size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                Send
              </button>
            </div>
          </div>
        </div>

        {/* Crew rail */}
        <div className="w-[220px] shrink-0 border-l border-zinc-800 flex flex-col bg-zinc-950">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-400">Crew</span>
            {agents.length > 0 && (
              <span className="ml-auto text-[10px] text-zinc-600">
                {agents.filter((a) => a.status === "active").length}/{agents.length}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {agents.length === 0 ? (
              <div className="text-[11px] text-zinc-700 text-center mt-6">Loading…</div>
            ) : (
              agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  isRunning={runningAgents.has(agent.id)}
                  isSelected={recipientId === agent.id}
                  onClick={() => {
                    setRecipientId(agent.id);
                    textareaRef.current?.focus();
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
