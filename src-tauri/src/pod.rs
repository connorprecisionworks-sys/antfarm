// pod.rs — Planner → Builder → Gate → Reviewer loop controller (Phase 2c).
//
// run_pod spawns a background thread that drives the state machine and emits
// "pod-stream" events. It never pushes — it surfaces a ready_to_push event
// for Connor to approve and push manually.

use crate::agents::{clear_agent_session_id, spawn_agent_run, AgentRunState};
use crate::dispatch::DispatchState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PodOptions {
    #[serde(default)]
    pub require_plan_approval: bool,
}

/// Event emitted on the "pod-stream" channel. Extends the AgentStreamEvent
/// shape with `pod_id` and `step` so the frontend can group by pod and track
/// the current stage.
///
/// kind: "start" | "step" | "ready_to_push" | "needs_you"
/// step: "planning" | "building" | "verifying" | "reviewing" | "ready_to_push" | "needs_you"
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PodStreamEvent {
    pub pod_id: String,
    pub step: String,
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_msg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// Reviewer's verdict text — populated on ready_to_push so the card shows
    /// the actual review text, not just "ready." A fallback-PASS (no verdict
    /// emitted) is visible because this field will be empty or absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer_note: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn new_pod_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("pod-{ts}")
}

fn emit_pod(
    app: &AppHandle,
    pod_id: &str,
    step: &str,
    kind: &str,
    text: &str,
    commit_msg: Option<String>,
    diff: Option<String>,
    reviewer_note: Option<String>,
) {
    let _ = app.emit(
        "pod-stream",
        PodStreamEvent {
            pod_id: pod_id.to_string(),
            step: step.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
            commit_msg,
            diff,
            reviewer_note,
        },
    );
}

fn extract_plan(text: &str) -> String {
    if let Some(idx) = text.find("---PLAN-READY---") {
        text[..idx].trim().to_string()
    } else {
        text.trim().to_string()
    }
}

fn extract_commit_msg(text: &str) -> Option<String> {
    let marker = "---COMMIT:";
    let pos = text.rfind(marker)?;
    let rest = &text[pos + marker.len()..];
    let end = rest.find("---").unwrap_or(rest.len());
    Some(rest[..end].trim().to_string())
}

/// Returns Ok(()) for PASS, Err(notes) for FAIL.
/// If the reviewer emits no verdict, treat as PASS to avoid infinite loops.
fn parse_review(text: &str) -> Result<(), String> {
    if text.contains("---REVIEW: PASS---") {
        return Ok(());
    }
    let fail_marker = "---REVIEW: FAIL:";
    if let Some(pos) = text.rfind(fail_marker) {
        let rest = &text[pos + fail_marker.len()..];
        let end = rest.find("---").unwrap_or(rest.len());
        return Err(rest[..end].trim().to_string());
    }
    Ok(())
}

fn git_diff_head(repo_path: &str) -> String {
    // Mark untracked files as intent-to-add so they appear in git diff HEAD.
    // Failure is silently ignored — e.g. already-staged files are fine.
    let _ = std::process::Command::new("git")
        .args(["add", "-N", "."])
        .current_dir(repo_path)
        .status();
    std::process::Command::new("git")
        .args(["diff", "HEAD"])
        .current_dir(repo_path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_else(|e| format!("(git diff failed: {e})"))
}

// ── Pod state machine ─────────────────────────────────────────────────────────

fn pod_loop(
    app: AppHandle,
    claude_path: String,
    children: Arc<Mutex<HashMap<String, Child>>>,
    reasons: Arc<Mutex<HashMap<String, &'static str>>>,
    pod_id: String,
    repo_path: String,
    task: String,
) {
    // Clear any stale builder session so this pod starts fresh.
    clear_agent_session_id("builder");

    eprintln!("[pod] {pod_id} started — repo={repo_path}");

    // ── PLAN ─────────────────────────────────────────────────────────────────
    emit_pod(&app, &pod_id, "planning", "start", "Planning the change…", None, None, None);

    let plan = match spawn_agent_run(
        app.clone(),
        claude_path.clone(),
        children.clone(),
        reasons.clone(),
        "planner".to_string(),
        task.clone(),
        Some(pod_id.clone()),
        false,
        Some(repo_path.clone()),
        Some(false),
    ) {
        Ok((_, rx)) => {
            let raw = rx.recv().unwrap_or_default();
            eprintln!("[pod] {pod_id} plan captured ({} chars)", raw.len());
            extract_plan(&raw)
        }
        Err(e) => {
            emit_pod(
                &app, &pod_id, "planning", "needs_you",
                &format!("Planner failed to start: {e}"),
                None, None, None,
            );
            return;
        }
    };

    // ── BUILDER LOOP ──────────────────────────────────────────────────────────
    const MAX_ROUNDS: u32 = 3;
    let mut round: u32 = 0;
    let mut fix_notes = String::new();
    let mut last_commit_msg = String::new();

    loop {
        if round >= MAX_ROUNDS {
            let msg = format!(
                "After {MAX_ROUNDS} rounds the build is still not passing. Last issue:\n\n{fix_notes}"
            );
            emit_pod(&app, &pod_id, "needs_you", "needs_you", &msg, None, None, None);
            eprintln!("[pod] {pod_id} capped at {MAX_ROUNDS} rounds — escalating");
            return;
        }

        // BUILD ───────────────────────────────────────────────────────────────
        emit_pod(
            &app, &pod_id, "building", "step",
            if round == 0 { "Writing the code…" } else { "Fixing and rebuilding…" },
            None, None, None,
        );

        let build_task = if round == 0 {
            format!("{task}\n\nPlan:\n{plan}")
        } else {
            format!("The previous attempt had issues — please fix them.\n\n{fix_notes}")
        };

        // resume_session=true for all rounds: round 0 cold-starts (session cleared
        // above) and saves the sid; rounds 1+ resume that sid.
        let build_text = match spawn_agent_run(
            app.clone(),
            claude_path.clone(),
            children.clone(),
            reasons.clone(),
            "builder".to_string(),
            build_task,
            Some(pod_id.clone()),
            true, // resume_session — saves sid on round 0, resumes on 1+
            Some(repo_path.clone()),
            Some(true), // builder_write
        ) {
            Ok((_, rx)) => {
                let t = rx.recv().unwrap_or_default();
                eprintln!("[pod] {pod_id} build round={round} text={} chars", t.len());
                t
            }
            Err(e) => {
                emit_pod(
                    &app, &pod_id, "building", "needs_you",
                    &format!("Builder failed to start: {e}"),
                    None, None, None,
                );
                return;
            }
        };

        // NEEDS YOU check (migration / destructive op)
        if let Some(pos) = build_text.find("NEEDS YOU:") {
            let msg = build_text[pos..].lines().next().unwrap_or("NEEDS YOU").to_string();
            emit_pod(&app, &pod_id, "building", "needs_you", &msg, None, None, None);
            eprintln!("[pod] {pod_id} builder surfaced NEEDS YOU — stopping");
            return;
        }

        last_commit_msg = extract_commit_msg(&build_text)
            .unwrap_or_else(|| "chore: automated change".to_string());

        // GATE ────────────────────────────────────────────────────────────────
        emit_pod(&app, &pod_id, "verifying", "step", "Checking it builds…", None, None, None);

        let gate = match crate::forge::run_verification_gate(repo_path.clone()) {
            Ok(g) => g,
            Err(e) => {
                fix_notes = format!("Verification gate error: {e}");
                round += 1;
                continue;
            }
        };

        eprintln!("[pod] {pod_id} gate round={round} passed={}", gate.passed);

        if !gate.passed {
            fix_notes = format!("Build gate failed ({}):\n{}", gate.command, gate.output);
            emit_pod(
                &app, &pod_id, "verifying", "step",
                &format!("Build check failed — round {} of {MAX_ROUNDS}.", round + 1),
                None, None, None,
            );
            round += 1;
            continue;
        }

        // REVIEW ──────────────────────────────────────────────────────────────
        emit_pod(&app, &pod_id, "reviewing", "step", "Reviewing the logic…", None, None, None);

        let diff = git_diff_head(&repo_path);
        let review_task = format!(
            "Review this change for correctness and quality.\n\n\
             Original request: {task}\n\nPlan:\n{plan}\n\nGit diff HEAD:\n{diff}"
        );

        let review_text = match spawn_agent_run(
            app.clone(),
            claude_path.clone(),
            children.clone(),
            reasons.clone(),
            "reviewer".to_string(),
            review_task,
            Some(pod_id.clone()),
            false,
            Some(repo_path.clone()),
            Some(false),
        ) {
            Ok((_, rx)) => {
                let t = rx.recv().unwrap_or_default();
                eprintln!("[pod] {pod_id} review round={round} text={} chars", t.len());
                t
            }
            Err(e) => {
                emit_pod(
                    &app, &pod_id, "reviewing", "needs_you",
                    &format!("Reviewer failed to start: {e}"),
                    None, None, None,
                );
                return;
            }
        };

        match parse_review(&review_text) {
            Ok(()) => {
                // READY TO PUSH ───────────────────────────────────────────────
                let final_diff = git_diff_head(&repo_path);
                eprintln!("[pod] {pod_id} READY TO PUSH — commit='{last_commit_msg}'");
                emit_pod(
                    &app,
                    &pod_id,
                    "ready_to_push",
                    "ready_to_push",
                    "Done and safe — ready for you to publish.",
                    Some(last_commit_msg),
                    Some(final_diff),
                    Some(review_text.clone()),
                );
                return;
            }
            Err(notes) => {
                fix_notes = format!("Reviewer found issues:\n{notes}");
                emit_pod(
                    &app, &pod_id, "reviewing", "step",
                    &format!("Review found issues — round {} of {MAX_ROUNDS}.", round + 1),
                    None, None, None,
                );
                eprintln!("[pod] {pod_id} review FAIL round={round}: {notes:.80?}");
                round += 1;
            }
        }
    }
}

// ── Tauri command ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn run_pod(
    app: AppHandle,
    dispatch: State<'_, DispatchState>,
    agent_run: State<'_, AgentRunState>,
    repo_path: String,
    task: String,
    _opts: Option<PodOptions>,
) -> Result<String, String> {
    let pod_id = new_pod_id();
    let claude_path = dispatch.claude_path.lock().unwrap().clone();
    let children = agent_run.children.clone();
    let reasons = agent_run.reasons.clone();
    let pid = pod_id.clone();
    let repo_path = crate::agents::expand_tilde(&repo_path);

    std::thread::spawn(move || {
        pod_loop(app, claude_path, children, reasons, pid, repo_path, task);
    });

    Ok(pod_id)
}

// ── Unit tests (pure helpers — no Tauri runtime required) ─────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_plan_stops_at_marker() {
        let text = "Here is my plan.\nStep 1: do thing.\n---PLAN-READY---\nExtra text ignored.";
        assert_eq!(extract_plan(text), "Here is my plan.\nStep 1: do thing.");
    }

    #[test]
    fn extract_plan_no_marker_returns_full() {
        let text = "No marker here.";
        assert_eq!(extract_plan(text), "No marker here.");
    }

    #[test]
    fn extract_commit_msg_found() {
        let text = "Summary of work.\n---COMMIT: feat: add reverse fn---\nDone.";
        assert_eq!(extract_commit_msg(text), Some("feat: add reverse fn".to_string()));
    }

    #[test]
    fn extract_commit_msg_picks_last() {
        let text = "---COMMIT: first---\nmore work\n---COMMIT: second: the real one---";
        assert_eq!(extract_commit_msg(text), Some("second: the real one".to_string()));
    }

    #[test]
    fn extract_commit_msg_none_when_absent() {
        assert_eq!(extract_commit_msg("no marker here"), None);
    }

    #[test]
    fn parse_review_pass() {
        assert!(parse_review("Looks good.\n---REVIEW: PASS---").is_ok());
    }

    #[test]
    fn parse_review_fail_extracts_notes() {
        let text = "Issue found.\n---REVIEW: FAIL: missing error handling---";
        assert_eq!(parse_review(text), Err("missing error handling".to_string()));
    }

    #[test]
    fn parse_review_no_verdict_treated_as_pass() {
        assert!(parse_review("Reviewer said nothing useful.").is_ok());
    }
}
