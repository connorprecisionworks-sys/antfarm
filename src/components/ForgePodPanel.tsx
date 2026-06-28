// Shared pod UI components used by both Forge.tsx (per-repo thread) and Chat.tsx
// (Jack → Forge inline delegation). Import these; do not duplicate.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, FileText, GitMerge, Loader,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PodRoleKey = "planner" | "builder" | "reviewer";

export interface PodRoleState {
  status: "idle" | "running" | "done" | "error";
  activity: string;
  text: string;
}

export interface PodTerminalReady {
  kind: "ready_to_push";
  commitMsg: string;
  diff: string;
  reviewerNote?: string;
}

export interface PodTerminalNeedsYou {
  kind: "needs_you";
  text: string;
}

export type PodTerminal = PodTerminalReady | PodTerminalNeedsYou;

// ── Constants ─────────────────────────────────────────────────────────────────

export const POD_ROLES: PodRoleKey[] = ["planner", "builder", "reviewer"];

export const POD_ROLE_LABELS: Record<PodRoleKey, string> = {
  planner:  "Planner",
  builder:  "Builder",
  reviewer: "Reviewer",
};

export const POD_STEP_LABEL: Record<string, string> = {
  planning:      "Planning the change…",
  building:      "Writing the code…",
  verifying:     "Checking it builds…",
  reviewing:     "Reviewing the logic…",
  ready_to_push: "Done and safe — ready to publish.",
  needs_you:     "Needs your attention.",
};

export const POD_STEP_ROLE: Partial<Record<string, PodRoleKey>> = {
  planning:  "planner",
  building:  "builder",
  reviewing: "reviewer",
};

export function emptyPodRoles(): Record<PodRoleKey, PodRoleState> {
  return {
    planner:  { status: "idle", activity: "", text: "" },
    builder:  { status: "idle", activity: "", text: "" },
    reviewer: { status: "idle", activity: "", text: "" },
  };
}

// ── PodRoleTabs ───────────────────────────────────────────────────────────────

export function PodRoleTabs({
  roles,
  activeRole,
  onSetRole,
  textRef,
  podStep,
  running,
}: {
  roles: Record<PodRoleKey, PodRoleState>;
  activeRole: PodRoleKey;
  onSetRole: (r: PodRoleKey) => void;
  textRef?: React.RefObject<HTMLPreElement>;
  podStep?: string;
  running?: boolean;
}) {
  const stepLabel = POD_STEP_LABEL[podStep ?? ""] ?? "";

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
          {POD_ROLES.map((role) => {
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
                {POD_ROLE_LABELS[role]}
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

// ── PodDoneCard ───────────────────────────────────────────────────────────────

export function PodDoneCard({
  repoPath,
  commitMsg,
  diff,
  reviewerNote,
  pushed,
  hasCumulativeDiff = false,
  onPush,
}: {
  repoPath: string;
  commitMsg: string;
  diff: string;
  reviewerNote?: string;
  pushed: boolean;
  hasCumulativeDiff?: boolean;
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

// ── PodNeedsYouCard ───────────────────────────────────────────────────────────

export function PodNeedsYouCard({ text }: { text: string }) {
  return (
    <div className="mt-2 border border-amber-700/40 rounded-lg bg-amber-950/20 px-4 py-3">
      <p className="text-xs font-medium text-amber-300 mb-1.5">Needs your attention</p>
      <p className="text-[11px] text-zinc-300 whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
  );
}
