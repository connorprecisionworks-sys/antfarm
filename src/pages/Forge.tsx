import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight,
  FileText, FolderOpen, GitMerge, Loader, Send, Zap,
} from "lucide-react";
import {
  type RoleKey,
  type RoleState,
  type ForgeTurn,
  type ForgeTurnTerminal,
  subscribe as subscribeForge,
  getSnapshot as getForgeSnapshot,
  appendTurn,
  markPushed,
} from "../lib/forgeThreadStore";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PodStreamPayload {
  podId: string;
  step: string;
  kind: string;
  text: string;
  commitMsg?: string;
  diff?: string;
  reviewerNote?: string;
}

interface AgentStreamPayload {
  runId: string;
  agentId: string;
  kind: string;
  text: string;
  parentRunId?: string;
}

// In-memory state for the currently running (or just-finished) pod turn.
// Persisted to forgeThreadStore only when a terminal event fires.
interface ActiveTurn {
  id: string;
  userMessage: string;
  podId: string;
  repoPath: string; // captured at send time — prevents stale-closure issues
  roles: Record<RoleKey, RoleState>;
  podStep: string;
  running: boolean;
  terminal: ForgeTurnTerminal | null;
  pushed: boolean;
  hasCumulativeDiff: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RECENTS_KEY = "forge:recentRepos";
const MAX_RECENTS = 5;
const ROLES: RoleKey[] = ["planner", "builder", "reviewer"];
const ROLE_LABELS: Record<RoleKey, string> = {
  planner: "Planner",
  builder: "Builder",
  reviewer: "Reviewer",
};
const STEP_ROLE: Partial<Record<string, RoleKey>> = {
  planning:  "planner",
  building:  "builder",
  reviewing: "reviewer",
};
const STEP_LABEL: Record<string, string> = {
  planning:      "Planning the change…",
  building:      "Writing the code…",
  verifying:     "Checking it builds…",
  reviewing:     "Reviewing the logic…",
  ready_to_push: "Done and safe — ready to publish.",
  needs_you:     "Needs your attention.",
};
const FALLBACK_REPO = "/Users/connordore/Desktop/antfarm-write-test";

function emptyRoles(): Record<RoleKey, RoleState> {
  return {
    planner:  { status: "idle", activity: "", text: "" },
    builder:  { status: "idle", activity: "", text: "" },
    reviewer: { status: "idle", activity: "", text: "" },
  };
}

function newTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Recents ───────────────────────────────────────────────────────────────────

function loadRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]"); }
  catch { return []; }
}

function saveRecent(path: string): void {
  const prev = loadRecents().filter((p) => p !== path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([path, ...prev].slice(0, MAX_RECENTS)));
}

// ── Conversation context builder ───────────────────────────────────────────────

function buildContext(turns: ForgeTurn[], hasCumulativeDiff: boolean): string | undefined {
  if (turns.length === 0 && !hasCumulativeDiff) return undefined;
  const recent = turns.slice(-6);
  const lines = recent.map((t, i) => {
    let outcome = "in progress";
    if (t.terminal?.kind === "ready_to_push") {
      outcome = t.pushed ? "approved and pushed" : "built, awaiting approval";
    } else if (t.terminal?.kind === "needs_you") {
      outcome = "escalated, needs attention";
    }
    return `Turn ${i + 1}: "${t.userMessage}" → ${outcome}`;
  });
  let ctx = `Prior turns in this coding session:\n${lines.join("\n")}`;
  if (hasCumulativeDiff) {
    ctx +=
      "\n\nIMPORTANT: The previous turn's changes are uncommitted in the working tree. " +
      "The next build continues on top of them cumulatively — this is expected and correct.";
  }
  return ctx;
}

// ── PodRoleTabs ───────────────────────────────────────────────────────────────

function PodRoleTabs({
  roles,
  activeRole,
  onSetRole,
  textRef,
  podStep,
  running,
}: {
  roles: Record<RoleKey, RoleState>;
  activeRole: RoleKey;
  onSetRole: (r: RoleKey) => void;
  textRef?: React.RefObject<HTMLPreElement>;
  podStep?: string;
  running?: boolean;
}) {
  const stepLabel = STEP_LABEL[podStep ?? ""] ?? "";

  return (
    <div className="space-y-1.5">
      {stepLabel && (
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          {running && <Loader size={10} className="animate-spin text-blue-400 shrink-0" />}
          <span>{stepLabel}</span>
        </div>
      )}

      <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-zinc-800/60 bg-zinc-900/40">
          {ROLES.map((role) => {
            const r       = roles[role];
            const isActive = role === activeRole;
            const isLive   = r.status === "running";
            return (
              <button
                key={role}
                onClick={() => onSetRole(role)}
                className={`flex items-center gap-1.5 px-3 py-2 text-[11px] border-r border-zinc-800/60 last:border-r-0 transition-colors ${
                  isActive
                    ? "bg-zinc-800/60 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isLive
                      ? "bg-blue-400 animate-pulse"
                      : r.status === "done"
                      ? "bg-emerald-400"
                      : r.status === "error"
                      ? "bg-red-400"
                      : "bg-zinc-600"
                  }`}
                />
                {ROLE_LABELS[role]}
                {isLive && r.activity && (
                  <span className="text-[10px] text-blue-400/60 truncate max-w-24">
                    {r.activity}
                  </span>
                )}
                {r.status !== "idle" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      invoke("open_agent_log", { agentId: role }).catch(() => {});
                    }}
                    title="View vault log"
                    className="ml-auto text-zinc-600 hover:text-zinc-400 transition-colors"
                  >
                    <FileText size={10} />
                  </button>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="p-3">
          {roles[activeRole].status === "idle" ? (
            <p className="text-[11px] text-zinc-600 min-h-8 flex items-center">
              {podStep === "verifying" && activeRole === "builder"
                ? "Build gate running…"
                : "Waiting…"}
            </p>
          ) : (
            <pre
              ref={textRef}
              className="text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words overflow-auto max-h-56 min-h-8 leading-relaxed"
            >
              {roles[activeRole].text || (
                <span className="text-zinc-600">
                  {roles[activeRole].status === "running" ? "Starting…" : "No output."}
                </span>
              )}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── TurnDoneCard ──────────────────────────────────────────────────────────────

function TurnDoneCard({
  repoPath,
  commitMsg,
  diff,
  reviewerNote,
  pushed,
  hasCumulativeDiff,
  onPush,
}: {
  repoPath: string;
  commitMsg: string;
  diff: string;
  reviewerNote?: string;
  pushed: boolean;
  hasCumulativeDiff: boolean;
  onPush: () => void;
}) {
  const [pushing, setPushing]     = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [showDiff, setShowDiff]   = useState(false);

  async function handlePush() {
    if (pushed || pushing) return;
    setPushing(true);
    setPushError(null);
    try {
      await invoke("builder_commit_push", { repoPath, commitMessage: commitMsg });
      onPush();
    } catch (e) {
      setPushError(String(e));
    } finally {
      setPushing(false);
    }
  }

  const verdictSummary = reviewerNote
    ? reviewerNote
        .replace(/---REVIEW: PASS---[\s\S]*$/, "")
        .replace(/---REVIEW: FAIL:[\s\S]*$/, "")
        .trim()
        .slice(0, 500) || reviewerNote.slice(0, 500)
    : undefined;

  return (
    <div className="mt-2 border border-emerald-700/40 rounded-lg bg-emerald-950/20 px-4 py-3">
      <div className="flex items-center gap-2 mb-2.5">
        <GitMerge size={12} className="text-emerald-400" />
        <span className="text-xs font-medium text-zinc-200">Build green — ready to push</span>
      </div>

      {hasCumulativeDiff && (
        <div className="mb-2.5 flex items-start gap-1.5 text-[11px] text-amber-400/80 bg-amber-950/20 border border-amber-700/30 rounded px-2 py-1.5">
          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
          <span>Cumulative diff — includes uncommitted changes from a prior turn.</span>
        </div>
      )}

      <p className="text-[11px] font-mono text-zinc-300 bg-zinc-900/60 rounded px-2 py-1.5 mb-2.5 break-all">
        {commitMsg}
      </p>

      {verdictSummary ? (
        <div className="mb-3 border-l-2 border-emerald-700/40 pl-2.5">
          <p className="text-[10px] text-emerald-400 font-medium mb-0.5">Reviewer verdict</p>
          <p className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed">
            {verdictSummary}{verdictSummary.length >= 500 ? "…" : ""}
          </p>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 mb-2.5 italic">
          Reviewer did not emit a verdict (treated as pass).
        </p>
      )}

      {diff && (
        <div className="mb-3">
          <button
            onClick={() => setShowDiff((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors mb-1"
          >
            {showDiff ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {showDiff ? "Hide diff" : "Show diff"}
          </button>
          {showDiff && (
            <pre className="text-[10px] font-mono text-zinc-400 bg-zinc-900/70 rounded p-2 overflow-auto max-h-60 whitespace-pre break-all">
              {diff}
            </pre>
          )}
        </div>
      )}

      {pushError && <p className="text-[11px] text-red-400 mb-2 break-all">{pushError}</p>}

      {pushed ? (
        <span className="flex items-center gap-1 text-xs text-emerald-400">
          <Check size={11} /> Committed and pushed
        </span>
      ) : (
        <button
          onClick={handlePush}
          disabled={pushing}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-700/60 hover:bg-emerald-700 disabled:opacity-50 text-emerald-100 border border-emerald-600/50 transition-colors"
        >
          <GitMerge size={11} />
          {pushing ? "Pushing…" : "Approve & push"}
        </button>
      )}
    </div>
  );
}

// ── TurnNeedsYouCard ──────────────────────────────────────────────────────────

function TurnNeedsYouCard({ text }: { text: string }) {
  return (
    <div className="mt-2 border border-amber-700/40 rounded-lg bg-amber-950/20 px-4 py-3">
      <p className="text-xs font-medium text-amber-300 mb-1.5">Needs your attention</p>
      <p className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
  );
}

// ── UserBubble ────────────────────────────────────────────────────────────────

function UserBubble({ message }: { message: string }) {
  return (
    <div className="flex justify-end">
      <div className="bg-zinc-800/70 border border-zinc-700/40 rounded-2xl rounded-tr-sm px-3 py-2 text-[13px] text-zinc-200 max-w-[85%] whitespace-pre-wrap leading-relaxed">
        {message}
      </div>
    </div>
  );
}

// ── CompletedTurnView ─────────────────────────────────────────────────────────

function CompletedTurnView({
  turn,
  repoPath,
  onPushed,
}: {
  turn: ForgeTurn;
  repoPath: string;
  onPushed: (turnId: string) => void;
}) {
  const [activeRole, setActiveRole] = useState<RoleKey>(turn.activeRole);

  return (
    <div className="space-y-2">
      <UserBubble message={turn.userMessage} />
      <PodRoleTabs
        roles={turn.roleEntries}
        activeRole={activeRole}
        onSetRole={setActiveRole}
      />
      {turn.terminal?.kind === "ready_to_push" && (
        <TurnDoneCard
          repoPath={repoPath}
          commitMsg={turn.terminal.commitMsg}
          diff={turn.terminal.diff}
          reviewerNote={turn.terminal.reviewerNote}
          pushed={turn.pushed}
          hasCumulativeDiff={false}
          onPush={() => onPushed(turn.id)}
        />
      )}
      {turn.terminal?.kind === "needs_you" && (
        <TurnNeedsYouCard text={turn.terminal.text} />
      )}
    </div>
  );
}

// ── ActiveTurnView ────────────────────────────────────────────────────────────

function ActiveTurnView({
  turn,
  textRef,
  onPushed,
}: {
  turn: ActiveTurn;
  textRef: React.RefObject<HTMLPreElement>;
  onPushed: () => void;
}) {
  const [activeRole, setActiveRole] = useState<RoleKey>("planner");

  // Auto-advance tab while the pod is running, respect user's choice when done.
  useEffect(() => {
    if (!turn.running) return;
    const suggested = STEP_ROLE[turn.podStep];
    if (suggested) setActiveRole(suggested);
  }, [turn.podStep, turn.running]);

  return (
    <div className="space-y-2">
      <UserBubble message={turn.userMessage} />
      <PodRoleTabs
        roles={turn.roles}
        activeRole={activeRole}
        onSetRole={setActiveRole}
        textRef={textRef}
        podStep={turn.podStep}
        running={turn.running}
      />
      {turn.terminal?.kind === "ready_to_push" && (
        <TurnDoneCard
          repoPath={turn.repoPath}
          commitMsg={turn.terminal.commitMsg}
          diff={turn.terminal.diff}
          reviewerNote={turn.terminal.reviewerNote}
          pushed={turn.pushed}
          hasCumulativeDiff={turn.hasCumulativeDiff}
          onPush={onPushed}
        />
      )}
      {turn.terminal?.kind === "needs_you" && (
        <TurnNeedsYouCard text={turn.terminal.text} />
      )}
    </div>
  );
}

// ── Forge page ────────────────────────────────────────────────────────────────

export function Forge() {
  const forgeSnapshot = useSyncExternalStore(subscribeForge, getForgeSnapshot);

  const [repoPath, setRepoPath]     = useState(() => loadRecents()[0] ?? FALLBACK_REPO);
  const [recents, setRecents]       = useState<string[]>(() => loadRecents());
  const [showRecents, setShowRecents] = useState(false);
  const [draft, setDraft]           = useState("");
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const threadRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const textAreaRef = useRef<HTMLPreElement>(null);

  const completedTurns = forgeSnapshot.threads[repoPath] ?? [];
  // Filter out the active turn so it doesn't appear twice (it's appended to the
  // store on terminal event while still living in local activeTurn state).
  const displayTurns = activeTurn
    ? completedTurns.filter((t) => t.id !== activeTurn.id)
    : completedTurns;

  const podRunning = activeTurn?.running ?? false;

  // Close recents on outside click.
  useEffect(() => {
    if (!showRecents) return;
    function close(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-recents-anchor]")) setShowRecents(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showRecents]);

  // On repo switch, clear the in-flight active turn (it belongs to the old repo).
  useEffect(() => {
    setActiveTurn(null);
    setLaunchError(null);
  }, [repoPath]);

  // Subscribe to pod events for the currently active pod.
  useEffect(() => {
    const podId = activeTurn?.podId;
    if (!podId) return;
    const subs: Array<() => void> = [];

    listen<PodStreamPayload>("pod-stream", (ev) => {
      const p = ev.payload;
      if (p.podId !== podId) return;

      setActiveTurn((prev) => {
        if (!prev || prev.podId !== podId) return prev;
        const suggestedRole = STEP_ROLE[p.step];

        if (p.kind === "ready_to_push") {
          const terminal: ForgeTurnTerminal = {
            kind: "ready_to_push",
            commitMsg: p.commitMsg ?? "",
            diff: p.diff ?? "",
            reviewerNote: p.reviewerNote,
          };
          const finished: ActiveTurn = { ...prev, podStep: p.step, running: false, terminal };
          // Persist completed turn immediately so it survives a reload.
          appendTurn(prev.repoPath, {
            id: prev.id,
            userMessage: prev.userMessage,
            podId: prev.podId,
            roleEntries: { ...prev.roles },
            activeRole: "reviewer",
            terminal,
            pushed: false,
          });
          return finished;
        }

        if (p.kind === "needs_you") {
          const terminal: ForgeTurnTerminal = { kind: "needs_you", text: p.text };
          const step = p.step === "needs_you" ? prev.podStep : p.step;
          const finished: ActiveTurn = { ...prev, podStep: step, running: false, terminal };
          appendTurn(prev.repoPath, {
            id: prev.id,
            userMessage: prev.userMessage,
            podId: prev.podId,
            roleEntries: { ...prev.roles },
            activeRole: (STEP_ROLE[step] ?? "builder"),
            terminal,
            pushed: false,
          });
          return finished;
        }

        return {
          ...prev,
          podStep: p.step,
          ...(suggestedRole ? {} : {}), // role advance handled in ActiveTurnView
        };
      });
    }).then((u) => subs.push(u));

    listen<AgentStreamPayload>("agent-stream", (ev) => {
      const p = ev.payload;
      if (p.parentRunId !== podId) return;
      const role = p.agentId as RoleKey;
      if (!ROLES.includes(role)) return;

      setActiveTurn((prev) => {
        if (!prev || prev.podId !== podId) return prev;
        const r = prev.roles[role];
        let nextRoles = prev.roles;
        switch (p.kind) {
          case "start":
            nextRoles = { ...prev.roles, [role]: { status: "running" as const, activity: "", text: "" } };
            break;
          case "text":
            nextRoles = { ...prev.roles, [role]: { ...r, text: r.text + p.text, status: "running" as const } };
            break;
          case "activity":
            nextRoles = { ...prev.roles, [role]: { ...r, activity: p.text } };
            break;
          case "done":
            nextRoles = { ...prev.roles, [role]: { ...r, status: "done" as const, activity: "" } };
            break;
          case "error":
          case "timeout":
          case "stopped":
            nextRoles = { ...prev.roles, [role]: { ...r, status: "error" as const, activity: "" } };
            break;
        }
        return { ...prev, roles: nextRoles };
      });
    }).then((u) => subs.push(u));

    return () => subs.forEach((f) => f());
  // Re-subscribe only when a new pod starts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurn?.podId]);

  // Auto-scroll the active role's text pane.
  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  }, [activeTurn?.roles]);

  // Scroll thread to bottom when a new turn starts or a terminal event lands.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (threadRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    });
  }, [completedTurns.length, activeTurn?.id, activeTurn?.terminal]);

  async function handleChooseRepo() {
    const selected = await openDialog({ directory: true, multiple: false, title: "Choose repo folder" });
    if (typeof selected === "string" && selected) {
      setRepoPath(selected);
      setShowRecents(false);
    }
  }

  function pickRecent(path: string) {
    setRepoPath(path);
    setShowRecents(false);
  }

  async function handleSend() {
    const message = draft.trim();
    if (!message || !repoPath.trim() || podRunning) return;

    const path = repoPath.trim();
    saveRecent(path);
    setRecents(loadRecents());
    setDraft("");
    setLaunchError(null);

    // Detect cumulative diff: last completed turn is ready_to_push but not yet pushed.
    const repoTurns = forgeSnapshot.threads[path] ?? [];
    const lastTurn  = repoTurns[repoTurns.length - 1];
    const hasCumulativeDiff =
      lastTurn?.terminal?.kind === "ready_to_push" && !lastTurn.pushed;

    const context = buildContext(repoTurns, hasCumulativeDiff);

    const turnId: string = newTurnId();
    const newTurn: ActiveTurn = {
      id: turnId,
      userMessage: message,
      podId: "", // filled in after invoke
      repoPath: path,
      roles: emptyRoles(),
      podStep: "planning",
      running: true,
      terminal: null,
      pushed: false,
      hasCumulativeDiff,
    };
    setActiveTurn(newTurn);

    try {
      const podId = await invoke<string>("run_pod", {
        repoPath: path,
        task: message,
        context: context ?? null,
      });
      setActiveTurn((prev) => (prev?.id === turnId ? { ...prev, podId } : prev));
    } catch (e) {
      setLaunchError(String(e));
      setActiveTurn((prev) =>
        prev?.id === turnId ? { ...prev, running: false } : prev
      );
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handlePushed(turnId: string) {
    markPushed(repoPath, turnId);
    setActiveTurn((prev) => (prev?.id === turnId ? { ...prev, pushed: true } : prev));
  }

  const hasThread = displayTurns.length > 0 || activeTurn !== null;

  return (
    <div className="flex flex-col h-full bg-zinc-950 overflow-hidden">
      {/* ── Header + repo picker ─────────────────────────────────────── */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-zinc-800">
        <div className="mb-3">
          <h1 className="text-sm font-semibold text-zinc-100 leading-none">Forge</h1>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Planner → Builder → Gate → Reviewer
          </p>
        </div>

        {/* Repo picker */}
        <div className="flex gap-1.5 items-stretch">
          <input
            value={repoPath}
            onChange={(e) => { setRepoPath(e.target.value); setShowRecents(false); }}
            disabled={podRunning}
            placeholder="/path/to/repo"
            className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 transition-colors font-mono"
          />
          {recents.length > 0 && (
            <div className="relative" data-recents-anchor>
              <button
                onClick={() => setShowRecents((v) => !v)}
                disabled={podRunning}
                title="Recent repos"
                className="h-full px-2 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center"
              >
                <ChevronDown size={13} />
              </button>
              {showRecents && (
                <div className="absolute top-full mt-1 right-0 z-20 w-72 bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl py-1 overflow-hidden">
                  {recents.map((p) => (
                    <button
                      key={p}
                      onClick={() => pickRecent(p)}
                      className={`w-full text-left px-3 py-1.5 text-[11px] font-mono truncate transition-colors ${
                        p === repoPath
                          ? "text-zinc-100 bg-zinc-800"
                          : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleChooseRepo}
            disabled={podRunning}
            title="Choose repo folder"
            className="px-2.5 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center gap-1.5 text-xs whitespace-nowrap"
          >
            <FolderOpen size={13} />
            Browse
          </button>
        </div>
      </div>

      {/* ── Thread scroll area ───────────────────────────────────────── */}
      <div
        ref={threadRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-6"
      >
        {!hasThread ? (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
              <Zap size={16} className="text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">No thread yet</p>
            <p className="text-xs text-zinc-600 mt-1">Type a task below and press Enter to kick off a pod</p>
          </div>
        ) : (
          <>
            {displayTurns.map((turn) => (
              <CompletedTurnView
                key={turn.id}
                turn={turn}
                repoPath={repoPath}
                onPushed={handlePushed}
              />
            ))}
            {activeTurn && (
              <ActiveTurnView
                turn={activeTurn}
                textRef={textAreaRef}
                onPushed={() => handlePushed(activeTurn.id)}
              />
            )}
          </>
        )}

        {launchError && (
          <p className="text-[11px] text-red-400 px-1">{launchError}</p>
        )}
      </div>

      {/* ── Message input ────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-zinc-800 px-5 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={podRunning}
            placeholder={
              podRunning
                ? "Pod is running…"
                : "Describe what to build… (Enter to send, Shift+Enter for newline)"
            }
            rows={2}
            className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none transition-colors"
          />
          <button
            onClick={() => void handleSend()}
            disabled={podRunning || !draft.trim() || !repoPath.trim()}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-zinc-700 whitespace-nowrap"
          >
            {podRunning
              ? <Loader size={12} className="animate-spin" />
              : <Send size={12} />}
            {podRunning ? "Running…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
