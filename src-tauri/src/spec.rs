// spec.rs — Spec mode: decompose scope → pod_loop per item → commit_local per green item.
//
// run_spec spawns a background thread that drives spec_loop and emits "spec-stream" events.
// Per-item pod-stream events still fire (tagged with spec_id-item-N) so the UI can show
// the live pod under each checklist item.

use crate::agents::{expand_tilde, spawn_agent_run, AgentRunState};
use crate::dispatch::DispatchState;
use crate::pod::{pod_loop, PodTerminal};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpecOptions {
    #[serde(default)]
    pub require_checklist_approval: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpecItemStatus {
    pub index: usize,
    pub text: String,
    pub status: String, // "pending" | "done" | "flagged"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag_reason: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpecStreamEvent {
    pub spec_id: String,
    /// "decomposing" | "checklist" | "item_start" | "item_done" | "item_flagged" | "spec_done" | "needs_you"
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_text: Option<String>,
    /// Populated on "checklist" and "spec_done"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<SpecItemStatus>>,
    /// Populated on "item_done"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_hash: Option<String>,
    /// Populated on "item_flagged"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag_reason: Option<String>,
    /// Populated on "spec_done"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_log: Option<String>,
    /// Populated on "spec_done"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub fn new_spec_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("spec-{ts}")
}

fn emit_spec(app: &AppHandle, event: SpecStreamEvent) {
    eprintln!(
        "[STEP]\t{}\t{}",
        event.phase,
        event.item_text.clone().unwrap_or_default()
    );
    let _ = app.emit("spec-stream", event);
}

fn parse_checklist(text: &str) -> Vec<String> {
    let end = text.find("---CHECKLIST-READY---").unwrap_or(text.len());
    text[..end]
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            if !t.starts_with(|c: char| c.is_ascii_digit()) {
                return None;
            }
            // Strip leading "1." / "1)" / "1:" / "1 " and whitespace
            let after_digits = t.trim_start_matches(|c: char| c.is_ascii_digit());
            let rest = after_digits
                .trim_start_matches(['.', ')', ':', ' '])
                .trim();
            if rest.is_empty() {
                None
            } else {
                Some(rest.to_string())
            }
        })
        .collect()
}

/// git add -A + git commit -m. Returns the short commit hash.
pub fn commit_local_impl(repo_path: &str, message: &str) -> Result<String, String> {
    let add = std::process::Command::new("git")
        .args(["-C", repo_path, "add", "-A"])
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&add.stderr)
        ));
    }
    let commit = std::process::Command::new("git")
        .args(["-C", repo_path, "commit", "-m", message])
        .output()
        .map_err(|e| e.to_string())?;
    if !commit.status.success() {
        let out = String::from_utf8_lossy(&commit.stdout);
        let err = String::from_utf8_lossy(&commit.stderr);
        if out.contains("nothing to commit") || err.contains("nothing to commit") {
            // No changes staged — return current HEAD without error
            return Ok(current_head(repo_path).unwrap_or_else(|| "no-changes".to_string()));
        }
        return Err(format!("git commit failed: {err}"));
    }
    Ok(current_head(repo_path).unwrap_or_else(|| "committed".to_string()))
}

fn current_head(repo_path: &str) -> Option<String> {
    std::process::Command::new("git")
        .args(["-C", repo_path, "rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn git_log_since(repo_path: &str, start_hash: &str) -> String {
    let range = if start_hash.is_empty() {
        "HEAD".to_string()
    } else {
        format!("{start_hash}..HEAD")
    };
    std::process::Command::new("git")
        .args(["-C", repo_path, "log", "--oneline", &range])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn git_diff_since(repo_path: &str, start_hash: &str) -> String {
    // Intent-to-add so new untracked files appear in the diff output
    let _ = std::process::Command::new("git")
        .args(["-C", repo_path, "add", "-N", "."])
        .status();
    if start_hash.is_empty() {
        std::process::Command::new("git")
            .args(["-C", repo_path, "diff", "HEAD"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    } else {
        std::process::Command::new("git")
            .args(["-C", repo_path, "diff", start_hash, "HEAD"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }
}

// ── Spec controller ───────────────────────────────────────────────────────────

pub fn spec_loop(
    app: AppHandle,
    claude_path: String,
    children: Arc<Mutex<HashMap<String, Child>>>,
    reasons: Arc<Mutex<HashMap<String, &'static str>>>,
    spec_id: String,
    repo_path: String,
    scope: String,
) {
    eprintln!("[spec] {spec_id} started — repo={repo_path}");

    // ── 1. DECOMPOSE ──────────────────────────────────────────────────────────
    emit_spec(
        &app,
        SpecStreamEvent {
            spec_id: spec_id.clone(),
            phase: "decomposing".to_string(),
            item_index: None,
            item_text: None,
            items: None,
            commit_hash: None,
            flag_reason: None,
            git_log: None,
            diff: None,
        },
    );

    let decompose_task = format!(
        "Given this scope and the codebase, produce an ordered numbered checklist of bounded \
         build tasks. Each task must be small enough to build and review in a single pass \
         (one page, one feature, one data change). Output ONLY a numbered list, one concrete \
         task per line, ordered so each builds on the last. End with ---CHECKLIST-READY---\n\n\
         Scope:\n{scope}"
    );

    let planner_text = match spawn_agent_run(
        app.clone(),
        claude_path.clone(),
        children.clone(),
        reasons.clone(),
        "planner".to_string(),
        decompose_task,
        Some(spec_id.clone()),
        false,
        Some(repo_path.clone()),
        Some(false),
    ) {
        Ok((_, rx)) => rx.recv().unwrap_or_default(),
        Err(e) => {
            emit_spec(
                &app,
                SpecStreamEvent {
                    spec_id: spec_id.clone(),
                    phase: "needs_you".to_string(),
                    item_index: None,
                    item_text: Some(format!("Planner failed to start: {e}")),
                    items: None,
                    commit_hash: None,
                    flag_reason: None,
                    git_log: None,
                    diff: None,
                },
            );
            return;
        }
    };

    let items = parse_checklist(&planner_text);
    if items.is_empty() {
        emit_spec(
            &app,
            SpecStreamEvent {
                spec_id: spec_id.clone(),
                phase: "needs_you".to_string(),
                item_index: None,
                item_text: Some(
                    "Planner did not return a numbered checklist ending with ---CHECKLIST-READY---.".to_string(),
                ),
                items: None,
                commit_hash: None,
                flag_reason: None,
                git_log: None,
                diff: None,
            },
        );
        return;
    }

    eprintln!("[spec] {spec_id} decomposed into {} items", items.len());

    let mut statuses: Vec<SpecItemStatus> = items
        .iter()
        .enumerate()
        .map(|(i, t)| SpecItemStatus {
            index: i,
            text: t.clone(),
            status: "pending".to_string(),
            commit_hash: None,
            flag_reason: None,
        })
        .collect();

    emit_spec(
        &app,
        SpecStreamEvent {
            spec_id: spec_id.clone(),
            phase: "checklist".to_string(),
            item_index: None,
            item_text: None,
            items: Some(statuses.clone()),
            commit_hash: None,
            flag_reason: None,
            git_log: None,
            diff: None,
        },
    );

    // Record commit hash before we start so the final diff spans the whole run
    let start_hash = current_head(&repo_path).unwrap_or_default();
    let mut completed_summaries: Vec<String> = Vec::new();

    // ── 2. Per-item pod loop ──────────────────────────────────────────────────
    for (i, item) in items.iter().enumerate() {
        emit_spec(
            &app,
            SpecStreamEvent {
                spec_id: spec_id.clone(),
                phase: "item_start".to_string(),
                item_index: Some(i),
                item_text: Some(item.clone()),
                items: None,
                commit_hash: None,
                flag_reason: None,
                git_log: None,
                diff: None,
            },
        );

        let context = format!(
            "Overall scope:\n{scope}\n\nCompleted items so far:\n{}",
            if completed_summaries.is_empty() {
                "(none yet)".to_string()
            } else {
                completed_summaries
                    .iter()
                    .enumerate()
                    .map(|(j, s)| format!("{}. {s}", j + 1))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        );

        let item_pod_id = format!("{spec_id}-item-{i}");
        eprintln!("[spec] {spec_id} running item {i}: {item:.80}");

        let terminal = pod_loop(
            app.clone(),
            claude_path.clone(),
            children.clone(),
            reasons.clone(),
            item_pod_id,
            repo_path.clone(),
            item.clone(),
            Some(context),
        );

        match terminal {
            PodTerminal::ReadyToPush { commit_msg, .. } => {
                match commit_local_impl(&repo_path, &commit_msg) {
                    Ok(hash) => {
                        statuses[i].status = "done".to_string();
                        statuses[i].commit_hash = Some(hash.clone());
                        completed_summaries.push(format!("✓ {item}"));
                        eprintln!("[spec] {spec_id} item {i} committed: {hash}");
                        emit_spec(
                            &app,
                            SpecStreamEvent {
                                spec_id: spec_id.clone(),
                                phase: "item_done".to_string(),
                                item_index: Some(i),
                                item_text: Some(item.clone()),
                                items: None,
                                commit_hash: Some(hash),
                                flag_reason: None,
                                git_log: None,
                                diff: None,
                            },
                        );
                    }
                    Err(e) => {
                        let reason = format!("commit failed: {e}");
                        statuses[i].status = "flagged".to_string();
                        statuses[i].flag_reason = Some(reason.clone());
                        eprintln!("[spec] {spec_id} item {i} commit error: {e}");
                        emit_spec(
                            &app,
                            SpecStreamEvent {
                                spec_id: spec_id.clone(),
                                phase: "item_flagged".to_string(),
                                item_index: Some(i),
                                item_text: Some(item.clone()),
                                items: None,
                                commit_hash: None,
                                flag_reason: Some(reason),
                                git_log: None,
                                diff: None,
                            },
                        );
                    }
                }
            }
            PodTerminal::NeedsYou { reason } => {
                statuses[i].status = "flagged".to_string();
                statuses[i].flag_reason = Some(reason.clone());
                eprintln!(
                    "[spec] {spec_id} item {i} flagged — continuing. reason: {:.100}",
                    reason
                );
                emit_spec(
                    &app,
                    SpecStreamEvent {
                        spec_id: spec_id.clone(),
                        phase: "item_flagged".to_string(),
                        item_index: Some(i),
                        item_text: Some(item.clone()),
                        items: None,
                        commit_hash: None,
                        flag_reason: Some(reason),
                        git_log: None,
                        diff: None,
                    },
                );
            }
        }
    }

    // ── 3. SPEC DONE ──────────────────────────────────────────────────────────
    let git_log = git_log_since(&repo_path, &start_hash);
    let diff = git_diff_since(&repo_path, &start_hash);
    eprintln!(
        "[spec] {spec_id} done. log: {} chars, diff: {} chars",
        git_log.len(),
        diff.len()
    );

    emit_spec(
        &app,
        SpecStreamEvent {
            spec_id: spec_id.clone(),
            phase: "spec_done".to_string(),
            item_index: None,
            item_text: None,
            items: Some(statuses),
            commit_hash: None,
            flag_reason: None,
            git_log: Some(git_log),
            diff: Some(diff),
        },
    );
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// git add -A + git commit -m (no push). Returns the short commit hash.
#[tauri::command]
pub fn commit_local(repo_path: String, message: String) -> Result<String, String> {
    commit_local_impl(&repo_path, &message)
}

/// Push accumulated local commits to origin (no commit — commits already made by spec_loop).
#[tauri::command]
pub fn git_push(repo_path: String) -> Result<String, String> {
    let push = std::process::Command::new("git")
        .args(["-C", &repo_path, "push"])
        .output()
        .map_err(|e| e.to_string())?;
    if !push.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&push.stderr)
        ));
    }
    Ok("pushed".to_string())
}

/// Spawn a spec run in a background thread. Returns the spec_id immediately.
#[tauri::command]
pub fn run_spec(
    app: AppHandle,
    dispatch: State<'_, DispatchState>,
    agent_run: State<'_, AgentRunState>,
    repo_path: String,
    scope: String,
    _opts: Option<SpecOptions>,
) -> Result<String, String> {
    let spec_id = new_spec_id();
    let claude_path = dispatch.claude_path.lock().unwrap().clone();
    let children = agent_run.children.clone();
    let reasons = agent_run.reasons.clone();
    let sid = spec_id.clone();
    let repo_path = expand_tilde(&repo_path);

    std::thread::spawn(move || {
        spec_loop(app, claude_path, children, reasons, sid, repo_path, scope);
    });

    Ok(spec_id)
}
