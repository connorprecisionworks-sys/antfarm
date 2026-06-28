// agents.rs — Agent registry + runner backend.
//
// Phase 1: list_agents() and get_agent(id) reading antfarm-memory/agents/*/agent.json.
// Phase 2: run_agent() — spawns claude -p, streams stdout as "agent-stream" events,
//          appends outcome to agent's log.md.
// Phase 3: delegation fan-out support (parent_run_id), write-scope hardening via
//          system prompt, NEEDS YOU injection for subagents.
//
// READ access: full vault via --add-dir so agents can read active/, agents/*, etc.
// WRITE scope: constrained by prompt instruction to agents/<id>/ and active/ only.

use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dispatch::DispatchState;

const COMPACT_THRESHOLD_PCT: f32 = 50.0;
const MODEL_CONTEXT_WINDOW: u32  = 200_000;
const SILENCE_SECS: u64 = 300;
const WALL_SECS: u64    = 1800;

// ── Path ──────────────────────────────────────────────────────────────────────

pub fn vault_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join("Desktop")
        .join("antfarm-memory")
}

/// Expand a leading `~` to $HOME so callers can accept `~/Desktop/…` paths.
pub fn expand_tilde(path: &str) -> String {
    let home = || std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    if path == "~" {
        home()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{}/{rest}", home())
    } else {
        path.to_string()
    }
}

// ── State ─────────────────────────────────────────────────────────────────────

pub struct AgentRunState {
    pub children: Arc<Mutex<HashMap<String, Child>>>,
    pub reasons:  Arc<Mutex<HashMap<String, &'static str>>>,
}

impl Default for AgentRunState {
    fn default() -> Self {
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
            reasons:  Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub role: String,
    pub model: String,
    pub vault: String,
    pub profile: String,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub connectors: Vec<String>,
    pub schedule: Option<String>,
    pub identity_note: Option<String>,
    pub log: Option<String>,
    pub status: String,
    pub created: Option<String>,
}

/// Event payload emitted as "agent-stream" Tauri event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub run_id: String,
    pub agent_id: String,
    /// "start" | "text" | "activity" | "done" | "error" | "timeout" | "stopped"
    pub kind: String,
    pub text: String,
    /// Non-null for subagent runs spawned by orchestrator fan-out.
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    #[serde(default)]
    pub usage_pct: f32,
    /// Absolute paths of files written during this run (populated on "done"/"error").
    #[serde(default)]
    pub outputs: Vec<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Extract the actual system prompt from prompt.md (content after the first `---` rule).
fn extract_system_prompt(content: &str) -> String {
    if let Some(idx) = content.find("\n---\n") {
        return content[idx + 5..].trim().to_string();
    }
    content.trim().to_string()
}

/// Append a dated outcome entry to the agent's log.md. Best-effort, never panics.
fn append_agent_log(vault: &PathBuf, agent_id: &str, run_id: &str, task: &str, result: &str, is_error: bool) {
    let log_path = vault.join("agents").join(agent_id).join("log.md");
    let now = Local::now().format("%Y-%m-%d %H:%M").to_string();
    let status = if is_error { "error" } else { "done" };
    let task_short: String  = task.chars().take(80).collect();
    let result_short: String = result.chars().take(300).collect();
    let entry = format!(
        "\n## {now} — {status}: {task_short}\n- run: {run_id}\n- result: {result_short}\n"
    );
    let mut doc = fs::read_to_string(&log_path).unwrap_or_default();
    if doc.trim().is_empty() {
        doc = format!(
            "# {} — log\n\nAppend-only record of runs, delegations, and outcomes. Newest at bottom.\n",
            agent_id
        );
    }
    doc.push_str(&entry);
    let _ = fs::write(&log_path, doc);
}

fn new_agent_run_id(agent_id: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("agent-{agent_id}-{ts}")
}

fn agent_sessions_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let d = PathBuf::from(home).join(".antfarm/agent-sessions");
    std::fs::create_dir_all(&d).ok();
    d
}

fn load_agent_session_id(agent_id: &str) -> Option<String> {
    let path = agent_sessions_dir().join(format!("{agent_id}.txt"));
    // Expire sessions after 24 hours
    let meta = std::fs::metadata(&path).ok()?;
    let session_mtime = meta.modified().ok()?;
    let age = session_mtime
        .elapsed()
        .unwrap_or(std::time::Duration::from_secs(u64::MAX));
    if age > std::time::Duration::from_secs(86_400) {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    // Invalidate if prompt.md or agent.json was modified after the session was saved
    let agent_dir = vault_root().join("agents").join(agent_id);
    for config_file in &["prompt.md", "agent.json"] {
        if let Ok(cfg_meta) = std::fs::metadata(agent_dir.join(config_file)) {
            if let Ok(cfg_mtime) = cfg_meta.modified() {
                if cfg_mtime > session_mtime {
                    let _ = std::fs::remove_file(&path);
                    return None;
                }
            }
        }
    }
    std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn save_agent_session_id(agent_id: &str, sid: &str) {
    let _ = std::fs::write(agent_sessions_dir().join(format!("{agent_id}.txt")), sid);
}

pub fn clear_agent_session_id(agent_id: &str) {
    let _ = std::fs::remove_file(agent_sessions_dir().join(format!("{agent_id}.txt")));
}

// ── Run trace helpers ─────────────────────────────────────────────────────────

fn trace_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let d = PathBuf::from(home).join(".antfarm/traces");
    std::fs::create_dir_all(&d).ok();
    d
}

/// Append one JSON line to the per-run trace file, flushed immediately so a
/// killed or timed-out run always has a complete trail up to the last event.
fn append_trace_line(run_id: &str, entry: serde_json::Value) {
    let path = trace_dir().join(format!("{run_id}.jsonl"));
    let mut line = serde_json::to_string(&entry).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
}

/// Extract a human-readable summary from a tool call's input JSON.
fn tool_input_summary(input: &serde_json::Value) -> String {
    for field in &["query", "command", "file_path", "path", "prompt", "url", "pattern"] {
        if let Some(v) = input.get(field).and_then(|v| v.as_str()) {
            let s: String = v.chars().take(100).collect();
            return format!("{field}: {s}");
        }
    }
    let s = serde_json::to_string(input).unwrap_or_default();
    s.chars().take(120).collect()
}

// ── Byte-level activity wrapper ───────────────────────────────────────────────
//
// Wraps any Read source and bumps last_activity on every non-empty read(), so the
// silence watchdog sees liveness from raw byte activity — not only after a complete
// JSON line has been assembled. While stream-json emits whole lines, the model may
// take well over 120s to produce its next event; this ensures any partial output
// (e.g. a large tool_result arriving in chunks) also resets the timer.

struct ActivityReader<R: Read> {
    inner:    R,
    activity: Arc<Mutex<std::time::Instant>>,
}

impl<R: Read> Read for ActivityReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            *self.activity.lock().unwrap() = std::time::Instant::now();
        }
        Ok(n)
    }
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

/// Matches a 5-field cron expression (`min hr dom mon dow`) against local time.
/// Supports: `*`, integers, comma lists `a,b`, ranges `a-b`, steps `*/n`.
fn cron_matches_now(expr: &str) -> bool {
    let now = Local::now();
    let fields: Vec<&str> = expr.trim().split_whitespace().collect();
    if fields.len() != 5 { return false; }

    fn matches(spec: &str, val: u32) -> bool {
        if spec == "*" { return true; }
        spec.split(',').any(|part| {
            if let Ok(n) = part.parse::<u32>() { return n == val; }
            if let Some((base, step)) = part.split_once('/') {
                let start: u32 = if base == "*" { 0 } else { base.parse().unwrap_or(0) };
                let step: u32  = step.parse().unwrap_or(1);
                return step > 0 && val >= start && (val - start) % step == 0;
            }
            if let Some((lo, hi)) = part.split_once('-') {
                let lo: u32 = lo.parse().unwrap_or(0);
                let hi: u32 = hi.parse().unwrap_or(0);
                return val >= lo && val <= hi;
            }
            false
        })
    }

    matches(fields[0], now.minute())
        && matches(fields[1], now.hour())
        && matches(fields[2], now.day())
        && matches(fields[3], now.month())
        && matches(fields[4], now.weekday().num_days_from_sunday())
}

fn schedule_dir() -> PathBuf {
    let d = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join(".antfarm/agent-scheduled");
    std::fs::create_dir_all(&d).ok();
    d
}

/// True if this agent already ran in the given `YYYY-MM-DD-HHmm` slot.
fn schedule_is_locked(agent_id: &str, slot: &str) -> bool {
    schedule_dir().join(format!("{agent_id}-{slot}.lock")).exists()
}

/// Create the lock file so re-checks within the same minute are no-ops.
fn schedule_lock(agent_id: &str, slot: &str) {
    let _ = std::fs::write(schedule_dir().join(format!("{agent_id}-{slot}.lock")), "");
}

// ── Builder Bash hook ─────────────────────────────────────────────────────────
//
// A PreToolUse hook blocks dangerous Bash commands before the agent can run them.
// The hook script and its settings file are written fresh on each write-mode run
// so the blocklist stays in sync with this source.
//
// SAFETY: the settings file contains ONLY "hooks" — no "permissions.allow" list.
// The permissions.allow gate causes stdin hangs under --permission-mode dontAsk
// (see comment near --allowedTools below). Hooks are subprocess-based and never
// wait on stdin.
//
// builder_commit_push() is completely unaffected: it calls std::process::Command
// directly from Rust, not through the agent's Bash tool.

const BUILDER_BASH_GUARD: &str = r#"#!/bin/bash
# Builder Bash guard — PreToolUse hook (managed by antfarm; do not hand-edit).
# Blocks dangerous Bash commands in write-mode Builder runs.
# Exit 0 = allow; Exit 2 = block (stdout is returned to the model as the reason).

INPUT=$(cat)

# Extract the command string from the tool call JSON.
# Claude Code PreToolUse sends: {"tool_name":"Bash","tool_input":{"command":"..."}, ...}
CMD=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    cmd = (d.get('tool_input') or {}).get('command') or d.get('command') or ''
    print(cmd)
except Exception:
    print('')
" 2>/dev/null || echo "")

# Normalize newlines to spaces so multi-line commands are matched on one line.
CMD_NORM=$(printf '%s' "$CMD" | tr '\n' ' ')

block() {
  printf '%s\n' "BLOCKED by Builder safety gate: $1. Migrations and commits/pushes require Connor's approval via the Approve & push button in the UI — do not retry with Bash. End your response with: NEEDS YOU: <one sentence describing what you need Connor to approve and why>."
  exit 2
}

# git push (any form: push, push origin main, push -u, push --force, etc.)
if printf '%s' "$CMD_NORM" | grep -qE '(^|[;&|(` ])git +push( |$|-)'; then
  block "'git push' is not permitted for the Builder agent — pushes go through the Approve and push button only"
fi

# git commit (any form)
if printf '%s' "$CMD_NORM" | grep -qE '(^|[;&|(` ])git +commit( |$|--)'; then
  block "'git commit' is not permitted for the Builder agent — commits go through the Approve and push button only"
fi

# git reset --hard (destructive)
if printf '%s' "$CMD_NORM" | grep -qE '(^|[;&|(` ])git +reset +.*--hard'; then
  block "'git reset --hard' is a destructive operation — surface for Connor's approval via NEEDS YOU"
fi

# git --force / --force-with-lease on any command (push is already caught above)
if printf '%s' "$CMD_NORM" | grep -qE '(^|[;&|(` ])git +[^ ]+ .*(--force-with-lease|--force)( |$)'; then
  block "force git operations are not permitted — surface for Connor's approval via NEEDS YOU"
fi

# supabase db push / supabase migration / supabase db reset
if printf '%s' "$CMD_NORM" | grep -qiE '(^|[;&|(` ])supabase +(db +push|migration|db +reset)( |$)'; then
  block "'supabase db push / migration / db reset' is a database migration — migrations require Connor's explicit approval"
fi

# prisma migrate / prisma db push
if printf '%s' "$CMD_NORM" | grep -qiE '(^|[;&|(` ])prisma +(migrate|db +push)( |$)'; then
  block "'prisma migrate / db push' is a database migration — migrations require Connor's explicit approval"
fi

# rm -rf and common destructive variants: -rf, -fr, -Rf, -rfv, --recursive --force, etc.
# Anchored to a command token boundary so paths/filenames containing "rm" (e.g. antfarm, rm-cache)
# never false-positive. The token separator class [;&|(` ] matches the same separators used above.
if printf '%s' "$CMD_NORM" | grep -qE '(^|[;&|(` ])rm +-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|(^|[;&|(` ])rm +-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|(^|[;&|(` ])rm +.*--recursive.*--force|(^|[;&|(` ])rm +.*--force.*--recursive'; then
  block "'rm -rf' or equivalent destructive deletion is not permitted — surface for Connor's approval via NEEDS YOU"
fi

exit 0
"#;

// ── Vault write guard ─────────────────────────────────────────────────────────
//
// Networked agents (Clerk, Scribe, Pulitzer, Scout, …) are now allowed to call
// Write/Edit/MultiEdit so they can draft files into the vault (content/drafts/,
// active/, agents/<id>/, etc.).  The disallowedTools blanket ban is replaced by
// this PreToolUse hook that checks the resolved absolute target path against
// vault_root().  Any write whose target is outside the vault is blocked (exit 2).
// Bash and NotebookEdit remain fully disallowed for networked agents.

const VAULT_WRITE_GUARD: &str = r#"#!/bin/bash
# Vault write guard — PreToolUse hook for networked agents (managed by antfarm; do not hand-edit).
# Permits Write/Edit/MultiEdit ONLY when the target path is inside the vault.
# Exit 0 = allow; Exit 2 = block (stdout is returned to the model as the reason).

VAULT_ROOT="__VAULT_ROOT__"

INPUT=$(cat)

# Extract tool name.
TOOL=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(d.get('tool_name', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")

case "$TOOL" in
    Write|Edit|MultiEdit) ;;
    *) exit 0 ;;
esac

# Extract all file paths from the tool input (Write/Edit: file_path; MultiEdit: edits[].file_path).
PATHS=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    inp = d.get('tool_input') or {}
    paths = []
    fp = inp.get('file_path', '')
    if fp:
        paths.append(fp)
    for e in (inp.get('edits') or inp.get('edit') or []):
        if isinstance(e, dict):
            efp = e.get('file_path', '')
            if efp and efp not in paths:
                paths.append(efp)
    print('\n'.join(paths))
except Exception:
    pass
" 2>/dev/null || echo "")

if [[ -z "$PATHS" ]]; then
    exit 0
fi

# Resolve vault root to canonical path once.
VAULT_REAL=$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$VAULT_ROOT" 2>/dev/null || echo "$VAULT_ROOT")

while IFS= read -r FILE_PATH; do
    [[ -z "$FILE_PATH" ]] && continue

    # Relative paths are resolved against cwd (networked agents run with vault as cwd).
    if [[ "$FILE_PATH" != /* ]]; then
        FILE_PATH="$(pwd)/$FILE_PATH"
    fi
    RESOLVED=$(python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

    # Allow only exact vault root or paths strictly under it.
    if [[ "$RESOLVED" != "$VAULT_REAL" && "$RESOLVED" != "$VAULT_REAL/"* ]]; then
        printf 'BLOCKED by vault write guard: write to "%s" is outside the vault (%s). Networked agents may only write inside the vault. To request code or infrastructure changes, end with: NEEDS YOU: <one sentence>.\n' "$RESOLVED" "$VAULT_ROOT"
        exit 2
    fi
done <<< "$PATHS"

exit 0
"#;

/// Lexically normalize a path without filesystem access (resolve . and ..).
fn normalize_path_lexical(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => { out.pop(); }
            Component::CurDir    => {}
            _                   => out.push(comp),
        }
    }
    out
}

/// True if `path` (absolute or vault-relative) resolves inside vault_root().
///
/// Absolute paths are checked directly.  Relative paths are resolved relative
/// to vault_root() — matching the cwd networked agents run with.  Path traversal
/// attacks (`../../antfarm/src`) are caught by the lexical normalization step.
pub fn path_is_inside_vault(path: &str) -> bool {
    let vault = vault_root();
    let target = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        vault.join(path)
    };
    // Canonicalize if the path exists; fall back to lexical normalization so
    // new files (not yet on disk) are checked correctly without an IO error.
    let target_norm = std::fs::canonicalize(&target)
        .unwrap_or_else(|_| normalize_path_lexical(&target));
    let vault_norm = std::fs::canonicalize(&vault).unwrap_or(vault);
    // PathBuf::starts_with is component-wise: "antfarm-memory-evil" is NOT
    // a prefix match for "antfarm-memory", so sibling directories are safe.
    target_norm.starts_with(&vault_norm)
}

/// Write the vault write guard hook script and its settings JSON to ~/.antfarm/.
/// Called at the start of every networked agent run so the guard stays current.
/// Returns the path to the settings JSON (passed to claude via --settings).
fn ensure_networked_hooks() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let hooks_dir = std::path::PathBuf::from(&home).join(".antfarm/hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let vault_str = vault_root().to_string_lossy().into_owned();
    let script = VAULT_WRITE_GUARD.replace("__VAULT_ROOT__", &vault_str);

    let guard_path = hooks_dir.join("vault-write-guard.sh");
    fs::write(&guard_path, &script).map_err(|e| e.to_string())?;

    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&guard_path).map_err(|e| e.to_string())?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&guard_path, perms).map_err(|e| e.to_string())?;

    let guard_path_str = guard_path.to_string_lossy().into_owned();
    let settings_path = std::path::PathBuf::from(&home).join(".antfarm/networked-write-settings.json");
    // Three separate matchers — one per tool — because matcher is an exact string.
    // The guard script also validates tool_name internally for defense in depth.
    // ONLY "hooks" here, no "permissions.allow" — avoid the stdin-hang bug where an
    // explicit allow list creates a secondary permission gate that blocks dontAsk mode.
    let settings_json = serde_json::json!({
        "hooks": {
            "PreToolUse": [
                {"matcher": "Write",     "hooks": [{"type": "command", "command": guard_path_str}]},
                {"matcher": "Edit",      "hooks": [{"type": "command", "command": guard_path_str}]},
                {"matcher": "MultiEdit", "hooks": [{"type": "command", "command": guard_path_str}]}
            ]
        }
    });
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings_json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(settings_path.to_string_lossy().into_owned())
}

/// Write the Builder Bash guard hook script and its settings JSON to ~/.antfarm/.
/// Called at the start of every write-mode Builder run so the blocklist stays current.
/// Returns the path to the settings JSON (passed to claude via --settings).
fn ensure_builder_hooks() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let hooks_dir = PathBuf::from(&home).join(".antfarm/hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let guard_path = hooks_dir.join("builder-bash-guard.sh");
    fs::write(&guard_path, BUILDER_BASH_GUARD).map_err(|e| e.to_string())?;

    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(&guard_path).map_err(|e| e.to_string())?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&guard_path, perms).map_err(|e| e.to_string())?;

    let guard_path_str = guard_path.to_string_lossy().into_owned();
    let settings_path  = PathBuf::from(&home).join(".antfarm/builder-write-settings.json");
    let settings_json  = serde_json::json!({
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [{"type": "command", "command": guard_path_str}]
                }
            ]
        }
    });
    fs::write(&settings_path, serde_json::to_string_pretty(&settings_json).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    Ok(settings_path.to_string_lossy().into_owned())
}

// ── Pending scheduled-run drain (show results in Chat on next open) ───────────

fn pending_runs_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join(".antfarm/scheduled-runs-pending.json")
}

/// Read a bool feature flag from the persisted settings.json without importing main.rs.
fn read_feature_flag(key: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = PathBuf::from(home)
        .join("Library/Application Support/com.connordore.antfarm/settings.json");
    let content = fs::read_to_string(&path).unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
    v.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn push_pending_run(agent_id: &str, agent_name: &str, time: &str) {
    let path = pending_runs_path();
    let mut list: Vec<serde_json::Value> = path
        .exists()
        .then(|| std::fs::read_to_string(&path).ok())
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.push(serde_json::json!({ "agentId": agent_id, "agentName": agent_name, "time": time }));
    let _ = std::fs::write(&path, serde_json::to_string(&list).unwrap_or_default());
}

/// Return and clear any scheduled runs that completed while the app was closed.
#[tauri::command]
pub fn drain_scheduled_runs() -> Vec<serde_json::Value> {
    let path = pending_runs_path();
    if !path.exists() { return vec![]; }
    let entries: Vec<serde_json::Value> =
        std::fs::read_to_string(&path).ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    entries
}

/// Task text injected when an agent fires on its schedule.
fn scheduled_task(agent: &Agent) -> String {
    let date = Local::now().format("%Y-%m-%d").to_string();
    match agent.id.as_str() {
        "clerk" => format!(
            "Scheduled morning run ({date}). \
             Reconcile today's plan: read or create active/state/plan-{date}.json, \
             carry forward unfinished items from yesterday, \
             write today's recap to active/daily/{date}.md. \
             Surface anything that needs Connor's attention in your response."
        ),
        _ => format!(
            "Scheduled run ({date}). Check your queue and complete any pending work."
        ),
    }
}

/// Spawn a background thread that wakes at the top of each minute, checks every
/// agent's `schedule` cron field, and fires `run_agent` for any match.
/// Idempotent: a lock file per agent+minute slot prevents double-runs.
pub fn start_agent_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        // Align to the start of the next minute so checks land on :00.
        let secs = Local::now().second();
        if secs > 0 {
            std::thread::sleep(std::time::Duration::from_secs((60 - secs) as u64));
        }
        loop {
            let slot     = Local::now().format("%Y-%m-%d-%H%M").to_string();
            let time_str = Local::now().format("%H:%M").to_string();

            for agent in list_agents() {
                let sched = match &agent.schedule {
                    Some(s) if !s.trim().is_empty() => s.clone(),
                    _ => continue,
                };
                if !cron_matches_now(&sched)              { continue; }
                if schedule_is_locked(&agent.id, &slot)   { continue; }
                // Morning feature gate: skip Clerk's scheduled run when morning is OFF
                if agent.id == "clerk" && !read_feature_flag("feature_morning") { continue; }

                schedule_lock(&agent.id, &slot);
                push_pending_run(&agent.id, &agent.name, &time_str);

                let task      = scheduled_task(&agent);
                let agent_id  = agent.id.clone();
                let app2      = app.clone();
                std::thread::spawn(move || {
                    let dispatch  = app2.state::<DispatchState>();
                    let agent_run = app2.state::<AgentRunState>();
                    let _ = run_agent(app2.clone(), dispatch, agent_run, agent_id, task, None, false, None, None);
                });
            }

            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}

// ── Networked permission helpers ──────────────────────────────────────────────
//
// Empirically verified (2026-06-25):
//   • --permission-mode dontAsk (and default) auto-approve ALL tool calls in
//     headless -p mode; --allowedTools is pre-approval only, NOT exclusive.
//   • --disallowedTools IS authoritative: listed tools are removed from the
//     model's toolset entirely and cannot be called.
//
// Therefore every agent gets a single --disallowedTools call that covers:
//   • Role-specific tools (Write/Edit/Bash for builder; Bash for networked)
//   • GWS MCP universe minus this agent's granted GWS tools
// Applied on EVERY turn (cold start and resume) so no path slips through.

// ── GWS MCP constants ─────────────────────────────────────────────────────────

const GWS_PREFIXES: &[&str] = &[
    "mcp__google_workspace_dore__",
    "mcp__google_workspace_pw__",
];

const GWS_GMAIL_SUFFIXES: &[&str] = &[
    "search_gmail_messages",
    "get_gmail_message_content",
    "get_gmail_messages_content_batch",
    "get_gmail_thread_content",
    "get_gmail_threads_content_batch",
    "draft_gmail_message",
    "send_gmail_message",
    "list_gmail_labels",
    "manage_gmail_label",
    "modify_gmail_message_labels",
    "batch_modify_gmail_message_labels",
    "list_gmail_filters",
    "manage_gmail_filter",
    "get_gmail_attachment_content",
    "start_google_auth",
];

const GWS_CAL_SUFFIXES: &[&str] = &[
    "list_calendars",
    "get_events",
    "manage_event",
    "create_calendar",
    "manage_focus_time",
    "manage_out_of_office",
    "query_freebusy",
];

// Granted gmail suffixes (subset of GWS_GMAIL_SUFFIXES, excluding send, manage_*, list_filters, start_auth)
const GMAIL_GRANTED_SUFFIXES: &[&str] = &[
    "search_gmail_messages",
    "get_gmail_message_content",
    "get_gmail_messages_content_batch",
    "get_gmail_thread_content",
    "get_gmail_threads_content_batch",
    "list_gmail_labels",
    "get_gmail_attachment_content",
    "draft_gmail_message",
    "modify_gmail_message_labels",
    "batch_modify_gmail_message_labels",
    "send_gmail_message",
];

// Granted calendar suffixes (reads + manage_event; create/focus/ooo/freebusy excluded or separate)
const CAL_GRANTED_SUFFIXES: &[&str] = &[
    "list_calendars",
    "get_events",
    "query_freebusy",
    "manage_event",
];

/// Full 44-tool GWS universe (2 prefixes × 22 suffixes).
fn gws_universe() -> Vec<String> {
    let mut tools = Vec::with_capacity(GWS_PREFIXES.len() * (GWS_GMAIL_SUFFIXES.len() + GWS_CAL_SUFFIXES.len()));
    for pfx in GWS_PREFIXES {
        for sfx in GWS_GMAIL_SUFFIXES { tools.push(format!("{pfx}{sfx}")); }
        for sfx in GWS_CAL_SUFFIXES  { tools.push(format!("{pfx}{sfx}")); }
    }
    tools
}

/// GWS tools granted to this agent based on connectors.
fn gws_granted(connectors: &[String]) -> Vec<String> {
    let mut granted = Vec::new();
    for pfx in GWS_PREFIXES {
        if connectors.iter().any(|c| c == "gmail") {
            for sfx in GMAIL_GRANTED_SUFFIXES { granted.push(format!("{pfx}{sfx}")); }
        }
        if connectors.iter().any(|c| c == "calendar") {
            for sfx in CAL_GRANTED_SUFFIXES { granted.push(format!("{pfx}{sfx}")); }
        }
    }
    granted
}

/// Comma-separated --allowedTools list for a networked agent.
/// Bash, Write, Edit, MultiEdit, NotebookEdit are intentionally absent —
/// networked agents are read-plus-connectors only; no file writes.
fn networked_allowed_tools(connectors: &[String]) -> String {
    let mut tools = vec!["Read", "Glob", "Grep"];
    for c in connectors {
        match c.as_str() {
            "web" => {
                tools.push("WebSearch");
                tools.push("WebFetch");
            }
            _ => {}
        }
    }
    let granted = gws_granted(connectors);
    let mut result = tools.join(",");
    if !granted.is_empty() {
        result.push(',');
        result.push_str(&granted.join(","));
    }
    result
}

/// Single unified --disallowedTools string for any agent.
/// Applied on every turn (cold + resume) — exactly one call per run.
///
/// Composition:
///   • builder advisory (default): Write,Edit,MultiEdit,NotebookEdit,Bash + all 44 GWS tools
///   • builder write mode:         NotebookEdit + all 44 GWS tools (Write/Edit/Bash granted)
///   • networked agents:           Write,Edit,MultiEdit,NotebookEdit,Bash +
///                                 (44 GWS universe minus this agent's granted GWS tools)
///   • offline-code non-builder:   Write,Edit,MultiEdit,NotebookEdit,Bash + all GWS
///   • start_google_auth always denied for everyone
pub(crate) fn build_deny_list(agent_id: &str, profile: &str, connectors: &[String], builder_write: bool) -> String {
    let mut deny: Vec<String> = Vec::new();

    if profile == "networked" {
        // Bash and NotebookEdit are fully denied. Write/Edit/MultiEdit are allowed
        // but path-scoped by the vault write guard hook (ensure_networked_hooks).
        deny.extend(["NotebookEdit", "Bash"].map(String::from));
        if !connectors.iter().any(|c| c == "web") {
            deny.push("WebSearch".to_string());
            deny.push("WebFetch".to_string());
        }
    }

    if agent_id == "builder" {
        if builder_write {
            // Write mode: grant Write/Edit/MultiEdit/Bash; still deny NotebookEdit (not needed)
            deny.push("NotebookEdit".to_string());
        } else {
            // Advisory mode: deny all write and execution tools
            deny.extend(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"].map(String::from));
        }
    } else if profile == "offline-code" {
        // offline-code agents (planner, reviewer) are always read-only
        deny.extend(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"].map(String::from));
    }

    // GWS deny: universe minus granted for this agent
    let granted = gws_granted(connectors);
    for tool in gws_universe() {
        if !granted.contains(&tool) {
            deny.push(tool);
        }
    }

    deny.join(",")
}

/// Connector-specific guidance injected into the system prompt for networked agents.
fn connector_prompt_section(connectors: &[String]) -> String {
    if connectors.is_empty() {
        return String::new();
    }
    let mut parts = vec!["\n\n## Connectors available this run".to_string()];
    for c in connectors {
        match c.as_str() {
            "web" => parts.push(
                "**web** — WebSearch and WebFetch are enabled. \
                 Search multiple queries as needed; cite sources in output.".into(),
            ),
            "gmail" => parts.push(
                "**gmail** — Gmail tools via mcp__google_workspace_dore__* (default, connordore36@gmail.com) \
                 and mcp__google_workspace_pw__* (precisionworks account only). \
                 Use the dore__ prefix by default; switch to pw__ only when the task is explicitly \
                 about the precisionworks account. Do not pass a user_google_email parameter — \
                 the prefix selects the account.\n\
                 Auto-allowed: search, read, triage, draft, archive (archive = modify_gmail_message_labels removing INBOX label), \
                 read attachments, label/modify messages.\n\
                 GATE (NEEDS YOU — stop and surface for approval before proceeding): send_gmail_message. \
                 To surface a draft for approval: write content to \
                 `active/drafts/email-<unix-epoch>.md` (sections: Subject, To, Body), \
                 then end with: NEEDS YOU: <one sentence — what you will do once approved>.".into(),
            ),
            "calendar" => parts.push(
                "**calendar** — Calendar tools via mcp__google_workspace_dore__* (default, connordore36@gmail.com) \
                 and mcp__google_workspace_pw__* (precisionworks account only). \
                 Use the dore__ prefix by default; switch to pw__ only when the task is explicitly \
                 about the precisionworks account. Do not pass a user_google_email parameter.\n\
                 Read operations (always allowed): list_calendars, get_events, query_freebusy.\n\
                 Create/update operations (allowed): manage_event with action=create or action=update.\n\
                 GATE (NEEDS YOU — stop and surface for approval before proceeding): manage_event with \
                 action=delete or any destructive calendar change.".into(),
            ),
            _ => {}
        }
    }
    parts.join("\n\n")
}

// ── Crew roster ───────────────────────────────────────────────────────────────

/// Build a compact, factual crew roster from agent.json files.
/// Injected only into the orchestrator's cold-start prompt so Jack stops
/// inventing crew status from stale memory.
fn crew_roster() -> String {
    let agents = list_agents();
    if agents.is_empty() {
        return String::new();
    }

    let mut out = String::from(
        "\n\n## Your crew right now (capabilities + status, injected by app — trust this over memory)"
    );

    for agent in &agents {
        let capability = if !agent.connectors.is_empty() {
            let parts: Vec<String> = agent.connectors.iter().map(|c| match c.as_str() {
                "web"      => "web research (WebSearch + WebFetch)".to_string(),
                "gmail"    => "email both accounts (read, triage, draft, archive; sending gated)".to_string(),
                "calendar" => "calendar both accounts (read + create/update; delete gated)".to_string(),
                other      => other.to_string(),
            }).collect();
            parts.join(" + ")
        } else {
            match agent.profile.as_str() {
                "offline-code" => "offline code (build harness)".to_string(),
                "networked"    => "vault read/write only".to_string(),
                other          => other.to_string(),
            }
        };

        let you = if agent.role == "orchestrator" { " (you)" } else { "" };
        out.push_str(&format!(
            "\n- {} ({}) — {}; status {}{you}.",
            agent.name, agent.id, capability, agent.status
        ));
    }

    out
}

// ── Registry commands ─────────────────────────────────────────────────────────

/// All agents: orchestrator first, then alphabetically by name.
#[tauri::command]
pub fn list_agents() -> Vec<Agent> {
    let agents_dir = vault_root().join("agents");
    let Ok(rd) = fs::read_dir(&agents_dir) else {
        return vec![];
    };
    let mut agents: Vec<Agent> = rd
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let content = fs::read_to_string(path.join("agent.json")).ok()?;
            serde_json::from_str(&content).ok()
        })
        .collect();
    agents.sort_by(|a, b| match (a.role.as_str(), b.role.as_str()) {
        ("orchestrator", "orchestrator") => a.name.cmp(&b.name),
        ("orchestrator", _) => std::cmp::Ordering::Less,
        (_, "orchestrator") => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    agents
}

/// Single agent by id.
#[tauri::command]
pub fn get_agent(id: String) -> Option<Agent> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let content = fs::read_to_string(vault_root().join("agents").join(&id).join("agent.json")).ok()?;
    serde_json::from_str(&content).ok()
}

#[tauri::command]
pub fn reset_agent_session(agent_id: String) -> Result<(), String> {
    if agent_id.is_empty() || agent_id.contains('/') || agent_id.contains("..") {
        return Err("invalid agent_id".into());
    }
    clear_agent_session_id(&agent_id);
    Ok(())
}

/// Load the incremental trace for a run from ~/.antfarm/traces/{run_id}.jsonl.
/// Returns every JSON line parsed into a Value; the last line is the terminal record.
#[tauri::command]
pub fn get_run_trace(run_id: String) -> Vec<serde_json::Value> {
    if run_id.is_empty() || run_id.contains('/') || run_id.contains("..") {
        return vec![];
    }
    let path = trace_dir().join(format!("{run_id}.jsonl"));
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    content.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect()
}

// ── spawn_agent_run ───────────────────────────────────────────────────────────

/// Core spawn helper. Returns (run_id, result_rx) where result_rx resolves to
/// the run's final text once it terminates. The Tauri command wrapper drops the
/// receiver (fire-and-forget); the pod controller keeps it to await the result.
pub fn spawn_agent_run(
    app: AppHandle,
    claude_path: String,
    agent_run_children: Arc<Mutex<HashMap<String, Child>>>,
    agent_run_reasons: Arc<Mutex<HashMap<String, &'static str>>>,
    agent_id: String,
    task: String,
    parent_run_id: Option<String>,
    resume_session: bool,
    repo_path: Option<String>,
    builder_write: Option<bool>,
) -> Result<(String, mpsc::Receiver<String>), String> {
    let vault = vault_root();

    // ── Load agent definition ──────────────────────────────────────────────────
    let agent: Agent = fs::read_to_string(vault.join("agents").join(&agent_id).join("agent.json"))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .ok_or_else(|| format!("agent not found: {agent_id}"))?;

    // ── Load system prompt from prompt.md (optional) ──────────────────────────
    let base_prompt = fs::read_to_string(vault.join("agents").join(&agent_id).join("prompt.md"))
        .ok()
        .map(|c| extract_system_prompt(&c));

    // ── Write-scope constraint (injected for all agents) ──────────────────────
    // --add-dir gives full READ access to the vault; writes are soft-constrained
    // via prompt so agents don't touch other agents' directories or the brain index.
    // Suppressed for write-mode Builder with a repo_path: the builder's own REPO SCOPE
    // instruction already scopes writes to the repo, and this vault text contradicts it.
    let write_scope = if builder_write.unwrap_or(false) && repo_path.is_some() {
        String::new()
    } else {
        format!(
            "\n\nVault write scope: you may only create or modify files under \
             `agents/{}/` and `active/`. Do not write to any other vault paths.",
            agent_id
        )
    };

    // ── Role-specific tail instructions ──────────────────────────────────────
    // Orchestrator: delegation block protocol so the app can wire real subagent runs.
    // Subagents: NEEDS YOU gate for irreversible actions.
    let role_note: String = if agent.role == "orchestrator" {
        "\n\nDelegation protocol: when you want to dispatch work to a subagent, end \
         your message with a fenced delegate block (and ONLY when you're actually \
         dispatching — omit it when you're just answering). Valid agent ids: \
         scout, scribe, clerk, builder, pulitzer. One line per agent, id then colon then task.\n\
         \n\
         ```delegate\n\
         scout: research the specific topic\n\
         clerk: the specific ops task\n\
         ```\n\
         \n\
         Produce the block at the very end of your message, after everything else. \
         Do not include it for agents you're not dispatching this turn."
            .to_string()
    } else {
        let mut note = "\n\nIf completing this task requires Connor's approval before an irreversible \
         action (sending email, merging code, posting, spending money), end your \
         response with exactly:\nNEEDS YOU: <one sentence — what you'll do once approved>"
            .to_string();
        if agent_id == "builder" {
            let builder_write_mode = builder_write.unwrap_or(false);
            if builder_write_mode {
                note.push_str(
                    "\n\n## Builder — write mode\n\n\
                     You are in write mode. You have Write, Edit, Bash access. These rules are non-negotiable:\n\n\
                     REPO SCOPE: Only create or modify files under the repo directory added to your context \
                     via --add-dir. Do not create or modify files anywhere else on the filesystem.\n\n\
                     STOP BEFORE PUSH: When the build is green, STOP. Do NOT run git commit, git push, \
                     or any push command autonomously. End your response with a plain-English summary of \
                     what changed, then the full diff (git diff HEAD), then exactly this line on its own:\n\
                     ---COMMIT: <one-line commit message>---\n\n\
                     MIGRATION HARD-STOP: If the task requires `supabase db push`, `supabase migration`, \
                     `prisma migrate`, or any database schema change command, STOP immediately and end with:\n\
                     NEEDS YOU: Migration required — <what migration is needed and why>. Never run migrations.\n\n\
                     BUILD GATE: After making changes, run the appropriate build check: `cargo check` for \
                     Rust projects, `npm run build` for TypeScript/frontend. If it fails, read the errors, \
                     fix them, and re-run. Cap retries at 5, then stop and report the errors in plain English.\n\n\
                     DESTRUCTIVE OPS: Never run rm -rf, git reset --hard, git push --force, or any \
                     destructive command without surfacing for approval first via NEEDS YOU."
                );
            } else {
                note.push_str(
                    "\n\nYou are in advisory mode: read the repo and answer Connor's question. \
                     Do not write files or run commands. Be surgical and token-efficient — \
                     use Glob/Grep to find the few relevant files and read only those, never \
                     slurp the whole tree. Connor can enable write mode in Settings to grant \
                     you file-editing access."
                );
            }
        }
        note
    };

    // ── Daily context preamble (orchestrator + clerk) ─────────────────────────
    // Injects plan staleness, recent commits, and today's agent activity so
    // these agents never work blind. Other agents stay lean.
    let daily_preamble = if agent.role == "orchestrator" || agent_id == "clerk" {
        crate::daily::daily_context_preamble(&vault)
    } else {
        String::new()
    };

    // ── Crew roster (orchestrator only — factual ground truth so Jack never fabricates) ──
    let crew_section = if agent.role == "orchestrator" {
        crew_roster()
    } else {
        String::new()
    };

    // ── Networked profile: connector tool allowlist + prompt guidance ─────────
    let is_networked = agent.profile == "networked";
    let connector_prompt = if is_networked {
        connector_prompt_section(&agent.connectors)
    } else {
        String::new()
    };

    // ── Build full -p prompt ──────────────────────────────────────────────────
    let now_dt = Local::now();
    let now = format!("{} (unix: {})", now_dt.format("%Y-%m-%d %H:%M %Z"), now_dt.timestamp());
    let full_prompt = match base_prompt {
        Some(sys) => format!(
            "{sys}{write_scope}{daily_preamble}{crew_section}{connector_prompt}{role_note}\n\n---\n\nCurrent date and time: {now}\n\nUser: {task}"
        ),
        None => format!(
            "Current date and time: {now}{write_scope}{daily_preamble}{crew_section}{connector_prompt}{role_note}\n\nUser: {task}"
        ),
    };

    // ── Session reuse ──────────────────────────────────────────────────────────
    let existing_sid = if resume_session { load_agent_session_id(&agent_id) } else { None };
    let is_resuming  = existing_sid.is_some();

    // ── Spawn child ───────────────────────────────────────────────────────────
    let claude    = claude_path;
    let vault_str = vault.to_string_lossy().into_owned();

    // Write-mode Builder uses bypassPermissions so the Bash hook is the sole Bash gate.
    // With dontAsk, hook exit-0 falls through to the permission layer which denies Bash
    // (no explicit allow exists). bypassPermissions skips that layer entirely.
    // --disallowedTools remains authoritative regardless: those tools are removed from
    // the model's tool schema before any permission check and cannot be called at all.
    let perm_mode = if builder_write.unwrap_or(false) { "bypassPermissions" } else { "dontAsk" };

    let mut cmd = Command::new(&claude);
    if let Some(ref sid) = existing_sid {
        // Warm resume: user task + current time. Re-add repo dir so Builder still
        // has filesystem access to the target repo on rounds 1+ of the pod loop.
        let now_dt = Local::now();
        let now = format!("{} (unix: {})", now_dt.format("%Y-%m-%d %H:%M %Z"), now_dt.timestamp());
        let msg  = format!("Current date and time: {now}\n\nUser: {task}");
        cmd.args(["--resume", sid, "-p", &msg,
                  "--output-format", "stream-json",
                  "--verbose",
                  "--permission-mode", perm_mode,
                  "--model", &agent.model]);
        if let Some(ref rp) = repo_path {
            if std::path::Path::new(rp).is_dir() {
                cmd.args(["--add-dir", rp]);
            }
        }
    } else {
        // Cold start: full system prompt + --add-dir (scope depends on agent role).
        cmd.args(["-p", &full_prompt,
                  "--output-format", "stream-json",
                  "--verbose",
                  "--permission-mode", perm_mode,
                  "--model", &agent.model]);
        // Orchestrator + Clerk reason from the full brain; all others use scoped dirs.
        if agent.role == "orchestrator" || agent_id == "clerk" {
            cmd.args(["--add-dir", &vault_str]);
        } else {
            let active_dir = format!("{vault_str}/active");
            let agent_dir  = format!("{vault_str}/agents/{agent_id}");
            cmd.args(["--add-dir", &active_dir, "--add-dir", &agent_dir]);
        }
        // Optional repo directory (chat lane only; warm resume carries scope via session).
        if let Some(ref rp) = repo_path {
            if std::path::Path::new(rp).is_dir() {
                cmd.args(["--add-dir", rp]);
                // Persist so builder_commit_push can resolve the path even when
                // selectedRepoPath is null on the frontend (warm-resume scenario).
                if builder_write.unwrap_or(false) {
                    let dir = vault.join("agents").join("builder");
                    let _ = fs::create_dir_all(&dir);
                    let _ = fs::write(dir.join("last_repo_path.txt"), rp);
                }
            }
        }
    }

    // Unified deny list — applied on every turn (cold + resume) for all agents.
    // Exactly one --disallowedTools call. Builder and networked both covered here.
    let deny = build_deny_list(&agent_id, &agent.profile, &agent.connectors, builder_write.unwrap_or(false));
    eprintln!("[antfarm] spawn {agent_id} profile={} deny_count={} deny={}", agent.profile, deny.split(',').count(), deny);
    if !deny.is_empty() { cmd.args(["--disallowedTools", &deny]); }

    // Builder write mode: inject Bash command safety hook via --settings.
    // The settings file contains ONLY "hooks" — no "permissions.allow" list —
    // so it does not trigger the stdin-hang bug (see comment below).
    if builder_write.unwrap_or(false) {
        match ensure_builder_hooks() {
            Ok(hook_settings) => { cmd.args(["--settings", &hook_settings]); }
            Err(e) => eprintln!("[antfarm] warn: could not write builder hooks: {e}"),
        }
    }

    // Networked agents: vault write guard hook + allowed list.
    // The hook settings file contains ONLY "hooks" — no "permissions.allow" —
    // so it does not trigger the stdin-hang bug that a secondary permission gate
    // would cause with --permission-mode dontAsk and /dev/null stdin.
    if is_networked {
        match ensure_networked_hooks() {
            Ok(hook_settings) => { cmd.args(["--settings", &hook_settings]); }
            Err(e) => eprintln!("[antfarm] warn: could not write networked hooks: {e}"),
        }
        let allowed = networked_allowed_tools(&agent.connectors);
        if !allowed.is_empty() { cmd.args(["--allowedTools", &allowed]); }
    }

    // Use repo_path as cwd when provided so Builder's relative Bash commands land in
    // the target repo, not the vault.  Agents with no repo_path keep the vault as cwd.
    let cwd: std::path::PathBuf = repo_path
        .as_deref()
        .filter(|rp| std::path::Path::new(rp).is_dir())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| vault.clone());

    let mut child = cmd
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn {claude}: {e}"))?;

    let run_id = new_agent_run_id(&agent_id);
    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    agent_run_children.lock().unwrap().insert(run_id.clone(), child);

    let prid = parent_run_id.clone();

    // Emit "start" immediately so the frontend can match future events.
    app.emit("agent-stream", AgentStreamEvent {
        run_id:        run_id.clone(),
        agent_id:      agent_id.clone(),
        kind:          "start".into(),
        text:          String::new(),
        parent_run_id: prid.clone(),
        input_tokens:  0,
        output_tokens: 0,
        usage_pct:     0.0,
        outputs:       vec![],
    }).ok();

    let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));
    let started       = std::time::Instant::now();

    // ── stdout reader thread ──────────────────────────────────────────────────
    let (result_tx, result_rx) = mpsc::sync_channel::<String>(1);
    {
        let app2            = app.clone();
        let rid             = run_id.clone();
        let aid             = agent_id.clone();
        let task_clone      = task.clone();
        let vault_clone     = vault.clone();
        let children_arc    = agent_run_children.clone();
        let reasons_arc     = agent_run_reasons.clone();
        let la_reader       = last_activity.clone();
        let is_resuming_clone     = is_resuming;
        let resume_session_clone  = resume_session;

        // Watchdog: kills the child if silent > SILENCE_SECS or wall time > WALL_SECS.
        // Does NOT emit events — the reader's safety-net branch emits the terminal event.
        {
            let children_wd = agent_run_children.clone();
            let reasons_wd  = agent_run_reasons.clone();
            let la_wd       = last_activity.clone();
            let rid_wd      = run_id.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if children_wd.lock().unwrap().get(&rid_wd).is_none() { break; }
                    let idle    = la_wd.lock().unwrap().elapsed();
                    let elapsed = started.elapsed();
                    if idle    > std::time::Duration::from_secs(SILENCE_SECS)
                        || elapsed > std::time::Duration::from_secs(WALL_SECS)
                    {
                        reasons_wd.lock().unwrap().insert(rid_wd.clone(), "timeout");
                        if let Some(child) = children_wd.lock().unwrap().get_mut(&rid_wd) {
                            let _ = child.kill();
                        }
                        break;
                    }
                }
            });
        }

        std::thread::spawn(move || {
            // ActivityReader resets the silence timer on any raw bytes, so partial
            // output mid-line (or any chunk) counts as liveness — not just complete events.
            let reader      = BufReader::new(ActivityReader { inner: stdout, activity: la_reader });
            let mut last_text   = String::new();
            let mut result_text = String::new();
            let mut final_text  = String::new();
            let mut captured_sid: Option<String> = None;
            let mut input_tokens:  u32 = 0;
            let mut output_tokens: u32 = 0;
            let mut outputs: Vec<String> = Vec::new();
            // Trace bookkeeping: elapsed_ms of the last traced event, total event count.
            let mut last_trace_elapsed_ms: u64 = 0;
            let mut trace_event_count:     u32 = 0;

            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };

                // Per-line trace timestamps (shared by all events in this stream line).
                let trace_elapsed_ms = started.elapsed().as_millis() as u64;
                let trace_ts         = Local::now().to_rfc3339();

                // Capture session_id from any stream line (appears in init line)
                if captured_sid.is_none() {
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        captured_sid = Some(sid.to_string());
                    }
                }

                let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

                // Trace the init event so the trail starts from session open.
                if typ == "system" && v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                    let sid_text = v.get("session_id").and_then(|s| s.as_str()).unwrap_or("?");
                    append_trace_line(&rid, serde_json::json!({
                        "ts": trace_ts, "elapsed_ms": trace_elapsed_ms,
                        "kind": "init", "tool_name": null,
                        "input_summary": format!("session {sid_text} started"),
                    }));
                    last_trace_elapsed_ms = trace_elapsed_ms;
                    trace_event_count    += 1;
                }

                if typ == "assistant" {
                    let mut chunks = Vec::new();
                    if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                        for block in content {
                            let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");

                            if block_type == "text" {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    chunks.push(text.to_string());
                                }
                            } else if block_type == "tool_use" {
                                let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                                let label = match name {
                                    "WebSearch" | "WebFetch" => "searching the web",
                                    n if n.contains("gmail")    => "reading inbox",
                                    n if n.contains("calendar") || n.contains("event") => "checking calendar",
                                    "Read" | "Glob" | "Grep"    => "reading files",
                                    "Write" | "Edit"            => "writing files",
                                    "Bash"                      => "running a command",
                                    other                       => other,
                                };
                                app2.emit("agent-stream", AgentStreamEvent {
                                    run_id:        rid.clone(),
                                    agent_id:      aid.clone(),
                                    kind:          "activity".into(),
                                    text:          label.to_string(),
                                    parent_run_id: prid.clone(),
                                    input_tokens:  0,
                                    output_tokens: 0,
                                    usage_pct:     0.0,
                                    outputs:       vec![],
                                }).ok();
                                // Trace each tool call with input summary.
                                {
                                    let input   = block.get("input").cloned()
                                        .unwrap_or(serde_json::Value::Null);
                                    let summary = tool_input_summary(&input);
                                    append_trace_line(&rid, serde_json::json!({
                                        "ts": trace_ts, "elapsed_ms": trace_elapsed_ms,
                                        "kind": "tool_use", "tool_name": name,
                                        "input_summary": summary,
                                    }));
                                    last_trace_elapsed_ms = trace_elapsed_ms;
                                    trace_event_count    += 1;
                                }
                                // Collect output file paths from Write/Edit calls.
                                if name == "Write" || name == "Edit" {
                                    if let Some(fp) = block.pointer("/input/file_path")
                                        .and_then(|p| p.as_str())
                                        .filter(|p| !p.is_empty())
                                    {
                                        let abs = if std::path::Path::new(fp).is_absolute() {
                                            fp.to_string()
                                        } else {
                                            vault_clone.join(fp).to_string_lossy().into_owned()
                                        };
                                        if outputs.len() < 10 && !outputs.contains(&abs) {
                                            outputs.push(abs);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if !chunks.is_empty() {
                        let chunk_text = chunks.join("");
                        last_text = chunk_text.clone();
                        app2.emit("agent-stream", AgentStreamEvent {
                            run_id:        rid.clone(),
                            agent_id:      aid.clone(),
                            kind:          "text".into(),
                            text:          chunk_text,
                            parent_run_id: prid.clone(),
                            input_tokens:  0,
                            output_tokens: 0,
                            usage_pct:     0.0,
                            outputs:       vec![],
                        }).ok();
                        // Trace non-trivial text blocks (last_text holds the cloned content).
                        if last_text.len() > 20 {
                            let summary: String = last_text.chars().take(80).collect();
                            append_trace_line(&rid, serde_json::json!({
                                "ts": trace_ts, "elapsed_ms": trace_elapsed_ms,
                                "kind": "text", "tool_name": null,
                                "input_summary": summary,
                            }));
                            last_trace_elapsed_ms = trace_elapsed_ms;
                            trace_event_count    += 1;
                        }
                    }
                } else if typ == "result" {
                    let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    result_text = v.get("result").and_then(|r| r.as_str())
                        .unwrap_or(&last_text)
                        .to_string();
                    final_text = result_text.clone();

                    input_tokens  = v.pointer("/usage/input_tokens")
                        .and_then(|t| t.as_u64()).unwrap_or(0) as u32;
                    output_tokens = v.pointer("/usage/output_tokens")
                        .and_then(|t| t.as_u64()).unwrap_or(0) as u32;
                    let usage_pct = (input_tokens as f32 / MODEL_CONTEXT_WINDOW as f32 * 100.0).min(100.0);

                    append_agent_log(&vault_clone, &aid, &rid, &task_clone, &result_text, is_error);

                    // Auto-render active/reports/*.md outputs → PDF.
                    // Wrapped in catch so a failed render never breaks the run.
                    if !is_error {
                        let report_paths: Vec<String> = outputs.iter()
                            .filter(|p| crate::pdf::is_active_report(p))
                            .cloned()
                            .collect();
                        for md_path in report_paths {
                            if let Ok(pdf_path) = crate::pdf::render_pdf_from_md(&md_path) {
                                if !outputs.contains(&pdf_path) {
                                    outputs.push(pdf_path);
                                }
                            }
                        }
                    }

                    // Trace result before emitting to frontend.
                    {
                        let subtype = v.get("subtype").and_then(|s| s.as_str())
                            .unwrap_or("result");
                        let cost = v.get("total_cost_usd").and_then(|c| c.as_f64())
                            .map(|c| format!(" · ${c:.4}")).unwrap_or_default();
                        let dur  = v.get("duration_ms").and_then(|d| d.as_u64())
                            .map(|d| format!(" · {:.1}s", d as f64 / 1000.0))
                            .unwrap_or_default();
                        append_trace_line(&rid, serde_json::json!({
                            "ts": trace_ts, "elapsed_ms": trace_elapsed_ms,
                            "kind": "result", "tool_name": null,
                            "input_summary": format!("{subtype}{cost}{dur}"),
                            "result_status": if is_error { "error" } else { "success" },
                        }));
                        last_trace_elapsed_ms = trace_elapsed_ms;
                        trace_event_count    += 1;
                    }

                    app2.emit("agent-stream", AgentStreamEvent {
                        run_id:        rid.clone(),
                        agent_id:      aid.clone(),
                        kind:          if is_error { "error".into() } else { "done".into() },
                        text:          result_text.clone(),
                        parent_run_id: prid.clone(),
                        input_tokens,
                        output_tokens,
                        usage_pct,
                        outputs:       outputs.clone(),
                    }).ok();

                    // Persist or clear session based on usage.
                    if is_resuming_clone || resume_session_clone {
                        if let Some(ref sid) = captured_sid {
                            if usage_pct < COMPACT_THRESHOLD_PCT {
                                save_agent_session_id(&aid, sid);
                            } else {
                                // Context over threshold — clear so next turn starts fresh.
                                clear_agent_session_id(&aid);
                            }
                        }
                    }
                }
            }

            // Reap child.
            children_arc.lock().unwrap().remove(&rid).and_then(|mut c| c.wait().ok());

            // Safety net: emit terminal event if we never got a `result` event.
            // Reads the reason flag set by the watchdog or stop_agent so there is
            // exactly one terminal event per run.
            if result_text.is_empty() {
                let reason      = reasons_arc.lock().unwrap().remove(&rid);
                let is_abnormal = reason.is_some();
                let (kind, msg): (&str, String) = match reason {
                    Some("timeout") => (
                        "timeout",
                        "Timed out after 300s of silence (or 30m wall limit).".to_string(),
                    ),
                    Some("stopped") => (
                        "stopped",
                        "Stopped by Connor.".to_string(),
                    ),
                    _ => (
                        "done",
                        if last_text.is_empty() {
                            "Agent run ended without output.".to_string()
                        } else {
                            last_text
                        },
                    ),
                };
                // Log every terminal state (timeout, stopped, or clean-exit-no-result).
                // Previously only abnormal states were logged, so a process that exited
                // cleanly without a result event left no record in the agent's log.
                append_agent_log(&vault_clone, &aid, &rid, &task_clone, &msg, is_abnormal);

                // Append terminal record to trace: captures reason, silence duration,
                // and which step was last so the UI can pinpoint the hang.
                {
                    let terminal_elapsed = started.elapsed().as_millis() as u64;
                    let terminal_ts      = Local::now().to_rfc3339();
                    let silence_secs     = terminal_elapsed
                        .saturating_sub(last_trace_elapsed_ms) as f64 / 1000.0;
                    append_trace_line(&rid, serde_json::json!({
                        "ts": terminal_ts,
                        "elapsed_ms": terminal_elapsed,
                        "kind": "terminal",
                        "tool_name": null,
                        "input_summary": "",
                        "reason": kind,
                        "last_event_elapsed_ms": last_trace_elapsed_ms,
                        "silence_secs": silence_secs,
                        "total_events": trace_event_count,
                    }));
                }

                final_text = msg.clone();
                app2.emit("agent-stream", AgentStreamEvent {
                    run_id:        rid,
                    agent_id:      aid,
                    kind:          kind.into(),
                    text:          msg,
                    parent_run_id: prid,
                    input_tokens:  0,
                    output_tokens: 0,
                    usage_pct:     0.0,
                    outputs:       vec![],
                }).ok();
            }
            let _ = result_tx.send(final_text);
        });
    }

    Ok((run_id, result_rx))
}

// ── run_agent (Tauri command — fire-and-forget wrapper) ───────────────────────

#[tauri::command]
pub fn run_agent(
    app: AppHandle,
    dispatch: State<'_, DispatchState>,
    agent_run: State<'_, AgentRunState>,
    agent_id: String,
    task: String,
    parent_run_id: Option<String>,
    resume_session: bool,
    repo_path: Option<String>,
    builder_write: Option<bool>,
) -> Result<String, String> {
    let claude = dispatch.claude_path.lock().unwrap().clone();
    let (run_id, _rx) = spawn_agent_run(
        app,
        claude,
        agent_run.children.clone(),
        agent_run.reasons.clone(),
        agent_id,
        task,
        parent_run_id,
        resume_session,
        repo_path,
        builder_write,
    )?;
    Ok(run_id)
}

// ── get_active_run_ids ────────────────────────────────────────────────────────

/// Returns the run IDs of child processes that are still running.
/// Chat uses this on remount to avoid marking still-alive runs as "stopped".
#[tauri::command]
pub fn get_active_run_ids(agent_run: State<'_, AgentRunState>) -> Vec<String> {
    agent_run.children.lock().unwrap().keys().cloned().collect()
}

// ── stop_agent ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn stop_agent(agent_run: State<'_, AgentRunState>, run_id: String) -> Result<(), String> {
    agent_run.reasons.lock().unwrap().insert(run_id.clone(), "stopped");
    if let Some(child) = agent_run.children.lock().unwrap().get_mut(&run_id) {
        let _ = child.kill();
    }
    Ok(())
}

// ── open_path ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn open_agent_log(agent_id: String) -> Result<(), String> {
    if agent_id.is_empty() || agent_id.contains('/') || agent_id.contains("..") {
        return Err("invalid agent_id".into());
    }
    let path = vault_root().join("agents").join(&agent_id).join("log.md");
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Image upload ──────────────────────────────────────────────────────────────

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png"  => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif"  => Some("image/gif"),
        _ => None,
    }
}

fn is_allowed_image_ext(filename: &str) -> bool {
    matches!(
        filename.rsplit('.').next().map(|s| s.to_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif")
    )
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect::<String>()
        .to_lowercase()
}

#[tauri::command]
pub fn save_upload(filename: String, data_base64: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    if !is_allowed_image_ext(&filename) {
        return Err("Only png, jpg, jpeg, webp, and gif images are accepted".into());
    }
    let data = STANDARD.decode(&data_base64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if data.len() > 10 * 1024 * 1024 {
        return Err(format!(
            "Image too large ({:.1} MB); max is 10 MB",
            data.len() as f64 / 1_048_576.0,
        ));
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let safe = sanitize_filename(&filename);
    let dir = vault_root().join("active").join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{ts}-{safe}"));
    std::fs::write(&dest, &data).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Copy a file that the OS dropped onto the window directly into the vault.
/// Avoids the browser → base64 → Rust round-trip used by the file-picker path.
#[tauri::command]
pub fn save_upload_from_path(src_path: String) -> Result<String, String> {
    let src = std::path::Path::new(&src_path);
    let filename = src
        .file_name()
        .ok_or_else(|| "invalid path".to_string())?
        .to_string_lossy()
        .to_string();
    if !is_allowed_image_ext(&filename) {
        return Err("Only png, jpg, jpeg, webp, and gif images are accepted".into());
    }
    let data = std::fs::read(src).map_err(|e| e.to_string())?;
    if data.len() > 10 * 1024 * 1024 {
        return Err(format!(
            "Image too large ({:.1} MB); max is 10 MB",
            data.len() as f64 / 1_048_576.0,
        ));
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let safe = sanitize_filename(&filename);
    let dir = vault_root().join("active").join("uploads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{ts}-{safe}"));
    std::fs::write(&dest, &data).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Read a local image file and return it as a `data:<mime>;base64,…` URL
/// so the webview can display a thumbnail for natively-dropped files.
#[tauri::command]
pub fn read_file_as_data_url(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let p = std::path::Path::new(&path);
    let ext = p
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .rsplit('.')
        .next()
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let mime = image_mime(&ext).ok_or_else(|| "unsupported image format".to_string())?;
    let data = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&data)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_connectors() -> Vec<String> { vec![] }

    fn deny_set(agent_id: &str, profile: &str) -> std::collections::HashSet<String> {
        build_deny_list(agent_id, profile, &no_connectors(), false)
            .split(',')
            .map(|s| s.to_string())
            .collect()
    }

    const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

    #[test]
    fn offline_code_planner_is_read_only() {
        let deny = deny_set("planner", "offline-code");
        for tool in WRITE_TOOLS {
            assert!(deny.contains(*tool), "planner deny list missing {tool}: {deny:?}");
        }
    }

    #[test]
    fn offline_code_reviewer_is_read_only() {
        let deny = deny_set("reviewer", "offline-code");
        for tool in WRITE_TOOLS {
            assert!(deny.contains(*tool), "reviewer deny list missing {tool}: {deny:?}");
        }
    }

    #[test]
    fn builder_advisory_is_read_only() {
        let deny = deny_set("builder", "offline-code");
        for tool in WRITE_TOOLS {
            assert!(deny.contains(*tool), "builder advisory deny list missing {tool}: {deny:?}");
        }
    }

    #[test]
    fn builder_write_mode_grants_bash_and_rw() {
        let deny: std::collections::HashSet<String> = build_deny_list("builder", "offline-code", &no_connectors(), true)
            .split(',')
            .map(|s| s.to_string())
            .collect();
        assert!(!deny.contains("Write"),  "write mode must not deny Write");
        assert!(!deny.contains("Edit"),   "write mode must not deny Edit");
        assert!(!deny.contains("Bash"),   "write mode must not deny Bash");
        assert!(deny.contains("NotebookEdit"), "write mode must still deny NotebookEdit");
    }

    #[test]
    fn networked_agent_bash_and_notebook_denied() {
        // Bash and NotebookEdit are fully denied for all networked agents.
        // Write/Edit/MultiEdit are allowed but path-guarded by the vault write guard hook.
        for agent_id in &["clerk", "scout", "scribe"] {
            let deny = deny_set(agent_id, "networked");
            for tool in &["NotebookEdit", "Bash"] {
                assert!(
                    deny.contains(*tool),
                    "networked agent '{agent_id}' deny list must include {tool}, got: {deny:?}"
                );
            }
            // Write/Edit/MultiEdit must NOT be denied — the hook enforces the path boundary.
            for tool in &["Write", "Edit", "MultiEdit"] {
                assert!(
                    !deny.contains(*tool),
                    "networked agent '{agent_id}' deny list must NOT include {tool} (hook-guarded), got: {deny:?}"
                );
            }
        }
    }

    #[test]
    fn vault_write_guard_allows_vault_paths() {
        let vault = vault_root().to_string_lossy().into_owned();

        // Absolute path inside vault
        let inside = format!("{vault}/content/drafts/test.md");
        assert!(path_is_inside_vault(&inside), "absolute vault path should be allowed: {inside}");

        // Relative path (resolved relative to vault root)
        assert!(path_is_inside_vault("content/drafts/test.md"), "relative vault path should be allowed");

        // Vault root itself
        assert!(path_is_inside_vault(&vault), "vault root itself should be allowed");

        // Nested path
        let nested = format!("{vault}/agents/pulitzer/drafts/post-123/post.json");
        assert!(path_is_inside_vault(&nested), "nested vault path should be allowed");
    }

    #[test]
    fn vault_write_guard_blocks_outside_paths() {
        // Antfarm source code
        assert!(
            !path_is_inside_vault("/Users/connordore/Desktop/antfarm/src/main.rs"),
            "antfarm src must be blocked"
        );
        // System temp
        assert!(
            !path_is_inside_vault("/tmp/evil.sh"),
            "tmp path must be blocked"
        );
        // Absolute non-vault desktop path
        assert!(
            !path_is_inside_vault("/Users/connordore/Desktop/antfarm/src/anything"),
            "antfarm/src must be blocked"
        );
        // Path traversal attack: resolves to ~/Desktop/antfarm/src/main.rs
        assert!(
            !path_is_inside_vault("../../antfarm/src/main.rs"),
            "traversal attack must be blocked"
        );
        // Sibling directory whose name starts with vault name — must not prefix-match
        let vault = vault_root().to_string_lossy().into_owned();
        let sibling = format!("{vault}-evil/secret.txt");
        assert!(
            !path_is_inside_vault(&sibling),
            "sibling dir with vault-name prefix must be blocked"
        );
    }
}

