# Scholar — Claude Code prompts

Paste these into Claude Code, in the `antfarm` repo, one phase at a time. After each phase, paste Code's report back to Cowork for review before sending the next. Every Rust change needs a full `npm run tauri dev` restart before testing. No database migrations in this work.

Sequencing note: Phase A3 (the Forge handoff) needs Forge Phase 2c (`run_pod`) to exist. You can build A1 and A2 now regardless. Build A3's card + button now too, but the button stays disabled until Forge 2c lands.

---

## Prompt 1 — Phase A1 (register Scholar + text inputs)

```
Read SCHOLAR-BUILD-PLAN.md in the repo root, all of it, before writing any code. It is the build plan for the Scholar learning agent.

Build Phase A1 ONLY: the scholar vault agent already exists at agents/scholar/ in the antfarm-memory vault. Confirm list_agents discovers it, add scholar to KNOWN_AGENT_IDS in Chat.tsx, and confirm it spawns as a networked agent (web search and fetch allowed, Bash and Write and Edit denied).

Report back with the file diff, cargo check and npm run build results, and proof from two live runs: (1) @scholar with a pasted transcript returns a briefing plus key techniques plus an apply section, and (2) @scholar asked to find videos about a topic fires a real web search and returns ranked picks. Stop for my review before moving on.
```

---

## Prompt 2 — Phase A2 (auto-pull transcript from a URL)

```
Phase A1 is approved. Build Phase A2 from SCHOLAR-BUILD-PLAN.md: the fetch_youtube_transcript Tauri command and the wiring so pasted YouTube URLs auto-pull the transcript and feed it into a Scholar digest run.

Use the most robust transcript method available (yt-dlp auto-subs stripped to plain text is reliable; the youtube-transcript npm package is a lighter option). Handle the captions-disabled case with a clean error, not a crash. Support multiple URLs in one go.

Report back with the file diff, cargo check and npm run build results, and proof from live runs against a real captioned YouTube URL (transcript pulled and digested), a captions-disabled URL (clean error), and two URLs at once. Stop for my review before moving on.
```

---

## Prompt 3 — Phase A3 (Forge handoff)

```
Phase A2 is approved. Build Phase A3 from SCHOLAR-BUILD-PLAN.md: the Forge handoff.

Detect Scholar's ---FORGE-PROPOSAL: <request>--- marker on a completed run (same gated pattern as Builder's ---COMMIT:--- card). Render a Send-to-Forge card showing the proposed experiment plus the one-line build request and a button. The button calls run_pod with the proposal as the task and a repo picker defaulting to ~/Desktop/antfarm-write-test. If run_pod does not exist yet, disable the button with a tooltip "Forge pod controller not built yet" instead of erroring.

Report back with the file diff and cargo check and npm run build results, plus confirmation that a Scholar run ending in a FORGE-PROPOSAL marker shows the card and a run without the marker does not. Stop for my review before Phase B1.
```

---

## Prompt 4 — Phase B1 (morning brief: video picks + knowledge nugget)

```
Phase A3 is approved. Build Phase B1 from SCHOLAR-BUILD-PLAN.md: add a Scholar-sourced section to the morning brief.

Extend the morning brief to include 2 to 3 video picks relevant to what Connor is actively building (read active/now.md and recent decisions for topics) each with a one-line why-watch, plus one short knowledge nugget or idea-to-try. Run Scholar in discover mode once as part of morning generation and cache it with the rest of the morning brief so it does not re-search on every reload. Make each pick clickable to feed it to Scholar for a full digest.

Report back with the file diff and cargo check and npm run build results. I will check the morning brief on my machine.
```
