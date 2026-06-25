import { describe, it, expect } from "vitest";
import {
  relayReducer,
  initRelayState,
  type RelayState,
  type RelayCommand,
} from "./relayReducer";

// Characterization tests: these pin the CURRENT observable behavior of the
// relay state machine (formerly the imperative ref-mirror code in DockArea).
// They are the safety net for the functional-core extraction — bugs included.

const init = (defaultSlug: string | null = "proj") => initRelayState(defaultSlug);

// Run a sequence of actions starting from a fresh (or given) state.
function run(actions: Parameters<typeof relayReducer>[1][], start?: RelayState): RelayState {
  return actions.reduce((s, a) => relayReducer(s, a), start ?? init());
}

const dispatchCmds = (s: RelayState) => s.commands.filter((c): c is Extract<RelayCommand, { kind: "dispatch" }> => c.kind === "dispatch");
const killCmds = (s: RelayState) => s.commands.filter((c): c is Extract<RelayCommand, { kind: "kill" }> => c.kind === "kill");

describe("register", () => {
  it("creates an idle slice whose projectSlug is the current defaultSlug", () => {
    const s = run([{ type: "register", paneId: "p1" }]);
    expect(s.panes.p1).toEqual({ runId: null, status: "idle", queue: [], projectSlug: "proj" });
  });

  it("is idempotent — re-registering an existing pane does not reset it", () => {
    const s1 = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
    ]);
    const s2 = relayReducer(s1, { type: "register", paneId: "p1" });
    expect(s2.panes.p1.status).toBe("running");
    expect(s2.panes.p1.runId).toBe("r1");
  });

  it("drains a pre-registered pending dispatch and clears it", () => {
    const s = run([
      { type: "setPending", paneId: "p1", prompt: "do the thing", slug: "other" },
      { type: "register", paneId: "p1" },
    ]);
    expect(s.pending.p1).toBeUndefined();
    const cmds = dispatchCmds(s);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ kind: "dispatch", paneId: "p1", prompt: "do the thing", slug: "other", deferred: false });
  });

  it("does not emit a dispatch when there is no pending entry", () => {
    const s = run([{ type: "register", paneId: "p1" }]);
    expect(dispatchCmds(s)).toHaveLength(0);
  });
});

describe("unregister", () => {
  it("removes the slice", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "unregister", paneId: "p1" },
    ]);
    expect(s.panes.p1).toBeUndefined();
  });

  it("kills an in-flight run (silently) when the pane is running", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "unregister", paneId: "p1" },
    ]);
    const kills = killCmds(s);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ kind: "kill", runId: "r1", log: false });
  });

  it("does NOT kill when the pane has a runId but is no longer running", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "finished", paneId: "p1", finalStatus: "done" }, // empty queue → settles "done"
      { type: "unregister", paneId: "p1" },
    ]);
    expect(killCmds(s)).toHaveLength(0);
  });

  it("orphans a non-empty queue with deterministic ids carrying the pane's slug", () => {
    let s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "queue", paneId: "p1", prompt: "q1" },
      { type: "queue", paneId: "p1", prompt: "q2" },
    ]);
    s = relayReducer(s, { type: "unregister", paneId: "p1" });
    expect(s.orphans.map(o => o.prompt)).toEqual(["q1", "q2"]);
    expect(s.orphans.every(o => o.slug === "proj")).toBe(true);
    expect(new Set(s.orphans.map(o => o.id)).size).toBe(2); // unique ids
    // running pane → kill command AND two orphans were created
    expect(killCmds(s)).toHaveLength(1);
  });

  it("is a no-op for an unknown pane", () => {
    const s0 = init();
    const s1 = relayReducer(s0, { type: "unregister", paneId: "ghost" });
    expect(s1).toBe(s0);
  });
});

describe("queue", () => {
  it("appends a prompt to the pane's queue", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "queue", paneId: "p1", prompt: "next" },
    ]);
    expect(s.panes.p1.queue).toEqual(["next"]);
  });

  it("ignores an unknown pane", () => {
    const s0 = run([{ type: "register", paneId: "p1" }]);
    const s1 = relayReducer(s0, { type: "queue", paneId: "ghost", prompt: "x" });
    expect(s1).toBe(s0);
  });
});

describe("finished", () => {
  it("with a non-empty queue: dequeues, goes idle, and emits a DEFERRED dispatch of the next prompt", () => {
    let s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "queue", paneId: "p1", prompt: "q1" },
      { type: "queue", paneId: "p1", prompt: "q2" },
    ]);
    s = relayReducer(s, { type: "finished", paneId: "p1", finalStatus: "done" });
    expect(s.panes.p1.status).toBe("idle");
    expect(s.panes.p1.queue).toEqual(["q2"]);
    const cmds = dispatchCmds(s);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ paneId: "p1", prompt: "q1", slug: "proj", deferred: true });
  });

  it("with an empty queue: settles the final status and emits no dispatch", () => {
    let s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
    ]);
    s = relayReducer(s, { type: "finished", paneId: "p1", finalStatus: "failed" });
    expect(s.panes.p1.status).toBe("failed");
    expect(dispatchCmds(s)).toHaveLength(0);
  });

  it("ignores an unknown pane", () => {
    const s0 = init();
    const s1 = relayReducer(s0, { type: "finished", paneId: "ghost", finalStatus: "done" });
    expect(s1).toBe(s0);
  });
});

describe("send (routing decision)", () => {
  it("free pane → dispatches to it (first free pane wins)", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "register", paneId: "p2" }, // idle → free
      { type: "send", prompt: "hello", slug: "proj" },
    ]);
    const cmds = dispatchCmds(s);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ paneId: "p2", prompt: "hello", deferred: false });
    expect(s.noPaneModal).toBeNull();
    expect(s.allBusyModal).toBeNull();
  });

  it("no panes → opens the noPaneModal", () => {
    const s = run([{ type: "send", prompt: "hello", slug: "proj" }]);
    expect(s.noPaneModal).toEqual({ prompt: "hello", slug: "proj" });
    expect(dispatchCmds(s)).toHaveLength(0);
  });

  it("all panes busy → opens the allBusyModal with the busy pane ids", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "register", paneId: "p2" },
      { type: "running", paneId: "p2", runId: "r2", slug: "proj" },
      { type: "send", prompt: "hello", slug: "proj" },
    ]);
    expect(s.allBusyModal).toEqual({ prompt: "hello", slug: "proj", paneIds: ["p1", "p2"] });
    expect(dispatchCmds(s)).toHaveLength(0);
  });

  it("treats done/failed/killed panes as free (re-usable)", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "finished", paneId: "p1", finalStatus: "killed" }, // empty queue → "killed"
      { type: "send", prompt: "again", slug: "proj" },
    ]);
    expect(dispatchCmds(s)).toHaveLength(1);
    expect(dispatchCmds(s)[0]).toMatchObject({ paneId: "p1", prompt: "again" });
  });
});

describe("running (dispatch_run resolved)", () => {
  it("marks an existing pane running while preserving its queue + projectSlug", () => {
    let s = run([{ type: "register", paneId: "p1" }]); // projectSlug "proj"
    s = relayReducer(s, { type: "queue", paneId: "p1", prompt: "later" });
    // NB: queueing onto an idle pane is not a real flow, but it pins the merge.
    s = relayReducer(s, { type: "running", paneId: "p1", runId: "r9", slug: "ignored" });
    expect(s.panes.p1).toEqual({ runId: "r9", status: "running", queue: ["later"], projectSlug: "proj" });
  });

  it("falls back to the dispatch slug for projectSlug when the pane is absent", () => {
    const s = relayReducer(init(), { type: "running", paneId: "p1", runId: "r9", slug: "fallback" });
    expect(s.panes.p1).toEqual({ runId: "r9", status: "running", queue: [], projectSlug: "fallback" });
  });
});

describe("killPane", () => {
  it("emits a kill command (logged) for a pane with a running run", () => {
    const s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "killPane", paneId: "p1" },
    ]);
    const kills = killCmds(s);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ runId: "r1", log: true });
  });

  it("is a no-op when the pane has no runId", () => {
    const s0 = run([{ type: "register", paneId: "p1" }]);
    const s1 = relayReducer(s0, { type: "killPane", paneId: "p1" });
    expect(s1).toBe(s0);
  });
});

describe("commands lifecycle", () => {
  it("commandsDone removes only the acked ids", () => {
    let s = run([
      { type: "setPending", paneId: "p1", prompt: "a", slug: null },
      { type: "register", paneId: "p1" }, // emits dispatch cmd id 0
      { type: "register", paneId: "p2" },
      { type: "running", paneId: "p2", runId: "r2", slug: null },
      { type: "killPane", paneId: "p2" }, // emits kill cmd id 1
    ]);
    expect(s.commands).toHaveLength(2);
    const firstId = s.commands[0].id;
    s = relayReducer(s, { type: "commandsDone", ids: [firstId] });
    expect(s.commands).toHaveLength(1);
    expect(s.commands[0].id).not.toBe(firstId);
  });

  it("command ids are unique across the machine's lifetime", () => {
    const s = run([
      { type: "setPending", paneId: "p1", prompt: "a", slug: null },
      { type: "register", paneId: "p1" },
      { type: "setPending", paneId: "p2", prompt: "b", slug: null },
      { type: "register", paneId: "p2" },
    ]);
    const ids = s.commands.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("modal + orphan + config plumbing", () => {
  it("config updates the default slug used by subsequent registers", () => {
    let s = relayReducer(init("proj"), { type: "config", defaultSlug: "switched" });
    s = relayReducer(s, { type: "register", paneId: "p1" });
    expect(s.panes.p1.projectSlug).toBe("switched");
  });

  it("closeNoPaneModal / closeAllBusyModal clear their signals", () => {
    let s = run([{ type: "send", prompt: "x", slug: null }]); // noPaneModal set
    s = relayReducer(s, { type: "closeNoPaneModal" });
    expect(s.noPaneModal).toBeNull();
  });

  it("dismissOrphan removes a single orphan by id", () => {
    let s = run([
      { type: "register", paneId: "p1" },
      { type: "running", paneId: "p1", runId: "r1", slug: "proj" },
      { type: "queue", paneId: "p1", prompt: "q1" },
      { type: "unregister", paneId: "p1" },
    ]);
    expect(s.orphans).toHaveLength(1);
    const id = s.orphans[0].id;
    s = relayReducer(s, { type: "dismissOrphan", id });
    expect(s.orphans).toHaveLength(0);
  });
});
