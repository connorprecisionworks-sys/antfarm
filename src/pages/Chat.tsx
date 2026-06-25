import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AtSign, Bot, Check, ChevronDown, ChevronRight, Loader,
  Mic, Moon, Send, X, Zap,
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
  /** "start" | "text" | "done" | "error" */
  kind: string;
  text: string;
}

type Filter = "needs-you" | "all";

// Placeholder messages (Phase 1 sample data)
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

// Live streaming entry from a real agent run
interface StreamEntry {
  id: string;          // local UI id
  runId: string;
  agentId: string;
  agentName: string;
  text: string;
  /** "thinking" | "streaming" | "done" | "error" */
  status: "thinking" | "streaming" | "done" | "error";
  time: string;
}

// ── Placeholder messages ───────────────────────────────────────────────────────

const PLACEHOLDER_MESSAGES: Msg[] = [
  {
    id: "m1",
    from: "Captain Jack",
    fromRole: "orchestrator",
    tier: "needs-you",
    content:
      "Ready to kick off today's research sprint. Scout will pull Anthropic pricing updates; Clerk will reconcile the plan against this morning's calendar. Want me to fan them out in parallel, or step through one at a time?",
    action: "Fan out now",
    time: "9:14 AM",
    collapsed: false,
  },
  {
    id: "m2",
    from: "Scout",
    fromRole: "subagent",
    tier: "fyi",
    content:
      "Research complete — findings saved to memory/research/anthropic-pricing-2026-06.md",
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
      "Gmail draft ready: reply to Lena re investor update. Approve to send, or I can open it for edits first.",
    action: "Approve & send",
    time: "8:15 AM",
    collapsed: false,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortModel(model: string): string {
  if (model.includes("opus")) return "Opus 4.6";
  if (model.includes("sonnet")) return "Sonnet 4.6";
  if (model.includes("haiku")) return "Haiku 4.5";
  return model;
}

function roleLabel(role: string): string {
  return role === "orchestrator" ? "Orchestrator" : "Subagent";
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Message components ────────────────────────────────────────────────────────

function NeedsYouMessage({
  msg,
  onDismiss,
}: {
  msg: Msg;
  onDismiss: (id: string) => void;
}) {
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
            className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 border border-zinc-700/50 hover:border-zinc-600/50 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function FyiMessage({ msg }: { msg: Msg }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-zinc-800/40 bg-zinc-900/25">
      <Bot size={11} className="text-zinc-700 shrink-0" />
      <span className="text-xs font-medium text-zinc-500">{msg.from}</span>
      <span className="text-xs text-zinc-600 flex-1 truncate">{msg.content}</span>
      <span className="text-[11px] text-zinc-700 shrink-0">{msg.time}</span>
    </div>
  );
}

function ChatterMessage({
  msg,
  onToggle,
}: {
  msg: Msg;
  onToggle: (id: string) => void;
}) {
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

// ── Streaming message bubble ──────────────────────────────────────────────────

function StreamBubble({ entry }: { entry: StreamEntry }) {
  const isLive   = entry.status === "thinking" || entry.status === "streaming";
  const isError  = entry.status === "error";
  const isEmpty  = !entry.text;

  return (
    <div
      className={`border rounded-xl p-4 transition-colors ${
        isError
          ? "border-red-800/50 border-l-[3px] border-l-red-500/60 bg-zinc-900/70"
          : isLive
          ? "border-zinc-700/60 border-l-[3px] border-l-blue-500/60 bg-zinc-900/70"
          : "border-zinc-800 border-l-[3px] border-l-zinc-600/60 bg-zinc-900/40"
      }`}
    >
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
            {isEmpty ? "thinking…" : "responding…"}
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500">{entry.time}</span>
      </div>

      {isEmpty && isLive ? (
        /* Thinking dots */
        <div className="flex gap-1 mt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-bounce [animation-delay:300ms]" />
        </div>
      ) : (
        <p
          className={`text-sm leading-relaxed whitespace-pre-wrap ${
            isError ? "text-red-300" : "text-zinc-100"
          }`}
        >
          {entry.text}
          {isLive && entry.text && (
            <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 align-text-bottom animate-pulse" />
          )}
        </p>
      )}
    </div>
  );
}

// ── Agent crew card ───────────────────────────────────────────────────────────

function AgentCard({
  agent,
  isRunning,
  onClick,
}: {
  agent: Agent;
  isRunning: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl border border-zinc-800/60 bg-zinc-900/50 hover:bg-zinc-900/80 p-3 transition-colors"
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
      {agent.schedule && (
        <div className="mt-1 text-[9px] text-zinc-700">⏰ {agent.schedule}</div>
      )}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Chat() {
  const [agents, setAgents]           = useState<Agent[]>([]);
  const [messages, setMessages]       = useState<Msg[]>(PLACEHOLDER_MESSAGES);
  const [streamEntries, setStreamEntries] = useState<StreamEntry[]>([]);
  const [runningAgents, setRunningAgents] = useState<Set<string>>(new Set());
  const [filter, setFilter]           = useState<Filter>("needs-you");
  const [draft, setDraft]             = useState("");
  const [overnight, setOvernight]     = useState(false);
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef   = useRef<HTMLDivElement>(null);

  // ── Load agents ──────────────────────────────────────────────────────────────
  useEffect(() => {
    invoke<Agent[]>("list_agents")
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  // Set default recipient once agents load
  useEffect(() => {
    if (agents.length > 0 && recipientId === null) {
      const orch = agents.find((a) => a.role === "orchestrator");
      setRecipientId(orch?.id ?? agents[0]?.id ?? null);
    }
  }, [agents, recipientId]);

  // ── Listen for agent-stream events ──────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<AgentStreamPayload>("agent-stream", (event) => {
      const { agentId, kind, text } = event.payload;

      if (kind === "start") {
        // Placeholder added on send; nothing to do here.
        return;
      }

      if (kind === "text") {
        setStreamEntries((prev) =>
          prev.map((e) =>
            e.agentId === agentId && (e.status === "thinking" || e.status === "streaming")
              ? { ...e, text, status: "streaming" }
              : e
          )
        );
        return;
      }

      if (kind === "done" || kind === "error") {
        setStreamEntries((prev) =>
          prev.map((e) =>
            e.agentId === agentId && (e.status === "thinking" || e.status === "streaming")
              ? { ...e, text: text || e.text, status: kind === "error" ? "error" : "done" }
              : e
          )
        );
        setRunningAgents((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [streamEntries, messages]);

  // ── Send handler ─────────────────────────────────────────────────────────────
  async function handleSend() {
    const task = draft.trim();
    if (!task || !recipient) return;
    setDraft("");

    const entryId  = `stream-${Date.now()}`;
    const agentId  = recipient.id;
    const agentName = recipient.name;

    // Optimistic: add thinking bubble
    setStreamEntries((prev) => [
      ...prev,
      { id: entryId, runId: "", agentId, agentName, text: "", status: "thinking", time: nowTime() },
    ]);
    setRunningAgents((prev) => new Set([...prev, agentId]));

    try {
      await invoke<string>("run_agent", { agentId, task });
    } catch (err) {
      setStreamEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, text: `Failed to start agent: ${err}`, status: "error" }
            : e
        )
      );
      setRunningAgents((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }

  // ── Recipient + filter ────────────────────────────────────────────────────────
  const defaultAgent = agents.find((a) => a.role === "orchestrator") ?? agents[0] ?? null;
  const recipient    = agents.find((a) => a.id === recipientId) ?? defaultAgent;

  const needsYouCount = messages.filter((m) => m.tier === "needs-you").length;

  const visibleMessages =
    filter === "needs-you"
      ? messages.filter((m) => m.tier === "needs-you")
      : messages;

  // Always show stream entries regardless of filter (they're from real interactions)
  const visibleEntries = streamEntries;

  function dismissMessage(id: string) {
    setMessages((msgs) => msgs.filter((m) => m.id !== id));
  }

  function toggleCollapse(id: string) {
    setMessages((msgs) =>
      msgs.map((m) => (m.id === id ? { ...m, collapsed: !m.collapsed } : m))
    );
  }

  function selectRecipient(agent: Agent) {
    setRecipientId(agent.id);
    textareaRef.current?.focus();
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-zinc-950 overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-4 px-5 h-14 border-b border-zinc-800 shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100 leading-none">Chat</h1>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            {agents.length > 0
              ? `${agents.length} agents · ${agents.filter((a) => a.status === "active").length} active`
              : "Loading crew…"}
          </p>
        </div>

        {/* Filter toggle */}
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

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Thread ── */}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-2">
            {/* Placeholder messages */}
            {visibleMessages.length === 0 && visibleEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center pb-16">
                <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
                  <Zap size={16} className="text-zinc-600" />
                </div>
                <p className="text-sm text-zinc-500">Nothing needs your attention</p>
                <p className="text-xs text-zinc-600 mt-1">Switch to All to see the full thread</p>
              </div>
            ) : (
              <>
                {visibleMessages.map((msg) => {
                  if (msg.tier === "needs-you") {
                    return <NeedsYouMessage key={msg.id} msg={msg} onDismiss={dismissMessage} />;
                  }
                  if (msg.tier === "chatter") {
                    return <ChatterMessage key={msg.id} msg={msg} onToggle={toggleCollapse} />;
                  }
                  return <FyiMessage key={msg.id} msg={msg} />;
                })}

                {/* Live agent stream bubbles */}
                {visibleEntries.map((entry) => (
                  <StreamBubble key={entry.id} entry={entry} />
                ))}
              </>
            )}
            <div ref={bottomRef} />
          </div>

          {/* ── Composer ── */}
          <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-5 pt-4 pb-5">
            {/* Recipient row */}
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

            {/* Textarea */}
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

            {/* Bottom bar */}
            <div className="flex items-center gap-3 mt-3">
              {/* Overnight toggle */}
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

              {/* Slash hints */}
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

              {/* Send */}
              <button
                onClick={handleSend}
                disabled={!draft.trim() || !recipient || runningAgents.has(recipient?.id ?? "")}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-zinc-700"
              >
                {runningAgents.has(recipient?.id ?? "") ? (
                  <Loader size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )}
                Send
              </button>
            </div>
          </div>
        </div>

        {/* ── Crew rail ── */}
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
                  onClick={() => selectRecipient(agent)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
