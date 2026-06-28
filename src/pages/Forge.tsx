import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Check, ChevronDown, ChevronRight, FolderOpen, GitMerge, Loader, Play, RotateCcw, FileText,
} from "lucide-react";

// ── Recent repos ──────────────────────────────────────────────────────────────

const RECENTS_KEY = "forge:recentRepos";
const MAX_RECENTS = 5;

function loadRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecent(path: string) {
  const prev = loadRecents().filter((p) => p !== path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([path, ...prev].slice(0, MAX_RECENTS)));
}

const FALLBACK_REPO = "/Users/connordore/Desktop/antfarm-write-test";

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

type RoleKey = "planner" | "builder" | "reviewer";

interface RoleState {
  status: "idle" | "running" | "done" | "error";
  activity: string;
  text: string;
}

interface PodReadyState {
  commitMsg: string;
  diff: string;
  reviewerNote?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROLES: RoleKey[] = ["planner", "builder", "reviewer"];

const ROLE_LABELS: Record<RoleKey, string> = {
  planner: "Planner",
  builder: "Builder",
  reviewer: "Reviewer",
};

const STEP_LABEL: Record<string, string> = {
  planning:     "Planning the change…",
  building:     "Writing the code…",
  verifying:    "Checking it builds…",
  reviewing:    "Reviewing the logic…",
  ready_to_push:"Done and safe — ready to publish.",
  needs_you:    "Needs your attention.",
};

// Which role tab to auto-focus when the pod enters a given step.
const STEP_ROLE: Partial<Record<string, RoleKey>> = {
  planning:  "planner",
  building:  "builder",
  reviewing: "reviewer",
};

function emptyRoles(): Record<RoleKey, RoleState> {
  return {
    planner:  { status: "idle", activity: "", text: "" },
    builder:  { status: "idle", activity: "", text: "" },
    reviewer: { status: "idle", activity: "", text: "" },
  };
}

// ── PodDoneCard ───────────────────────────────────────────────────────────────

function PodDoneCard({
  repoPath, commitMsg, diff, reviewerNote, onDismiss,
}: {
  repoPath: string;
  commitMsg: string;
  diff: string;
  reviewerNote?: string;
  onDismiss: () => void;
}) {
  const [pushing, setPushing]   = useState(false);
  const [pushed, setPushed]     = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  async function handlePush() {
    setPushing(true);
    setPushError(null);
    try {
      await invoke("builder_commit_push", { repoPath, commitMessage: commitMsg });
      setPushed(true);
    } catch (e) {
      setPushError(String(e));
    } finally {
      setPushing(false);
    }
  }

  // Extract the reviewer's readable summary: text before the verdict marker line.
  const verdictSummary = reviewerNote
    ? reviewerNote
        .replace(/---REVIEW: PASS---[\s\S]*$/, "")
        .replace(/---REVIEW: FAIL:[\s\S]*$/, "")
        .trim()
        .slice(0, 500) || reviewerNote.slice(0, 500)
    : undefined;

  return (
    <div className="mt-4 border border-emerald-700/40 rounded-lg bg-emerald-950/20 px-4 py-3">
      <div className="flex items-center gap-2 mb-2.5">
        <GitMerge size={12} className="text-emerald-400" />
        <span className="text-xs font-medium text-zinc-200">Build green — ready to push</span>
      </div>

      {/* Commit message */}
      <p className="text-[11px] font-mono text-zinc-300 bg-zinc-900/60 rounded px-2 py-1.5 mb-2.5 break-all">
        {commitMsg}
      </p>

      {/* Reviewer verdict */}
      {verdictSummary ? (
        <div className="mb-3 border-l-2 border-emerald-700/40 pl-2.5">
          <p className="text-[10px] text-emerald-400 font-medium mb-0.5">Reviewer verdict</p>
          <p className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed">
            {verdictSummary}{verdictSummary.length >= 500 ? "…" : ""}
          </p>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 mb-2.5 italic">Reviewer did not emit a verdict (treated as pass).</p>
      )}

      {/* Diff toggle */}
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
            <pre className="text-[10px] font-mono text-zinc-400 bg-zinc-900/70 rounded p-2 overflow-auto max-h-72 whitespace-pre break-all">
              {diff}
            </pre>
          )}
        </div>
      )}

      {pushError && <p className="text-[11px] text-red-400 mb-2 break-all">{pushError}</p>}

      <div className="flex gap-2 flex-wrap items-center">
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

// ── Forge page ────────────────────────────────────────────────────────────────

export function Forge() {
  const [repoPath, setRepoPath]   = useState(() => loadRecents()[0] ?? FALLBACK_REPO);
  const [task, setTask]           = useState("");
  const [podId, setPodId]         = useState<string | null>(null);
  const [podStep, setPodStep]     = useState("");
  const [roles, setRoles]         = useState<Record<RoleKey, RoleState>>(emptyRoles());
  const [activeRole, setActiveRole] = useState<RoleKey>("planner");
  const [readyState, setReadyState] = useState<PodReadyState | null>(null);
  const [needsYou, setNeedsYou]   = useState<string | null>(null);
  const [running, setRunning]     = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [recents, setRecents]     = useState<string[]>(() => loadRecents());
  const [showRecents, setShowRecents] = useState(false);
  const textAreaRef = useRef<HTMLPreElement>(null);

  // Close recents dropdown on outside click.
  useEffect(() => {
    if (!showRecents) return;
    function close(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-recents-anchor]")) setShowRecents(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showRecents]);

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

  // Subscribe to pod-stream + agent-stream events for the active pod.
  useEffect(() => {
    if (!podId) return;
    const subs: Array<() => void> = [];

    listen<PodStreamPayload>("pod-stream", (ev) => {
      const p = ev.payload;
      if (p.podId !== podId) return;
      setPodStep(p.step);

      const impliedRole = STEP_ROLE[p.step];
      if (impliedRole) setActiveRole(impliedRole);

      if (p.kind === "ready_to_push") {
        setReadyState({ commitMsg: p.commitMsg ?? "", diff: p.diff ?? "", reviewerNote: p.reviewerNote });
        setRunning(false);
      } else if (p.kind === "needs_you") {
        setNeedsYou(p.text);
        setRunning(false);
      }
    }).then((u) => subs.push(u));

    listen<AgentStreamPayload>("agent-stream", (ev) => {
      const p = ev.payload;
      if (p.parentRunId !== podId) return;
      const role = p.agentId as RoleKey;
      if (!ROLES.includes(role)) return;

      setRoles((prev) => {
        const r = prev[role];
        switch (p.kind) {
          case "start":
            // New run for this role — reset so re-runs (builder round 2+) start fresh.
            return { ...prev, [role]: { status: "running", activity: "", text: "" } };
          case "text":
            return { ...prev, [role]: { ...r, text: r.text + p.text, status: "running" } };
          case "activity":
            return { ...prev, [role]: { ...r, activity: p.text } };
          case "done":
            return { ...prev, [role]: { ...r, status: "done", activity: "" } };
          case "error":
          case "timeout":
          case "stopped":
            return { ...prev, [role]: { ...r, status: "error", activity: "" } };
          default:
            return prev;
        }
      });
    }).then((u) => subs.push(u));

    return () => subs.forEach((f) => f());
  }, [podId]);

  // Auto-scroll the text area when new content arrives for the active role.
  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles[activeRole].text]);

  async function handleRun() {
    if (!task.trim() || !repoPath.trim() || running) return;
    const path = repoPath.trim();
    saveRecent(path);
    setRecents(loadRecents());
    setLaunchError(null);
    setReadyState(null);
    setNeedsYou(null);
    setPodStep("planning");
    setRoles(emptyRoles());
    setActiveRole("planner");
    setRunning(true);
    try {
      const id = await invoke<string>("run_pod", { repoPath: path, task: task.trim() });
      setPodId(id);
    } catch (e) {
      setLaunchError(String(e));
      setRunning(false);
    }
  }

  const hasActivity = podId !== null;
  const stepLabel   = STEP_LABEL[podStep] ?? "";

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Forge</h1>
        <p className="text-xs text-zinc-500 mt-0.5">
          Coding crew — Planner → Builder → Gate → Reviewer
        </p>
      </div>

      {/* Launch form */}
      <div className="space-y-3 border border-zinc-800/60 rounded-lg p-4">
        <div>
          <label className="block text-[11px] text-zinc-500 mb-1">Repo</label>
          <div className="flex gap-1.5 items-stretch">
            {/* Editable path field */}
            <input
              value={repoPath}
              onChange={(e) => { setRepoPath(e.target.value); setShowRecents(false); }}
              disabled={running}
              placeholder="/path/to/repo"
              className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 transition-colors font-mono"
            />
            {/* Recent repos dropdown toggle */}
            {recents.length > 0 && (
              <div className="relative" data-recents-anchor>
                <button
                  onClick={() => setShowRecents((v) => !v)}
                  disabled={running}
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
            {/* Native folder picker */}
            <button
              onClick={handleChooseRepo}
              disabled={running}
              title="Choose repo folder"
              className="px-2.5 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center gap-1.5 text-xs whitespace-nowrap"
            >
              <FolderOpen size={13} />
              Browse
            </button>
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-zinc-500 mb-1">Task</label>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={running}
            rows={3}
            placeholder="Describe what to build…"
            className="w-full bg-zinc-900/60 border border-zinc-700/50 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none transition-colors"
          />
        </div>
        {launchError && (
          <p className="text-[11px] text-red-400">{launchError}</p>
        )}
        <button
          onClick={handleRun}
          disabled={running || !task.trim() || !repoPath.trim()}
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-blue-700/70 hover:bg-blue-700 disabled:opacity-40 text-white border border-blue-600/50 transition-colors"
        >
          {running
            ? <Loader size={13} className="animate-spin" />
            : <Play size={13} />}
          {running ? "Pod running…" : "Run Forge pod"}
        </button>
      </div>

      {/* Pod activity */}
      {hasActivity && (
        <div className="space-y-3">
          {/* Plain-English roll-up */}
          {stepLabel && (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              {running && (
                <Loader size={11} className="animate-spin text-blue-400 shrink-0" />
              )}
              <span>{stepLabel}</span>
            </div>
          )}

          {/* Role tabs */}
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
                    onClick={() => setActiveRole(role)}
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
                      <span className="text-[10px] text-blue-400/60 truncate max-w-28">
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
                  ref={textAreaRef}
                  className="text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words overflow-auto max-h-72 min-h-8 leading-relaxed"
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

          {/* Ready to push card */}
          {readyState && (
            <PodDoneCard
              repoPath={repoPath}
              commitMsg={readyState.commitMsg}
              diff={readyState.diff}
              reviewerNote={readyState.reviewerNote}
              onDismiss={() => {
                setReadyState(null);
                setPodId(null);
                setPodStep("");
                // roles intentionally kept — user can still read the trace
              }}
            />
          )}

          {/* Needs-you escalation */}
          {needsYou && (
            <div className="border border-amber-700/40 rounded-lg bg-amber-950/20 px-4 py-3">
              <p className="text-xs font-medium text-amber-300 mb-1.5">Needs your attention</p>
              <p className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed">
                {needsYou}
              </p>
              <button
                onClick={() => {
                  setNeedsYou(null);
                  setPodId(null);
                  setPodStep("");
                  // roles intentionally kept — user can still read the trace
                }}
                className="mt-2.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* New run button — shown after pod finishes (running=false, no active cards) */}
          {!running && !readyState && !needsYou && (
            <button
              onClick={() => {
                setRoles(emptyRoles());
                setPodId(null);
                setPodStep("");
              }}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RotateCcw size={11} />
              New run
            </button>
          )}
        </div>
      )}
    </div>
  );
}
