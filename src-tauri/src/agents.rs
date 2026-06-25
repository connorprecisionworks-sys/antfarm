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

// ── State ─────────────────────────────────────────────────────────────────────

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

/// Event payload emitted as "agent-stream" Tauri event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStreamEvent {
    pub run_id: String,
    pub agent_id: String,
    /// "start" | "text" | "done" | "error"
    pub kind: String,
    pub text: String,
    /// Non-null for subagent runs spawned by orchestrator fan-out.
    pub parent_run_id: Option<String>,
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

/// Comma-separated allowedTools string for a networked agent, keyed by connector list.
fn networked_allowed_tools(connectors: &[String]) -> String {
    let mut tools = vec!["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
    for c in connectors {
        match c.as_str() {
            "web" => {
                tools.push("WebSearch");
                tools.push("WebFetch");
            }
            "gmail" => {
                tools.extend([
                    "mcp__claude_ai_Gmail__search_threads",
                    "mcp__claude_ai_Gmail__get_thread",
                    "mcp__claude_ai_Gmail__create_draft",
                    "mcp__claude_ai_Gmail__list_drafts",
                    "mcp__claude_ai_Gmail__list_labels",
                    "mcp__claude_ai_Gmail__label_thread",
                    "mcp__claude_ai_Gmail__label_message",
                ]);
            }
            "calendar" => {
                tools.extend([
                    "mcp__claude_ai_Google_Calendar__list_events",
                    "mcp__claude_ai_Google_Calendar__create_event",
                    "mcp__claude_ai_Google_Calendar__update_event",
                    "mcp__claude_ai_Google_Calendar__delete_event",
                ]);
            }
            _ => {}
        }
    }
    tools.join(",")
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
                "**gmail** — Gmail tools available: search_threads, get_thread, create_draft, \
                 list_drafts, list_labels, label_thread, label_message. \
                 Auto-allowed: search, read, triage, label, archive, create drafts. \
                 GATE (stop and ask): anything that leaves the building (sending). \
                 To surface a draft for approval: write content to \
                 `active/drafts/email-<unix-epoch>.md` (sections: Subject, To, Body), \
                 then end with: NEEDS YOU: <one sentence — what you will do once approved>.".into(),
            ),
            "calendar" => parts.push(
                "**calendar** — Google Calendar tools for reading and creating events. \
                 Note: calendar may need re-authentication if not yet authorized.".into(),
            ),
            _ => {}
        }
    }
    parts.join("\n\n")
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
        "\n\nIf completing this task requires Connor's approval before an irreversible \
         action (sending email, merging code, posting, spending money), end your \
         response with exactly:\nNEEDS YOU: <one sentence — what you'll do once approved>"
            .to_string()
    };

    // ── Daily context preamble (orchestrator + clerk) ─────────────────────────
    // Injects plan staleness, recent commits, and today's agent activity so
    // these agents never work blind. Other agents stay lean.
    let daily_preamble = if agent.role == "orchestrator" || agent_id == "clerk" {
        crate::daily::daily_context_preamble(&vault)
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
            "{sys}{write_scope}{daily_preamble}{connector_prompt}{role_note}\n\n---\n\nCurrent date and time: {now}\n\nUser: {task}"
        ),
        None => format!(
            "Current date and time: {now}{write_scope}{daily_preamble}{connector_prompt}{role_note}\n\nUser: {task}"
        ),
    };

    // ── Spawn child ───────────────────────────────────────────────────────────
    let claude  = dispatch.claude_path.lock().unwrap().clone();
    let add_dir = vault.to_string_lossy().into_owned(); // full vault = full read access

    let mut cmd = Command::new(&claude);
    cmd.args([
        "-p", &full_prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "dontAsk",
        "--model", &agent.model,
        "--add-dir", &add_dir,
    ]);

    // Networked agents get explicit tool allowlist + optional settings file.
    if is_networked {
        let allowed = networked_allowed_tools(&agent.connectors);
        if !allowed.is_empty() {
            cmd.args(["--allowedTools", &allowed]);
        }
        let settings_path = PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join(".claude")
            .join("settings.networked.json");
        if settings_path.exists() {
            cmd.arg("--settings").arg(&settings_path);
        }
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
            let mut last_text   = String::new();
            let mut result_text = String::new();

            for line in reader.lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };

                let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

                if typ == "assistant" {
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
                            run_id:        rid.clone(),
                            agent_id:      aid.clone(),
                            kind:          "text".into(),
                            text:          chunk_text,
                            parent_run_id: prid.clone(),
                        }).ok();
                    }
                } else if typ == "result" {
                    let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                    result_text = v.get("result").and_then(|r| r.as_str())
                        .unwrap_or(&last_text)
                        .to_string();

                    append_agent_log(&vault_clone, &aid, &rid, &task_clone, &result_text, is_error);

                    app2.emit("agent-stream", AgentStreamEvent {
                        run_id:        rid.clone(),
                        agent_id:      aid.clone(),
                        kind:          if is_error { "error".into() } else { "done".into() },
                        text:          result_text.clone(),
                        parent_run_id: prid.clone(),
                    }).ok();
                }
            }

            // Reap child.
            children_arc.lock().unwrap().remove(&rid).and_then(|mut c| c.wait().ok());

            // Safety net: emit done if we never got a `result` event.
            if result_text.is_empty() {
                let msg = if last_text.is_empty() {
                    "Agent run ended without output.".into()
                } else {
                    last_text
                };
                app2.emit("agent-stream", AgentStreamEvent {
                    run_id:        rid,
                    agent_id:      aid,
                    kind:          "done".into(),
                    text:          msg,
                    parent_run_id: prid,
                }).ok();
            }
        });
    }

    Ok(run_id)
}

// ── Networked settings scaffold ───────────────────────────────────────────────

/// Write ~/.claude/settings.networked.json and mirror to the vault.
/// Called once to bootstrap the allowlist that networked agents load via --settings.
#[tauri::command]
pub fn scaffold_networked_settings() -> Result<String, String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
    let claude_dir = home.join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;

    let settings = serde_json::json!({
        "permissions": {
            "allow": [
                "Bash", "Read", "Write", "Edit", "Glob", "Grep",
                "WebSearch", "WebFetch",
                "mcp__claude_ai_Gmail__search_threads",
                "mcp__claude_ai_Gmail__get_thread",
                "mcp__claude_ai_Gmail__create_draft",
                "mcp__claude_ai_Gmail__list_drafts",
                "mcp__claude_ai_Gmail__list_labels",
                "mcp__claude_ai_Gmail__label_thread",
                "mcp__claude_ai_Gmail__label_message"
            ],
            "deny": []
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
