use base64::{engine::general_purpose, Engine as _};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub(crate) struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyState(pub Arc<Mutex<HashMap<String, PtyEntry>>>);

impl Default for PtyState {
    fn default() -> Self {
        PtyState(Arc::new(Mutex::new(HashMap::new())))
    }
}

/// CD_claude brain directory — the orchestrator boots with read access to this
/// so it carries cross-project memory, not just the current repo.
fn brain_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    format!("{}/Desktop/CD_claude", home)
}

#[tauri::command]
pub fn spawn_pty(
    pane_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    kind: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    // Kill any pre-existing PTY for this pane (e.g. hot reload)
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(mut old) = guard.remove(&pane_id) {
            let _ = old.child.kill();
        }
    }

    let pty_system = NativePtySystem::default();
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    // Resolve CWD — fall back to $HOME if empty or non-existent
    let cwd_resolved = if !cwd.is_empty() && std::path::Path::new(&cwd).is_dir() {
        cwd
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
    };

    // Build the command. Plain shell = interactive login-capable shell.
    // Orchestrator / executor = launch `claude` through a login shell (so PATH
    // and tools resolve) via `exec`, so claude owns the PTY directly.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.cwd(&cwd_resolved);

    match kind.as_deref() {
        Some("orchestrator") => {
            let claude = crate::dispatch::resolve_claude_path();
            let brain = brain_dir();
            // Orchestrator: Opus 4.8 (the planner), + cross-project brain via --add-dir.
            cmd.args([
                "-lc",
                &format!("exec \"{}\" --add-dir \"{}\" --model claude-opus-4-8", claude, brain),
            ]);
        }
        Some("executor") => {
            let claude = crate::dispatch::resolve_claude_path();
            // Executor: Sonnet 4.6 (cheap volume execution).
            cmd.args(["-lc", &format!("exec \"{}\" --model claude-sonnet-4-6", claude)]);
        }
        // "shell" or None — plain interactive shell, unchanged behavior.
        _ => {}
    }

    // Spawn child; slave is still held in pair until we destructure below
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop pair.slave in the parent — child holds the open slave FD
    let master = pair.master;
    drop(pair.slave);

    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    {
        let mut guard = state.0.lock().unwrap();
        guard.insert(pane_id.clone(), PtyEntry { writer, master, child });
    }

    // Background thread: read PTY output → base64-encode → emit as Tauri event
    let event_name = format!("pty-output-{}", pane_id);
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,  // EOF — child exited
                Ok(n) => {
                    let encoded = general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_clone.emit(&event_name, encoded);
                }
                Err(_) => break, // EIO or closed master
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_pty(
    pane_id: String,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(entry) = guard.get_mut(&pane_id) {
        entry.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = entry.writer.flush();
    }
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    pane_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    if let Some(entry) = guard.get(&pane_id) {
        entry
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn kill_pty(
    pane_id: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut entry) = guard.remove(&pane_id) {
        let _ = entry.child.kill();
    }
    Ok(())
}

/// Kill all live PTYs — call on window close to prevent zombie shell processes.
pub fn kill_all(map: &Arc<Mutex<HashMap<String, PtyEntry>>>) {
    let mut guard = map.lock().unwrap();
    for (_, mut entry) in guard.drain() {
        let _ = entry.child.kill();
    }
}
