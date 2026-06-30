// ── Relay reducer (R2 multi-pane manager) ──────────────────────────────────
// Pure functional core for the executor-relay state machine. Every transition
// here is a pure (state, action) => state function: NO invoke(), NO dockview
// api calls, NO setTimeout. Side effects the shell must perform are emitted as
// `commands` — plain data the imperative shell (useRelayManager) interprets.
//
// This replaces the previous ref-mirror tangle (relayMapRef/dispatchRef/
// pendingDispatchRef/workspaceRef + ExecutorRelayPane's notifyFinishedRef) that
// existed only to dodge stale closures. A stable useReducer dispatch over this
// pure reducer makes that bug class structurally impossible.

// Per-pane relay slice — keyed by Dockview panel id. Shape is FROZEN: the
// RelayManagerContext exposes this verbatim to ExecutorRelayPane / AllBusyModal.
export interface PaneRelaySlice {
  runId: string | null;
  status: string; // "idle" | "running" | "done" | "failed" | "killed"
  queue: string[];
  projectSlug: string | null;
}

export interface PendingDispatch {
  prompt: string;
  slug: string | null;
}

export interface OrphanItem {
  id: string;
  prompt: string;
  slug: string | null;
}

export interface NoPaneModalState {
  prompt: string;
  slug: string | null;
}

export interface AllBusyModalState {
  prompt: string;
  slug: string | null;
  paneIds: string[];
}

// Side-effect intents emitted by the reducer; executed by the shell.
//  - dispatch: invoke('dispatch_run'); `deferred` => run on a setTimeout(…,0)
//    macrotask so React commits the preceding state update first (queue drain).
//  - kill: invoke('kill_run'); `log` => surface failures via console.error
//    (matches the old killRunForPane; orphan/unregister kills stayed silent).
export type RelayCommand =
  | { id: number; kind: "dispatch"; paneId: string; prompt: string; slug: string | null; deferred: boolean }
  | { id: number; kind: "kill"; runId: string; log: boolean };

export interface RelayState {
  // panes ← formerly the `relayMap` useState (+ relayMapRef mirror)
  panes: Record<string, PaneRelaySlice>;
  // pending ← formerly pendingDispatchRef: paneId → prompt+slug to fire on register
  pending: Record<string, PendingDispatch>;
  // orphans ← formerly the `orphanTray` useState
  orphans: OrphanItem[];
  // modal signals the component renders (reducer decides, shell/UI renders)
  noPaneModal: NoPaneModalState | null;
  allBusyModal: AllBusyModalState | null;
  // defaultSlug ← formerly workspaceRef.current.project_slug
  defaultSlug: string | null;
  // outbound side-effect queue for the shell
  commands: RelayCommand[];
  // monotonic counter for command ids + orphan ids (keeps the reducer
  // deterministic — no crypto.randomUUID() inside the pure core)
  seq: number;
}

export type RelayAction =
  // sync the workspace's default project slug into the machine
  | { type: "config"; defaultSlug: string | null }
  // ExecutorRelayPane mounted: ensure a slice exists, drain any pending dispatch
  | { type: "register"; paneId: string }
  // ExecutorRelayPane unmounted: kill a running run, orphan a non-empty queue
  | { type: "unregister"; paneId: string }
  // pre-register a prompt to fire the instant a pane registers (delegate/spawn)
  | { type: "setPending"; paneId: string; prompt: string; slug: string | null }
  // route a prompt: free pane → dispatch / no panes → modal / all busy → modal
  | { type: "send"; prompt: string; slug: string | null }
  // queue a prompt behind a busy pane (AllBusyModal "Queue behind…")
  | { type: "queue"; paneId: string; prompt: string }
  // a run finished: drain the next queued prompt, else settle the final status
  | { type: "finished"; paneId: string; finalStatus: string }
  // a dispatch_run resolved and the pane still exists: mark it running
  | { type: "running"; paneId: string; runId: string; slug: string | null }
  // Kill button: kill this pane's running run
  | { type: "killPane"; paneId: string }
  | { type: "closeNoPaneModal" }
  | { type: "closeAllBusyModal" }
  | { type: "dismissOrphan"; id: string }
  // shell acks processed commands so they aren't run twice
  | { type: "commandsDone"; ids: number[] };

const FREE_STATUSES = ["idle", "done", "failed", "killed"];

export function initRelayState(defaultSlug: string | null): RelayState {
  return {
    panes: {},
    pending: {},
    orphans: [],
    noPaneModal: null,
    allBusyModal: null,
    defaultSlug,
    commands: [],
    seq: 0,
  };
}

export function relayReducer(state: RelayState, action: RelayAction): RelayState {
  switch (action.type) {
    case "config": {
      if (state.defaultSlug === action.defaultSlug) return state;
      return { ...state, defaultSlug: action.defaultSlug };
    }

    case "register": {
      const { paneId } = action;
      let panes = state.panes;
      if (!panes[paneId]) {
        panes = {
          ...panes,
          [paneId]: { runId: null, status: "idle", queue: [], projectSlug: state.defaultSlug },
        };
      }
      // If delegate()/spawnRelayPane pre-registered a dispatch, fire it now.
      const pending = state.pending[paneId];
      if (!pending) {
        return panes === state.panes ? state : { ...state, panes };
      }
      const restPending = { ...state.pending };
      delete restPending[paneId];
      return {
        ...state,
        panes,
        pending: restPending,
        commands: [
          ...state.commands,
          { id: state.seq, kind: "dispatch", paneId, prompt: pending.prompt, slug: pending.slug, deferred: false },
        ],
        seq: state.seq + 1,
      };
    }

    case "unregister": {
      const { paneId } = action;
      const slice = state.panes[paneId];
      if (!slice) return state;

      let seq = state.seq;
      let commands = state.commands;
      // Kill an in-flight run for the vanishing pane.
      if (slice.runId && slice.status === "running") {
        commands = [...commands, { id: seq, kind: "kill", runId: slice.runId, log: false }];
        seq += 1;
      }
      // Orphan any still-queued prompts so the user can re-route them.
      let orphans = state.orphans;
      if (slice.queue.length > 0) {
        orphans = [
          ...orphans,
          ...slice.queue.map((prompt, i) => ({ id: `orphan-${seq + i}`, prompt, slug: slice.projectSlug })),
        ];
        seq += slice.queue.length;
      }

      const panes = { ...state.panes };
      delete panes[paneId];
      return { ...state, panes, orphans, commands, seq };
    }

    case "setPending": {
      return {
        ...state,
        pending: {
          ...state.pending,
          [action.paneId]: { prompt: action.prompt, slug: action.slug },
        },
      };
    }

    case "send": {
      const paneIds = Object.keys(state.panes);
      const freePaneId = paneIds.find(id => FREE_STATUSES.includes(state.panes[id].status));
      if (freePaneId) {
        return {
          ...state,
          commands: [
            ...state.commands,
            { id: state.seq, kind: "dispatch", paneId: freePaneId, prompt: action.prompt, slug: action.slug, deferred: false },
          ],
          seq: state.seq + 1,
        };
      }
      if (paneIds.length === 0) {
        return { ...state, noPaneModal: { prompt: action.prompt, slug: action.slug } };
      }
      return { ...state, allBusyModal: { prompt: action.prompt, slug: action.slug, paneIds } };
    }

    case "queue": {
      const slice = state.panes[action.paneId];
      if (!slice) return state;
      return {
        ...state,
        panes: { ...state.panes, [action.paneId]: { ...slice, queue: [...slice.queue, action.prompt] } },
      };
    }

    case "finished": {
      const slice = state.panes[action.paneId];
      if (!slice) return state;
      if (slice.queue.length > 0) {
        const [next, ...rest] = slice.queue;
        return {
          ...state,
          panes: { ...state.panes, [action.paneId]: { ...slice, status: "idle", queue: rest } },
          // Deferred so React commits the idle+dequeue before the next dispatch.
          commands: [
            ...state.commands,
            { id: state.seq, kind: "dispatch", paneId: action.paneId, prompt: next, slug: slice.projectSlug, deferred: true },
          ],
          seq: state.seq + 1,
        };
      }
      return {
        ...state,
        panes: { ...state.panes, [action.paneId]: { ...slice, status: action.finalStatus } },
      };
    }

    case "running": {
      const base = state.panes[action.paneId] ?? { runId: null, status: "idle", queue: [], projectSlug: action.slug };
      return {
        ...state,
        panes: { ...state.panes, [action.paneId]: { ...base, runId: action.runId, status: "running" } },
      };
    }

    case "killPane": {
      const slice = state.panes[action.paneId];
      if (!slice?.runId) return state;
      return {
        ...state,
        commands: [...state.commands, { id: state.seq, kind: "kill", runId: slice.runId, log: true }],
        seq: state.seq + 1,
      };
    }

    case "closeNoPaneModal": {
      if (!state.noPaneModal) return state;
      return { ...state, noPaneModal: null };
    }

    case "closeAllBusyModal": {
      if (!state.allBusyModal) return state;
      return { ...state, allBusyModal: null };
    }

    case "dismissOrphan": {
      const orphans = state.orphans.filter(o => o.id !== action.id);
      if (orphans.length === state.orphans.length) return state;
      return { ...state, orphans };
    }

    case "commandsDone": {
      if (state.commands.length === 0) return state;
      const remaining = state.commands.filter(c => !action.ids.includes(c.id));
      if (remaining.length === state.commands.length) return state;
      return { ...state, commands: remaining };
    }

    default:
      return state;
  }
}
