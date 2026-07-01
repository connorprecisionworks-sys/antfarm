// Module-level store for Forge per-repo thread state.
// Mirrors chatStore.ts pattern (useSyncExternalStore) with localStorage persistence.

export type RoleKey = "planner" | "builder" | "reviewer";

export interface RoleState {
  status: "idle" | "running" | "done" | "error";
  activity: string;
  text: string;
}

export interface ForgeTurnTerminalReady {
  kind: "ready_to_push";
  commitMsg: string;
  diff: string;
  reviewerNote?: string;
}

export interface ForgeTurnTerminalNeedsYou {
  kind: "needs_you";
  text: string;
}

export type ForgeTurnTerminal = ForgeTurnTerminalReady | ForgeTurnTerminalNeedsYou;

export interface ForgeTurn {
  id: string;
  userMessage: string;
  podId: string;
  roleEntries: Record<RoleKey, RoleState>;
  // Which tab is shown by default when viewing this completed turn.
  activeRole: RoleKey;
  terminal: ForgeTurnTerminal | null;
  pushed: boolean;
  userImages?: string[];
}

// ── Spec run records ───────────────────────────────────────────────────────────

export interface SpecItemRecord {
  index: number;
  text: string;
  status: "done" | "flagged";
  commitHash?: string;
  flagReason?: string;
}

export interface SpecRunRecord {
  id: string;        // specId
  scope: string;
  completedAt: number;
  items: SpecItemRecord[];
  gitLog: string;
  diff: string;
  pushed: boolean;
}

// ── Active pod state (in-flight, ephemeral — not persisted) ──────────────────

export interface ActivePodEntry {
  turnId: string;
  repoPath: string;
  userMessage: string;
  roles: Record<RoleKey, RoleState>;
  podStep: string;
  running: boolean;
  terminal: ForgeTurnTerminal | null;
  pushed: boolean;
  hasCumulativeDiff: boolean;
  userImages?: string[];
}

export interface ForgeSnapshot {
  // Keyed by absolute repoPath.
  threads: Record<string, ForgeTurn[]>;
  specRuns: Record<string, SpecRunRecord[]>;
  // Keyed by podId. Ephemeral — not saved to localStorage.
  activePods: Record<string, ActivePodEntry>;
}

// ── Persistence ────────────────────────────────────────────────────────────────

const THREADS_KEY = "forge:threads:v1";
// Cap per-role text to avoid localStorage bloat while keeping the gist of each run.
const MAX_ROLE_TEXT = 8000;

function capRoles(roles: Record<RoleKey, RoleState>): Record<RoleKey, RoleState> {
  return {
    planner:  { ...roles.planner,  text: roles.planner.text.slice(0, MAX_ROLE_TEXT) },
    builder:  { ...roles.builder,  text: roles.builder.text.slice(0, MAX_ROLE_TEXT) },
    reviewer: { ...roles.reviewer, text: roles.reviewer.text.slice(0, MAX_ROLE_TEXT) },
  };
}

function loadFromStorage(): Pick<ForgeSnapshot, "threads" | "specRuns"> {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ForgeSnapshot>;
      return {
        threads: parsed.threads ?? {},
        specRuns: parsed.specRuns ?? {},
      };
    }
  } catch {}
  return { threads: {}, specRuns: {} };
}

function saveToStorage(s: ForgeSnapshot): void {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(s));
  } catch {}
}

// ── Internal state ─────────────────────────────────────────────────────────────

let snapshot: ForgeSnapshot = { ...loadFromStorage(), activePods: {} };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

// ── useSyncExternalStore API ───────────────────────────────────────────────────

export function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function getSnapshot(): ForgeSnapshot {
  return snapshot;
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export function appendTurn(repoPath: string, turn: ForgeTurn): void {
  const capped: ForgeTurn = { ...turn, roleEntries: capRoles(turn.roleEntries) };
  const prev = snapshot.threads[repoPath] ?? [];
  snapshot = { ...snapshot, threads: { ...snapshot.threads, [repoPath]: [...prev, capped] } };
  saveToStorage(snapshot);
  emit();
}

export function markPushed(repoPath: string, turnId: string): void {
  const prev = snapshot.threads[repoPath] ?? [];
  const next = prev.map((t) => (t.id === turnId ? { ...t, pushed: true } : t));
  snapshot = { ...snapshot, threads: { ...snapshot.threads, [repoPath]: next } };
  saveToStorage(snapshot);
  emit();
}

export function appendSpecRun(repoPath: string, run: SpecRunRecord): void {
  const prev = snapshot.specRuns[repoPath] ?? [];
  snapshot = {
    ...snapshot,
    specRuns: { ...snapshot.specRuns, [repoPath]: [...prev, run] },
  };
  saveToStorage(snapshot);
  emit();
}

export function markSpecRunPushed(repoPath: string, specId: string): void {
  const prev = snapshot.specRuns[repoPath] ?? [];
  const next = prev.map((r) => (r.id === specId ? { ...r, pushed: true } : r));
  snapshot = { ...snapshot, specRuns: { ...snapshot.specRuns, [repoPath]: next } };
  saveToStorage(snapshot);
  emit();
}

// ── Active pod mutations ───────────────────────────────────────────────────────

/** Register an in-flight pod. Evicts any prior pod for the same repoPath. */
export function registerActivePod(podId: string, entry: ActivePodEntry): void {
  const cleaned: Record<string, ActivePodEntry> = {};
  for (const [pid, e] of Object.entries(snapshot.activePods)) {
    if (e.repoPath !== entry.repoPath) cleaned[pid] = e;
  }
  snapshot = { ...snapshot, activePods: { ...cleaned, [podId]: entry } };
  emit();
}

/** Update the current step label for a running pod. */
export function patchActivePodStep(podId: string, podStep: string): void {
  const cur = snapshot.activePods[podId];
  if (!cur) return;
  snapshot = { ...snapshot, activePods: { ...snapshot.activePods, [podId]: { ...cur, podStep } } };
  emit();
}

/** Apply an agent-stream event to a role inside an active pod. */
export function reconcileActivePodRole(
  podId: string,
  role: RoleKey,
  kind: string,
  text: string,
): void {
  const cur = snapshot.activePods[podId];
  if (!cur) return;
  const r = cur.roles[role];
  let updated: RoleState;
  switch (kind) {
    case "start":    updated = { status: "running", activity: "", text: "" }; break;
    case "text":     updated = { ...r, text: r.text + text, status: "running" }; break;
    case "activity": updated = { ...r, activity: text }; break;
    case "done":     updated = { ...r, status: "done", activity: "" }; break;
    default:         updated = { ...r, status: "error", activity: "" }; break;
  }
  const roles = { ...cur.roles, [role]: updated };
  snapshot = { ...snapshot, activePods: { ...snapshot.activePods, [podId]: { ...cur, roles } } };
  emit();
}

/**
 * Mark a pod terminal: update activePods entry (running→false, terminal set)
 * and persist the completed turn to threads in one atomic snapshot update.
 */
export function finalizeAndPersistPod(
  podId: string,
  terminal: ForgeTurnTerminal,
  activeRole: RoleKey,
): void {
  const cur = snapshot.activePods[podId];
  if (!cur) return;
  const updatedEntry: ActivePodEntry = { ...cur, running: false, terminal };
  const turn: ForgeTurn = {
    id: cur.turnId,
    userMessage: cur.userMessage,
    podId,
    roleEntries: capRoles(cur.roles),
    activeRole,
    terminal,
    pushed: false,
    userImages: cur.userImages,
  };
  const prev = snapshot.threads[cur.repoPath] ?? [];
  snapshot = {
    ...snapshot,
    activePods: { ...snapshot.activePods, [podId]: updatedEntry },
    threads:    { ...snapshot.threads, [cur.repoPath]: [...prev, turn] },
  };
  saveToStorage(snapshot);
  emit();
}

/** Mark the active pod's push card as pushed. */
export function markActivePodPushed(podId: string): void {
  const cur = snapshot.activePods[podId];
  if (!cur) return;
  snapshot = { ...snapshot, activePods: { ...snapshot.activePods, [podId]: { ...cur, pushed: true } } };
  emit();
}
