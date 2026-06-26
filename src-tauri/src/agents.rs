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
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::dispatch::DispatchState;

const COMPACT_THRESHOLD_PCT: f32 = 50.0;
const MODEL_CONTEXT_WINDOW: u32  = 200_000;
const SILENCE_SECS: u64 = 120;
const WALL_SECS: u64    = 1800;

// ── Path ──────────────────────────────────────────────────────────────────────

fn vault_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join("Desktop")
        .join("antfarm-memory")
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

fn clear_agent_session_id(agent_id: &str) {
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

// ── Pending scheduled-run drain (show results in Chat on next open) ───────────

fn pending_runs_path() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join(".antfarm/scheduled-runs-pending.json")
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

                schedule_lock(&agent.id, &slot);
                push_pending_run(&agent.id, &agent.name, &time_str);

                let task      = scheduled_task(&agent);
                let agent_id  = agent.id.clone();
                let app2      = app.clone();
                std::thread::spawn(move || {
                    let dispatch  = app2.state::<DispatchState>();
                    let agent_run = app2.state::<AgentRunState>();
                    let _ = run_agent(app2.clone(), dispatch, agent_run, agent_id, task, None, false, None);
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
/// Bash is intentionally absent — no shell for networked agents.
fn networked_allowed_tools(connectors: &[String]) -> String {
    let mut tools = vec!["Read", "Write", "Edit", "Glob", "Grep"];
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
///   • builder (offline-code):  Write,Edit,MultiEdit,NotebookEdit,Bash + all 44 GWS tools
///   • networked agents:        Bash + (44 GWS universe minus this agent's granted GWS tools)
///   • start_google_auth always denied for everyone
fn build_deny_list(agent_id: &str, profile: &str, connectors: &[String]) -> String {
    let mut deny: Vec<String> = Vec::new();

    if profile == "networked" {
        deny.push("Bash".to_string());
        if !connectors.iter().any(|c| c == "web") {
            deny.push("WebSearch".to_string());
            deny.push("WebFetch".to_string());
        }
    }

    if agent_id == "builder" {
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

// ── run_agent ─────────────────────────────────────────────────────────────────

/// Spawn a claude -p agent run. Reads agent.json + prompt.md, injects write-scope
/// and (for subagents) NEEDS YOU instructions, streams "agent-stream" events,
/// appends to log.md on completion.
///
/// `parent_run_id` — set by the orchestrator fan-out so the frontend can group
/// subagent chatter under the parent turn.
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
) -> Result<String, String> {
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
    let write_scope = format!(
        "\n\nVault write scope: you may only create or modify files under \
         `agents/{}/` and `active/`. Do not write to any other vault paths.",
        agent_id
    );

    // ── Role-specific tail instructions ──────────────────────────────────────
    // Orchestrator: delegation block protocol so the app can wire real subagent runs.
    // Subagents: NEEDS YOU gate for irreversible actions.
    let role_note: String = if agent.role == "orchestrator" {
        "\n\nDelegation protocol: when you want to dispatch work to a subagent, end \
         your message with a fenced delegate block (and ONLY when you're actually \
         dispatching — omit it when you're just answering). Valid agent ids: \
         scout, scribe, clerk, builder. One line per agent, id then colon then task.\n\
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
            note.push_str(
                "\n\nYou are in read-only advisory mode in chat: read the repo and answer \
                 Connor's question, do not write files or run commands. Be surgical and \
                 token-efficient — use Glob/Grep to find the few relevant files and read only \
                 those, never slurp the whole tree. For real code changes, Connor dispatches \
                 you to the build harness."
            );
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
    let now = Local::now().format("%Y-%m-%d %H:%M %Z").to_string();
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
    let claude    = dispatch.claude_path.lock().unwrap().clone();
    let vault_str = vault.to_string_lossy().into_owned();

    let mut cmd = Command::new(&claude);
    if let Some(ref sid) = existing_sid {
        // Warm resume: only user task (+ current time). No --add-dir needed.
        let now = Local::now().format("%Y-%m-%d %H:%M %Z").to_string();
        let msg  = format!("Current date and time: {now}\n\nUser: {task}");
        cmd.args(["--resume", sid, "-p", &msg,
                  "--output-format", "stream-json",
                  "--verbose",
                  "--permission-mode", "dontAsk",
                  "--model", &agent.model]);
    } else {
        // Cold start: full system prompt + --add-dir (scope depends on agent role).
        cmd.args(["-p", &full_prompt,
                  "--output-format", "stream-json",
                  "--verbose",
                  "--permission-mode", "dontAsk",
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
            }
        }
    }

    // Unified deny list — applied on every turn (cold + resume) for all agents.
    // Exactly one --disallowedTools call. Builder and networked both covered here.
    let deny = build_deny_list(&agent_id, &agent.profile, &agent.connectors);
    if !deny.is_empty() { cmd.args(["--disallowedTools", &deny]); }

    // Networked agents: allowed list only. Do NOT load settings.networked.json via
    // --settings — its explicit permissions.allow list creates a secondary permission
    // gate that overrides --permission-mode dontAsk and causes headless Write calls
    // to hang silently (stdin is /dev/null; the gate waits for input that never arrives).
    // Security is fully covered by --disallowedTools above, which is authoritative.
    if is_networked {
        let allowed = networked_allowed_tools(&agent.connectors);
        if !allowed.is_empty() { cmd.args(["--allowedTools", &allowed]); }
    }

    let mut child = cmd
        .current_dir(&vault)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn {claude}: {e}"))?;

    let run_id = new_agent_run_id(&agent_id);
    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    agent_run.children.lock().unwrap().insert(run_id.clone(), child);

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
    {
        let app2            = app.clone();
        let rid             = run_id.clone();
        let aid             = agent_id.clone();
        let task_clone      = task.clone();
        let vault_clone     = vault.clone();
        let children_arc    = agent_run.children.clone();
        let reasons_arc     = agent_run.reasons.clone();
        let la_reader       = last_activity.clone();
        let is_resuming_clone     = is_resuming;
        let resume_session_clone  = resume_session;

        // Watchdog: kills the child if silent > SILENCE_SECS or wall time > WALL_SECS.
        // Does NOT emit events — the reader's safety-net branch emits the terminal event.
        {
            let children_wd = agent_run.children.clone();
            let reasons_wd  = agent_run.reasons.clone();
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
            let reader      = BufReader::new(stdout);
            let mut last_text   = String::new();
            let mut result_text = String::new();
            let mut captured_sid: Option<String> = None;
            let mut input_tokens:  u32 = 0;
            let mut output_tokens: u32 = 0;
            let mut outputs: Vec<String> = Vec::new();
            // Trace bookkeeping: elapsed_ms of the last traced event, total event count.
            let mut last_trace_elapsed_ms: u64 = 0;
            let mut trace_event_count:     u32 = 0;

            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                *la_reader.lock().unwrap() = std::time::Instant::now();
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
                        "Timed out after 120s of silence (or 30m wall limit).".to_string(),
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
        });
    }

    Ok(run_id)
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

// ── Networked settings scaffold ───────────────────────────────────────────────

/// Write ~/.claude/settings.networked.json and mirror to the vault.
/// Called once to bootstrap the allowlist that networked agents load via --settings.
#[tauri::command]
pub fn scaffold_networked_settings() -> Result<String, String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
    let claude_dir = home.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;

    // Build allow list: base tools + union of all possible GWS grants across connectors.
    // Per-agent restriction is enforced via --disallowedTools at runtime; this file
    // acts as a defense-in-depth layer for tools that no networked agent should ever call.
    let mut allow_list: Vec<serde_json::Value> = vec![
        "Read".into(), "Write".into(), "Edit".into(), "Glob".into(), "Grep".into(),
        "WebSearch".into(), "WebFetch".into(),
    ];
    // Add the full granted sets (union across connectors) as allowed
    for pfx in GWS_PREFIXES {
        for sfx in GMAIL_GRANTED_SUFFIXES { allow_list.push(format!("{pfx}{sfx}").into()); }
        for sfx in CAL_GRANTED_SUFFIXES   { allow_list.push(format!("{pfx}{sfx}").into()); }
    }

    // Globally denied for all networked agents regardless of connector.
    // Includes Bash + the permanently-off GWS tool suffixes across both prefixes.
    let always_deny_suffixes = [
        "start_google_auth",
        "manage_gmail_filter",
        "manage_gmail_label",
        "create_calendar",
        "manage_focus_time",
        "manage_out_of_office",
    ];
    let mut deny_list: Vec<serde_json::Value> = vec!["Bash".into()];
    for pfx in GWS_PREFIXES {
        for sfx in always_deny_suffixes {
            deny_list.push(format!("{pfx}{sfx}").into());
        }
    }

    let settings = serde_json::json!({
        "permissions": {
            "allow": allow_list,
            "deny":  deny_list,
        }
    });

    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let dest = claude_dir.join("settings.networked.json");
    fs::write(&dest, &json).map_err(|e| e.to_string())?;

    // Mirror to vault so Connor can review/edit it there too.
    let vault_copy = vault_root().join("settings.networked.json");
    let _ = fs::write(vault_copy, &json);

    Ok(dest.to_string_lossy().into_owned())
}
