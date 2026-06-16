use chrono::Local;
use serde_json;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::State;

use crate::dispatch::DispatchState;

const MORNING_PROMPT: &str = r#"You are Connor's chief of staff and morning agent (think Jarvis).
Connor's rules: no em dashes, direct, warm but sharp.

Read these files via --add-dir: active/whoop-today.json, CLAUDE.md, active/now.md,
active/tomorrow-plan.md, active/school-schedule.md.

Summer context: School (Jupiter Christian) may not be in session. Check school-schedule.md
before listing any school commitments.

Output ONLY this JSON object. No prose, no code fences, nothing else:

{
  "greeting": "<short warm opener, 10 words max>",
  "date_label": "<e.g. JUN 16 · OPEN DAY or JUN 17 · SCHOOL 8:30-3:15>",
  "health": {
    "recovery": <integer 0-100 from whoop-today.json>,
    "sleep_hours": <float 1dp>,
    "sleep_perf": <integer 0-100 sleep performance %>,
    "hrv": <float 1dp ms>,
    "rhr": <integer bpm>,
    "strain": <float 1dp>,
    "read": "<ONE line: how these numbers shape today. Low -> front-load easy work, protect energy for meetings; high -> attack the hardest thing first, good training day.>"
  },
  "day_line": "<one sentence: shape of the day — energy level + key anchor>",
  "commitments": ["<time + event, e.g. 2:00pm Jake ACU call>"],
  "tasks": [
    { "id": "t1", "text": "<e.g. Get the Roastlytics demo ready for Scotty>", "detail": "<time estimate or context, 8 words max>" }
  ],
  "agent_note": "<one proactive line: a habit reminder, demo prep nudge, or offer to run an agent swarm. Omit this field entirely if nothing useful to say.>",
  "auto_planned": false
}

Rules:
- tasks: 3-5 of today's REAL priorities, written like a founder's sticky note — concrete outcomes in plain English (e.g. 'Get the Roastlytics demo ready for Scotty', 'Prep for the 2pm Jake call'). Translate anything technical in the brain into the human GOAL it serves. NEVER output internal engineering substeps or workflow jargon: no 'build', 'test', 'deploy', 'green', 'git push', 'npm run build', 'merge', 'commit', migration/RPC/commit-hash names, or Claude Code/harness steps. If a brain note is a dev task, name the goal, not the steps. Order by leverage, factoring in recovery.
- commitments: only hard-scheduled items with times. Use [] if none.
- active/tomorrow-plan.md may contain a LOCKED plan with header 'Plan for <date> (LOCKED ...)'. If that date matches today's date, use it as the backbone of commitments + tasks (do not re-derive from scratch) and set auto_planned to false. If missing or the date does not match today, auto-generate from active/now.md + recent brain context and set auto_planned to true.
- If whoop-today.json is missing or fetched_at date is not today: set all health numbers to 0, read = "No Whoop data for today."
- Output ONLY the JSON. Nothing else."#;

// ── Plan-sig helper ───────────────────────────────────────────────────────────
// Returns "YYYY-MM-DD|<locked-timestamp>" when tomorrow-plan.md is locked for
// today, or "none" otherwise. This string is stored in the briefing cache so a
// same-day re-lock (new timestamp) naturally busts the cache.

fn today_plan_sig(brain: &str) -> String {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let plan_path = format!("{}/active/tomorrow-plan.md", brain);
    let content = match std::fs::read_to_string(&plan_path) {
        Ok(s) => s,
        Err(_) => return "none".into(),
    };
    let first_line = content.lines().next().unwrap_or("");
    if let Some(rest) = first_line.strip_prefix("# Plan for ") {
        let mut parts = rest.splitn(2, " (LOCKED ");
        let date_part = parts.next().unwrap_or("").trim();
        if date_part == today {
            if let Some(locked_part) = parts.next() {
                let ts = locked_part.trim_end_matches(')');
                return format!("{today}|{ts}");
            }
        }
    }
    "none".into()
}

#[tauri::command]
pub async fn generate_morning_briefing(
    dispatch: State<'_, DispatchState>,
    now: String,
    force: bool,
) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let brain = format!("{}/Desktop/CD_claude", home);
    let claude = dispatch.claude_path.lock().unwrap().clone();

    tauri::async_runtime::spawn_blocking(move || run_morning(brain, claude, now, force))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

pub(crate) fn run_morning(brain: String, claude: String, now: String, force: bool) -> Result<String, String> {
    let today      = Local::now().format("%Y-%m-%d").to_string();
    let plan_sig   = today_plan_sig(&brain);
    let cache_path = format!("{}/active/today-brief.json", brain);

    // Cache hit: same date + same plan_sig -> return unchanged
    if !force {
        if let Ok(raw) = std::fs::read_to_string(&cache_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                let cached_date = v.get("date").and_then(|x| x.as_str()).unwrap_or("");
                let cached_sig  = v.get("plan_sig").and_then(|x| x.as_str()).unwrap_or("X");
                if cached_date == today && cached_sig == plan_sig {
                    if let Some(briefing) = v.get("briefing") {
                        return Ok(briefing.to_string());
                    }
                }
            }
        }
    }

    // No locked plan and not a forced auto-plan: ask instead of guessing
    if plan_sig == "none" && !force {
        return Ok(r#"{"needs_plan":true}"#.into());
    }

    let prompt = format!("Current local date and time: {now}.\n\n{MORNING_PROMPT}");

    let mut child = Command::new(&claude)
        .args([
            "-p",
            &prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "dontAsk",
            "--add-dir",
            &brain,
            "--model",
            "claude-haiku-4-5-20251001",
        ])
        .current_dir(&brain)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let started = Instant::now();
    let max_wall = Duration::from_secs(120);
    let mut result_text = String::new();

    loop {
        if started.elapsed() > max_wall {
            child.kill().ok();
            break;
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                        result_text = v
                            .get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    child.wait().ok();

    if result_text.is_empty() {
        return Err("morning briefing returned empty result".into());
    }

    // Write cache so reloads return the same briefing (busted only by date or new lock)
    if let Ok(bv) = serde_json::from_str::<serde_json::Value>(&result_text) {
        let auto_planned = bv.get("auto_planned").and_then(|v| v.as_bool()).unwrap_or(false);
        let cache_obj = serde_json::json!({
            "date": today,
            "plan_sig": plan_sig,
            "auto_planned": auto_planned,
            "briefing": bv,
        });
        let _ = std::fs::create_dir_all(format!("{}/active", brain));
        let _ = std::fs::write(&cache_path, cache_obj.to_string());
    }

    Ok(result_text)
}

// ── Whoop refresh (decoupled from briefing generation) ────────────────────────

#[tauri::command]
pub async fn refresh_whoop() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let cmd = format!(
            "node {}/Desktop/CD_claude/tools-built/whoop-report/whoop-fetch.cjs",
            home
        );
        let mut child = Command::new("/bin/zsh")
            .args(["-lc", &cmd])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to spawn whoop-fetch: {e}"))?;
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            child.wait().ok();
            tx.send(()).ok();
        });
        match rx.recv_timeout(Duration::from_secs(90)) {
            Ok(()) => Ok("ok".into()),
            Err(_) => Err("whoop-fetch timed out after 90s".into()),
        }
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?
}

// Sync version of refresh_whoop for use from the mobile HTTP server thread.
pub(crate) fn refresh_whoop_blocking() -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let cmd = format!(
        "node {}/Desktop/CD_claude/tools-built/whoop-report/whoop-fetch.cjs",
        home
    );
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", &cmd])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn whoop-fetch: {e}"))?;
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        child.wait().ok();
        tx.send(()).ok();
    });
    match rx.recv_timeout(Duration::from_secs(90)) {
        Ok(()) => Ok("ok".into()),
        Err(_) => Err("whoop-fetch timed out after 90s".into()),
    }
}

// ── Right-now insight ────────────────────────────────────────────────────────

const INSIGHT_PROMPT: &str = r#"You are Connor's live morning coach. Give ONE short, specific recommendation for what to do RIGHT NOW based on his current state. It is SUMMER (no school).

His progress so far: {done_summary}

Also read active/whoop-today.json (recovery/sleep) and CLAUDE.md + active/now.md + active/tomorrow-plan.md for his day and priorities.

React to what he's done. Vibe: "Coffee and breakfast in, you're fueled. Recovery's middling, so knock out the Jake points while you're sharp, then take your workout as the break." / "Workout done. Your focus window's open, start the Roastlytics seed before energy dips."

Output 1-2 sentences, conversational, specific, no fluff, no em dashes. Just the recommendation, nothing else."#;

#[tauri::command]
pub async fn morning_insight(
    dispatch: State<'_, DispatchState>,
    done_summary: String,
    now: String,
) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let brain = format!("{}/Desktop/CD_claude", home);
    let claude = dispatch.claude_path.lock().unwrap().clone();

    tauri::async_runtime::spawn_blocking(move || run_insight(claude, brain, done_summary, now))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

pub(crate) fn run_insight(claude: String, brain: String, done_summary: String, now: String) -> Result<String, String> {
    let base = INSIGHT_PROMPT.replace("{done_summary}", &done_summary);
    let prompt = format!("Current local date and time: {now}.\n\n{base}");
    let args = vec![
        "-p".into(), prompt,
        "--model".into(), "claude-haiku-4-5-20251001".into(),
        "--output-format".into(), "stream-json".into(),
        "--verbose".into(),
        "--permission-mode".into(), "dontAsk".into(),
        "--add-dir".into(), brain.clone(),
    ];
    let (text, _) = crate::chat::run_headless(&claude, args, &brain)?;
    if text.is_empty() {
        Err("morning_insight: empty response".into())
    } else {
        Ok(text)
    }
}

// ── Morning chat ──────────────────────────────────────────────────────────────
//
// Per-day warm-session chat. Turn 1 (cold start): embeds MORNING_CHAT_PROMPT +
// briefing JSON in the -p value and uses --add-dir to give the model the full
// brain. Turn N: --resume <session_id> with only the new user message + current
// time. Session id is persisted to ~/.antfarm/morning-sessions/{date_key}.txt
// so warm follow-ups survive across quick app re-launches within the same day.

const MORNING_CHAT_PROMPT: &str = "You are Connor's morning agent (Jarvis). You know his day. Help him through it: answer follow-ups, react to 'I finished X' by suggesting the next move, recommend, and when something is a real task offer to dispatch it to his agents (1 agent / swarm / orchestrator). Warm, sharp, short. No em dashes.";

fn morning_sessions_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let d = PathBuf::from(home).join(".antfarm/morning-sessions");
    std::fs::create_dir_all(&d).ok();
    d
}

fn load_morning_session_id(date_key: &str) -> Option<String> {
    std::fs::read_to_string(morning_sessions_dir().join(format!("{date_key}.txt")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn save_morning_session_id(date_key: &str, sid: &str) {
    let _ = std::fs::write(morning_sessions_dir().join(format!("{date_key}.txt")), sid);
}

fn morning_turn_core(
    claude: &str,
    brain: &str,
    date_key: &str,
    briefing_json: &str,
    message: &str,
    now: &str,
) -> Result<(String, Option<String>), String> {
    let session_id = load_morning_session_id(date_key);

    let args: Vec<String> = if let Some(sid) = session_id {
        // Warm resume: prepend current time to user message; session carries prior context.
        let msg_with_time = format!("Current local date and time: {now}.\n\n{message}");
        vec![
            "--resume".into(), sid,
            "-p".into(), msg_with_time,
            "--model".into(), "claude-haiku-4-5-20251001".into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
        ]
    } else {
        // Cold start: embed system prompt + time + briefing + user message.
        let prompt = format!(
            "Current local date and time: {now}.\n\n\
             {MORNING_CHAT_PROMPT}\n\n\
             Here is Connor's briefing for today:\n{briefing_json}\n\n\
             You have the full brain directory via --add-dir \
             (active/whoop-today.json, CLAUDE.md, active/now.md, \
             active/tomorrow-plan.md, etc.) and can read any file you need.\n\n\
             User: {message}"
        );
        vec![
            "-p".into(), prompt,
            "--model".into(), "claude-haiku-4-5-20251001".into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
            "--add-dir".into(), brain.into(),
        ]
    };

    crate::chat::run_headless(claude, args, brain)
}

// Full chat turn for the mobile HTTP server: calls morning_turn_core + persists session.
pub(crate) fn morning_chat_turn(
    claude: &str,
    brain: &str,
    date_key: &str,
    briefing_json: &str,
    message: &str,
    now: &str,
) -> Result<String, String> {
    let (reply, new_sid) = morning_turn_core(claude, brain, date_key, briefing_json, message, now)?;
    if let Some(sid) = new_sid {
        save_morning_session_id(date_key, &sid);
    }
    if reply.is_empty() {
        return Err("morning chat: empty reply".into());
    }
    Ok(reply)
}

// ── Assistant (dispatch-aware) chat ──────────────────────────────────────────
//
// Like morning-chat but with a dispatch-detection layer. When the user asks to
// BUILD/FIX/CREATE something in a repo, the model returns a __DISPATCH__ prefix
// so the mobile server can author + arm a plan. Otherwise behaves like morning-chat.

const ASSISTANT_SYSTEM_PROMPT: &str = "You are Jarvis, Connor's sharp chief of staff and morning agent. \
Warm, decisive, no fluff, no em dashes. \
You help Connor through his day and can dispatch agent runs to do technical work.\n\n\
AVAILABLE PROJECTS: {project_slugs}\n\n\
RULES:\n\
• If the user is chatting, asking advice, giving updates, or exploring ideas: reply conversationally in 1-3 sentences.\n\
• If the user is explicitly asking to BUILD, FIX, ADD, CREATE, IMPLEMENT, or DO something \
technical in a project repo: output EXACTLY this on one line and NOTHING else:\n\
__DISPATCH__ {{\"task\":\"<specific concrete task>\",\"project_slug\":\"<slug>\"}}\n\
  Pick the most likely project slug from the list. If unclear, ask in CHAT mode.\n\
• Do NOT dispatch for planning talk, analysis, or anything that is not code/infra work.\n\n\
Connor's briefing for today:\n{briefing_json}";

fn assistant_sessions_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let d = PathBuf::from(home).join(".antfarm/assistant-sessions");
    std::fs::create_dir_all(&d).ok();
    d
}

fn load_assistant_session_id(date_key: &str) -> Option<String> {
    std::fs::read_to_string(assistant_sessions_dir().join(format!("{date_key}.txt")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn save_assistant_session_id(date_key: &str, sid: &str) {
    let _ = std::fs::write(assistant_sessions_dir().join(format!("{date_key}.txt")), sid);
}

pub(crate) struct DispatchIntent {
    pub task: String,
    pub project_slug: String,
}

pub(crate) enum AssistantReply {
    Chat(String),
    Dispatch(DispatchIntent),
}

fn assistant_turn_core(
    claude: &str,
    brain: &str,
    date_key: &str,
    briefing_json: &str,
    message: &str,
    now: &str,
    project_slugs: &str,
) -> Result<(AssistantReply, Option<String>), String> {
    let session_id = load_assistant_session_id(date_key);

    let args: Vec<String> = if let Some(sid) = &session_id {
        let msg_with_time = format!("Current local date and time: {now}.\n\n{message}");
        vec![
            "--resume".into(), sid.clone(),
            "-p".into(), msg_with_time,
            "--model".into(), "claude-haiku-4-5-20251001".into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
        ]
    } else {
        let system = ASSISTANT_SYSTEM_PROMPT
            .replace("{project_slugs}", project_slugs)
            .replace("{briefing_json}", briefing_json);
        let prompt = format!("Current local date and time: {now}.\n\n{system}\n\nUser: {message}");
        vec![
            "-p".into(), prompt,
            "--model".into(), "claude-haiku-4-5-20251001".into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
            "--add-dir".into(), brain.into(),
        ]
    };

    let (raw_reply, new_sid) = crate::chat::run_headless(claude, args, brain)?;

    let reply = if let Some(json_part) = raw_reply.trim().strip_prefix("__DISPATCH__") {
        match serde_json::from_str::<serde_json::Value>(json_part.trim()) {
            Ok(v) => {
                let task = v.get("task").and_then(|t| t.as_str()).unwrap_or("").to_string();
                let slug = v.get("project_slug").and_then(|s| s.as_str()).unwrap_or("").to_string();
                if !task.is_empty() && !slug.is_empty() {
                    AssistantReply::Dispatch(DispatchIntent { task, project_slug: slug })
                } else {
                    AssistantReply::Chat(raw_reply)
                }
            }
            Err(_) => AssistantReply::Chat(raw_reply),
        }
    } else {
        AssistantReply::Chat(raw_reply)
    };

    Ok((reply, new_sid))
}

pub(crate) fn assistant_chat_turn(
    claude: &str,
    brain: &str,
    date_key: &str,
    briefing_json: &str,
    message: &str,
    now: &str,
    project_slugs: &str,
) -> Result<(AssistantReply, Option<String>), String> {
    let (reply, new_sid) = assistant_turn_core(
        claude, brain, date_key, briefing_json, message, now, project_slugs,
    )?;
    if let Some(sid) = &new_sid {
        save_assistant_session_id(date_key, sid);
    }
    Ok((reply, new_sid))
}

#[tauri::command]
pub async fn morning_chat_send(
    dispatch: State<'_, DispatchState>,
    date_key: String,
    briefing_json: String,
    message: String,
    now: String,
) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let brain = format!("{}/Desktop/CD_claude", home);
    let claude = dispatch.claude_path.lock().unwrap().clone();

    let dk = date_key.clone();
    let bj = briefing_json.clone();

    let (reply, new_sid) = tauri::async_runtime::spawn_blocking(move || {
        morning_turn_core(&claude, &brain, &dk, &bj, &message, &now)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))??;

    if let Some(sid) = new_sid {
        save_morning_session_id(&date_key, &sid);
    }

    if reply.is_empty() {
        return Err("morning chat: empty reply from model".into());
    }
    Ok(reply)
}
