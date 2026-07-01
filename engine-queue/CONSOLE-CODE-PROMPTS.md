# Console Rung Code Prompts

Paste-ready prompts for the console glow-up rungs (see CONSOLE-SCOPE.md). One bounded rung at a time. Execution work for a cheap/fast model or Claude Code, not the Fable window.

---

## Rung A — Live play-by-play (step narration)

Paste into Claude Code opened in the antfarm repo (`/Users/connordore/Desktop/antfarm`).

```
Implement live step narration for the antfarm engine queue (Console Rung A). Two parts: a tiny Rust change so each pod/spec step prints a machine-readable line, and a poller change to stream those into Supabase as a job runs. The React console already reads `current_phase` and `steps`, so NO console change is needed. Work incrementally; run the gate after each part and report.

PART 1 — Rust (engine): make steps observable on stderr.
- src-tauri/src/pod.rs, function `emit_pod` (~line 58): it already does `let _ = app.emit("pod-stream", ...)`. Add ONE line at the end of the function:
    eprintln!("[STEP]\t{}\t{}", step, text);
- src-tauri/src/spec.rs, function `emit_spec` (~line 74): add after the existing emit:
    eprintln!("[STEP]\t{}\t{}", event.phase, event.item_text.clone().unwrap_or_default());
- Additive only; do not change existing behavior.
- GATE: `cargo build --release` green (this rebuilds the ant-farm binary the poller runs). Report, then continue.

PART 2 — Poller: stream steps into Supabase live.
- engine-queue/poller/index.mjs, function `processQueued`.
- Replace the single `execFileAsync(ANTFARM_BIN, args, EXEC_OPTS)` call with a streamed `spawn` so stderr can be read line-by-line while the job runs:
    - import { spawn } from "node:child_process".
    - Spawn the binary. Accumulate ALL stdout into a string (needed for the existing final parse). Also accumulate all stderr into a string (for NEEDS YOU / error detection). Read stderr incrementally (readline over the stderr stream, or split buffered chunks on newlines).
    - For each stderr line matching /^\[STEP\]\t([^\t]*)\t(.*)$/: phase = group 1, text = group 2. Append { phase, text, ts: new Date().toISOString() } to a local `steps` array and update the job live:
        await supabase.from("jobs").update({ current_phase: phase, steps }).eq("id", job.id);
    - On process close, exit code 0: parse the buffered stdout with the existing parseForgeOutput and set { status: "done", result_summary: stdout, commit_hash, reviewer_note, diff, current_phase: "done" } (keep the accumulated steps).
    - On non-zero exit: if accumulated stderr includes "NEEDS YOU" -> { status: "needs_you", result_summary: stderr }; else { status: "error", error: stderr || "unknown error" }.
- Keep single-job-at-a-time and the approvals-first tick logic unchanged.
- GATE: `node --check index.mjs`.

Report: files changed, cargo build result, node --check result. Do NOT run live — Connor tests by queueing a forge job from the phone and watching the pipeline light up step by step.
```

Connor's gate after Code pushes: restart the poller (`node index.mjs` in engine-queue/poller), queue a forge job on antfarm-write-test from the phone, and watch the console pipeline advance Plan -> Build -> Review -> Done with live plain-English step text.

---

## Rung E + tabs — Agents chat (conversational, with memory) and a two-tab console

Paste into Claude Code opened in the antfarm repo. Three parts (SQL, poller, console). Work incrementally, run the gate after each part, report.

```
Upgrade the antfarm phone console: split it into two tabs (Forge and Agents) and add a conversational chat with any agent, with short-lived memory. Build in this repo. Three parts.

CONTEXT:
- Phone console = Vite React app at engine-queue/console-app/ (src/App.jsx, src/ui.css, src/supabase.js). Access is open (Supabase RLS allows anon).
- Mac poller = engine-queue/poller/index.mjs. It processes rows in the Supabase `jobs` table one at a time.
- Existing tables: `jobs` (id, repo, kind[forge|spec|delegate], task, agent, status, result_summary, diff, commit_hash, reviewer_note, error, approved, steps jsonb, current_phase, created_at, updated_at) and `repos` (name, path, label).

PART 1 — SQL. Write engine-queue/sql/004_chat.sql (and 004_chat_rollback.sql). Do NOT run it (Connor runs it in the Supabase SQL editor). Contents:
- Create table public.messages: id uuid primary key default gen_random_uuid(), agent text not null, role text not null check (role in ('user','assistant')), content text not null, created_at timestamptz not null default now(). Index on (agent, created_at). Enable RLS. Open policy: for all to anon, authenticated using (true) with check (true).
- Allow the 'chat' job kind: `alter table public.jobs drop constraint if exists jobs_kind_check;` then `alter table public.jobs add constraint jobs_kind_check check (kind in ('forge','spec','delegate','chat'));`

PART 2 — Poller (engine-queue/poller/index.mjs):
- Add config: CHAT_MEMORY_HOURS (default 12), CHAT_RETENTION_DAYS (default 3).
- In the queued pick: FIRST query the oldest queued job with kind='chat'; if one exists handle it as chat, else fall back to the existing oldest-queued-job logic (so chat replies are snappy but still one-at-a-time).
- Chat handling for a kind='chat' job:
  - Fetch messages where agent = job.agent and created_at >= (now minus CHAT_MEMORY_HOURS), ordered created_at asc.
  - Build a transcript string: each line `${m.role === 'user' ? 'User' : job.agent}: ${m.content}`, joined by blank lines (this already includes the just-sent user message).
  - Run execFile(ANTFARM_BIN, ['delegate', job.agent, transcript], EXEC_OPTS).
  - On success: insert into messages { agent: job.agent, role: 'assistant', content: stdout.trim() }; set the job status 'done'. Do NOT set steps/current_phase for chat jobs.
  - On failure: insert { agent: job.agent, role: 'assistant', content: (stderr || err.message) }; set job status 'error'.
- Add a periodic cleanup (reuse the repo-scan interval): delete from messages where created_at < (now minus CHAT_RETENTION_DAYS).
- Keep single-job-at-a-time and the approvals-first tick unchanged.
- GATE: node --check index.mjs.

PART 3 — Console (engine-queue/console-app/src/App.jsx + ui.css):
- Add a two-tab switcher under the header: "Forge" and "Agents" (active tab in React state).
- FORGE tab = the current console content, with one change: remove 'delegate' from the kind chips (KINDS = ['forge','spec']) and make the job feed query filter kind in ('forge','spec'). Keep the repo/project dropdown and the live pipeline.
- AGENTS tab = new chat:
  - Agent dropdown at top: values jack, clerk, scout, scribe, pulitzer, scholar; labels Captain Jack, Clerk, Scout, Scribe, Pulitzer, Scholar.
  - Message thread for the selected agent: fetch messages where agent = selected, order created_at asc, poll every 2500ms. User messages right-aligned, assistant left-aligned (chat bubbles).
  - Input + send at bottom. On send: insert a message { agent, role:'user', content } AND insert a job { repo:'-', kind:'chat', agent, task: content }; clear the input. (repo:'-' just satisfies the not-null column; chat ignores it.)
  - Show a subtle "typing..." indicator when the newest message is from the user and no assistant reply has arrived yet.
- Style tabs and bubbles to match the existing dark theme in ui.css.
- GATE: npm run build passes in engine-queue/console-app.

Report: files changed, both gate results, and the exact SQL Connor needs to run. Do NOT run live. Do NOT push yet; report first.
```

Connor after Code reports: run 004_chat.sql in Supabase, restart the poller, redeploy the console (`npx vercel deploy --prod` in console-app), then open the Agents tab and talk to an agent.
