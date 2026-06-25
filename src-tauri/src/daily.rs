// daily.rs — Day-awareness primitives for Phase 4.
//
// Provides:
//   get_plan_state()    — most recent plan-YYYY-MM-DD.json; flags staleness
//   get_daily_context() — plan + git commits + agent log excerpts (sensors)
//   write_daily_recap() — writes active/daily/YYYY-MM-DD.md
//   write_plan()        — writes / overwrites active/state/plan-YYYY-MM-DD.json
//
// daily_context_preamble() is a pub helper called by agents.rs to inject
// today's state into Captain Jack and Clerk's -p prompts.

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::time::UNIX_EPOCH;
use tauri::command;

// ── Paths ─────────────────────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

fn vault_root() -> PathBuf {
    home_dir().join("Desktop").join("antfarm-memory")
}

fn antfarm_repo() -> PathBuf {
    home_dir().join("Desktop").join("antfarm")
}

fn today_str() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

// ── Types ─────────────────────────────────────────────────────────────────────

/// Minimal typed view of the plan file. The full raw JSON is also returned
/// so the frontend can display it without us needing to mirror every field.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanState {
    /// Date string from the most recent plan file (or today if none found).
    pub date: String,
    /// Today's date — used by the frontend to compute staleness without trust issues.
    pub today: String,
    /// true when plan.date != today (a past plan is on disk, not today's).
    pub stale: bool,
    /// false when no plan-*.json file exists at all.
    pub file_exists: bool,
    /// How many days old the plan is (0 = today, 1 = yesterday, …).
    pub days_old: i64,
    /// Best-effort focus line (null if the file schema doesn't have one).
    pub focus: Option<String>,
    /// Number of unfinished items the app can detect (null = can't parse items).
    pub open_items: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DailyContext {
    pub plan: PlanState,
    /// Recent git commits from all registry repos (last 48h).
    pub recent_commits: Vec<String>,
    /// Today's run entries across all agent log.md files.
    pub agent_log_lines: Vec<String>,
    /// Claude Code sessions active today (title / cwd label).
    pub cc_sessions: Vec<String>,
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

/// Find the most recent plan-YYYY-MM-DD.json under active/state/.
/// Returns (date_string, path) or None.
fn find_most_recent_plan(vault: &PathBuf) -> Option<(String, PathBuf)> {
    let state_dir = vault.join("active").join("state");
    let rd = fs::read_dir(&state_dir).ok()?;
    let mut plans: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if name.starts_with("plan-") && name.ends_with(".json") {
                let date = name
                    .trim_start_matches("plan-")
                    .trim_end_matches(".json")
                    .to_string();
                // Validate YYYY-MM-DD
                if date.len() == 10 && date.chars().filter(|c| *c == '-').count() == 2 {
                    return Some((date, path));
                }
            }
            None
        })
        .collect();
    plans.sort_by(|a, b| b.0.cmp(&a.0)); // most recent first
    plans.into_iter().next()
}

fn days_between(from: &str, to: &str) -> i64 {
    let parse = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    match (parse(from), parse(to)) {
        (Some(f), Some(t)) => (t - f).num_days(),
        _ => 0,
    }
}

fn read_plan_state_inner(vault: &PathBuf) -> PlanState {
    let today = today_str();

    let Some((date, path)) = find_most_recent_plan(vault) else {
        return PlanState {
            date: today.clone(),
            today,
            stale: false,
            file_exists: false,
            days_old: 0,
            focus: None,
            open_items: None,
        };
    };

    let raw: serde_json::Value = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or(serde_json::Value::Null);

    // Best-effort extraction of optional fields.
    let focus = raw.get("focus").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Count open items — try the standardised "items" array; fall back to
    // any array field containing objects with a "status" != "done".
    let open_items = raw
        .get("items")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|item| {
                    item.get("status")
                        .and_then(|s| s.as_str())
                        .map(|s| s != "done")
                        .unwrap_or(true)
                })
                .count()
        });

    let days_old = days_between(&date, &today);

    PlanState {
        stale: date != today,
        days_old,
        file_exists: true,
        focus,
        open_items,
        date,
        today,
    }
}

// ── Sensor helpers ────────────────────────────────────────────────────────────

/// Discover all resolvable (slug, repo_path) pairs from the registry.
fn registry_repos(vault: &PathBuf) -> Vec<(String, PathBuf)> {
    let registry_path = vault.join("ant-farm-registry.json");
    let Ok(content) = fs::read_to_string(&registry_path) else { return vec![]; };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { return vec![]; };
    let Some(projects) = v.get("projects").and_then(|p| p.as_object()) else { return vec![]; };
    let home = home_dir();
    let mut results = vec![];
    for (slug, proj) in projects {
        let repos = proj.get("repos").and_then(|r| r.as_array()).cloned().unwrap_or_default();
        for repo in &repos {
            let Some(name) = repo.as_str() else { continue };
            let candidates = [
                home.join("Desktop").join(name),
                home.join(name),
            ];
            for path in &candidates {
                if path.join(".git").exists() {
                    results.push((slug.clone(), path.clone()));
                    break;
                }
            }
        }
    }
    results
}

/// Recent commits across all registry repos + the antfarm app repo.
fn read_recent_commits(vault: &PathBuf) -> Vec<String> {
    let mut all: Vec<String> = Vec::new();

    // Registry repos
    for (slug, repo_path) in registry_repos(vault) {
        let Ok(out) = Command::new("git")
            .args(["log", "--since=48 hours ago", "--oneline", "-10"])
            .current_dir(&repo_path)
            .output()
        else { continue };
        if !out.status.success() { continue }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if !line.is_empty() {
                all.push(format!("[{slug}] {line}"));
            }
        }
    }

    // Antfarm app repo (not in registry)
    let app_repo = antfarm_repo();
    if let Ok(out) = Command::new("git")
        .args(["log", "--since=48 hours ago", "--oneline", "-10"])
        .current_dir(&app_repo)
        .output()
    {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if !line.is_empty() {
                    all.push(format!("[antfarm] {line}"));
                }
            }
        }
    }

    all
}

/// CC sessions modified today — returns human-readable labels.
fn read_today_cc_sessions() -> Vec<String> {
    let projects_dir = home_dir().join(".claude/projects");
    let today = today_str();
    let Ok(dirs) = fs::read_dir(&projects_dir) else { return vec![]; };
    let mut sessions: Vec<String> = Vec::new();

    for dir_entry in dirs.flatten() {
        let dir = dir_entry.path();
        if !dir.is_dir() { continue; }
        let Ok(files) = fs::read_dir(&dir) else { continue; };
        for fe in files.flatten() {
            let fpath = fe.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }

            // Only sessions touched today
            let Ok(meta) = fs::metadata(&fpath) else { continue; };
            let mtime_today = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| {
                    chrono::Local.timestamp_opt(d.as_secs() as i64, 0)
                        .single()
                        .map(|dt| dt.format("%Y-%m-%d").to_string() == today)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if !mtime_today { continue; }

            // Extract title + cwd from first 6 KB
            let Ok(f) = fs::File::open(&fpath) else { continue; };
            let mut buf = String::new();
            let _ = std::io::BufReader::new(f).take(6144).read_to_string(&mut buf);

            let mut title: Option<String> = None;
            let mut cwd: Option<String> = None;
            for line in buf.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                if title.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                    title = v.get("aiTitle").and_then(|t| t.as_str()).map(|s| s.to_string());
                }
                if cwd.is_none() {
                    if let Some(c) = v.get("cwd").and_then(|c| c.as_str()).filter(|s| !s.is_empty()) {
                        cwd = Some(c.to_string());
                    }
                }
                if title.is_some() && cwd.is_some() { break; }
            }

            let cwd_label = cwd.as_deref()
                .map(|c| {
                    std::path::Path::new(c)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(c)
                        .to_string()
                })
                .unwrap_or_else(|| "unknown".to_string());

            let entry = match title {
                Some(t) => format!("{cwd_label}: \"{t}\""),
                None if cwd.is_some() => format!("session in {cwd_label}"),
                _ => continue,
            };
            if !sessions.contains(&entry) {
                sessions.push(entry);
            }
        }
    }
    sessions
}

fn read_today_agent_logs(vault: &PathBuf) -> Vec<String> {
    let today = today_str();
    let agents_dir = vault.join("agents");
    let Ok(entries) = fs::read_dir(&agents_dir) else {
        return vec![];
    };

    let mut lines: Vec<String> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let agent_id = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let log_path = path.join("log.md");
        let Ok(content) = fs::read_to_string(&log_path) else {
            continue;
        };

        // Collect lines from ## sections whose header contains today's date.
        let mut in_today = false;
        for line in content.lines() {
            if line.starts_with("## ") {
                in_today = line.contains(&today);
            }
            if in_today && !line.trim().is_empty() {
                lines.push(format!("[{agent_id}] {line}"));
            }
        }
    }

    lines
}

// ── Preamble for agent prompt injection ───────────────────────────────────────

/// Build a concise markdown preamble injected into Captain Jack + Clerk prompts.
/// Keeps agents calibrated to the real day without requiring them to parse files themselves.
pub fn daily_context_preamble(vault: &PathBuf) -> String {
    let plan = read_plan_state_inner(vault);
    let commits = read_recent_commits(vault);
    let cc_sessions = read_today_cc_sessions();
    let agent_logs = read_today_agent_logs(vault);

    let mut out = String::new();

    // ── Plan state ────────────────────────────────────────────────────────────
    out.push_str("\n\n## Day state (injected by app)");
    if !plan.file_exists {
        out.push_str("\nNo plan file found. Today is unplanned — offer to plan it.");
    } else if plan.stale {
        let noun = if plan.days_old == 1 { "day" } else { "days" };
        let open = plan
            .open_items
            .map(|n| format!(", {n} item(s) still open"))
            .unwrap_or_default();
        out.push_str(&format!(
            "\nPLAN IS STALE — last plan is from {} ({} {noun} ago{}). \
             Today is {}. Never present the stale plan as current. \
             Surface the staleness plainly and offer to reconcile.",
            plan.date, plan.days_old, open, plan.today
        ));
    } else {
        let focus = plan
            .focus
            .as_deref()
            .unwrap_or("(no focus set)");
        let open_note = plan
            .open_items
            .map(|n| {
                if n == 0 {
                    " All items done.".to_string()
                } else {
                    format!(" {n} item(s) open.")
                }
            })
            .unwrap_or_default();
        out.push_str(&format!(
            "\nToday's plan is current ({date}). Focus: \"{focus}\".{open_note}",
            date = plan.date,
        ));
    }

    // ── CC sessions today ────────────────────────────────────────────────────
    if !cc_sessions.is_empty() {
        out.push_str("\n\n## Claude Code sessions today\n");
        for s in &cc_sessions {
            out.push_str(&format!("- {s}\n"));
        }
    }

    // ── Recent commits (all registry repos + antfarm, last 48h) ──────────────
    if !commits.is_empty() {
        out.push_str("\n\n## Recent commits (last 48h)\n");
        out.push_str(&commits.join("\n"));
    }

    // ── Agent activity today ──────────────────────────────────────────────────
    if !agent_logs.is_empty() {
        out.push_str("\n\n## Agent runs today\n");
        for line in agent_logs.iter().take(20) {
            out.push_str(line);
            out.push('\n');
        }
    }

    out
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[command]
pub fn get_plan_state() -> PlanState {
    read_plan_state_inner(&vault_root())
}

#[command]
pub fn get_daily_context() -> DailyContext {
    let vault = vault_root();
    DailyContext {
        plan: read_plan_state_inner(&vault),
        recent_commits: read_recent_commits(&vault),
        agent_log_lines: read_today_agent_logs(&vault),
        cc_sessions: read_today_cc_sessions(),
    }
}

/// Write today's recap to active/daily/YYYY-MM-DD.md.
#[command]
pub fn write_daily_recap(content: String) -> Result<String, String> {
    let vault = vault_root();
    let today = today_str();
    let daily_dir = vault.join("active").join("daily");
    fs::create_dir_all(&daily_dir).map_err(|e| e.to_string())?;
    let path = daily_dir.join(format!("{today}.md"));
    fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Write (or overwrite) today's plan to active/state/plan-YYYY-MM-DD.json.
/// Validates JSON before writing.
#[command]
pub fn write_plan(plan_json: String) -> Result<String, String> {
    let vault = vault_root();
    let today = today_str();
    let state_dir = vault.join("active").join("state");
    fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
    // Validate JSON
    let _: serde_json::Value =
        serde_json::from_str(&plan_json).map_err(|e| format!("invalid JSON: {e}"))?;
    let path = state_dir.join(format!("plan-{today}.json"));
    fs::write(&path, &plan_json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
