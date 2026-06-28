# Forge Phase 3 — Conversational coding build plan

Scoped 2026-06-27 (Cowork). Turn Forge from a one-shot launcher into a CHAT: a per-repo conversation where each message runs the Planner -> Builder -> Reviewer pod loop, stops for Connor's approval, and the next message builds on the evolving codebase. Plus: Captain Jack can hand a coding build off to Forge from the main chat.

Read this whole file before writing code. Build in phase order. Each phase pushes to `main` only after acceptance + `cargo check` + `npm run build` both green. No database migrations.

## Locked decisions
- **Dedicated Forge chat AND Jack delegation.** Phase 3a builds the dedicated Forge chat. Phase 3b lets Captain Jack delegate a build to a Forge pod from the main chat.
- **One thread per repo.** Each repo has its own coding conversation + history. Switch repo (via the existing folder picker / recents) -> load that repo's thread.
- **Full Planner -> Builder -> Reviewer loop every turn** (v1). Consistent quality, reviewer always checks. (Adaptive — quick Builder-only turns for tiny tweaks — is a noted v2, do NOT build it now.)
- **Per-turn stop-before-push.** Every turn ends with the approve-and-push card for that turn's diff. Connor approves each turn. All existing hard gates stay (never autonomous push/migrate, repo allow-list, separate-clone).

## What exists (reuse, do not rebuild)
- `run_pod` (pod.rs): the Plan -> Build -> gate -> Review -> loop(cap 3) -> ready_to_push/needs_you state machine, emits `pod-stream` events tagged with `pod_id` + `step`.
- `Forge.tsx`: the current one-shot launcher (repo picker w/ folder dialog + recents, task box, TabbedDelegation role tabs, PodDoneCard approve-and-push, needs_you card, trace tabs + View log).
- `chatStore.ts` (src/lib): the module store (useSyncExternalStore) that persists the main Chat thread across navigation — the pattern to follow for Forge thread persistence.
- The main `Chat.tsx`: delegation parsing (`parseDelegations`, ` ```delegate ` blocks, `(after:)`), fan-out, the tabbed panel — the integration point for Phase 3b.

---

## Phase 3a — Dedicated Forge chat (per-repo threads)

Convert the Forge page from one-shot to a chat thread.

**Thread model:** a Forge thread = an ordered list of turns. Each turn = `{ id, userMessage, podId, roleEntries (planner/builder/reviewer stream), terminal (ready_to_push card data | needs_you) }`. Threads are keyed by absolute `repoPath`. Persist them (localStorage keyed by repoPath is fine for v1, mirroring the recents dropdown). On repo switch, load that repo's thread; show empty state for a new repo.

**UI:** keep the repo picker (folder dialog + recents) at the top as the thread selector. Below it, a scrollable conversation: each user message rendered as a chat bubble, each assistant turn rendered as the pod (reuse TabbedDelegation role tabs for live progress + the PodDoneCard / needs_you card at the end). A message input pinned at the bottom. Sending a message appends a user turn and starts a pod.

**Conversation context into the pod:** `run_pod` gains an optional `history` / `context` param. When a message is sent in an ongoing thread, pass a COMPACT running summary of prior turns (each prior turn's user message + a one-line outcome, e.g. "built the hero; approved" or "added work grid; pending"). The Planner re-reads the repo for actual code state; the conversation summary gives intent continuity so follow-ups like "now make the hero bolder" resolve correctly. Keep the summary short (cap to last ~6 turns) to avoid context bloat.

**Per-turn gate + carryover:** each turn ends with the approve-and-push card for that turn's `git diff HEAD`. If Connor approves, it commits+pushes (existing `builder_commit_push`) and the next turn starts clean. If Connor sends another message WITHOUT approving, handle gracefully: the working tree still has the prior turn's uncommitted changes, the next pod builds on top, and `git diff HEAD` shows the cumulative diff (note this in the card so it's not surprising). Do not lose or auto-discard uncommitted work.

**Acceptance:** Pick connordore-com. Send "add a /about route with a short bio"; watch the pod run in-thread, land on the approve card, approve. Send a follow-up "make the about headline bigger"; confirm it runs as a second turn, understands the follow-up, and builds on the prior state. Reload the app, reopen Forge with that repo, and confirm the thread history is still there. `cargo check` + `npm run build` green. Commit + push.

---

## Phase 3b — Jack -> Forge delegation

Let Captain Jack hand a coding build to a Forge pod from the main chat.

- Extend the delegation system so Jack can target `forge` with a repo + task. Simplest: a delegate line format like `forge: <task> [repo: <path or known project>]`, parsed in Chat.tsx alongside existing delegations. When seen, the app calls `run_pod(repoPath, task)` instead of `run_agent`, and renders the pod inline in the main chat (reuse the pod rendering: role tabs + approve card). The approve-and-push gate still applies inline.
- Update Captain Jack's prompt (vault, agents/chief-of-staff/prompt.md) so Jack knows: for code builds in a known repo, delegate to Forge rather than trying to do it himself or routing through advisory Builder; Jack must include the repo. Keep Jack's plain-English narration ("Handing this to the Forge coding crew on connordore.com.").
- Repo resolution: map known project names to paths (reuse the registry / recents) so Jack can say `forge: ... repo: connordore.com` and the app resolves it; if ambiguous, Jack asks Connor which repo.

**Acceptance:** In the main chat, ask Jack "have Forge add a footer to connordore.com." Confirm Jack delegates to a Forge pod, the pod runs inline, and the approve card appears in the main thread. `cargo check` + `npm run build` green. Commit + push.

---

## Hard gates (unchanged)
- Stop-before-push every turn; Connor approves each. Never autonomous push/migrate. Repo allow-list via the selected repo. Separate-clone rule for self-improvement. Build-gate green before a turn is "done."

## Out of scope (do not build now)
- Adaptive per-turn routing (quick Builder-only tweaks) — v2.
- Parallel Forge threads running pods simultaneously — later.
- Streaming partial diffs mid-build — later.
