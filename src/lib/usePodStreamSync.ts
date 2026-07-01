// Global pod-stream reconciler — mounted once in App.tsx.
// Listens to "pod-stream" and "agent-stream" for every registered active pod
// and drives forgeThreadStore.activePods, regardless of which route is mounted.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  type RoleKey,
  type ForgeTurnTerminal,
  getSnapshot,
  patchActivePodStep,
  reconcileActivePodRole,
  finalizeAndPersistPod,
} from "./forgeThreadStore";

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

// podStep → active role (mirrors POD_STEP_ROLE in ForgePodPanel)
const STEP_TO_ROLE: Record<string, RoleKey> = {
  planning:  "planner",
  building:  "builder",
  verifying: "builder",
  reviewing: "reviewer",
};

/**
 * Mount this hook once in App.tsx.
 * Handles all pod events for any pod registered via registerActivePod(),
 * persisting terminal state into forgeThreadStore so Forge (and future Chat)
 * can render live progress even if the Forge route is unmounted.
 */
export function usePodStreamSync(): void {
  useEffect(() => {
    const subs: Array<() => void> = [];

    listen<PodStreamPayload>("pod-stream", (ev) => {
      const p = ev.payload;
      if (!getSnapshot().activePods[p.podId]) return; // not a tracked pod

      if (p.kind === "ready_to_push") {
        const terminal: ForgeTurnTerminal = {
          kind: "ready_to_push",
          commitMsg: p.commitMsg ?? "",
          diff: p.diff ?? "",
          reviewerNote: p.reviewerNote,
        };
        finalizeAndPersistPod(p.podId, terminal, "reviewer");
      } else if (p.kind === "needs_you") {
        const terminal: ForgeTurnTerminal = { kind: "needs_you", text: p.text };
        const curStep = getSnapshot().activePods[p.podId]?.podStep ?? "";
        const step     = p.step === "needs_you" ? curStep : p.step;
        const role: RoleKey = (STEP_TO_ROLE[step] ?? "builder") as RoleKey;
        finalizeAndPersistPod(p.podId, terminal, role);
      } else {
        patchActivePodStep(p.podId, p.step);
      }
    }).then((u) => subs.push(u));

    listen<AgentStreamPayload>("agent-stream", (ev) => {
      const p = ev.payload;
      if (!p.parentRunId) return;
      if (!getSnapshot().activePods[p.parentRunId]) return; // not a tracked pod

      const role = p.agentId as RoleKey;
      if (!["planner", "builder", "reviewer"].includes(role)) return;

      reconcileActivePodRole(p.parentRunId, role, p.kind, p.text);
    }).then((u) => subs.push(u));

    return () => subs.forEach((f) => f());
  }, []);
}
