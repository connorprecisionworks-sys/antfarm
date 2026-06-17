import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { Lock, Mic, Moon, Send } from "lucide-react";

// ── Animation styles ──────────────────────────────────────────────────────────

const TONIGHT_STYLES = `
  @keyframes dotBounceN {
    0%, 80%, 100% { transform: translateY(0); }
    40%           { transform: translateY(-4px); }
  }
  @media (prefers-reduced-motion: no-preference) {
    .tn-dot-b1 { animation: dotBounceN 1.2s ease-in-out infinite 0ms; }
    .tn-dot-b2 { animation: dotBounceN 1.2s ease-in-out infinite 160ms; }
    .tn-dot-b3 { animation: dotBounceN 1.2s ease-in-out infinite 320ms; }
    .tn-msg { animation: tnMsgIn 0.2s ease-out both; }
  }
  @keyframes tnMsgIn {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowStr() { return new Date().toLocaleString(); }

let _seq = 0;
function newId() { return `tn-${++_seq}`; }

function tomorrowLabel() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMsg {
  id: string;
  role: "user" | "agent" | "error";
  text: string;
}

interface TomorrowPlan {
  locked: boolean;
  target_date: string;
  markdown: string;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMsg }) {
  const isUser  = msg.role === "user";
  const isError = msg.role === "error";
  return (
    <div className={`flex tn-msg ${isUser ? "justify-end" : "justify-start"}`}>
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
    <div className="flex justify-start tn-msg">
      <div className="bg-zinc-800 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
        <span className="tn-dot-b1 w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block" />
        <span className="tn-dot-b2 w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block" />
        <span className="tn-dot-b3 w-1.5 h-1.5 rounded-full bg-zinc-500 inline-block" />
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Tonight() {
  const navigate = useNavigate();
  const [existingPlan, setExistingPlan] = useState<TomorrowPlan | null>(null);
  const [showExisting, setShowExisting] = useState(true);
  const [messages, setMessages]         = useState<ChatMsg[]>([]);
  const [input, setInput]               = useState("");
  const [thinking, setThinking]         = useState(false);
  const [locking, setLocking]           = useState(false);
  const [lockedMd, setLockedMd]         = useState<string | null>(null);
  const [lockError, setLockError]       = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  // Load any existing plan on mount
  useEffect(() => {
    invoke<TomorrowPlan>("get_tomorrow_plan")
      .then((p) => { if (p.locked || p.markdown) setExistingPlan(p); })
      .catch(() => {});
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    setInput("");
    setThinking(true);
    setMessages((prev) => [...prev, { id: newId(), role: "user", text }]);
    try {
      const reply = await invoke<string>("plan_chat_send", {
        message: text,
        now: nowStr(),
      });
      setMessages((prev) => [...prev, { id: newId(), role: "agent", text: reply }]);
    } catch (e) {
      setMessages((prev) => [...prev, { id: newId(), role: "error", text: String(e) }]);
    } finally {
      setThinking(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function lockPlan() {
    setLocking(true);
    setLockError(null);
    try {
      const md = await invoke<string>("lock_tomorrow_plan", { now: nowStr() });
      setLockedMd(md);
      setExistingPlan({ locked: true, target_date: "", markdown: md });
      setShowExisting(true);
    } catch (e) {
      setLockError(String(e));
    } finally {
      setLocking(false);
    }
  }

  // What to show in the locked plan panel
  const displayPlan  = lockedMd ?? (existingPlan?.locked ? existingPlan.markdown : null);
  const hasDraftPlan = !displayPlan && existingPlan && existingPlan.markdown;

  return (
    <div className="h-full flex flex-col">
      <style>{TONIGHT_STYLES}</style>

      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-800 shrink-0">
        <Moon size={16} strokeWidth={1.5} className="text-zinc-400" />
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Tonight</h1>
          <p className="text-xs text-zinc-500">Plan for {tomorrowLabel()}</p>
        </div>
        <button
          onClick={() => navigate("/voice?mode=night")}
          className="ml-auto flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          title="Plan out loud with Captain Jack"
        >
          <Mic size={12} strokeWidth={1.75} />
          Plan out loud
        </button>
      </div>

      {/* Locked plan card */}
      {displayPlan && showExisting && (
        <div className="shrink-0 mx-6 mt-4 rounded-xl border border-emerald-900/40 bg-emerald-950/20 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-emerald-900/30">
            <div className="flex items-center gap-2">
              <Lock size={12} strokeWidth={2} className="text-emerald-400" />
              <span className="text-xs font-medium text-emerald-400">Tomorrow is locked</span>
            </div>
            <button
              onClick={() => setShowExisting(false)}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Re-plan
            </button>
          </div>
          <pre className="px-4 py-3 text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed max-h-52 overflow-y-auto">
            {displayPlan}
          </pre>
        </div>
      )}

      {/* Draft / unlocked existing plan */}
      {hasDraftPlan && showExisting && (
        <div className="shrink-0 mx-6 mt-4 rounded-xl border border-zinc-700/40 bg-zinc-900/30 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-500">Prior draft</span>
            <button
              onClick={() => setShowExisting(false)}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              Dismiss
            </button>
          </div>
          <pre className="px-4 py-3 text-xs text-zinc-500 whitespace-pre-wrap font-mono leading-relaxed max-h-40 overflow-y-auto">
            {existingPlan!.markdown}
          </pre>
        </div>
      )}

      {/* Lock error */}
      {lockError && (
        <div className="shrink-0 mx-6 mt-3 rounded-lg bg-red-950/30 border border-red-900/40 px-4 py-2.5">
          <p className="text-xs text-red-300">{lockError}</p>
        </div>
      )}

      {/* Chat messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-2"
      >
        {messages.length === 0 && !thinking && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 pb-10">
            <Moon size={28} strokeWidth={1} className="text-zinc-700" />
            <p className="text-sm text-zinc-500">Talk through tomorrow with your chief of staff.</p>
            <p className="text-xs text-zinc-600 max-w-xs leading-relaxed">
              Cover commitments, the one big rock, work blocks, and personal. Then lock the plan.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
        {thinking && <TypingIndicator />}
      </div>

      {/* Input + lock bar */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/60 px-4 py-3 space-y-2">
        <div className="flex gap-2 items-center">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            disabled={thinking}
            placeholder={thinking ? "Thinking..." : "Talk through tomorrow..."}
            className="flex-1 text-xs bg-zinc-900 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-indigo-500/60 disabled:opacity-50 transition-colors"
          />
          <button
            onClick={send}
            disabled={thinking || !input.trim()}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={13} strokeWidth={2} className="text-zinc-200" />
          </button>
        </div>

        <button
          onClick={lockPlan}
          disabled={locking || thinking}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
        >
          {locking ? (
            <>
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Locking plan...
            </>
          ) : (
            <>
              <Lock size={13} strokeWidth={2} />
              Lock tomorrow's plan
            </>
          )}
        </button>
      </div>
    </div>
  );
}
