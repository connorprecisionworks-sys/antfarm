// Module-level store for Chat thread state — survives React Router unmount/remount.
// All six shared pieces live here; UI-only state (draft, filter, etc.) stays local.

export interface StreamEntry {
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  text: string;
  status: "thinking" | "streaming" | "done" | "error" | "timeout" | "stopped";
  time: string;
  parentId?: string;
  userMsg?: string;
  inputTokens?: number;
  outputTokens?: number;
  usagePct?: number;
  activity?: string;
  outputs?: string[];
}

export interface Msg {
  id: string;
  from: string;
  fromRole: "orchestrator" | "subagent" | "chatter";
  tier: "needs-you" | "fyi" | "chatter";
  content: string;
  action?: string;
  time: string;
  collapsed: boolean;
}

export interface ChatSnapshot {
  streamEntries: StreamEntry[];
  messages: Msg[];
  runningAgents: Set<string>;
  fannedIds: Set<string>;
  chattersOpen: Set<string>;
  dismissedBuilders: Set<string>;
}

// ── Internal state ─────────────────────────────────────────────────────────────

let snapshot: ChatSnapshot = {
  streamEntries: [],
  messages: [],
  runningAgents: new Set(),
  fannedIds: new Set(),
  chattersOpen: new Set(),
  dismissedBuilders: new Set(),
};

const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

// ── useSyncExternalStore API ───────────────────────────────────────────────────

export function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function getSnapshot(): ChatSnapshot {
  return snapshot;
}

// ── Setters — accept value or functional-update form ─────────────────────────

export function setStreamEntries(
  updater: StreamEntry[] | ((prev: StreamEntry[]) => StreamEntry[])
): void {
  const next = typeof updater === "function" ? updater(snapshot.streamEntries) : updater;
  snapshot = { ...snapshot, streamEntries: next };
  emit();
}

export function setMessages(
  updater: Msg[] | ((prev: Msg[]) => Msg[])
): void {
  const next = typeof updater === "function" ? updater(snapshot.messages) : updater;
  snapshot = { ...snapshot, messages: next };
  emit();
}

export function setRunningAgents(
  updater: Set<string> | ((prev: Set<string>) => Set<string>)
): void {
  const next = typeof updater === "function" ? updater(snapshot.runningAgents) : updater;
  snapshot = { ...snapshot, runningAgents: next };
  emit();
}

export function setFannedIds(
  updater: Set<string> | ((prev: Set<string>) => Set<string>)
): void {
  const next = typeof updater === "function" ? updater(snapshot.fannedIds) : updater;
  snapshot = { ...snapshot, fannedIds: next };
  emit();
}

export function setChattersOpen(
  updater: Set<string> | ((prev: Set<string>) => Set<string>)
): void {
  const next = typeof updater === "function" ? updater(snapshot.chattersOpen) : updater;
  snapshot = { ...snapshot, chattersOpen: next };
  emit();
}

export function setDismissedBuilders(
  updater: Set<string> | ((prev: Set<string>) => Set<string>)
): void {
  const next = typeof updater === "function" ? updater(snapshot.dismissedBuilders) : updater;
  snapshot = { ...snapshot, dismissedBuilders: next };
  emit();
}
