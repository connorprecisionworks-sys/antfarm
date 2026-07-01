# Antfarm Console — Full Scope

The mobile mission control for the whole farm. From your phone: see every agent working, start work by talking to it in plain English, watch it happen step by step, get buzzed when it needs you, review and approve, and set recurring auto-checks. The engine runs on the Mac; the phone commands and reviews. No open ports (everything flows through Supabase).

## What "perfect" means (your vision, plain English)

1. See all my agents. One live view of what every agent is doing right now: Captain Jack, Clerk, Pulitzer, Scholar, and the coding crew (Forge). Not just coding jobs.
2. Start work by talking. I type (or say) what I want in plain English and it figures out the right agent, project, and job. I can also have a back-and-forth conversation with an agent, like texting them.
3. Watch it happen. Play-by-play in plain English while a job runs: planning, building, reviewing, done. It feels alive.
4. Review and approve. See what got done in plain English, read the change, approve it to go live or send it back with notes.
5. Buzz me. My phone alerts me when something finishes or needs my decision, so I am not babysitting it.
6. Run on a schedule. Recurring automated jobs, like a daily bug check or code review on a project, without me starting them.

## Where it stands today (already shipped)

- Engine as a headless command (`ant-farm forge/spec/delegate`), plus an MCP server so Cowork and Claude Code can trigger it.
- A Supabase job queue and a Mac poller: the phone drops a job, the Mac runs it with the full Planner/Builder/Reviewer crew, commits locally, and only pushes when you approve.
- A React mobile console (dark, ChatGPT/Anthropic style): queue a job, see status, view the diff, approve and ship.
- A repo picker: the poller scans your machine and the console shows your real projects as a dropdown with friendly names (Roastlytics maps to roast-dash), plus name aliases.

## The build, in rungs (each one is useful on its own)

### Rung A — Play-by-play progress (live narration)
What you get: while a job runs, the console shows each step in plain English and the pipeline lights up Plan to Build to Review to Done, live.
What it needs:
- Tiny engine tweak: each step prints a friendly line the poller can read.
- Poller upgrade: stream those lines into the job's `steps` and `current_phase` as it runs (the schema and the console already support this; the console pipeline reads them automatically).
Effort: small. Impact: high (this is the "wow, it's actually doing it" moment).

### Rung B — Buzz me (push notifications)
What you get: your phone buzzes when a job finishes or needs your decision. Tap the notification to jump to it.
What it needs:
- Make the console an installable app (add to home screen). On iPhone, notifications require the app be added to the home screen once.
- Web push setup: a small set of push keys, a table of your device subscriptions, and the poller sends a push when a job flips to done or needs-you.
Effort: medium. Impact: high (removes babysitting).

### Rung C — Recurring auto-jobs (scheduled checks)
What you get: set it and forget it. "Every morning, run a bug check on Roastlytics." It queues itself, runs, and buzzes you with anything worth seeing.
What it needs:
- A schedules table (what to run, where, how often).
- The poller checks schedules and enqueues jobs when due (reuses everything else).
- Console screen to create, pause, and delete schedules.
- A couple of ready-made job templates (bug check, code review, dependency check).
Effort: medium. Impact: high (turns the farm proactive).

### Rung D — See all agents (unified activity feed)
What you get: one live feed of everything every agent does, coding or not, not just queue jobs. Grouped by agent, newest first, each with a plain-English summary and status.
What it needs:
- An activity table every agent run writes to.
- The Antfarm desktop app publishes each agent run (start, finish, summary) to that table, including scheduled runs and chat runs. This is the core new plumbing that makes the phone a true mission control.
- Console feed view, filterable by agent.
Effort: medium-large (touches the desktop app). Impact: high (this is the "see everything" you asked for).

### Rung E — Talk to it (conversational intake + agent chat)
What you get: type what you want in plain English and it routes to the right agent, project, and job type. Plus real back-and-forth threads with any agent, like texting Jack or Clerk from your phone.
What it needs:
- Conversation model in Supabase (threads + messages), one thread per agent or topic.
- Routing: your message goes to Captain Jack (the orchestrator), who decides whether to answer, hand it to a coding pod, or delegate to another agent. Reuses Jack's existing delegation.
- The poller runs each turn and writes replies back; the console shows the thread and streams the reply.
- Plain-English intake that auto-fills project and job type, with an option to fine-tune.
Effort: large (this is the biggest piece). Impact: very high (this is the "just talk to it" dream).

### Rung F — Make it perfect (polish)
What you get: it feels like a real, premium app.
Candidates:
- Instant updates (live subscription instead of polling).
- Add-to-home-screen app icon, splash, offline shell.
- Send-back-with-notes: reject a result with a comment that spins a fix job.
- Nicer diff viewer (color, collapsible files).
- Subtle "the ants are working" animation for that wow factor.
- Optional light lock again if you ever share the URL (a real one, not the fake password).
Effort: ongoing. Impact: medium (the shine).

## Recommended order

A (play-by-play) first because it is small and makes everything feel alive. Then B (buzz me) so you stop checking. Then C (recurring checks) for proactive value. Then D (see all agents) and E (talk to it) as the two big builds that complete the mission-control vision. F (polish) folds in along the way.

## Decisions still open

- Notifications on iPhone need you to add the app to your home screen once. OK?
- "Chat with an agent" over the queue means each reply waits for the Mac to run it (seconds, not instant like a normal chat). Acceptable, or do you want it to feel instant?
- Security is currently open (no login). Fine while the URL is private. Revisit if you ever want it locked.

## In plain English

Today you can send a coding job from your phone and approve it. This scope turns that into a full remote control for your whole team of agents: watch them work in real time, get buzzed when they need you, talk to them in plain language, and set them to run checks on their own. We build it in small rungs so each step works and pays off before the next.
