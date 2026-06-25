import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AtSign, Bot, Check, ChevronDown, ChevronRight, FileText,
  GitMerge, Loader, Mic, Moon, Play, Send, X, Zap,
} from "lucide-react";

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

interface AgentStreamPayload {
  runId: string;
  agentId: string;
  kind: string;   // "start" | "text" | "done" | "error"
  text: string;
  parentRunId: string | null;
}

type Filter = "needs-you" | "all";

// Placeholder (seeded) messages
interface Msg {
  id: string;
  from: string;
  fromRole: "orchestrator" | "subagent" | "chatter";
  tier: "needs-you" | "fyi" | "chatter";
  content: string;
  action?: string;
  time: string;
  collapsed: boolean;
}

// Live stream entry from a real agent run
interface StreamEntry {
  id: string;          // stable local id
  runId: string;       // "" until backend returns it
  agentId: string;
  agentName: string;
  text: string;
  status: "thinking" | "streaming" | "done" | "error";
  time: string;
  parentId?: string;   // local id of the orchestrator entry that spawned this
}

// A parsed delegation task from Jack's ```delegate block
interface DelegationTask {
  agentId: string;
  task: string;
}

// ── Placeholder messages ───────────────────────────────────────────────────────

const PLACEHOLDER_MESSAGES: Msg[] = [
  {
    id: "m1",
    from: "Captain Jack",
    fromRole: "orchestrator",
    tier: "needs-you",
    content:
      "Ready to kick off today's research sprint. Scout will pull Anthropic pricing updates; Clerk will reconcile the plan. Want me to fan out in parallel?",
    action: "Fan out now",
    time: "9:14 AM",
    collapsed: false,
  },
  {
    id: "m2",
    from: "Scout",
    fromRole: "subagent",
    tier: "fyi",
    content: "Research complete — findings saved to memory/research/anthropic-pricing-2026-06.md",
    time: "8:47 AM",
    collapsed: false,
  },
  {
    id: "m3",
    from: "Builder → Scribe",
    fromRole: "chatter",
    tier: "chatter",
    content: "README diff ready. Handing off for copy pass.",
    time: "8:32 AM",
    collapsed: true,
  },
  {
    id: "m4",
    from: "Scribe",
    fromRole: "subagent",
    tier: "needs-you",
    content:
      "Gmail draft ready: reply to Lena re investor update. Approve to send, or open for edits.",
    action: "Approve & send",
    time: "8:15 AM",
    collapsed: false,
  },
];

// ── Parse helpers ─────────────────────────────────────────────────────────────

const KNOWN_AGENT_IDS = new Set(["scout", "scribe", "clerk", "builder"]);

/** Extract ```delegate\n...\n``` block from agent text. Returns null if absent. */
function parseDelegations(text: string): DelegationTask[] | null {
  const match = text.match(/```delegate\n([\s\S]*?)```/);
  if (!match) return null;
  const tasks = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return null;
      const agentId = line.slice(0, idx).trim().toLowerCase();
      const task    = line.slice(idx + 1).trim();
      if (!agentId || !task || !KNOWN_AGENT_IDS.has(agentId)) return null;
      return { agentId, task } as DelegationTask;
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
            <span className="text-zinc-400 leading-relaxed">{t.task}</span>
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

function BuilderDoneCard({ onDismiss }: { onDismiss: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mt-3 border border-zinc-700/50 rounded-lg bg-zinc-800/30 px-3 py-2.5">
      <div className="flex items-center gap-2 mb-2">
        <GitMerge size={11} className="text-emerald-400" />
        <span className="text-xs font-medium text-zinc-300">Builder finished</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => navigate("/memory")}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-700/60 text-zinc-300 hover:bg-zinc-700 border border-zinc-600/50 transition-colors"
        >
          <FileText size={11} />
          View log
        </button>
        <button
          title="Worktree merge coming in Phase 4"
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-zinc-600 border border-zinc-700/30 cursor-not-allowed"
        >
          <GitMerge size={11} />
          Merge
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
  const isLive   = entry.status === "thinking" || entry.status === "streaming";
  const isError  = entry.status === "error";
  const isDone   = entry.status === "done";

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
        ) : (
          <Bot size={12} className="text-zinc-500 shrink-0" />
        )}
        <span className="text-xs font-medium text-zinc-200">{entry.agentName}</span>
        {isLive && (
          <span className="text-[10px] text-blue-400/70 bg-blue-500/10 px-1.5 py-0.5 rounded-full">
            {!entry.text ? "thinking…" : "responding…"}
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500">{entry.time}</span>
      </div>

      {/* Body */}
      {!entry.text && isLive ? (
        <div className="flex gap-1 mt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:300ms]" />
        </div>
      ) : (
        <p className={`text-sm leading-relaxed whitespace-pre-wrap ${isError ? "text-red-300" : "text-zinc-100"}`}>
          {displayText}
          {isLive && displayText && (
            <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 align-text-bottom animate-pulse" />
          )}
        </p>
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

      {/* Builder done card */}
      {isBuilder && isDone && !isError && (
        <BuilderDoneCard onDismiss={onDismissBuilder} />
      )}
    </div>
  );
}

// ── Chatter group (collapsed subagent runs) ───────────────────────────────────

function ChatterGroup({
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
  const names = children.map((e) => e.agentName).join(", ");

  return (
    <div className="ml-5 border-l-2 border-zinc-800/60 pl-3">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-[11px] text-zinc-600 hover:text-zinc-400 py-1.5 transition-colors"
      >
        {collapsed ? (
          <ChevronRight size={11} className="shrink-0" />
        ) : (
          <ChevronDown size={11} className="shrink-0" />
        )}
        <span>watching agent chatter</span>
        <span className="text-zinc-700">· {children.length}</span>
        {liveCount > 0 && (
          <span className="text-blue-400/60 ml-1">· {liveCount} running</span>
        )}
        {collapsed && (
          <span className="text-zinc-700 truncate max-w-[160px]">{names}</span>
        )}
      </button>

      {!collapsed && (
        <div className="space-y-2 mt-1 mb-3">
          {children.map((entry) => (
            <StreamBubble
              key={entry.id}
              entry={entry}
              agents={agents}
              runningAgents={runningAgents}
              isChild={true}
              isFanned={false}
              onFanout={() => {}}
              onApprove={() => onApprove(entry)}
              onReject={() => onReject(entry)}
              onDismissBuilder={() => onDismissBuilder(entry.id)}
            />
          ))}
        </div>
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
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Chat() {
  const [agents, setAgents]             = useState<Agent[]>([]);
  const [messages, setMessages]         = useState<Msg[]>(PLACEHOLDER_MESSAGES);
  const [streamEntries, setStreamEntries] = useState<StreamEntry[]>([]);
  const [runningAgents, setRunningAgents] = useState<Set<string>>(new Set());
  /** Set of parent entry IDs whose delegation has been fanned out. */
  const [fannedIds, setFannedIds]       = useState<Set<string>>(new Set());
  /** Set of parent entry IDs whose chatter group is expanded. */
  const [chattersOpen, setChattersOpen] = useState<Set<string>>(new Set());
  const [, setDismissedBuilders] = useState<Set<string>>(new Set());
  const [filter, setFilter]             = useState<Filter>("needs-you");
  const [draft, setDraft]               = useState("");
  const [overnight, setOvernight]       = useState(false);
  const [recipientId, setRecipientId]   = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef   = useRef<HTMLDivElement>(null);

  // ── Load agents ──────────────────────────────────────────────────────────────
  useEffect(() => {
    invoke<Agent[]>("list_agents")
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (agents.length > 0 && recipientId === null) {
      const orch = agents.find((a) => a.role === "orchestrator");
      setRecipientId(orch?.id ?? agents[0]?.id ?? null);
    }
  }, [agents, recipientId]);

  // ── agent-stream event listener ──────────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<AgentStreamPayload>("agent-stream", (event) => {
      const { runId, agentId, kind, text } = event.payload;
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
          if (kind === "text")  return { ...e, text, status: "streaming" };
          if (kind === "done")  return { ...e, text: text || e.text, status: "done" };
          if (kind === "error") return { ...e, text: text || e.text, status: "error" };
          return e;
        })
      );

      if (kind === "done" || kind === "error") {
        setRunningAgents((prev) => {
          const s = new Set(prev);
          s.delete(agentId);
          return s;
        });
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

  // ── Send handler ──────────────────────────────────────────────────────────────
  async function handleSend() {
    const task = draft.trim();
    if (!task || !recipient) return;
    setDraft("");

    const entryId   = `stream-${Date.now()}`;
    const agentId   = recipient.id;
    const agentName = recipient.name;

    setStreamEntries((prev) => [
      ...prev,
      { id: entryId, runId: "", agentId, agentName, text: "", status: "thinking", time: nowTime() },
    ]);
    setRunningAgents((prev) => new Set([...prev, agentId]));

    try {
      const runId = await invoke<string>("run_agent", {
        agentId, task, parentRunId: null,
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

  // ── Fan-out handler ───────────────────────────────────────────────────────────
  async function handleFanout(parentEntryId: string, tasks: DelegationTask[]) {
    setFannedIds((prev) => new Set([...prev, parentEntryId]));
    // Open the chatter group immediately
    setChattersOpen((prev) => new Set([...prev, parentEntryId]));

    // Create thinking placeholders for all subagents
    const childDefs = tasks.map((t) => ({
      id: `child-${t.agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      runId:     "",
      agentId:   t.agentId,
      agentName: agents.find((a) => a.id === t.agentId)?.name ?? t.agentId,
      text:      "",
      status:    "thinking" as const,
      time:      nowTime(),
      parentId:  parentEntryId,
      task:      t.task,
    }));

    setStreamEntries((prev) => [...prev, ...childDefs]);
    setRunningAgents((prev) => new Set([...prev, ...tasks.map((t) => t.agentId)]));

    // Fire all run_agents (concurrent, no await chain)
    for (const child of childDefs) {
      const task = tasks.find((t) => t.agentId === child.agentId)?.task ?? "";
      invoke<string>("run_agent", {
        agentId: child.agentId,
        task,
        parentRunId: null,
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
            s.delete(child.agentId);
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
  const defaultAgent = agents.find((a) => a.role === "orchestrator") ?? agents[0] ?? null;
  const recipient    = agents.find((a) => a.id === recipientId) ?? defaultAgent;

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
                  return (
                    <div key={entry.id} className="space-y-0">
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
                      {kids.length > 0 && (
                        <ChatterGroup
                          children={kids}
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
              <button className="flex items-center gap-1 text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors">
                <AtSign size={11} />
                mention
              </button>
            </div>

            <div className="relative">
              <textarea
                ref={textareaRef}
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  recipient
                    ? `Message ${recipient.name}… type /dispatch or /plan to start a run`
                    : "Type a message…"
                }
                className="w-full resize-none bg-zinc-900/60 border border-zinc-700/60 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 pr-12 transition-colors"
              />
              <button className="absolute right-3 top-3 text-zinc-600 hover:text-zinc-400 transition-colors">
                <Mic size={15} />
              </button>
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
