// ── useRelayManager (R2 multi-pane manager) ────────────────────────────────
// The imperative SHELL around the pure relayReducer. It owns the async I/O the
// reducer can't: invoke('dispatch_run'), invoke('kill_run'), and the deferred
// queue-drain. The reducer decides WHAT to do (emitting `commands`); this hook
// just executes those commands and reports results back via dispatch().
//
// Because useReducer's `dispatch` is referentially stable, every callback this
// hook hands out (registerPane, notifyFinished, …) is stable too — which is the
// whole point: the old code mirrored relayMap/dispatch/pending/workspace into
// refs purely to dodge stale closures. Those mirrors are gone. The ONE ref that
// remains, `latestState`, is not a stale-closure patch — it is the sanctioned
// "re-check current state on async resolve" mechanism for the orphaned-run
// guard (a run dispatched for a pane that vanished mid-flight must be killed).

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RepoPath, RunRecord, WorkspaceEntry } from "../../types";
import {
  relayReducer,
  initRelayState,
  type PaneRelaySlice,
  type RelayState,
} from "./relayReducer";

export type { PaneRelaySlice } from "./relayReducer";

// ── Context shapes (FROZEN — consumers TerminalPane/ExecutorRelayPane/AllBusyModal
// read these verbatim). Defined here so DockArea can build the providers. ────
export interface RelaySendCtx {
  busy: boolean; // always false in R2 — modals handle the all-busy case
  send: (prompt: string, projectSlug: string | null) => void;
}

export interface RelayManagerCtx {
  relayMap: Record<string, PaneRelaySlice>;
  registerPane: (paneId: string) => void;
  unregisterPane: (paneId: string) => void;
  notifyFinished: (paneId: string, finalStatus: string) => void;
  killRunForPane: (paneId: string) => void;
}

export interface RelayManager {
  relayMap: Record<string, PaneRelaySlice>;
  noPaneModal: RelayState["noPaneModal"];
  allBusyModal: RelayState["allBusyModal"];
  orphans: RelayState["orphans"];
  relaySendCtx: RelaySendCtx;
  relayManagerCtx: RelayManagerCtx;
  // Imperative handlers for DockArea's render / dockview glue (all stable):
  sendPrompt: (prompt: string, slug: string | null) => void;
  registerPendingDispatch: (paneId: string, prompt: string, slug: string | null) => void;
  closeNoPaneModal: () => void;
  closeAllBusyModal: () => void;
  queueBehindPane: (paneId: string, prompt: string) => void;
  dismissOrphan: (id: string) => void;
}

export function useRelayManager(workspace: WorkspaceEntry): RelayManager {
  const [state, dispatch] = useReducer(relayReducer, workspace.project_slug ?? null, initRelayState);

  // Latest committed state, for async re-checks in the shell (invariant: a run
  // dispatched for a pane that was removed mid-flight gets killed). NOT a
  // stale-closure mirror of reducer logic — only read inside async resolves.
  const latestState = useRef(state);
  useEffect(() => { latestState.current = state; }, [state]);

  // Keep the machine's default slug in sync with the active workspace.
  useEffect(() => {
    dispatch({ type: "config", defaultSlug: workspace.project_slug ?? null });
  }, [workspace.project_slug]);

  // Perform a dispatch_run, re-checking pane existence BEFORE and AFTER the
  // async call (the orphaned-run guard). Mirrors the old dispatchToPaneInternal.
  const runDispatch = useCallback(async (paneId: string, prompt: string, slug: string | null) => {
    const effectiveSlug = slug ?? latestState.current.defaultSlug;
    let projectPath = "";
    if (effectiveSlug) {
      try {
        const paths = await invoke<RepoPath[]>("get_project_paths", { slug: effectiveSlug });
        projectPath = paths[0]?.path ?? "";
      } catch { /* ignore */ }
    }
    if (!projectPath) return;
    if (!latestState.current.panes[paneId]) return; // pane removed before dispatch
    try {
      const rec = await invoke<RunRecord>("dispatch_run", {
        projectPath,
        prompt,
        useWorktree: true,
        permissionMode: "acceptEdits",
      });
      if (!latestState.current.panes[paneId]) {
        // Pane removed while dispatch was in flight — kill the orphaned run.
        invoke("kill_run", { runId: rec.runId }).catch(() => {});
        return;
      }
      dispatch({ type: "running", paneId, runId: rec.runId, slug });
    } catch (err) {
      console.error("[relay] dispatch_run failed:", err);
    }
  }, [dispatch]);

  // Execute side-effect commands the reducer emitted, then ack them so they run
  // exactly once. Processing never enqueues new commands synchronously, so the
  // ack-by-id keeps this loop convergent.
  useEffect(() => {
    if (state.commands.length === 0) return;
    const ids: number[] = [];
    for (const cmd of state.commands) {
      ids.push(cmd.id);
      if (cmd.kind === "kill") {
        if (cmd.log) {
          invoke("kill_run", { runId: cmd.runId }).catch(err => console.error("[relay] kill_run failed:", err));
        } else {
          invoke("kill_run", { runId: cmd.runId }).catch(() => {});
        }
      } else {
        const go = () => runDispatch(cmd.paneId, cmd.prompt, cmd.slug);
        // Deferred drain: macrotask so React commits the idle+dequeue first.
        if (cmd.deferred) setTimeout(go, 0);
        else go();
      }
    }
    dispatch({ type: "commandsDone", ids });
  }, [state.commands, runDispatch]);

  // ── Stable callbacks (dispatch is referentially stable) ───────────────────
  const registerPane = useCallback((paneId: string) => dispatch({ type: "register", paneId }), []);
  const unregisterPane = useCallback((paneId: string) => dispatch({ type: "unregister", paneId }), []);
  const notifyFinished = useCallback((paneId: string, finalStatus: string) => dispatch({ type: "finished", paneId, finalStatus }), []);
  const killRunForPane = useCallback((paneId: string) => dispatch({ type: "killPane", paneId }), []);
  const sendPrompt = useCallback((prompt: string, slug: string | null) => dispatch({ type: "send", prompt, slug }), []);
  const registerPendingDispatch = useCallback((paneId: string, prompt: string, slug: string | null) => dispatch({ type: "setPending", paneId, prompt, slug }), []);
  const closeNoPaneModal = useCallback(() => dispatch({ type: "closeNoPaneModal" }), []);
  const closeAllBusyModal = useCallback(() => dispatch({ type: "closeAllBusyModal" }), []);
  const queueBehindPane = useCallback((paneId: string, prompt: string) => dispatch({ type: "queue", paneId, prompt }), []);
  const dismissOrphan = useCallback((id: string) => dispatch({ type: "dismissOrphan", id }), []);

  const relaySendCtx = useMemo<RelaySendCtx>(() => ({ busy: false, send: sendPrompt }), [sendPrompt]);
  const relayManagerCtx = useMemo<RelayManagerCtx>(() => ({
    relayMap: state.panes,
    registerPane,
    unregisterPane,
    notifyFinished,
    killRunForPane,
  }), [state.panes, registerPane, unregisterPane, notifyFinished, killRunForPane]);

  return {
    relayMap: state.panes,
    noPaneModal: state.noPaneModal,
    allBusyModal: state.allBusyModal,
    orphans: state.orphans,
    relaySendCtx,
    relayManagerCtx,
    sendPrompt,
    registerPendingDispatch,
    closeNoPaneModal,
    closeAllBusyModal,
    queueBehindPane,
    dismissOrphan,
  };
}
