// agents.rs — Agent registry backend.
//
// Reads antfarm-memory/agents/*/agent.json and exposes list_agents() and
// get_agent(id) to the frontend. Reuses the vault-path pattern from memory.rs.
// Tolerant parser: missing/malformed files are silently skipped.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn vault_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
        .join("Desktop")
        .join("antfarm-memory")
}

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

/// All agents in vault order: orchestrator first, then alphabetically by name.
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
            let json_path = path.join("agent.json");
            let content = fs::read_to_string(&json_path).ok()?;
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
    let json_path = vault_root().join("agents").join(&id).join("agent.json");
    let content = fs::read_to_string(&json_path).ok()?;
    serde_json::from_str(&content).ok()
}
