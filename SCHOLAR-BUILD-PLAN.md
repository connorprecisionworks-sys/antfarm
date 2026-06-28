# Scholar — Learning agent build plan

Scoped 2026-06-27 (Cowork). Scholar turns "I want to learn X" into something Connor can act on in minutes: it finds good videos, digests transcripts into briefings, ties the ideas to his projects, and proposes a Forge experiment he can approve and build. The goal loop: Connor sees an idea (e.g. an agent memory system) -> pastes the transcript or asks Scholar to find it -> Scholar learns it and proposes how to apply it -> on Connor's go, Forge builds and tests it.

Read this whole file before writing code. The Scholar vault agent already exists at `agents/scholar/` in the antfarm-memory vault (agent.json, identity.md, prompt.md, log.md), networked profile, web only, no Write/Edit/Bash. Build in the phase order below. Each phase pushes to `main` only after its acceptance checks pass and `cargo check` + `npm run build` are both green. No database migrations in this work.

## Locked decisions

- **Learn-and-apply is capability A (build first). Morning discovery is capability B (build second).**
- **Three ways in:** DISCOVER (Scholar web-searches for videos on a topic), URL (Connor pastes YouTube links, the app fetches the transcript), PASTE (raw transcript text).
- **Scholar never writes code and never auto-builds.** It ends a buildable idea with a `---FORGE-PROPOSAL: <one-line request>---` marker. Connor presses "Send to Forge" to turn it into a Forge pod. Stop-for-go is the gate.
- **Forge handoff depends on Forge Phase 2c (`run_pod`).** Build Scholar's proposal marker + button now, but the button calls `run_pod`, so the live handoff only works once Forge 2c lands. Until then the button can be disabled with a "Forge not ready yet" tooltip, or Connor actions the proposal by hand.
- **Anti-hallucination:** Scholar's prompt already forbids inventing techniques/tools/numbers. Nothing to enforce in code; just do not strip the prompt.

## What already exists (reuse)

- The agent spawn + streaming machinery (`run_agent`, `AgentStreamEvent`, watchdog, activity labels) and the networked profile path (web search + fetch, Bash denied) — Scholar is a networked agent like Scout.
- `KNOWN_AGENT_IDS` in Chat.tsx, the chat input + @mention routing, the tabbed panel.
- The morning brief (morning.rs + the Captain Jack morning view) for capability B.
- Forge `run_pod` (from FORGE-BUILD-PLAN.md) for the handoff.

---

## Phase A1 — Register Scholar + the three text inputs

- Confirm `list_agents` discovers `agents/scholar/`. Add `scholar` to `KNOWN_AGENT_IDS` in Chat.tsx.
- The PASTE and DISCOVER paths need no new plumbing: Connor can @scholar in chat and paste a transcript, or ask "find videos about X." Confirm Scholar spawns networked (web yes, Bash/Write/Edit denied) and runs.

**Acceptance:** @scholar with a pasted transcript returns a briefing + key techniques + apply section. @scholar "find videos about agent memory, present findings" returns real ranked picks (web search fired, check the activity label). Confirm Scholar cannot Write/Edit/Bash. `cargo check` + `npm run build` green. Commit + push.

---

## Phase A2 — Auto-pull transcript from a YouTube URL

Add a Tauri command `fetch_youtube_transcript(url: String) -> Result<TranscriptResult, String>`:

```rust
struct TranscriptResult { title: String, channel: String, duration: String, transcript: String }
```

- Use the most robust available method. `yt-dlp` writing auto-subs (`--write-auto-sub --skip-download --sub-format vtt`) then stripping VTT timestamps to plain text is the reliable path; the `youtube-transcript` npm package is a lighter alternative if a Node sidecar is acceptable. Connor has an existing Instagram-transcribe approach — reuse the same method if it generalizes to YouTube.
- Detect and surface the common failure: transcripts disabled / none available -> return a clear error string Scholar/UI can show, do not crash.
- Cap the returned transcript length sanely; if huge, keep it whole but be mindful of the agent context meter.

Wire it so that when Connor pastes one or more YouTube URLs into the Scholar input, the app calls `fetch_youtube_transcript` for each, then feeds the combined transcript text into a Scholar run as the DIGEST input (with the title/channel as context).

**Acceptance:** paste a real YouTube URL with captions -> transcript text comes back and Scholar digests it. Paste a URL with captions disabled -> clean error, no crash. Multiple URLs in one go -> each fetched and digested. `cargo check` + `npm run build` green. Commit + push.

---

## Phase A3 — The Forge handoff (the payoff)

- Detect Scholar's `---FORGE-PROPOSAL: <one-line request>---` marker on a completed run (same pattern as Builder's `---COMMIT:---`, gated so it only renders when the marker is actually present).
- Render a "Send to Forge" card under the run: shows the proposed experiment in plain English + the one-line build request, with a button.
- The button calls `run_pod` (Forge) with the proposal as the task and a repo picker (default `~/Desktop/antfarm-write-test` while dogfooding). This is the stop-for-go gate: nothing builds until Connor clicks.
- If `run_pod` does not exist yet (Forge 2c not landed), disable the button with a tooltip "Forge pod controller not built yet" rather than erroring.

**Acceptance:** a Scholar run that ends with a FORGE-PROPOSAL marker renders the Send-to-Forge card; clicking it (once Forge 2c is in) starts a pod against antfarm-write-test with the proposal as the task. A run with no marker shows no card. `cargo check` + `npm run build` green. Commit + push.

---

## Phase B1 — Morning brief: video picks + knowledge nugget (capability B)

Connor wants a 10-minute morning ritual: coffee, sit down, read something worth knowing, get an idea to try, and see a couple of videos worth watching.

- Extend the morning brief (morning.rs / the morning view) to include a Scholar-sourced section: 2 to 3 video picks relevant to what Connor is actively building (read active/now.md + recent decisions for topics), each with the one-line why-watch, plus one short knowledge nugget or idea-to-try.
- This runs Scholar in DISCOVER mode against the current focus topics as part of the morning generation. Keep it cheap: a single Scholar run, cached with the rest of the morning brief (do not re-search on every reload).
- Each video pick should be actionable: a click to paste/feed it to Scholar for a full digest (ties B back into A).

**Acceptance:** the morning brief shows a "Worth watching" section with real, relevant video picks + a knowledge nugget, generated once and cached with the brief. `cargo check` + `npm run build` green. Commit + push.

---

## Hard gates

- Scholar never writes code or runs Bash. Implementation only ever happens through a Forge pod, after Connor's go.
- The transcript fetch command is a plain process/sidecar call, not routed through any agent's Bash tool.
- Connor verifies the real runs on his machine; Code's report ends at diff + build green + commit + push.
- Respect the context/usage meter: transcripts are large; cache the morning Scholar run.

## Out of scope (do not build now)

- Auto-summarizing every video in a channel / playlists.
- Posting or content-generation from transcripts (that is the separate content pipeline).
- Pointing the Forge handoff at any repo other than antfarm-write-test while dogfooding.
