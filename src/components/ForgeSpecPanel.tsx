// Spec-mode UI components for the Forge page.
// SpecRunView, SpecItemRow, SpecDoneCard — used by Forge.tsx.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  GitMerge,
  Loader,
  XCircle,
} from "lucide-react";
import {
  type PodRoleKey,
  type PodRoleState,
  POD_STEP_ROLE,
  emptyPodRoles,
  PodRoleTabs,
} from "./ForgePodPanel";
import { type SpecRunRecord } from "../lib/forgeThreadStore";

// ── Exported types ─────────────────────────────────────────────────────────────

export interface SpecItemLive {
  index: number;
  text: string;
  status: "pending" | "building" | "done" | "flagged";
  commitHash?: string;
  flagReason?: string;
  roles: Record<PodRoleKey, PodRoleState>;
  podStep: string;
  podRunning: boolean;
  expanded: boolean;
}

export interface ActiveSpecRun {
  specId: string;
  repoPath: string;
  scope: string;
  phase: "decomposing" | "running" | "done" | "error";
  items: SpecItemLive[];
  gitLog?: string;
  diff?: string;
  pushed: boolean;
  errorText?: string;
}

export { emptyPodRoles };
export { POD_STEP_ROLE };

// ── SpecItemRow ────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: SpecItemLive["status"] }) {
  switch (status) {
    case "pending":
      return <Circle size={13} className="text-zinc-600 shrink-0" />;
    case "building":
      return <Loader size={13} className="text-blue-400 animate-spin shrink-0" />;
    case "done":
      return <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />;
    case "flagged":
      return <XCircle size={13} className="text-amber-400 shrink-0" />;
  }
}

export function SpecItemRow({
  item,
  onToggle,
  textRef,
}: {
  item: SpecItemLive;
  onToggle: (index: number) => void;
  textRef?: React.RefObject<HTMLPreElement>;
}) {
  const [activeRole, setActiveRole] = useState<PodRoleKey>("planner");

  // Auto-advance tab while the pod is building this item.
  const suggestedRole = POD_STEP_ROLE[item.podStep];

  return (
    <div className="border border-zinc-800/50 rounded-lg overflow-hidden">
      {/* Row header */}
      <button
        onClick={() => onToggle(item.index)}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-zinc-900/40 transition-colors text-left"
      >
        <span className="mt-0.5">
          <StatusChip status={item.status} />
        </span>
        <span className="flex-1 text-[12px] text-zinc-200 leading-snug">{item.text}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {item.status === "done" && item.commitHash && (
            <span className="text-[10px] font-mono text-emerald-500/70">{item.commitHash}</span>
          )}
          {(item.status === "building" || item.status === "done" || item.status === "flagged") && (
            item.expanded
              ? <ChevronDown size={12} className="text-zinc-500" />
              : <ChevronRight size={12} className="text-zinc-500" />
          )}
        </span>
      </button>

      {/* Expanded pod view */}
      {item.expanded && (
        <div className="border-t border-zinc-800/50 px-3 py-3 bg-zinc-900/20">
          {item.status === "flagged" && item.flagReason && (
            <div className="mb-2.5 flex items-start gap-1.5 text-[11px] text-amber-400/80 bg-amber-950/20 border border-amber-700/30 rounded px-2 py-1.5">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span className="whitespace-pre-wrap">{item.flagReason}</span>
            </div>
          )}
          {(item.status === "building" || item.status === "done") && (
            <PodRoleTabs
              roles={item.roles}
              activeRole={suggestedRole && item.podRunning ? suggestedRole : activeRole}
              onSetRole={setActiveRole}
              textRef={textRef}
              podStep={item.podStep}
              running={item.podRunning}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── SpecDoneCard ───────────────────────────────────────────────────────────────

export function SpecDoneCard({
  run,
  onPushed,
  onDiscard,
}: {
  run: ActiveSpecRun;
  onPushed: () => void;
  onDiscard: () => void;
}) {
  const [pushing, setPushing]   = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const doneCount    = run.items.filter((i) => i.status === "done").length;
  const flaggedCount = run.items.filter((i) => i.status === "flagged").length;
  const flaggedItems = run.items.filter((i) => i.status === "flagged");

  async function handlePush() {
    if (run.pushed || pushing) return;
    setPushing(true);
    setPushError(null);
    try {
      await invoke("git_push", { repoPath: run.repoPath });
      onPushed();
    } catch (e) {
      setPushError(String(e));
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="mt-3 border border-emerald-700/40 rounded-lg bg-emerald-950/20 px-4 py-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <GitMerge size={13} className="text-emerald-400" />
        <span className="text-xs font-semibold text-zinc-200">
          Spec complete — {doneCount} done{flaggedCount > 0 ? `, ${flaggedCount} flagged` : ""}
        </span>
      </div>

      {/* Local commits */}
      {run.gitLog && (
        <div>
          <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wide mb-1.5">
            Local commits
          </p>
          <pre className="text-[11px] font-mono text-zinc-300 bg-zinc-900/60 rounded px-2 py-1.5 whitespace-pre-wrap break-all leading-relaxed">
            {run.gitLog.trim()}
          </pre>
        </div>
      )}

      {/* Full diff */}
      {run.diff && (
        <div>
          <button
            onClick={() => setShowDiff((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showDiff ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {showDiff ? "Hide full diff" : "Show full diff"}
          </button>
          {showDiff && (
            <pre className="mt-1.5 text-[10px] font-mono text-zinc-400 bg-zinc-900/70 rounded p-2 overflow-auto max-h-72 whitespace-pre break-all">
              {run.diff}
            </pre>
          )}
        </div>
      )}

      {/* Flagged items */}
      {flaggedItems.length > 0 && (
        <div>
          <p className="text-[10px] text-amber-400 font-medium uppercase tracking-wide mb-1.5">
            Flagged items — review manually
          </p>
          <div className="space-y-1.5">
            {flaggedItems.map((item) => (
              <div key={item.index} className="bg-amber-950/20 border border-amber-700/30 rounded px-2.5 py-1.5">
                <p className="text-[11px] text-zinc-300">{item.text}</p>
                {item.flagReason && (
                  <p className="text-[10px] text-amber-400/80 mt-0.5 whitespace-pre-wrap">
                    {item.flagReason}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {pushError && (
        <p className="text-[11px] text-red-400 break-all">{pushError}</p>
      )}

      {/* Actions */}
      {run.pushed ? (
        <span className="flex items-center gap-1.5 text-xs text-emerald-400">
          <Check size={12} /> All commits pushed
        </span>
      ) : (
        <div className="flex items-center gap-3">
          <button
            onClick={handlePush}
            disabled={pushing}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-700/60 hover:bg-emerald-700 disabled:opacity-50 text-emerald-100 border border-emerald-600/50 transition-colors"
          >
            <GitMerge size={11} />
            {pushing ? "Pushing…" : "Approve & push all"}
          </button>
          <button
            onClick={onDiscard}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Leave local
          </button>
        </div>
      )}
    </div>
  );
}

// ── SpecRunView ────────────────────────────────────────────────────────────────

export function SpecRunView({
  run,
  textRef,
  onToggleItem,
  onPushed,
  onDiscard,
}: {
  run: ActiveSpecRun;
  textRef?: React.RefObject<HTMLPreElement>;
  onToggleItem: (index: number) => void;
  onPushed: () => void;
  onDiscard: () => void;
}) {
  const buildingCount = run.items.filter((i) => i.status === "building").length;
  const doneCount     = run.items.filter((i) => i.status === "done").length;

  return (
    <div className="space-y-2">
      {/* Scope bubble */}
      <div className="flex justify-end">
        <div className="bg-zinc-800/70 border border-zinc-700/40 rounded-2xl rounded-tr-sm px-3 py-2 text-[13px] text-zinc-200 max-w-[85%] whitespace-pre-wrap leading-relaxed">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Spec scope</span>
          {run.scope}
        </div>
      </div>

      {/* Phase header */}
      <div className="flex items-center gap-2 text-[11px] text-zinc-500 px-0.5">
        {run.phase === "decomposing" && (
          <>
            <Loader size={10} className="animate-spin text-blue-400" />
            <span>Decomposing scope into tasks…</span>
          </>
        )}
        {run.phase === "running" && (
          <>
            {buildingCount > 0 && <Loader size={10} className="animate-spin text-blue-400" />}
            <span>
              {doneCount} / {run.items.length} done
            </span>
          </>
        )}
        {run.phase === "done" && (
          <>
            <Check size={10} className="text-emerald-400" />
            <span>Spec run complete</span>
          </>
        )}
        {run.phase === "error" && (
          <>
            <AlertTriangle size={10} className="text-amber-400" />
            <span>{run.errorText ?? "Spec run failed"}</span>
          </>
        )}
      </div>

      {/* Checklist */}
      {run.items.length > 0 && (
        <div className="space-y-1.5">
          {run.items.map((item) => (
            <SpecItemRow
              key={item.index}
              item={item}
              onToggle={onToggleItem}
              textRef={textRef}
            />
          ))}
        </div>
      )}

      {/* Final review card */}
      {run.phase === "done" && (
        <SpecDoneCard run={run} onPushed={onPushed} onDiscard={onDiscard} />
      )}
    </div>
  );
}

// ── SpecRunSummary (completed, persisted) ──────────────────────────────────────

export function SpecRunSummary({ run }: { run: SpecRunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const doneCount    = run.items.filter((i) => i.status === "done").length;
  const flaggedCount = run.items.filter((i) => i.status === "flagged").length;

  return (
    <div className="border border-zinc-800/50 rounded-lg bg-zinc-900/30 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-zinc-800/30 transition-colors"
      >
        <GitMerge size={11} className={run.pushed ? "text-emerald-400" : "text-zinc-500"} />
        <span className="flex-1 text-[11px] text-zinc-400 truncate">{run.scope}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">
          {doneCount}✓{flaggedCount > 0 ? ` ${flaggedCount}⚠` : ""}{run.pushed ? " · pushed" : ""}
        </span>
        {expanded ? <ChevronDown size={11} className="text-zinc-600" /> : <ChevronRight size={11} className="text-zinc-600" />}
      </button>
      {expanded && (
        <div className="border-t border-zinc-800/40 px-3 py-2.5 space-y-1.5">
          {run.items.map((item) => (
            <div key={item.index} className="flex items-start gap-2 text-[11px]">
              {item.status === "done"
                ? <CheckCircle2 size={11} className="text-emerald-400 shrink-0 mt-0.5" />
                : <XCircle size={11} className="text-amber-400 shrink-0 mt-0.5" />}
              <span className="text-zinc-400">{item.text}</span>
              {item.commitHash && (
                <span className="font-mono text-zinc-600 text-[10px] shrink-0">{item.commitHash}</span>
              )}
            </div>
          ))}
          {run.gitLog && (
            <pre className="mt-1.5 text-[10px] font-mono text-zinc-500 whitespace-pre-wrap break-all">
              {run.gitLog.trim()}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
