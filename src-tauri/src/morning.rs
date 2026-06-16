use serde_json;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::State;

use crate::dispatch::DispatchState;

const MORNING_PROMPT: &str = r#"You are Connor's chief of staff and morning agent (think Jarvis). Generate his morning briefing as scannable markdown for his phone. Follow his rules: no em dashes, no fluff, direct, warm but sharp.

Read these files (you have them via --add-dir): active/whoop-today.json (his Whoop health), CLAUDE.md (priorities + how he works), active/now.md and active/tomorrow-plan.md (in-flight work + the day plan), active/school-schedule.md (schedule).

Produce, in this order:
1. A HEALTH READ from whoop-today.json: recovery %, sleep hours + performance, HRV, resting HR, yesterday's strain — then ONE sharp line predicting how today should go and how to flex intensity (low recovery / restless -> front-load light work, protect energy for meetings, maybe skip a hard workout; high recovery -> attack the hardest thing first, good training day). If the file is missing or fetched_at is not today, say so in one line.
2. TODAY: date, weekday, fixed commitments/meetings with times.
3. THE PLAN: the prioritized things to do today (lean on tomorrow-plan.md / now.md), ordered by leverage, factoring in his recovery.
4. START HERE: the single first task + one line why.
5. A short proactive nudge or two (a habit, a prep reminder for upcoming demos, an offer to run an agent swarm on something) — keep it human, like a manager who knows him.
End with one line: the #1 thing that makes today a win.
Keep it tight."#;

#[tauri::command]
pub fn generate_morning_briefing(dispatch: State<'_, DispatchState>) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let brain = format!("{}/Desktop/CD_claude", home);

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

    // Step 2: headless claude briefing — same stream-json pattern as summarize_run
    let claude = dispatch.claude_path.lock().unwrap().clone();

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
