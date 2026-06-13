// dispatch.rs — Antfarm headless dispatch
//
// Spawns `claude -p` runs, streams their stream-json stdout to the frontend
// as Tauri events, and persists run records under ~/.antfarm/runs/.
//
// Fixes applied to the reference scaffold:
//   - PATH resolution via login shell at startup (no bare "claude" for .app)
//   - native --worktree flag instead of hand-rolled git worktree add
//   - kill_run writes "killed" immediately; reader thread never overwrites it
//   - per-run permission-mode choice from the UI
//   - session_id captured from the stream-json init line

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

// ── Shared state ──────────────────────────────────────────────────────────────

pub struct DispatchState {
    children:    Arc<Mutex<HashMap<String, Child>>>,
    killed:      Arc<Mutex<HashSet<String>>>,
    pub claude_path: Arc<Mutex<String>>,
}

impl Default for DispatchState {
    fn default() -> Self {
        Self {
            children:    Arc::new(Mutex::new(HashMap::new())),
            killed:      Arc::new(Mutex::new(HashSet::new())),
            claude_path: Arc::new(Mutex::new("claude".to_string())),
        }
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub run_id:          String,
    pub project_path:    String,
    pub effective_cwd:   String,
    pub prompt:          String,
    pub status:          String,  // "running" | "done" | "failed" | "killed"
    pub started_at:      String,
    pub finished_at:     Option<String>,
    pub used_worktree:   bool,
    pub session_id:      Option<String>,
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id:  String,
    pub kind:    String,  // "line" | "stderr" | "status"
    pub payload: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

fn runs_dir() -> PathBuf {
    let d = home().join(".antfarm/runs");
    std::fs::create_dir_all(&d).ok();
    d
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_run_id() -> String {
    let n = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("run-{ts}-{n:04}")
}

fn save_record(rec: &RunRecord) {
    if let Ok(json) = serde_json::to_string_pretty(rec) {
        let _ = std::fs::write(runs_dir().join(format!("{}.json", rec.run_id)), json);
    }
}

fn emit_event(app: &AppHandle, ev: RunEvent) {
    app.emit("antfarm-run-event", &ev).ok();
}

/// Resolve the claude CLI via a login shell so a Finder-launched .app picks
/// up NVM, Homebrew, and custom PATH from ~/.zprofile / ~/.zshrc.
pub fn resolve_claude_path() -> String {
    if let Ok(out) = Command::new("/bin/zsh").args(["-lc", "command -v claude"]).output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                eprintln!("antfarm dispatch: resolved claude → {p}");
                return p;
            }
        }
    }
    let h = home();
    for candidate in [
        h.join(".local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        h.join(".npm-global/bin/claude"),
    ] {
        if candidate.exists() {
            let s = candidate.to_string_lossy().into_owned();
            eprintln!("antfarm dispatch: resolved claude → {s} (fallback)");
            return s;
        }
    }
    eprintln!("antfarm dispatch: claude not found; falling back to bare 'claude'");
    "claude".to_string()
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn dispatch_run(
    app: AppHandle,
    state: State<'_, DispatchState>,
    project_path: String,
    prompt: String,
    use_worktree: bool,
    permission_mode: String,
) -> Result<RunRecord, String> {
    let run_id  = new_run_id();
    let claude  = state.claude_path.lock().unwrap().clone();

    let mut args: Vec<String> = vec![
        "-p".into(), prompt.clone(),
        "--output-format".into(), "stream-json".into(),
        "--verbose".into(),
        "--permission-mode".into(), permission_mode.clone(),
    ];
    if use_worktree {
        args.push("--worktree".into());
    }

    let mut child = Command::new(&claude)
        .args(&args)
        .current_dir(&project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn {claude}: {e}"))?;

    let mut rec = RunRecord {
        run_id:          run_id.clone(),
        project_path:    project_path.clone(),
        effective_cwd:   project_path.clone(),
        prompt,
        status:          "running".into(),
        started_at:      now_iso(),
        finished_at:     None,
        used_worktree:   use_worktree,
        session_id:      None,
        permission_mode,
    };
    save_record(&rec);

    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take();
    state.children.lock().unwrap().insert(run_id.clone(), child);

    // ── stdout reader ──────────────────────────────────────────────────────
    {
        let app2     = app.clone();
        let rid      = run_id.clone();
        let children = state.children.clone();
        let killed   = state.killed.clone();
        let mut local = rec.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }

                // Capture session_id from the stream-json init line
                if local.session_id.is_none() {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("system")
                            && v.get("subtype").and_then(|t| t.as_str()) == Some("init")
                        {
                            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                                local.session_id = Some(sid.to_string());
                                save_record(&local);
                            }
                        }
                    }
                }

                emit_event(&app2, RunEvent {
                    run_id: rid.clone(), kind: "line".into(), payload: line,
                });
            }

            // Reap child
            let exit_status = {
                let mut map = children.lock().unwrap();
                map.remove(&rid).and_then(|mut c| c.wait().ok())
            };

            // kill_run marks the run before killing, so check the flag
            // before writing a final status to avoid overwriting "killed".
            if killed.lock().unwrap().contains(&rid) {
                emit_event(&app2, RunEvent {
                    run_id: rid, kind: "status".into(), payload: "killed".into(),
                });
                return;
            }

            let final_status = match exit_status {
                Some(s) if s.success() => "done",
                Some(_)                => "failed",
                None                   => "done",
            };
            local.status      = final_status.into();
            local.finished_at = Some(now_iso());
            save_record(&local);
            emit_event(&app2, RunEvent {
                run_id: rid, kind: "status".into(), payload: final_status.into(),
            });
        });
    }

    // ── stderr reader ──────────────────────────────────────────────────────
    if let Some(stderr) = stderr {
        let app2 = app.clone();
        let rid  = run_id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                emit_event(&app2, RunEvent {
                    run_id: rid.clone(), kind: "stderr".into(), payload: line,
                });
            }
        });
    }

    rec.status = "running".into();
    Ok(rec)
}

#[tauri::command]
pub fn list_runs(project_path: Option<String>) -> Result<Vec<RunRecord>, String> {
    let mut runs = vec![];
    if let Ok(entries) = std::fs::read_dir(runs_dir()) {
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                if let Ok(rec) = serde_json::from_str::<RunRecord>(&text) {
                    if let Some(ref filter) = project_path {
                        if &rec.project_path != filter { continue; }
                    }
                    runs.push(rec);
                }
            }
        }
    }
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(runs)
}

#[tauri::command]
pub fn kill_run(state: State<'_, DispatchState>, run_id: String) -> Result<(), String> {
    // Mark as killed BEFORE touching the child so the reader thread
    // always sees the flag when stdout eventually closes.
    state.killed.lock().unwrap().insert(run_id.clone());

    let child = state.children.lock().unwrap().remove(&run_id);
    if let Some(mut child) = child {
        child.kill().ok(); // ignore errors (already dead is fine)
        // Write "killed" to disk immediately so a restart shows the right status.
        let rec_path = runs_dir().join(format!("{run_id}.json"));
        if let Ok(text) = std::fs::read_to_string(&rec_path) {
            if let Ok(mut rec) = serde_json::from_str::<RunRecord>(&text) {
                rec.status      = "killed".into();
                rec.finished_at = Some(now_iso());
                save_record(&rec);
            }
        }
        Ok(())
    } else {
        Err(format!("no running process for {run_id}"))
    }
}

/// Open macOS Terminal at `cwd` and resume a claude session by `sid`.
/// Shared by take_over_run (dispatch) and take_over_overnight_run (harness).
pub fn open_terminal_resume(cwd: &str, sid: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"Terminal\"\n\
         do script (\"cd \" & quoted form of {cwd:?} & \" && claude --resume {sid}\")\n\
         activate\n\
         end tell",
        cwd = cwd,
        sid = sid,
    );
    use std::io::Write;
    let mut child = Command::new("osascript")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if let Some(w) = child.stdin.as_mut() {
        w.write_all(script.as_bytes()).ok();
    }
    Ok(())
}

#[tauri::command]
pub fn take_over_run(run_id: String) -> Result<(), String> {
    let rec: RunRecord = std::fs::read_to_string(runs_dir().join(format!("{run_id}.json")))
        .map_err(|e| format!("run not found: {e}"))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))?;
    let sid = rec.session_id
        .ok_or_else(|| "session_id not yet captured for this run".to_string())?;
    open_terminal_resume(&rec.effective_cwd, &sid)
}
