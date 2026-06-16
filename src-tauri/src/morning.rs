use serde_json;
use std::io::{BufRead, BufReader};
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
    { "id": "t1", "text": "<concise task name>", "detail": "<time estimate or context, 8 words max>" }
  ],
  "agent_note": "<one proactive line: a habit reminder, demo prep nudge, or offer to run an agent swarm. Omit this field entirely if nothing useful to say.>"
}

Rules:
- tasks: 4-7 items ordered by leverage factoring in recovery.
- commitments: only hard-scheduled items with times. Use [] if none.
- If whoop-today.json is missing or fetched_at date is not today: set all health numbers to 0, read = "No Whoop data for today."
- Output ONLY the JSON. Nothing else."#;

#[tauri::command]
pub async fn generate_morning_briefing(dispatch: State<'_, DispatchState>) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let brain = format!("{}/Desktop/CD_claude", home);
    let claude = dispatch.claude_path.lock().unwrap().clone();

    tauri::async_runtime::spawn_blocking(move || run_morning(home, brain, claude))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

fn run_morning(home: String, brain: String, claude: String) -> Result<String, String> {
    // Step 1: best-effort whoop refresh (~45s timeout, ignore errors)
    {
        let cmd = format!(
            "node {}/Desktop/CD_claude/tools-built/whoop-report/whoop-fetch.cjs",
            home
        );
        if let Ok(mut child) = Command::new("/bin/zsh")
            .args(["-lc", &cmd])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
        {
            let (tx, rx) = mpsc::channel::<()>();
            std::thread::spawn(move || {
                child.wait().ok();
                tx.send(()).ok();
            });
            let _ = rx.recv_timeout(Duration::from_secs(45));
        }
    }

    // Step 2: headless claude — stream-json, same pattern as summarize_run
    let mut child = Command::new(&claude)
        .args([
            "-p",
            MORNING_PROMPT,
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "dontAsk",
            "--add-dir",
            &brain,
            "--model",
            "claude-sonnet-4-6",
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
        Err("morning briefing returned empty result".into())
    } else {
        Ok(result_text)
    }
}
