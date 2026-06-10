// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Project {
    slug: String,
    name: String,
    status: Option<String>,
    last_activity: Option<u64>,
    idea_count: usize,
    decision_count: usize,
    repos: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RegistryProject {
    #[serde(default)]
    repos: Vec<String>,
}

#[derive(Deserialize, Default)]
struct Registry {
    #[serde(default)]
    projects: HashMap<String, RegistryProject>,
}

fn mtime_secs(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().and_then(|m| {
        m.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()))
    })
}

fn newest_mtime(dir: &Path) -> Option<u64> {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return mtime_secs(dir),
    };
    let mut best = mtime_secs(dir);
    for entry in rd.flatten() {
        let p = entry.path();
        let t = if p.is_dir() {
            newest_mtime(&p)
        } else {
            mtime_secs(&p)
        };
        match (best, t) {
            (None, Some(v)) => best = Some(v),
            (Some(a), Some(b)) if b > a => best = Some(b),
            _ => {}
        }
    }
    best
}

fn count_bullets(path: &Path) -> usize {
    match fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                t.starts_with("- ") || t.starts_with("* ")
            })
            .count(),
        Err(_) => 0,
    }
}

fn extract_name(readme: &Path, fallback: &str) -> String {
    match fs::read_to_string(readme) {
        Ok(content) => {
            for line in content.lines() {
                if let Some(rest) = line.trim().strip_prefix("# ") {
                    let name = rest.trim().to_string();
                    if !name.is_empty() {
                        return name;
                    }
                }
            }
            fallback.to_string()
        }
        Err(_) => fallback.to_string(),
    }
}

fn extract_status(readme: &Path) -> Option<String> {
    match fs::read_to_string(readme) {
        Ok(content) => {
            for line in content.lines() {
                if let Some(rest) = line.trim().strip_prefix("Status:") {
                    let s = rest.trim().to_string();
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
            None
        }
        Err(_) => None,
    }
}

fn load_registry(brain_root: &Path) -> Registry {
    match fs::read_to_string(brain_root.join("ant-farm-registry.json")) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Registry::default(),
    }
}

fn scan_projects(tools_dir: &Path, registry: &Registry) -> Vec<Project> {
    let rd = match fs::read_dir(tools_dir) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let mut projects: Vec<Project> = rd
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let slug = path.file_name()?.to_string_lossy().to_string();
            let readme = path.join("README.md");
            Some(Project {
                name: extract_name(&readme, &slug),
                status: extract_status(&readme),
                last_activity: newest_mtime(&path),
                idea_count: count_bullets(&path.join("ideas.md")),
                decision_count: count_bullets(&path.join("decisions.md")),
                repos: registry
                    .projects
                    .get(&slug)
                    .map(|p| p.repos.clone())
                    .unwrap_or_default(),
                slug,
            })
        })
        .collect();

    projects.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    projects
}

#[tauri::command]
fn list_projects() -> Vec<Project> {
    let home = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h),
        Err(_) => return vec![],
    };
    let brain_root = home.join("Desktop").join("CD_claude");
    let registry = load_registry(&brain_root);
    scan_projects(&brain_root.join("tools-built"), &registry)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_projects])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
