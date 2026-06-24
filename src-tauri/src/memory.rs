// memory.rs — Obsidian vault browser/editor backend.
//
// Backs the in-app "Memory" page. Reads and writes the markdown vault at
// ~/Desktop/antfarm-memory (the migrated CD_claude brain). All paths are
// relative to the vault root and validated against traversal so the UI can
// never read or write outside the vault.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

/// Root of the memory vault. Single source of truth for every command here.
fn vault_root() -> PathBuf {
    home_dir().join("Desktop").join("antfarm-memory")
}

/// Resolve a vault-relative path, rejecting absolute paths and `..` traversal.
fn safe_path(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|seg| seg == "..") {
        return Err(format!("invalid path: {rel}"));
    }
    Ok(vault_root().join(rel))
}

#[derive(Serialize)]
pub struct MemoryFile {
    pub path: String, // vault-relative, e.g. "tools-built/roastlytics/README.md"
    pub name: String, // basename, e.g. "README.md"
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<MemoryFile>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // skip .obsidian and other dotfiles
        }
        if path.is_dir() {
            walk(&path, root, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(MemoryFile {
                    path: rel.to_string_lossy().into_owned(),
                    name,
                });
            }
        }
    }
}

/// Flat, sorted list of every markdown note in the vault. The UI builds the
/// folder tree from the relative paths.
#[tauri::command]
pub fn memory_list() -> Vec<MemoryFile> {
    let root = vault_root();
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    out
}

#[tauri::command]
pub fn memory_read(path: String) -> Result<String, String> {
    let p = safe_path(&path)?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_write(path: String, content: String) -> Result<(), String> {
    let p = safe_path(&path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())
}

/// Append a dated record of a completed harness run to the memory vault, so the
/// agent's memory COMPOUNDS across runs instead of resetting each night. The next
/// run (which boots with the vault on `--add-dir`) can read this log and carry
/// continuity. Best-effort and never fails a run: all errors are swallowed.
pub fn append_run_memory(
    run_id: &str,
    goal: &str,
    status: &str,
    verdict: &str,
    summary: &str,
    cost_usd: f64,
) {
    let log = vault_root().join("active").join("agent-log.md");
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let verdict_str = if verdict.is_empty() { status } else { verdict };
    let summary_str = if summary.trim().is_empty() {
        "(no diff / no summary)"
    } else {
        summary.trim()
    };
    let entry = format!(
        "\n## {run_id} — {status}\n- ts: {ts} (unix seconds)\n- goal: {goal}\n- verdict: {verdict_str}\n- cost: ${cost_usd:.2}\n- summary: {summary_str}\n"
    );
    let mut doc = fs::read_to_string(&log).unwrap_or_default();
    if doc.trim().is_empty() {
        doc = "# Antfarm Agent Log\n\nAppend-only memory of what the overnight harness did. Newest entries at the bottom. The agent reads this to carry continuity across runs.\n".to_string();
    }
    doc.push_str(&entry);
    let _ = fs::write(&log, doc);
}

#[derive(Serialize)]
pub struct MemoryHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// Case-insensitive substring search across every note. Capped so a broad
/// query can't flood the UI or stall the thread.
#[tauri::command]
pub fn memory_search(query: String) -> Vec<MemoryHit> {
    let q = query.trim().to_lowercase();
    let mut hits = Vec::new();
    if q.is_empty() {
        return hits;
    }
    for f in memory_list() {
        let p = vault_root().join(&f.path);
        let content = match fs::read_to_string(&p) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                hits.push(MemoryHit {
                    path: f.path.clone(),
                    line: (i as u32) + 1,
                    text: line.trim().chars().take(160).collect(),
                });
                if hits.len() >= 200 {
                    return hits;
                }
            }
        }
    }
    hits
}
