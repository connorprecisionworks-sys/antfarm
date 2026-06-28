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

export interface ForgeSnapshot {
  // Keyed by absolute repoPath.
  threads: Record<string, ForgeTurn[]>;
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

function loadFromStorage(): ForgeSnapshot {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (raw) return JSON.parse(raw) as ForgeSnapshot;
  } catch {}
  return { threads: {} };
}

function saveToStorage(s: ForgeSnapshot): void {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(s));
  } catch {}
}

// ── Internal state ─────────────────────────────────────────────────────────────

let snapshot: ForgeSnapshot = loadFromStorage();
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
