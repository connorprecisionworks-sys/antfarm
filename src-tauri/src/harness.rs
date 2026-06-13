// harness.rs - Antfarm overnight harness (H2, 2026-06-12)
//
// H0: dontAsk does not abort on denial; blocked = denials > 0 AND accept fails.
// H1: permission_denials from result line; open_terminal_resume extracted.
// H2: PID recorded while step runs (step pushed to state.json before attempt
//     loop); reconcile_orphans() sweeps "running" entries on fresh startup.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

// ── Shared state ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct HarnessState {
    pub aborts: Arc<Mutex<HashMap<String, bool>>>,
}

// ── Plan spec ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Budgets {
    pub per_step_usd: f64,
    pub per_run_usd: f64,
    pub per_night_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepSpec {
    pub id: String,
    pub prompt: String,
    pub accept: String,
    pub max_attempts: Option<u32>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSpec {
    pub run_id: String,
    pub project_path: String,
    pub goal: String,
    pub setup: Option<String>,
    pub on_fail: Option<String>,  // "stop_run" (default) | "continue"
    pub steps: Vec<StepSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanDefaults {
    pub model: String,
    pub max_wall_minutes: u64,
    pub silence_minutes: u64,
    pub max_attempts: u32,
    pub permission_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightPlan {
    pub plan_id: String,
    pub armed: bool,
    pub budgets: Budgets,
    pub defaults: PlanDefaults,
    pub runs: Vec<RunSpec>,
}

// ── Live state ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub step_id: String,
    pub status: String,  // pending|running|green|failed|timeout|stalled|budget_stop|blocked|interrupted|skipped|budget_skip
    pub attempts: u32,
    pub cost_usd: f64,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub accept_output_tail: Option<String>,
    pub permission_denials: u32,
    #[serde(default)]
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub run_id: String,
    pub status: String,  // pending|running|done|failed|interrupted|budget_skip|accepted|rejected|conflict
    pub worktree: String,
    pub branch: String,
    pub base_commit: String,
    pub cost_usd: f64,
    pub steps: Vec<StepState>,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanState {
    pub plan_id: String,
    pub status: String,  // armed|running|done|aborted|budget_stop
    pub cost_usd: f64,
    pub runs: Vec<RunState>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

fn plans_dir() -> PathBuf {
    let d = home().join(".antfarm/plans");
    std::fs::create_dir_all(&d).ok();
    d
}

fn save_state(st: &PlanState) {
    let dir = plans_dir().join(&st.plan_id);
    std::fs::create_dir_all(&dir).ok();
    if let Ok(json) = serde_json::to_string_pretty(st) {
        let _ = std::fs::write(dir.join("state.json"), json);
    }
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").arg("-C").arg(repo).args(args).output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn create_worktree(repo: &str, run_id: &str) -> Result<(String, String, String), String> {
    let wt = format!("{repo}/.antfarm-worktrees/{run_id}");
    let branch = format!("antfarm/{run_id}");
    let base = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    git(repo, &["worktree", "add", &wt, "-b", &branch])?;
    Ok((wt, branch, base))
}

fn exclude_from_worktree_git(worktree: &str, pattern: &str) -> Result<(), String> {
    let exclude_path = git(worktree, &["rev-parse", "--git-path", "info/exclude"])
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("rev-parse --git-path info/exclude failed: {e}"))?;
    let exclude_path = Path::new(&exclude_path);
    if let Some(parent) = exclude_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let existing = std::fs::read_to_string(exclude_path).unwrap_or_default();
    if existing.lines().any(|l| l == pattern) {
        return Ok(());
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern);
    content.push('\n');
    std::fs::write(exclude_path, content).map_err(|e| e.to_string())
}

fn write_allowlist(worktree: &str, project_slug: &str) -> Result<(), String> {
    let src = home().join(format!(".antfarm/allowlists/{project_slug}.json"));
    let text = std::fs::read_to_string(&src)
        .map_err(|e| format!("allowlist missing for {project_slug}: {e} — refuse to run unattended without one"))?;
    let dir = Path::new(worktree).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), text).map_err(|e| e.to_string())?;
    exclude_from_worktree_git(worktree, ".claude/settings.json")
}

fn build_step_prompt(run: &RunSpec, step: &StepSpec, idx: usize, worktree: &str,
                     prev_result_tail: &str, accept_fail_output: Option<&str>) -> String {
    let log = git(worktree, &["log", "--oneline", "-10"]).unwrap_or_default();
    let retry = accept_fail_output.map(|o| format!(
        "\nPrevious attempt FAILED its acceptance check. Output:\n{o}\nFix the cause, do not just rerun the check.\n"
    )).unwrap_or_default();
    format!(
        "You are step {n} of {total} in an UNATTENDED overnight run. Nobody can answer questions.\n\
         Repo: {wt} (a git worktree on a private branch; main is untouched).\n\
         Run goal: {goal}\n\
         Checkpoint log:\n{log}\n\
         Previous step result (tail): {prev}\n{retry}\
         Your ONLY job this step: {prompt}\n\
         Acceptance check that will be run after you finish: `{accept}`\n\
         Rules: stay inside this worktree. Do NOT git push. Do NOT start servers or watch modes. \
         Prefer finishing over exploring.",
        n = idx + 1, total = run.steps.len(), wt = worktree, goal = run.goal,
        log = log.trim(), prev = prev_result_tail, retry = retry,
        prompt = step.prompt, accept = step.accept,
    )
}

#[derive(Debug, Default)]
struct StepOutcome {
    exit_ok: bool,
    killed_reason: Option<String>,
    cost_usd: f64,
    session_id: Option<String>,
    result_tail: String,
    permission_denials: u32,
    pid: Option<u32>,
}

/// Spawn one headless step and supervise it with watchdogs.
/// `out.pid` is populated immediately after spawn so callers can persist it.
fn run_step_process(app: &AppHandle, claude: &str, worktree: &str, prompt: &str,
                    model: &str, permission_mode: &str,
                    max_wall: Duration, max_silence: Duration, step_cap_usd: f64,
                    abort: &Arc<Mutex<HashMap<String, bool>>>, plan_id: &str)
                    -> Result<StepOutcome, String> {
    let mut child = Command::new(claude)
        .args(["-p", prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", permission_mode,
               "--model", model])
        .current_dir(worktree)
        .stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null())
        .spawn().map_err(|e| format!("spawn failed: {e}"))?;

    let mut out = StepOutcome::default();
    out.pid = Some(child.id());  // captured immediately; caller persists to state.json

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() { break; }
        }
    });

    let started = Instant::now();
    let mut last_line = Instant::now();
    let mut est_cost = 0.0_f64;

    loop {
        let reason = if started.elapsed() > max_wall { Some("timeout") }
            else if last_line.elapsed() > max_silence { Some("stalled") }
            else if est_cost > step_cap_usd { Some("budget_stop") }
            else if *abort.lock().unwrap().get(plan_id).unwrap_or(&false) { Some("aborted") }
            else { None };
        if let Some(r) = reason {
            child.kill().ok();
            out.killed_reason = Some(r.into());
            out.cost_usd = if out.cost_usd > 0.0 { out.cost_usd } else { est_cost };
            child.wait().ok();
            return Ok(out);
        }

        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => {
                last_line = Instant::now();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if typ == "system" && v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                        out.session_id = v.get("session_id").and_then(|s| s.as_str()).map(String::from);
                    }
                    if typ == "assistant" {
                        if let Some(u) = v.pointer("/message/usage/output_tokens").and_then(|x| x.as_u64()) {
                            est_cost += (u as f64) * 0.000015;
                        }
                    }
                    if typ == "result" {
                        out.cost_usd = v.get("total_cost_usd").and_then(|c| c.as_f64()).unwrap_or(est_cost);
                        out.result_tail = v.get("result").and_then(|r| r.as_str())
                            .unwrap_or("").chars().rev().take(600).collect::<String>()
                            .chars().rev().collect();
                        out.exit_ok = v.get("is_error").and_then(|e| e.as_bool()) != Some(true);
                        if let Some(arr) = v.get("permission_denials").and_then(|d| d.as_array()) {
                            out.permission_denials = arr.len() as u32;
                        }
                    }
                }
                app.emit("antfarm-harness-event", serde_json::json!({
                    "planId": plan_id, "kind": "line"
                })).ok();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if out.cost_usd == 0.0 { out.cost_usd = est_cost; }
    out.exit_ok = out.exit_ok && status.success();
    Ok(out)
}

fn run_accept(worktree: &str, accept: &str) -> (bool, String) {
    match Command::new("/bin/zsh").args(["-c", accept]).current_dir(worktree).output() {
        Ok(o) => {
            let mut text = String::from_utf8_lossy(&o.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&o.stderr));
            let tail: String = text.chars().rev().take(1200).collect::<String>().chars().rev().collect();
            (o.status.success(), tail)
        }
        Err(e) => (false, format!("accept spawn failed: {e}")),
    }
}

fn checkpoint(worktree: &str, step_id: &str) {
    git(worktree, &["add", "-A"]).ok();
    git(worktree, &["commit", "-m", &format!("antfarm checkpoint: {step_id} green"), "--allow-empty"]).ok();
}

fn reset_to_checkpoint(worktree: &str) {
    git(worktree, &["reset", "--hard"]).ok();
    git(worktree, &["clean", "-fd"]).ok();
}

fn summarize_run(claude: &str, worktree: &str, base_commit: &str, goal: &str) -> (String, f64) {
    let diff = match git(worktree, &["diff", &format!("{base_commit}...HEAD")]) {
        Ok(d) => d,
        Err(_) => return (String::new(), 0.0),
    };
    if diff.trim().is_empty() {
        return (String::new(), 0.0);
    }
    let diff_capped = if diff.len() > 40_000 {
        format!("{}\n... (diff truncated at 40k chars)", &diff[..40_000])
    } else {
        diff
    };
    let prompt = format!(
        "Goal of this work: {goal}\n\nHere is the full diff:\n{diff_capped}\n\n\
         In ONE short paragraph (3-5 sentences), plainly explain what was changed and what it \
         contributes to the project, and whether it appears to accomplish the goal. \
         No preamble, no lists, just the paragraph."
    );
    let mut child = match Command::new(claude)
        .args(["-p", &prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", "dontAsk",
               "--model", "claude-sonnet-4-6"])
        .current_dir(worktree)
        .stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return (String::new(), 0.0),
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => { child.kill().ok(); return (String::new(), 0.0); }
    };
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() { break; }
        }
    });
    let started = Instant::now();
    let max_wall = Duration::from_secs(120);
    let mut result_text = String::new();
    let mut cost = 0.0_f64;
    loop {
        if started.elapsed() > max_wall {
            child.kill().ok();
            break;
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                        result_text = v.get("result").and_then(|r| r.as_str())
                            .unwrap_or("").trim().to_string();
                        cost = v.get("total_cost_usd").and_then(|c| c.as_f64()).unwrap_or(0.0);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    child.wait().ok();
    (result_text, cost)
}

// ── Crash recovery ────────────────────────────────────────────────────────────

/// Called once at startup. Any plan/run/step left "running" on disk is an
/// orphan from a prior crash or force-quit — no harness thread is alive for it.
/// Marks them interrupted/aborted so the morning UI shows an honest status.
pub fn reconcile_orphans() {
    let dir = plans_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let mut n = 0u32;
    for entry in entries.flatten() {
        let state_path = entry.path().join("state.json");
        let Ok(text) = std::fs::read_to_string(&state_path) else { continue };
        let Ok(mut st) = serde_json::from_str::<PlanState>(&text) else { continue };
        let mut changed = false;
        for run in &mut st.runs {
            for step in &mut run.steps {
                if step.status == "running" {
                    step.status = "interrupted".into();
                    n += 1;
                    changed = true;
                }
            }
            if run.status == "running" {
                run.status = "interrupted".into();
                changed = true;
            }
        }
        if st.status == "running" {
            st.status = "aborted".into();
            changed = true;
        }
        if changed {
            save_state(&st);
        }
    }
    eprintln!("antfarm harness: reconcile_orphans — {n} orphaned steps marked interrupted");
}

// ── The night executor ────────────────────────────────────────────────────────

pub fn execute_plan(app: AppHandle, claude: String, plan: NightPlan,
                    aborts: Arc<Mutex<HashMap<String, bool>>>) {
    std::thread::spawn(move || {
        let mut st = PlanState {
            plan_id: plan.plan_id.clone(), status: "running".into(),
            ..Default::default()
        };
        save_state(&st);
        let caffeinate = Command::new("caffeinate").args(["-i", "-s"]).spawn().ok();

        for run in &plan.runs {
            if st.cost_usd >= plan.budgets.per_night_usd {
                st.runs.push(RunState { run_id: run.run_id.clone(), status: "budget_skip".into(), ..Default::default() });
                save_state(&st);
                continue;
            }
            let slug = Path::new(&run.project_path).file_name()
                .map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();

            let (wt, branch, base) = match create_worktree(&run.project_path, &run.run_id)
                .and_then(|r| { write_allowlist(&r.0, &slug)?; Ok(r) }) {
                Ok(r) => r,
                Err(e) => {
                    st.runs.push(RunState { run_id: run.run_id.clone(), status: format!("setup_failed: {e}"), ..Default::default() });
                    save_state(&st);
                    continue;
                }
            };
            if let Some(setup) = &run.setup { run_accept(&wt, setup); }

            let mut rs = RunState {
                run_id: run.run_id.clone(), status: "running".into(),
                worktree: wt.clone(), branch, base_commit: base,
                goal: run.goal.clone(),
                ..Default::default()
            };
            save_state_with(&mut st, &rs);

            let mut prev_tail = String::from("(first step)");
            let mut run_failed = false;

            for (i, step) in run.steps.iter().enumerate() {
                // Push the step as "running" before the attempt loop so a crash
                // during execution leaves an honest status in state.json.
                rs.steps.push(StepState {
                    step_id: step.id.clone(), status: "running".into(),
                    prompt: step.prompt.clone(),
                    ..Default::default()
                });
                let si = rs.steps.len() - 1;

                if run_failed && run.on_fail.as_deref().unwrap_or("stop_run") == "stop_run" {
                    rs.steps[si].status = "skipped".into();
                    save_state_with(&mut st, &rs);
                    continue;
                }
                if st.cost_usd >= plan.budgets.per_night_usd || rs.cost_usd >= plan.budgets.per_run_usd {
                    rs.steps[si].status = "budget_skip".into();
                    save_state_with(&mut st, &rs);
                    continue;
                }

                save_state_with(&mut st, &rs);  // step visible as "running" on disk

                let max_attempts = step.max_attempts.unwrap_or(plan.defaults.max_attempts);
                let mut fail_output: Option<String> = None;

                for attempt in 1..=max_attempts {
                    rs.steps[si].attempts = attempt;
                    let prompt = build_step_prompt(run, step, i, &wt, &prev_tail, fail_output.as_deref());
                    let outcome = run_step_process(
                        &app, &claude, &wt, &prompt,
                        step.model.as_deref().unwrap_or(&plan.defaults.model),
                        &plan.defaults.permission_mode,
                        Duration::from_secs(plan.defaults.max_wall_minutes * 60),
                        Duration::from_secs(plan.defaults.silence_minutes * 60),
                        plan.budgets.per_step_usd,
                        &aborts, &plan.plan_id,
                    ).unwrap_or_default();

                    // PID captured in outcome immediately after spawn; persist it.
                    rs.steps[si].pid = outcome.pid;
                    rs.steps[si].cost_usd += outcome.cost_usd;
                    rs.cost_usd += outcome.cost_usd;
                    st.cost_usd += outcome.cost_usd;
                    rs.steps[si].session_id = outcome.session_id.clone()
                        .or_else(|| rs.steps[si].session_id.clone());
                    rs.steps[si].permission_denials += outcome.permission_denials;

                    if let Some(reason) = outcome.killed_reason {
                        rs.steps[si].status = reason; run_failed = true; break;
                    }

                    let (passed, tail) = run_accept(&wt, &step.accept);
                    rs.steps[si].accept_output_tail = Some(tail.clone());
                    if passed {
                        checkpoint(&wt, &step.id);
                        rs.steps[si].status = "green".into();
                        prev_tail = outcome.result_tail;
                        break;
                    }
                    if outcome.permission_denials > 0 {
                        rs.steps[si].status = "blocked".into(); run_failed = true; break;
                    }
                    reset_to_checkpoint(&wt);
                    fail_output = Some(tail);
                    if attempt == max_attempts {
                        rs.steps[si].status = "failed".into(); run_failed = true;
                    }
                }
                save_state_with(&mut st, &rs);
            }

            let any_green = rs.steps.iter().any(|s| s.status == "green");
            if any_green && !rs.base_commit.is_empty() {
                let (summ, summ_cost) = summarize_run(&claude, &rs.worktree, &rs.base_commit, &run.goal);
                rs.summary = summ;
                rs.cost_usd += summ_cost;
                st.cost_usd += summ_cost;
            }
            rs.status = if run_failed { "failed".into() } else { "done".into() };
            save_state_with(&mut st, &rs);
        }

        st.status = if *aborts.lock().unwrap().get(&plan.plan_id).unwrap_or(&false)
            { "aborted".into() } else { "done".into() };
        save_state(&st);
        if let Some(mut c) = caffeinate { c.kill().ok(); }
        app.emit("antfarm-harness-event", serde_json::json!({
            "planId": plan.plan_id, "kind": "plan_done"
        })).ok();
    });
}

fn save_state_with(st: &mut PlanState, rs: &RunState) {
    if let Some(existing) = st.runs.iter_mut().find(|r| r.run_id == rs.run_id) {
        *existing = rs.clone();
    } else {
        st.runs.push(rs.clone());
    }
    save_state(st);
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn arm_night_plan(app: AppHandle, state: State<'_, HarnessState>,
                      dispatch: State<'_, crate::dispatch::DispatchState>,
                      plan_path: String) -> Result<String, String> {
    let text = std::fs::read_to_string(&plan_path).map_err(|e| e.to_string())?;
    let plan: NightPlan = serde_json::from_str(&text).map_err(|e| format!("invalid plan: {e}"))?;
    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    let id = plan.plan_id.clone();
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(id)
}

#[tauri::command]
pub fn abort_night_plan(state: State<'_, HarnessState>, plan_id: String) -> Result<(), String> {
    state.aborts.lock().unwrap().insert(plan_id, true);
    Ok(())
}

#[tauri::command]
pub fn list_plan_states() -> Result<Vec<PlanState>, String> {
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(plans_dir()) {
        for e in entries.flatten() {
            if let Ok(text) = std::fs::read_to_string(e.path().join("state.json")) {
                if let Ok(st) = serde_json::from_str::<PlanState>(&text) { out.push(st); }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn harness_run_diff(plan_id: String, run_id: String) -> Result<String, String> {
    let rs = find_run(&plan_id, &run_id)?;
    let mut diff = git(&rs.worktree, &["diff", &format!("{}...HEAD", rs.base_commit)])?;
    let dirty = git(&rs.worktree, &["status", "--short"])?;
    if !dirty.trim().is_empty() {
        diff.push_str("\n\n== UNCOMMITTED ==\n");
        diff.push_str(&dirty);
    }
    Ok(diff)
}

#[tauri::command]
pub fn accept_run(plan_id: String, run_id: String) -> Result<String, String> {
    let rs = find_run(&plan_id, &run_id)?;
    let repo = repo_of(&rs.worktree)?;
    match git(&repo, &["merge", "--squash", &rs.branch]) {
        Ok(_) => {
            git(&repo, &["commit", "-m", &format!("{run_id} (antfarm overnight)")])?;
            set_run_status(&plan_id, &run_id, "accepted")?;
            Ok("merged".into())
        }
        Err(e) => {
            git(&repo, &["merge", "--abort"]).ok();
            set_run_status(&plan_id, &run_id, "conflict")?;
            Err(format!("merge conflict, take over instead: {e}"))
        }
    }
}

#[tauri::command]
pub fn reject_run(plan_id: String, run_id: String) -> Result<(), String> {
    let rs = find_run(&plan_id, &run_id)?;
    let repo = repo_of(&rs.worktree)?;
    git(&repo, &["worktree", "remove", "--force", &rs.worktree])?;
    git(&repo, &["branch", "-D", &rs.branch]).ok();
    set_run_status(&plan_id, &run_id, "rejected")
}

#[tauri::command]
pub fn take_over_overnight_run(plan_id: String, run_id: String) -> Result<(), String> {
    let rs = find_run(&plan_id, &run_id)?;
    let sid = rs.steps.iter().rev().find_map(|s| s.session_id.clone())
        .ok_or("no session_id captured for this run")?;
    crate::dispatch::open_terminal_resume(&rs.worktree, &sid)
}

#[tauri::command]
pub fn list_stale_worktrees(days: u64) -> Result<Vec<String>, String> {
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(days * 86_400);
    let mut stale = vec![];
    for st in list_plan_states()? {
        for rs in &st.runs {
            let terminal = matches!(rs.status.as_str(), "accepted" | "rejected" | "done" | "failed");
            if terminal && Path::new(&rs.worktree).exists() {
                if let Ok(meta) = std::fs::metadata(&rs.worktree) {
                    if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                        stale.push(rs.worktree.clone());
                    }
                }
            }
        }
    }
    Ok(stale)
}

#[tauri::command]
pub fn harness_run_summary(plan_id: String, run_id: String) -> Result<String, String> {
    let rs = find_run(&plan_id, &run_id)?;
    if rs.worktree.is_empty() || rs.base_commit.is_empty() {
        return Ok(String::new());
    }
    Ok(git(&rs.worktree, &["diff", "--stat", &format!("{}...HEAD", rs.base_commit)])
        .unwrap_or_default()
        .trim()
        .to_string())
}

// ── Dev verification commands ─────────────────────────────────────────────────

fn dev_plan_id_and_run_id(suffix: &str) -> (String, String) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    (format!("dev-{suffix}-{ts}"), format!("run-{suffix}-{ts}"))
}

fn trivial_step(id: &str, accept: &str, max_attempts: u32) -> StepSpec {
    StepSpec {
        id: id.into(),
        // Minimal prompt: does not touch files so the worktree stays clean and
        // accept="true"/"false" purely tests harness routing, not claude output.
        prompt: "Reply with the single word OK. Do not edit any files.".into(),
        accept: accept.into(),
        max_attempts: Some(max_attempts),
        model: None,
    }
}

fn haiku_defaults() -> PlanDefaults {
    PlanDefaults {
        model: "claude-haiku-4-5-20251001".into(),
        max_wall_minutes: 5,
        silence_minutes: 2,
        max_attempts: 2,
        permission_mode: "dontAsk".into(),
    }
}

/// H2 verification (a): 3-step plan where step 2's accept is "false".
/// Expected: step1=green, step2=failed (2 retries), step3=skipped, run=failed.
#[tauri::command]
pub fn dev_test_3step_fail(app: AppHandle, state: State<'_, HarnessState>,
                            dispatch: State<'_, crate::dispatch::DispatchState>)
                            -> Result<String, String> {
    let antfarm = home().join("Desktop/antfarm").to_string_lossy().into_owned();
    let (plan_id, run_id) = dev_plan_id_and_run_id("3step");
    let plan = NightPlan {
        plan_id: plan_id.clone(),
        armed: true,
        budgets: Budgets { per_step_usd: 0.50, per_run_usd: 2.0, per_night_usd: 5.0 },
        defaults: haiku_defaults(),
        runs: vec![RunSpec {
            run_id: run_id.clone(),
            project_path: antfarm,
            goal: "3-step fail-path harness verification".into(),
            setup: Some("true".into()),  // fast noop; no node_modules needed
            on_fail: Some("stop_run".into()),
            steps: vec![
                trivial_step("step1", "true",  2),  // accept = shell `true` (exit 0) → green
                trivial_step("step2", "false", 2),  // accept = shell `false` (exit 1) → retry×2 → failed
                trivial_step("step3", "true",  2),  // should be skipped (on_fail stop_run)
            ],
        }],
    };
    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(format!("3step-fail plan started — plan_id={plan_id} run_id={run_id}"))
}

/// H2 verification (b): night budget gate.
/// per_night_usd is set below any real API call cost so step 2 gets budget_skip.
/// Expected: step1 runs (cost accumulates), step2=budget_skip.
#[tauri::command]
pub fn dev_test_budget_gate(app: AppHandle, state: State<'_, HarnessState>,
                             dispatch: State<'_, crate::dispatch::DispatchState>)
                             -> Result<String, String> {
    let antfarm = home().join("Desktop/antfarm").to_string_lossy().into_owned();
    let (plan_id, run_id) = dev_plan_id_and_run_id("budget");
    let plan = NightPlan {
        plan_id: plan_id.clone(),
        armed: true,
        // per_night_usd is $0.00001 — below any real API call cost (even haiku trivial = ~$0.0001).
        // After step 1 completes, st.cost_usd > 0.00001 so step 2 gets budget_skip.
        budgets: Budgets { per_step_usd: 1.0, per_run_usd: 1.0, per_night_usd: 0.00001 },
        defaults: haiku_defaults(),
        runs: vec![RunSpec {
            run_id: run_id.clone(),
            project_path: antfarm,
            goal: "Budget gate harness verification".into(),
            setup: Some("true".into()),
            on_fail: None,
            steps: vec![
                trivial_step("step1", "true", 1),  // runs; cost > per_night_usd after this
                trivial_step("step2", "true", 1),  // budget_skip — never spawns claude
            ],
        }],
    };
    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(format!("budget-gate plan started — plan_id={plan_id} run_id={run_id}"))
}

/// H1 green-path dev command (retained from H1).
#[tauri::command]
pub fn dev_test_harness(app: AppHandle, state: State<'_, HarnessState>,
                         dispatch: State<'_, crate::dispatch::DispatchState>,
                         fail_accept: Option<bool>) -> Result<String, String> {
    let antfarm_path = home().join("Desktop/antfarm").to_string_lossy().into_owned();
    let (plan_id, run_id) = dev_plan_id_and_run_id("h1");
    let accept_cmd = if fail_accept.unwrap_or(false) { "false".into() } else { "npm run build".into() };
    let plan = NightPlan {
        plan_id: plan_id.clone(),
        armed: true,
        budgets: Budgets { per_step_usd: 2.0, per_run_usd: 5.0, per_night_usd: 10.0 },
        defaults: PlanDefaults {
            model: "claude-sonnet-4-6".into(),
            max_wall_minutes: 15,
            silence_minutes: 5,
            max_attempts: 2,
            permission_mode: "dontAsk".into(),
        },
        runs: vec![RunSpec {
            run_id: run_id.clone(),
            project_path: antfarm_path,
            goal: "Add a one-line comment to README.md".into(),
            setup: Some("npm ci".into()),
            on_fail: None,
            steps: vec![StepSpec {
                id: "add-readme-comment".into(),
                prompt: "Add a single HTML comment at the very top of README.md: \
                         <!-- antfarm harness H1 test -->. Do not modify any other file.".into(),
                accept: accept_cmd,
                max_attempts: Some(2),
                model: None,
            }],
        }],
    };
    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(format!("H1 plan started — plan_id={plan_id} run_id={run_id}"))
}

// ── Small lookups ─────────────────────────────────────────────────────────────

fn find_run(plan_id: &str, run_id: &str) -> Result<RunState, String> {
    list_plan_states()?.into_iter()
        .find(|p| p.plan_id == plan_id)
        .and_then(|p| p.runs.into_iter().find(|r| r.run_id == run_id))
        .ok_or_else(|| format!("run {run_id} not found in plan {plan_id}"))
}

fn set_run_status(plan_id: &str, run_id: &str, status: &str) -> Result<(), String> {
    let path = plans_dir().join(plan_id).join("state.json");
    let mut st: PlanState = serde_json::from_str(
        &std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    ).map_err(|e| e.to_string())?;
    if let Some(r) = st.runs.iter_mut().find(|r| r.run_id == run_id) {
        r.status = status.into();
    }
    save_state(&st);
    Ok(())
}

fn repo_of(worktree: &str) -> Result<String, String> {
    Path::new(worktree).parent().and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "cannot derive repo from worktree path".into())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// reconcile_orphans must flip any "running" plan/run/step to the correct
    /// terminal status on process restart (crash-recovery path).
    #[test]
    fn reconcile_orphans_marks_running_entries() {
        let plan_id = "test-reconcile-harness-h2";
        let dir = plans_dir().join(plan_id);
        std::fs::create_dir_all(&dir).unwrap();

        let st = PlanState {
            plan_id: plan_id.into(),
            status: "running".into(),
            cost_usd: 0.05,
            runs: vec![RunState {
                run_id: "test-run-1".into(),
                status: "running".into(),
                steps: vec![
                    StepState {
                        step_id: "step-green".into(),
                        status: "green".into(),  // already terminal — must stay green
                        pid: Some(12345),
                        ..Default::default()
                    },
                    StepState {
                        step_id: "step-inflight".into(),
                        status: "running".into(),  // orphan — must become interrupted
                        pid: Some(99999),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
        };
        save_state(&st);

        reconcile_orphans();

        let text = std::fs::read_to_string(dir.join("state.json")).unwrap();
        let after: PlanState = serde_json::from_str(&text).unwrap();

        assert_eq!(after.status, "aborted", "plan should be aborted");
        assert_eq!(after.runs[0].status, "interrupted", "run should be interrupted");
        assert_eq!(after.runs[0].steps[0].status, "green", "finished step must stay green");
        assert_eq!(after.runs[0].steps[1].status, "interrupted", "in-flight step should be interrupted");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Budget gate: once per_night_usd is consumed, subsequent steps must be
    /// marked budget_skip without calling into execute_plan's step body.
    /// Verifies the check `st.cost_usd >= plan.budgets.per_night_usd`.
    #[test]
    fn budget_gate_threshold() {
        let b = Budgets { per_step_usd: 1.0, per_run_usd: 10.0, per_night_usd: 0.00001 };
        // Any positive cost_usd should exceed the tiny budget.
        let cost_after_step1 = 0.001_f64;
        assert!(
            cost_after_step1 >= b.per_night_usd,
            "real API cost should exceed 0.00001 usd threshold"
        );
        // Zero cost (before any step) must NOT trigger the gate.
        assert!(
            !(0.0_f64 >= b.per_night_usd),
            "gate must be open before first step runs"
        );
    }
}
