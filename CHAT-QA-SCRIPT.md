# Chief-of-Staff Chat — In-Depth QA Script

Scope: the agent chat in `src/pages/Chat.tsx` + `src-tauri/src/agents.rs` (Captain Jack / Scout / Scribe / Clerk / Builder). NOT the scope-a-build chat in `chat.rs` (that's the harness/Workspace flow).

Run each test in order. Mark P (pass) / F (fail) / N (needs work) and jot what you saw. Anything marked F or N becomes a fix prompt for Code.

---

## 0. Setup (do first)

- [ ] In antfarm, run in your terminal: `npm run tauri dev`
- [ ] Confirm the build includes Phases A/B/C (watchdog, stop button, activity labels, output links). If `git log --oneline -3` in antfarm doesn't show the three commits, they didn't land — stop and tell me.
- [ ] Open the Chat page. Header shows "N agents · M active". Crew loads (5 agents).

---

## 1. Routing & composer

- **T1.1 Default recipient.** Open Chat. The "To:" chip shows Captain Jack (orchestrator) by default. → P/F
- **T1.2 Recipient picker via mention button.** Click "mention", pick Scout from the dropdown. "To:" flips to Scout, draft shows `@Scout `. → P/F
- **T1.3 Inline @mention.** Clear the draft. Type `@scribe ` — recipient flips to Scribe as you complete the name. → P/F
- **T1.4 @mention override on send.** With "To:" = Captain Jack, type `@scout what's new in AI` and send. The run targets Scout, not Jack. → P/F
- **T1.5 Remove recipient.** Click the X on the "To:" chip. It clears to "no recipient". Sending is blocked (nothing happens). → P/F
- **T1.6 Enter sends, Shift+Enter newlines.** Confirm both. → P/F
- **T1.7 Unknown @mention.** Type `@nobody hello` and send. Should fall back to the current recipient with the full text as the task (not crash). → P/F

## 2. Agent capabilities

- **T2.1 Scout (web).** Send `@scout find the 3 newest Anthropic model releases`. Watch the live label: it should read **"searching the web"** while WebSearch runs (not just "thinking…"). Final answer cites sources. → P/F
- **T2.2 Scout output link.** If Scout writes a file (e.g. a PDF or .md to active/ or its agent folder), a clickable file chip appears under the answer. Click it — the file opens. → P/F
- **T2.3 Scribe (Gmail draft + NEEDS YOU).** Send `@scribe draft a short reply to the most recent email from <someone>`. Expect: live label **"reading inbox"**, a draft written to `active/drafts/email-*.md`, and the answer ends with a NEEDS YOU action showing inline **Approve / Reject** buttons. → P/F
- **T2.4 Clerk (plan).** Send `@clerk reconcile today's plan`. Live label shows file activity. When done, the plan banner at the top refreshes (plan state re-queried on Clerk done). → P/F
- **T2.5 Builder.** Send `@builder summarize what you'd change in <some file>` (read-only ask). Confirm it runs and returns; Builder-done card renders. → P/F

## 3. Delegation fan-out (Captain Jack)

- **T3.1 Jack proposes a fan-out.** Send to Captain Jack: `research Anthropic pricing and reconcile my plan`. Jack should end with a delegate block → a **Delegation card** with the proposed subagents. → P/F
- **T3.2 Fan out.** Click "Fan out". Child entries (Scout, Clerk) appear grouped under Jack in a chatter group, each running concurrently with their own live labels. → P/F
- **T3.3 Chatter group toggle.** Collapse/expand the child group. Counts and live states are correct. → P/F
- **T3.4 Children reach terminal states.** Each child ends in done/error/timeout/stopped independently. → P/F

## 4. NEW — watchdog, stop, states, outputs (Phases A/B/C)

- **T4.1 Stop button appears on live runs.** Start any run. While it's live, a Stop button shows in the entry header. → P/F
- **T4.2 Stop works.** Hit Stop mid-run. The run ends promptly in a **"Stopped"** state with muted styling and "Stopped by Connor." text. The agent leaves the running set (no stuck spinner). → P/F
- **T4.3 Stop disabled before runId.** Immediately after sending (sub-second), the Stop button is disabled until the run id is assigned, then enables. → P/F
- **T4.4 Activity labels are real.** Across T2.1–T2.4 the live label changed with what the agent actually did (searching the web / reading inbox / reading files / writing files), not a static string. → P/F
- **T4.5 Terminal states are distinct.** Confirm you've seen at least: **done** (zinc), **error** (red, message visible), **stopped** (muted). Each is visually unambiguous and the message text is never swallowed. → P/F
- **T4.6 Timeout (the watchdog).** Hard to trigger on purpose. If any run ever hangs, it should self-kill at ~120s of silence and show an amber **"Timed out"** state with a clock icon, instead of spinning forever. If you can force a hang (e.g. kill network mid-web-run), verify. Otherwise mark N/A. → P/F/NA
- **T4.7 Context meter.** On a completed run, the thin context-usage bar + "% ctx" shows when usage data is present. → P/F

## 5. Voice, memory, approvals, scheduling

- **T5.1 Voice dictation.** Click the mic, speak a sentence, click again to stop. Transcript appends into the draft. (Grant mic permission once.) → P/F
- **T5.2 Session memory (warm resume).** Send Scout a question, then a follow-up that depends on the first ("now compare those to OpenAI"). The second answer should show continuity (faster, no cold repo re-read). → P/F
- **T5.3 Fast follow-up race (known issue #5).** Fire a second message to the same agent within a second of the first. Watch whether the second cold-starts instead of resuming. Note behavior — this is a known queued fix. → P/F
- **T5.4 Approve a NEEDS YOU.** From T2.3, click Approve. A follow-up run fires ("APPROVED — proceed"). → P/F
- **T5.5 Reject a NEEDS YOU.** On another NEEDS YOU, click Reject. The entry marks "[Rejected by Connor]" and resolves to done; no run fires. → P/F
- **T5.6 Scheduled-run drain.** If Clerk's 7am (or any scheduled) run fired while the app was closed, on next open a synthetic entry shows "Scheduled run at HH:MM…". (Tied to queued fix #6 — scheduler catch-up.) → P/F/NA

---

## Findings from the code audit (know these BEFORE testing — they're scaffolding/gaps, not bugs you caused)

1. **Placeholder messages are still seeded.** The chat ships 3 hardcoded fake messages (`PLACEHOLDER_MESSAGES`): a Captain Jack "Ready to kick off today's research sprint" (counts toward the "Needs you" badge as 1), a Scout "Research complete", and a Builder→Scribe chatter. These are demo scaffolding mixed into the real thread. For a real product they should be removed or gated behind an empty-state. **Recommend: cut them.**
2. **"Overnight" toggle is a dead control.** The Overnight switch in the composer flips state but `handleSend` never reads `overnight` — it does nothing. Either wire it (overnight = queue the run for the harness/scheduled lane) or remove it.
3. **`/dispatch` and `/plan` hints are unimplemented.** The composer placeholder says "type /dispatch or /plan to start a run", but `handleSend` only parses a leading `@mention` — slash commands are sent as literal task text. Either implement them or drop the hint.
4. **Listener match race (edge case).** Incoming stream events match an entry by exact runId, or fall back to (agentId + live) while runId is still unassigned. If you start two runs of the SAME agent within the sub-second runId-assignment gap, the first live entry can absorb the second's events. Rare in normal use; worth a fix if you hit cross-wired output during T5.3.
5. **Two chat systems share the name "chat."** This script tests the Chief-of-Staff agent chat. The harness scope-a-build chat (`chat.rs`, used from Workspace) is separate and untouched by Phases A/B/C — it has its own 120s wall timeout and no silence watchdog. Flag if you want that one hardened too.

---

When done: tell me which T-IDs are F or N. I'll turn each into a paste-ready Code fix prompt, batched sensibly, and we keep your review-before-commit flow.
