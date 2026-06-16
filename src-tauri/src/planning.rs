use chrono::Local;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

use crate::dispatch::DispatchState;

const PLAN_CHAT_PROMPT: &str = "You are Connor's nightly planning partner / chief of staff. \
It is the night before. Your job: help him LOCK what he works on tomorrow. \
Read the brain via --add-dir: CLAUDE.md, active/now.md, active/tomorrow-plan.md, \
active/whoop-today.json, and project decisions. \
Ask sharp questions ONE or TWO at a time -- hard commitments + times, the ONE big rock \
that must move tomorrow, what he's mid-build on (Roastlytics demo, Antfarm, Golden Bean), \
personal (workout/reading), when he wants to start. \
Push him to DECIDE; don't let him stay vague. \
Reference what he's actually working on. \
When the day feels set, tell him to hit 'Lock tomorrow's plan.' \
Warm, direct, short. No em dashes.";

fn brain_path() -> String {
    format!(
        "{}/Desktop/CD_claude",
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
    )
}

fn plan_sessions_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let d = PathBuf::from(home).join(".antfarm/plan-sessions");
    std::fs::create_dir_all(&d).ok();
    d
}

fn load_plan_session_id(date_key: &str) -> Option<String> {
    std::fs::read_to_string(plan_sessions_dir().join(format!("{date_key}.txt")))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn save_plan_session_id(date_key: &str, sid: &str) {
    let _ = std::fs::write(plan_sessions_dir().join(format!("{date_key}.txt")), sid);
}

fn today_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn tomorrow_key() -> String {
    let t = Local::now() + chrono::Duration::days(1);
    t.format("%Y-%m-%d").to_string()
}

fn plan_turn_core(
    claude: &str,
    brain: &str,
    date_key: &str,
    message: &str,
    now: &str,
) -> Result<(String, Option<String>), String> {
    let session_id = load_plan_session_id(date_key);

    let args: Vec<String> = if let Some(sid) = session_id {
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
        let prompt = format!(
            "Current local date and time: {now}.\n\n\
             {PLAN_CHAT_PROMPT}\n\n\
             You have the full brain directory via --add-dir (CLAUDE.md, active/now.md, \
             active/tomorrow-plan.md, active/whoop-today.json, etc.) \
             and can read any file you need.\n\n\
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

fn lock_turn_core(
    claude: &str,
    brain: &str,
    date_key: &str,
    now: &str,
    tomorrow: &str,
) -> Result<(String, Option<String>), String> {
    let lock_base = format!(
        "Output ONLY the locked plan as markdown, no preamble. \
         First line EXACTLY: '# Plan for {tomorrow}'. \
         Sections: ## Big rock; ## Commitments (time + event, [] if none); \
         ## Work blocks (ordered by leverage); ## Personal; ## Notes. \
         Base it on our whole conversation + the brain. \
         Plain founder language, no engineering/build/deploy/git jargon."
    );

    let session_id = load_plan_session_id(date_key);

    let args: Vec<String> = if let Some(sid) = session_id {
        let instruction = format!("Current local date and time: {now}.\n\n{lock_base}");
        vec![
            "--resume".into(), sid,
            "-p".into(), instruction,
            "--model".into(), "claude-haiku-4-5-20251001".into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
        ]
    } else {
        let prompt = format!(
            "Current local date and time: {now}.\n\n\
             {PLAN_CHAT_PROMPT}\n\n\
             You have the brain via --add-dir. \
             The user wants to lock tomorrow's plan directly.\n\n\
             {lock_base}"
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

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn plan_chat_send(
    dispatch: State<'_, DispatchState>,
    message: String,
    now: String,
) -> Result<String, String> {
    let brain = brain_path();
    let claude = dispatch.claude_path.lock().unwrap().clone();
    let date_key = today_key();
    let dk = date_key.clone();

    let (reply, new_sid) = tauri::async_runtime::spawn_blocking(move || {
        plan_turn_core(&claude, &brain, &dk, &message, &now)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))??;

    if let Some(sid) = new_sid {
        save_plan_session_id(&date_key, &sid);
    }

    if reply.is_empty() {
        return Err("plan chat: empty reply".into());
    }
    Ok(reply)
}

#[tauri::command]
pub async fn lock_tomorrow_plan(
    dispatch: State<'_, DispatchState>,
    now: String,
) -> Result<String, String> {
    let brain = brain_path();
    let claude = dispatch.claude_path.lock().unwrap().clone();
    let date_key = today_key();
    let tomorrow = tomorrow_key();

    let brain2  = brain.clone();
    let dk      = date_key.clone();
    let now2    = now.clone();
    let tmrw    = tomorrow.clone();

    let (raw_md, new_sid) = tauri::async_runtime::spawn_blocking(move || {
        lock_turn_core(&claude, &brain2, &dk, &now2, &tmrw)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))??;

    if let Some(sid) = new_sid {
        save_plan_session_id(&date_key, &sid);
    }

    if raw_md.is_empty() {
        return Err("lock_tomorrow_plan: empty response from model".into());
    }

    // Strip markdown code fences if model wrapped the output
    let clean = raw_md
        .trim()
        .trim_start_matches("```markdown")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();

    // Append " (LOCKED <now>)" to the first line (the # Plan for ... header)
    let locked_md = if let Some(nl) = clean.find('\n') {
        format!("{} (LOCKED {}){}", &clean[..nl], now, &clean[nl..])
    } else {
        format!("{} (LOCKED {})", clean, now)
    };

    // Write to active/tomorrow-plan.md
    let active_dir = format!("{}/active", brain);
    std::fs::create_dir_all(&active_dir)
        .map_err(|e| format!("could not create active dir: {e}"))?;
    let plan_path = format!("{}/tomorrow-plan.md", active_dir);
    std::fs::write(&plan_path, &locked_md)
        .map_err(|e| format!("failed to write tomorrow-plan.md: {e}"))?;

    Ok(locked_md)
}

#[derive(Serialize)]
pub struct TomorrowPlan {
    pub locked: bool,
    pub target_date: String,
    pub markdown: String,
}

#[tauri::command]
pub async fn get_tomorrow_plan() -> Result<TomorrowPlan, String> {
    let brain    = brain_path();
    let tomorrow = tomorrow_key();
    let plan_path = format!("{}/active/tomorrow-plan.md", brain);

    let markdown = match std::fs::read_to_string(&plan_path) {
        Ok(s) => s,
        Err(_) => {
            return Ok(TomorrowPlan {
                locked: false,
                target_date: tomorrow,
                markdown: String::new(),
            })
        }
    };

    // Parse first line: "# Plan for YYYY-MM-DD" or "# Plan for YYYY-MM-DD (LOCKED ...)"
    let first_line = markdown.lines().next().unwrap_or("");
    let target_date = first_line
        .strip_prefix("# Plan for ")
        .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
        .unwrap_or_default();

    let locked = first_line.contains("(LOCKED") && target_date == tomorrow;

    Ok(TomorrowPlan {
        locked,
        target_date: if target_date.is_empty() { tomorrow } else { target_date },
        markdown,
    })
}
