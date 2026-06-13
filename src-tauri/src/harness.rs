// harness.rs - Antfarm overnight harness (H1, 2026-06-12)
//
// Executes a night plan: runs (one git worktree each) made of steps (one
// fresh headless `claude -p` each), with accept commands, git checkpoints,
// wall/silence/cost watchdogs, budget gates, and morning accept/reject.
//
// H0 findings baked in:
//   - dontAsk does NOT abort on a denied tool; is_error stays false.
//     Blocked detection uses permission_denials array from the result line,
//     not exit_ok. A step is `blocked` only when denials > 0 AND accept fails.
//   - Allow-list file vehicle confirmed: .claude/settings.json in worktree is
//     honored under dontAsk. write_allowlist enforced (refuses without one).

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

// ── Plan spec (deserialized from ~/.antfarm/plans/<id>/plan.json) ────────────

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
    pub permission_mode: String,  // "dontAsk"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightPlan {
    pub plan_id: String,
    pub armed: bool,
    pub budgets: Budgets,
    pub defaults: PlanDefaults,
    pub runs: Vec<RunSpec>,
}

// ── Live state (persisted on every transition) ────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StepState {
    pub step_id: String,
    pub status: String,  // pending|running|green|failed|timeout|stalled|budget_stop|blocked|interrupted|skipped
    pub attempts: u32,
    pub cost_usd: f64,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub accept_output_tail: Option<String>,
    pub permission_denials: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub run_id: String,
    pub status: String,  // pending|running|done|failed|...|accepted|rejected|merge_failed|conflict
    pub worktree: String,
    pub branch: String,
    pub base_commit: String,
    pub cost_usd: f64,
    pub steps: Vec<StepState>,
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

/// Worktree at <repo>/.antfarm-worktrees/<run_id>, branch antfarm/<run_id>.
fn create_worktree(repo: &str, run_id: &str) -> Result<(String, String, String), String> {
    let wt = format!("{repo}/.antfarm-worktrees/{run_id}");
    let branch = format!("antfarm/{run_id}");
    let base = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    git(repo, &["worktree", "add", &wt, "-b", &branch])?;
    Ok((wt, branch, base))
}

/// Copy ~/.antfarm/allowlists/<slug>.json -> <worktree>/.claude/settings.json.
/// Refuses to proceed without an allowlist (unattended runs must be scoped).
fn write_allowlist(worktree: &str, project_slug: &str) -> Result<(), String> {
    let src = home().join(format!(".antfarm/allowlists/{project_slug}.json"));
    let text = std::fs::read_to_string(&src)
        .map_err(|e| format!("allowlist missing for {project_slug}: {e} — refuse to run unattended without one"))?;
    let dir = Path::new(worktree).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), text).map_err(|e| e.to_string())
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
    killed_reason: Option<String>,  // timeout|stalled|budget_stop|aborted
    cost_usd: f64,
    session_id: Option<String>,
    result_tail: String,
    permission_denials: u32,        // length of permission_denials array in the result line
}

/// Spawn one headless step and supervise it with watchdogs.
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
                        // H0: dontAsk does not abort on denial; is_error stays false.
                        // Count denied tools from the result line for blocked detection.
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

/// Run the accept command in the worktree. Returns (passed, output_tail).
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

// ── The night executor ────────────────────────────────────────────────────────

pub fn execute_plan(app: AppHandle, claude: String, plan: NightPlan,
                    aborts: Arc<Mutex<HashMap<String, bool>>>) {
    std::thread::spawn(move || {
        let mut st = PlanState {
            plan_id: plan.plan_id.clone(), status: "running".into(),
            ..Default::default()
        };
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
            // Run setup command (e.g. npm ci) before any step; fresh worktree has no node_modules.
            if let Some(setup) = &run.setup { run_accept(&wt, setup); }

            let mut rs = RunState {
                run_id: run.run_id.clone(), status: "running".into(),
                worktree: wt.clone(), branch, base_commit: base, ..Default::default()
            };
            let mut prev_tail = String::from("(first step)");
            let mut run_failed = false;

            for (i, step) in run.steps.iter().enumerate() {
                let mut ss = StepState { step_id: step.id.clone(), status: "running".into(), ..Default::default() };
                if run_failed && run.on_fail.as_deref().unwrap_or("stop_run") == "stop_run" {
                    ss.status = "skipped".into();
                    rs.steps.push(ss); continue;
                }
                if st.cost_usd >= plan.budgets.per_night_usd || rs.cost_usd >= plan.budgets.per_run_usd {
                    ss.status = "budget_skip".into();
                    rs.steps.push(ss); continue;
                }

                let max_attempts = step.max_attempts.unwrap_or(plan.defaults.max_attempts);
                let mut fail_output: Option<String> = None;

                for attempt in 1..=max_attempts {
                    ss.attempts = attempt;
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

                    ss.cost_usd += outcome.cost_usd;
                    rs.cost_usd += outcome.cost_usd;
                    st.cost_usd += outcome.cost_usd;
                    ss.session_id = outcome.session_id.clone().or(ss.session_id.take());
                    ss.permission_denials += outcome.permission_denials;

                    if let Some(reason) = outcome.killed_reason {
                        ss.status = reason; run_failed = true; break;
                    }

                    // H0: dontAsk does not abort on denial; always run the accept check.
                    // blocked only when denials > 0 AND accept fails.
                    let (passed, tail) = run_accept(&wt, &step.accept);
                    ss.accept_output_tail = Some(tail.clone());
                    if passed {
                        checkpoint(&wt, &step.id);
                        ss.status = "green".into();
                        prev_tail = outcome.result_tail;
                        break;
                    }
                    if outcome.permission_denials > 0 {
                        ss.status = "blocked".into(); run_failed = true; break;
                    }
                    reset_to_checkpoint(&wt);
                    fail_output = Some(tail);
                    if attempt == max_attempts { ss.status = "failed".into(); run_failed = true; }
                }
                rs.steps.push(ss);
                save_state_with(&mut st, &rs);
            }

            rs.status = if run_failed { "failed".into() } else { "done".into() };
            save_state_with(&mut st, &rs);
            // Worktree kept; morning review decides its fate.
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

/// Dev-only: run a single-step toy plan against the antfarm repo to smoke-test the harness.
/// Step: add a one-line comment to README.md. Accept: npm run build. Setup: npm ci.
#[tauri::command]
pub fn dev_test_harness(app: AppHandle, state: State<'_, HarnessState>,
                         dispatch: State<'_, crate::dispatch::DispatchState>,
                         fail_accept: Option<bool>) -> Result<String, String> {
    let antfarm_path = home().join("Desktop/antfarm").to_string_lossy().into_owned();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let run_id = format!("dev-test-{ts}");
    let plan_id = format!("dev-test-plan-{ts}");

    let accept_cmd = if fail_accept.unwrap_or(false) {
        "false".to_string()
    } else {
        "npm run build".to_string()
    };

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
                prompt: "Add a single comment line at the very top of README.md. \
                         The comment should say: <!-- antfarm harness H1 test -->. \
                         Do not modify any other file.".into(),
                accept: accept_cmd,
                max_attempts: Some(2),
                model: None,
            }],
        }],
    };

    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(format!("dev test plan started — plan_id={plan_id} run_id={run_id} — watch ~/.antfarm/plans/{plan_id}/state.json"))
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
    // <repo>/.antfarm-worktrees/<run_id> -> <repo>
    Path::new(worktree).parent().and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "cannot derive repo from worktree path".into())
}
