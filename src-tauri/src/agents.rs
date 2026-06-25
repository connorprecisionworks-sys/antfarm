// agents.rs — Agent registry + runner backend.
//
// Phase 1: list_agents() and get_agent(id) reading antfarm-memory/agents/*/agent.json.
// Phase 2: run_agent(agent_id, task) — spawns claude -p, streams stdout back as
//   "agent-stream" Tauri events, appends outcome to agent's log.md.
//
// Reuses the vault-path pattern from memory.rs. Tolerant parser: missing/malformed
// files surface as empty results rather than errors.

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::dispatch::DispatchState;

// ── Path ──────────────────────────────────────────────────────────────────────

fn vault_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join("Desktop")
        .join("antfarm-memory")
}

// ── State for tracking live agent processes ───────────────────────────────────

pub struct AgentRunState {
    pub children: Arc<Mutex<HashMap<String, Child>>>,
}

impl Default for AgentRunState {
    fn default() -> Self {
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
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

/// Per-event payload emitted as "agent-stream" to the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub run_id: String,
    pub agent_id: String,
    /// "start" | "text" | "done" | "error"
    pub kind: String,
    pub text: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Extract the usable system prompt from prompt.md.
/// The file is structured as: title/intro, "---", actual prompt.
/// Returns everything after the first horizontal rule (or the full file if none).
fn extract_system_prompt(content: &str) -> String {
    if let Some(idx) = content.find("\n---\n") {
        return content[idx + 5..].trim().to_string();
    }
    content.trim().to_string()
}

/// Append a one-line outcome entry to the agent's log.md. Best-effort.
fn append_agent_log(vault: &PathBuf, agent_id: &str, run_id: &str, task: &str, result: &str, is_error: bool) {
    let log_path = vault.join("agents").join(agent_id).join("log.md");
    let now = Local::now().format("%Y-%m-%d %H:%M").to_string();
    let status = if is_error { "error" } else { "done" };
    let task_short: String = task.chars().take(80).collect();
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

/// Run-id generator — timestamp + agent prefix.
fn new_agent_run_id(agent_id: &str) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("agent-{agent_id}-{ts}")
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

/// Single agent by id. Returns None if not found or malformed.
#[tauri::command]
pub fn get_agent(id: String) -> Option<Agent> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let content = fs::read_to_string(vault_root().join("agents").join(&id).join("agent.json")).ok()?;
    serde_json::from_str(&content).ok()
}

// ── run_agent ─────────────────────────────────────────────────────────────────

/// Spawn an agent run: reads agent.json + prompt.md, fires claude -p, streams
/// stdout as "agent-stream" events, and appends an outcome line to log.md.
/// Returns the run_id immediately; the run continues in background threads.
#[tauri::command]
pub fn run_agent(
    app: AppHandle,
    dispatch: State<'_, DispatchState>,
    agent_run: State<'_, AgentRunState>,
    agent_id: String,
    task: String,
) -> Result<String, String> {
    let vault = vault_root();

    // ── Load agent definition ──────────────────────────────────────────────────
    let agent_json = vault.join("agents").join(&agent_id).join("agent.json");
    let agent: Agent = fs::read_to_string(&agent_json)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .ok_or_else(|| format!("agent not found: {agent_id}"))?;

    // ── Load system prompt from prompt.md (optional) ──────────────────────────
    let prompt_path = vault.join("agents").join(&agent_id).join("prompt.md");
    let system_prompt = fs::read_to_string(&prompt_path)
        .ok()
        .map(|c| extract_system_prompt(&c));

    // ── Build the -p value ────────────────────────────────────────────────────
    let now = Local::now().format("%Y-%m-%d %H:%M %Z").to_string();
    let full_prompt = match system_prompt {
        Some(sys) => format!("{sys}\n\n---\n\nCurrent date and time: {now}\n\nUser: {task}"),
        None      => format!("Current date and time: {now}\n\nUser: {task}"),
    };

    // ── Resolve claude path + vault --add-dir ─────────────────────────────────
    let claude = dispatch.claude_path.lock().unwrap().clone();
    // Pass the full vault root so the agent can read active/, agents/*, etc.
    let add_dir = vault.to_string_lossy().into_owned();

    // ── Spawn child ───────────────────────────────────────────────────────────
    let mut child = Command::new(&claude)
        .args([
            "-p", &full_prompt,
            "--output-format", "stream-json",
            "--verbose",
            "--permission-mode", "dontAsk",
            "--model", &agent.model,
            "--add-dir", &add_dir,
        ])
        .current_dir(&vault)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn {claude}: {e}"))?;

    let run_id = new_agent_run_id(&agent_id);
    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    agent_run.children.lock().unwrap().insert(run_id.clone(), child);

    // Emit "start" so the frontend knows the run is live
    app.emit("agent-stream", AgentStreamEvent {
        run_id: run_id.clone(),
        agent_id: agent_id.clone(),
        kind: "start".into(),
        text: String::new(),
    }).ok();

    // ── stdout reader thread ──────────────────────────────────────────────────
    {
        let app2         = app.clone();
        let rid          = run_id.clone();
        let aid          = agent_id.clone();
        let task_clone   = task.clone();
        let vault_clone  = vault.clone();
        let children_arc = agent_run.children.clone();

        std::thread::spawn(move || {
            let reader      = BufReader::new(stdout);
            let mut last_text   = String::new(); // accumulate assistant turns
            let mut result_text = String::new();

            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };

                let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

                if typ == "assistant" {
                    // Extract text content from message.content[]
                    let mut chunks = Vec::new();
                    if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                        for block in content {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    chunks.push(text.to_string());
                                }
                            }
                        }
                    }
                    if !chunks.is_empty() {
                        let chunk_text = chunks.join("");
                        last_text = chunk_text.clone();
                        app2.emit("agent-stream", AgentStreamEvent {
                            run_id:   rid.clone(),
                            agent_id: aid.clone(),
                            kind:     "text".into(),
                            text:     chunk_text,
                        }).ok();
                    }
                } else if typ == "result" {
                    let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    result_text = v.get("result").and_then(|r| r.as_str())
                        .unwrap_or(&last_text)
                        .to_string();

                    append_agent_log(
                        &vault_clone,
                        &aid,
                        &rid,
                        &task_clone,
                        &result_text,
                        is_error,
                    );

                    app2.emit("agent-stream", AgentStreamEvent {
                        run_id:   rid.clone(),
                        agent_id: aid.clone(),
                        kind:     if is_error { "error".into() } else { "done".into() },
                        text:     result_text.clone(),
                    }).ok();
                }
            }

            // Reap child
            children_arc.lock().unwrap().remove(&rid).and_then(|mut c| c.wait().ok());

            // Emit done if we never got a "result" event (e.g. claude errored immediately)
            if result_text.is_empty() {
                let msg = if last_text.is_empty() { "Agent run ended without output.".into() } else { last_text };
                app2.emit("agent-stream", AgentStreamEvent {
                    run_id:   rid,
                    agent_id: aid.clone(),
                    kind:     "done".into(),
                    text:     msg,
                }).ok();
            }
        });
    }

    Ok(run_id)
}
