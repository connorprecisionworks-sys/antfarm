# Forge Phase 3 (conversational coding) — Claude Code prompts

Paste into Claude Code, in the `antfarm` repo, one phase at a time. Paste Code's report back to Cowork before the next. Full `npm run tauri dev` restart after any Rust change. No migrations.

---

## Prompt 1 — Phase 3a (dedicated Forge chat, per-repo threads)

```
Read FORGE-CHAT-BUILD-PLAN.md in the repo root, all of it. Build Phase 3a only: turn the Forge page into a per-repo chat thread.

Convert Forge.tsx from one-shot to a conversation: keep the repo picker (folder dialog + recents) as the thread selector, render a scrollable thread of turns (user message bubble + the pod's role tabs + the approve/needs_you card per turn), and a message input pinned at the bottom. Each sent message starts a pod via run_pod and appends a turn.

Persist threads per absolute repoPath (localStorage, mirroring the recents pattern); load the repo's thread on switch; empty state for a new repo. Follow the chatStore.ts pattern for the store.

Add an optional conversation-context param to run_pod: when a message is sent mid-thread, pass a compact summary of the last ~6 turns (each turn's user message + a one-line outcome) so follow-ups resolve correctly. The Planner still re-reads the repo for code state.

Keep the per-turn stop-before-push gate (approve card per turn -> builder_commit_push). Handle the case where Connor sends another message without approving: the next pod builds on the uncommitted working tree and the diff is cumulative — note that on the card, don't discard work.

Report the diff, cargo check + npm run build, and a description of a two-turn live run against /Users/connordore/Desktop/connordore-com (turn 1 builds something and approves; turn 2 is a follow-up that builds on it) plus confirmation the thread survives an app reload. Stop for my review before Phase 3b.
```

---

## Prompt 2 — Phase 3b (Jack -> Forge delegation)

```
Phase 3a is approved. Build Phase 3b from FORGE-CHAT-BUILD-PLAN.md: let Captain Jack delegate a coding build to a Forge pod from the main chat.

Extend the delegation parsing in Chat.tsx so Jack can target `forge` with a task and a repo (e.g. a delegate line `forge: <task> repo: <path-or-known-project>`). When parsed, call run_pod(repoPath, task) instead of run_agent and render the pod inline in the main chat (reuse the role tabs + approve-and-push card). Resolve known project names to paths via the registry/recents; if the repo is ambiguous, Jack should ask which repo.

Update Captain Jack's prompt at agents/chief-of-staff/prompt.md (vault): for code builds in a known repo, delegate to Forge rather than doing it himself or using advisory Builder; always include the repo; narrate the handoff in plain English. (This is a vault edit — confirm it's within the prompt, not app source.)

Report the diff, cargo check + npm run build, and a live test: in the main chat ask Jack "have Forge add a footer to connordore.com" and confirm it spins a Forge pod inline with the approve card. Stop for my review.
```
