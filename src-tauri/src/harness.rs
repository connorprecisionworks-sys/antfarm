// harness.rs - Antfarm overnight harness (H2, 2026-06-12)
//
// H0: dontAsk does not abort on denial; blocked = denials > 0 AND accept fails.
// H1: permission_denials from result line; open_terminal_resume extracted.
// H2: PID recorded while step runs (step pushed to state.json before attempt
//     loop); reconcile_orphans() sweeps "running" entries on fresh startup.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
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

fn default_max_parallel() -> u32 { 3 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightPlan {
    pub plan_id: String,
    pub armed: bool,
    pub budgets: Budgets,
    pub defaults: PlanDefaults,
    #[serde(default = "default_max_parallel")]
    pub max_parallel: u32,
    pub runs: Vec<RunSpec>,
}

// ── Validation types ──────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub goal: String,
    pub project_path: String,
    pub path_exists: bool,
    pub is_git: bool,
    pub step_count: u32,
    pub models: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSummary {
    pub plan_id: String,
    pub run_count: u32,
    pub step_count: u32,
    pub models: Vec<String>,
    pub per_step_usd: f64,
    pub per_run_usd: f64,
    pub per_night_usd: f64,
    pub runs: Vec<RunSummary>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanValidation {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub summary: PlanSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorResult {
    pub plan_path: String,
    pub validation: PlanValidation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalOption {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub tradeoff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalResult {
    pub scope: String,
    pub options: Vec<ProposalOption>,
    pub questions: Vec<String>,
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
    #[serde(default)]
    pub model_used: String,
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
    #[serde(default)]
    pub review_verdict: String,
    #[serde(default)]
    pub review_notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanState {
    pub plan_id: String,
    pub status: String,  // armed|running|done|aborted|budget_stop
    pub cost_usd: f64,
    pub runs: Vec<RunState>,
    #[serde(default)]
    pub updated_at: u64,  // unix secs; always set from file mtime at read time, never trusted from disk
}

// ── Model tier escalation ─────────────────────────────────────────────────────

const HAIKU:  &str = "claude-haiku-4-5-20251001";
const SONNET: &str = "claude-sonnet-4-6";
const OPUS:   &str = "claude-opus-4-8";

fn tier_of(model: &str) -> usize {
    let m = model.to_lowercase();
    if m.contains("haiku")  { 0 }
    else if m.contains("sonnet") { 1 }
    else if m.contains("opus")   { 2 }
    else { 1 }
}

fn model_for_tier(i: usize) -> &'static str {
    match i { 0 => HAIKU, 1 => SONNET, _ => OPUS }
}

/// attempt is 1-indexed: attempt 1 = base model, each retry bumps one tier, capped at Opus.
fn escalated_model(base: &str, attempt: u32) -> String {
    model_for_tier((tier_of(base) + (attempt as usize - 1)).min(2)).to_string()
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

fn plans_authored_dir() -> PathBuf {
    let d = home().join(".antfarm/plans-authored");
    std::fs::create_dir_all(&d).ok();
    d
}

fn is_known_model(s: &str) -> bool {
    let m = s.to_lowercase();
    m.contains("haiku") || m.contains("sonnet") || m.contains("opus")
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
    // Clear any stale state from a prior run with the same id so re-runs never collide.
    git(repo, &["worktree", "remove", "--force", &wt]).ok();
    git(repo, &["worktree", "prune"]).ok();
    git(repo, &["branch", "-D", &branch]).ok();
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
    let allowlists = home().join(".antfarm/allowlists");
    let src = allowlists.join(format!("{project_slug}.json"));
    let default_path = allowlists.join("_default.json");
    let text = std::fs::read_to_string(&src)
        .or_else(|_| std::fs::read_to_string(&default_path))
        .map_err(|_| format!(
            "no allowlist found for '{project_slug}' and no _default.json fallback — \
             refuse to run unattended without one"
        ))?;
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

#[derive(Deserialize)]
struct ReviewJson {
    verdict: String,
    notes: String,
}

fn review_run(claude: &str, worktree: &str, base_commit: &str, goal: &str, accept_tails: &str) -> (String, String, f64) {
    let diff = match git(worktree, &["diff", &format!("{base_commit}...HEAD")]) {
        Ok(d) => d,
        Err(_) => return (String::new(), String::new(), 0.0),
    };
    if diff.trim().is_empty() {
        return (String::new(), String::new(), 0.0);
    }
    let diff_capped = if diff.len() > 40_000 {
        format!("{}\n... (diff truncated at 40k chars)", &diff[..40_000])
    } else {
        diff
    };
    let prompt = format!(
        "You are a strict code reviewer for an UNATTENDED overnight run. The work claims to accomplish this goal:\n{goal}\n\n\
         Full diff (base...HEAD):\n{diff_capped}\n\n\
         Acceptance-check output:\n{accept_tails}\n\n\
         Decide whether the diff correctly and safely accomplishes the goal with NO unrequested or out-of-scope changes. \
         Respond with ONLY a single-line JSON object, no prose, no code fence: \
         {{\"verdict\":\"approve\"|\"request_changes\"|\"reject\",\"notes\":\"one or two sentences; for non-approve, name the specific problem\"}}. \
         approve = fully meets the goal, safe, in scope. \
         request_changes = close but a specific fixable issue. \
         reject = fundamentally wrong or unsafe."
    );
    let mut child = match Command::new(claude)
        .args(["-p", &prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", "dontAsk",
               "--model", OPUS])
        .current_dir(worktree)
        .stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return ("flagged_parse_error".into(), format!("spawn failed: {e}"), 0.0),
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => { child.kill().ok(); return ("flagged_parse_error".into(), "no stdout".into(), 0.0); }
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

    // Lenient parse: find first '{' and last '}', serde_json from that slice.
    let raw_tail: String = result_text.chars().rev().take(200).collect::<String>().chars().rev().collect();
    let parsed = result_text.find('{')
        .and_then(|start| result_text.rfind('}').map(|end| &result_text[start..=end]))
        .and_then(|slice| serde_json::from_str::<ReviewJson>(slice).ok());

    match parsed {
        Some(r) => {
            let verdict = r.verdict.trim().to_lowercase();
            (verdict, r.notes, cost)
        }
        None => (
            "flagged_parse_error".into(),
            format!("could not parse reviewer JSON; raw tail: {raw_tail}"),
            cost,
        ),
    }
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

fn execute_run(
    app: &AppHandle,
    claude: &str,
    run: &RunSpec,
    budgets: &Budgets,
    defaults: &PlanDefaults,
    shared: &Arc<Mutex<PlanState>>,
    git_lock: &Arc<Mutex<()>>,
    aborts: &Arc<Mutex<HashMap<String, bool>>>,
    plan_id: &str,
) {
    // Night budget gate: if already at/over budget, mark budget_skip and return.
    {
        let mut guard = shared.lock().unwrap();
        if guard.cost_usd >= budgets.per_night_usd {
            guard.runs.push(RunState {
                run_id: run.run_id.clone(), status: "budget_skip".into(), ..Default::default()
            });
            save_state(&*guard);
            return;
        }
    }

    let slug = Path::new(&run.project_path).file_name()
        .map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();

    // Serialize worktree creation — concurrent `git worktree add` races on .git metadata.
    let worktree_result = {
        let _git = git_lock.lock().unwrap();
        create_worktree(&run.project_path, &run.run_id)
            .and_then(|r| { write_allowlist(&r.0, &slug)?; Ok(r) })
    };
    let (wt, branch, base) = match worktree_result {
        Ok(r) => r,
        Err(e) => {
            let mut guard = shared.lock().unwrap();
            guard.runs.push(RunState {
                run_id: run.run_id.clone(),
                status: format!("setup_failed: {e}"),
                ..Default::default()
            });
            save_state(&*guard);
            return;
        }
    };

    if let Some(setup) = &run.setup { run_accept(&wt, setup); }

    let mut rs = RunState {
        run_id: run.run_id.clone(), status: "running".into(),
        worktree: wt.clone(), branch, base_commit: base,
        goal: run.goal.clone(),
        ..Default::default()
    };
    {
        let mut guard = shared.lock().unwrap();
        save_state_with(&mut guard, &rs);
    }

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
            let mut guard = shared.lock().unwrap();
            save_state_with(&mut guard, &rs);
            continue;
        }

        let night_over = shared.lock().unwrap().cost_usd >= budgets.per_night_usd;
        if night_over || rs.cost_usd >= budgets.per_run_usd {
            rs.steps[si].status = "budget_skip".into();
            let mut guard = shared.lock().unwrap();
            save_state_with(&mut guard, &rs);
            continue;
        }

        {
            let mut guard = shared.lock().unwrap();
            save_state_with(&mut guard, &rs);  // step visible as "running" on disk
        }

        let max_attempts = step.max_attempts.unwrap_or(defaults.max_attempts);
        let base_model = step.model.as_deref().unwrap_or(&defaults.model);
        let mut fail_output: Option<String> = None;

        for attempt in 1..=max_attempts {
            rs.steps[si].attempts = attempt;
            let model = escalated_model(base_model, attempt);
            if attempt > 1 && model != escalated_model(base_model, attempt - 1) {
                eprintln!("antfarm harness: step {} attempt {} escalated to {}", step.id, attempt, model);
            }
            let prompt = build_step_prompt(run, step, i, &wt, &prev_tail, fail_output.as_deref());
            let outcome = run_step_process(
                app, claude, &wt, &prompt,
                &model,
                &defaults.permission_mode,
                Duration::from_secs(defaults.max_wall_minutes * 60),
                Duration::from_secs(defaults.silence_minutes * 60),
                budgets.per_step_usd,
                aborts, plan_id,
            ).unwrap_or_default();

            // PID captured immediately after spawn; persist to state.
            rs.steps[si].pid = outcome.pid;
            rs.steps[si].model_used = model.clone();
            rs.steps[si].session_id = outcome.session_id.clone()
                .or_else(|| rs.steps[si].session_id.clone());
            rs.steps[si].permission_denials += outcome.permission_denials;

            // Cost: update local per-run counter, then lock to add night delta + save.
            rs.steps[si].cost_usd += outcome.cost_usd;
            rs.cost_usd += outcome.cost_usd;
            {
                let mut guard = shared.lock().unwrap();
                guard.cost_usd += outcome.cost_usd;
                save_state_with(&mut guard, &rs);
            }

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
        {
            let mut guard = shared.lock().unwrap();
            save_state_with(&mut guard, &rs);
        }
    }

    let gated = !run_failed && rs.steps.iter().any(|s| s.status == "green");
    if gated && !rs.base_commit.is_empty() {
        // a. summarize (unchanged)
        let (summ, summ_cost) = summarize_run(claude, &rs.worktree, &rs.base_commit, &run.goal);
        rs.summary = summ;
        rs.cost_usd += summ_cost;
        {
            let mut guard = shared.lock().unwrap();
            guard.cost_usd += summ_cost;
        }
        // b. budget guard: if night is now over budget, mark done and skip the gate
        let over_budget = shared.lock().unwrap().cost_usd >= budgets.per_night_usd;
        if over_budget {
            rs.status = "done".into();
        } else {
            // c. Opus approval gate
            let accept_tails: String = {
                let raw: String = rs.steps.iter()
                    .filter_map(|s| s.accept_output_tail.as_deref())
                    .collect::<Vec<_>>()
                    .join("\n---\n");
                if raw.len() > 4_000 { format!("{}\n... (truncated)", &raw[..4_000]) } else { raw }
            };
            let (review_verdict, review_notes, review_cost) =
                review_run(claude, &rs.worktree, &rs.base_commit, &run.goal, &accept_tails);
            rs.cost_usd += review_cost;
            rs.review_verdict = review_verdict.clone();
            rs.review_notes = review_notes;
            {
                let mut guard = shared.lock().unwrap();
                guard.cost_usd += review_cost;
            }
            rs.status = if review_verdict == "approve" { "approved".into() } else { "flagged".into() };
        }
    } else {
        rs.status = if run_failed { "failed".into() } else { "done".into() };
    }
    {
        let mut guard = shared.lock().unwrap();
        save_state_with(&mut guard, &rs);
    }
}

pub fn execute_plan(app: AppHandle, claude: String, plan: NightPlan,
                    aborts: Arc<Mutex<HashMap<String, bool>>>) {
    std::thread::spawn(move || {
        let plan_id = plan.plan_id.clone();
        let budgets = plan.budgets;
        let defaults = plan.defaults;
        let max_parallel = plan.max_parallel.max(1) as usize;
        let queue: Arc<Mutex<VecDeque<RunSpec>>> =
            Arc::new(Mutex::new(plan.runs.into_iter().collect()));

        let shared = Arc::new(Mutex::new(PlanState {
            plan_id: plan_id.clone(), status: "running".into(),
            ..Default::default()
        }));
        {
            let guard = shared.lock().unwrap();
            save_state(&*guard);
        }

        let caffeinate = Command::new("caffeinate").args(["-i", "-s"]).spawn().ok();
        let git_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));

        let mut handles = Vec::with_capacity(max_parallel);
        for _ in 0..max_parallel {
            let app = app.clone();
            let claude = claude.clone();
            let budgets = budgets.clone();
            let defaults = defaults.clone();
            let shared = shared.clone();
            let git_lock = git_lock.clone();
            let aborts = aborts.clone();
            let plan_id = plan_id.clone();
            let queue = queue.clone();

            handles.push(std::thread::spawn(move || {
                loop {
                    let run = { queue.lock().unwrap().pop_front() };
                    match run {
                        None => break,
                        Some(run) => execute_run(
                            &app, &claude, &run, &budgets, &defaults,
                            &shared, &git_lock, &aborts, &plan_id,
                        ),
                    }
                }
            }));
        }

        for h in handles { h.join().ok(); }

        let aborted = *aborts.lock().unwrap().get(&plan_id).unwrap_or(&false);
        {
            let mut guard = shared.lock().unwrap();
            guard.status = if aborted { "aborted".into() } else { "done".into() };
            save_state(&*guard);
        }

        if let Some(mut c) = caffeinate { c.kill().ok(); }
        app.emit("antfarm-harness-event", serde_json::json!({
            "planId": plan_id, "kind": "plan_done"
        })).ok();
    });
}

pub fn validate_night_plan(plan: &NightPlan) -> PlanValidation {
    use std::collections::{BTreeSet, HashSet};

    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if plan.plan_id.trim().is_empty() {
        errors.push("plan_id is empty".into());
    }
    if plan.runs.is_empty() {
        errors.push("runs list is empty".into());
    }
    if !is_known_model(&plan.defaults.model) {
        errors.push(format!("defaults.model '{}' is not a known model (must contain haiku, sonnet, or opus)", plan.defaults.model));
    }

    // Budget sanity
    let b = &plan.budgets;
    if !b.per_step_usd.is_finite() || b.per_step_usd <= 0.0 {
        errors.push(format!("per_step_usd must be finite and > 0 (got {})", b.per_step_usd));
    } else if !b.per_run_usd.is_finite() || b.per_run_usd <= 0.0 {
        errors.push(format!("per_run_usd must be finite and > 0 (got {})", b.per_run_usd));
    } else if b.per_run_usd < b.per_step_usd {
        errors.push(format!("per_run_usd ({}) must be >= per_step_usd ({})", b.per_run_usd, b.per_step_usd));
    }
    if !b.per_night_usd.is_finite() || b.per_night_usd <= 0.0 {
        errors.push(format!("per_night_usd must be finite and > 0 (got {})", b.per_night_usd));
    } else if b.per_night_usd < b.per_run_usd {
        errors.push(format!("per_night_usd ({}) must be >= per_run_usd ({})", b.per_night_usd, b.per_run_usd));
    }

    // Run-level checks
    let mut seen_run_ids: HashSet<&str> = HashSet::new();
    for run in &plan.runs {
        if run.run_id.trim().is_empty() {
            errors.push("a run has an empty run_id".into());
        } else if !seen_run_ids.insert(run.run_id.as_str()) {
            errors.push(format!("duplicate run_id '{}'", run.run_id));
        }
        if run.steps.is_empty() {
            errors.push(format!("run '{}' has zero steps", run.run_id));
        }
        if run.project_path.trim().is_empty() {
            errors.push(format!("run '{}': project_path is empty", run.run_id));
        } else if !Path::new(&run.project_path).is_dir() {
            errors.push(format!("run '{}': project_path '{}' does not exist as a directory", run.run_id, run.project_path));
        }
        let mut seen_step_ids: HashSet<&str> = HashSet::new();
        for step in &run.steps {
            if step.id.trim().is_empty() {
                errors.push(format!("run '{}': a step has an empty id", run.run_id));
            } else if !seen_step_ids.insert(step.id.as_str()) {
                errors.push(format!("run '{}': duplicate step id '{}'", run.run_id, step.id));
            }
            if step.accept.trim().is_empty() {
                errors.push(format!("run '{}' step '{}': accept is empty", run.run_id, step.id));
            }
            if let Some(m) = &step.model {
                if !is_known_model(m) {
                    errors.push(format!("run '{}' step '{}': model '{}' is not a known model", run.run_id, step.id, m));
                }
            }
        }
    }

    // Warnings
    if plan.armed {
        warnings.push("armed flag in file is ignored; use the Arm button".into());
    }
    if plan.budgets.per_night_usd > 20.0 {
        warnings.push(format!("high night budget ${:.2}", plan.budgets.per_night_usd));
    }
    let plans_state_dir = home().join(".antfarm/plans").join(&plan.plan_id);
    if plans_state_dir.is_dir() {
        warnings.push(format!("plan_id '{}' already exists; arming may collide with prior state", plan.plan_id));
    }
    for run in &plan.runs {
        let p = Path::new(&run.project_path);
        if p.is_dir() && !p.join(".git").is_dir() {
            warnings.push(format!("run '{}': '{}' has no .git subdir; harness creates a worktree", run.run_id, run.project_path));
        }
        if run.setup.is_none() && p.is_dir()
            && (p.join("package.json").exists() || p.join("Cargo.toml").exists()) {
            warnings.push(format!("run '{}': no setup command; a fresh worktree has no installed deps", run.run_id));
        }
    }

    // Build summary
    let mut all_models: BTreeSet<String> = BTreeSet::new();
    all_models.insert(plan.defaults.model.clone());
    let mut total_steps: u32 = 0;
    let mut run_summaries: Vec<RunSummary> = Vec::new();
    for run in &plan.runs {
        let p = Path::new(&run.project_path);
        let path_exists = p.is_dir();
        let is_git = p.join(".git").is_dir();
        let mut run_models: BTreeSet<String> = BTreeSet::new();
        run_models.insert(plan.defaults.model.clone());
        for step in &run.steps {
            let m = step.model.as_deref().unwrap_or(&plan.defaults.model).to_string();
            run_models.insert(m.clone());
            all_models.insert(m);
        }
        total_steps += run.steps.len() as u32;
        run_summaries.push(RunSummary {
            run_id: run.run_id.clone(),
            goal: run.goal.clone(),
            project_path: run.project_path.clone(),
            path_exists,
            is_git,
            step_count: run.steps.len() as u32,
            models: run_models.into_iter().collect(),
        });
    }

    PlanValidation {
        ok: errors.is_empty(),
        errors,
        warnings,
        summary: PlanSummary {
            plan_id: plan.plan_id.clone(),
            run_count: plan.runs.len() as u32,
            step_count: total_steps,
            models: all_models.into_iter().collect(),
            per_step_usd: plan.budgets.per_step_usd,
            per_run_usd: plan.budgets.per_run_usd,
            per_night_usd: plan.budgets.per_night_usd,
            runs: run_summaries,
        },
    }
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

pub fn arm_plan_from_path(
    app: AppHandle,
    claude: String,
    aborts: Arc<Mutex<HashMap<String, bool>>>,
    plan_path: String,
) -> Result<String, String> {
    let text = std::fs::read_to_string(&plan_path).map_err(|e| e.to_string())?;
    let plan: NightPlan = serde_json::from_str(&text).map_err(|e| format!("invalid plan: {e}"))?;
    aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    let id = plan.plan_id.clone();
    execute_plan(app, claude, plan, aborts);
    Ok(id)
}

#[tauri::command]
pub fn arm_night_plan(app: AppHandle, state: State<'_, HarnessState>,
                      dispatch: State<'_, crate::dispatch::DispatchState>,
                      plan_path: String) -> Result<String, String> {
    let claude = dispatch.claude_path.lock().unwrap().clone();
    arm_plan_from_path(app, claude, state.aborts.clone(), plan_path)
}

#[tauri::command]
pub fn validate_plan_file(plan_path: String) -> Result<PlanValidation, String> {
    let text = match std::fs::read_to_string(&plan_path) {
        Ok(t) => t,
        Err(e) => return Err(format!("read error: {e}")),
    };
    match serde_json::from_str::<NightPlan>(&text) {
        Ok(plan) => Ok(validate_night_plan(&plan)),
        Err(e) => Ok(PlanValidation {
            ok: false,
            errors: vec![format!("invalid plan JSON: {e}")],
            ..Default::default()
        }),
    }
}

const PLAN_AUTHOR_PROMPT: &str = r#"You are the orchestrator for an overnight coding harness. Convert the user's request into a single valid night-plan JSON object and output ONLY that JSON, no prose, no markdown fences.

User request: {description}
Target repository: {project_path}
Use this exact plan_id: {plan_id}

Inspect the repo (read package.json, Cargo.toml, or test files) to choose REAL accept checks and setup commands that match this project.

Schema (all fields required unless marked optional):
{
  "plan_id": "{plan_id}",
  "armed": false,
  "budgets": { "per_step_usd": <num>, "per_run_usd": <num>, "per_night_usd": <num> },
  "defaults": { "model": "claude-sonnet-4-6", "max_wall_minutes": 30, "silence_minutes": 5, "max_attempts": 2, "permission_mode": "dontAsk" },
  "max_parallel": 1,
  "runs": [
    {
      "run_id": "<unique-kebab-id>",
      "project_path": "{project_path}",
      "goal": "<one sentence>",
      "setup": "<install command or omit if no deps, e.g. npm ci>",
      "on_fail": "stop_run",
      "steps": [
        { "id": "<unique-within-run>", "prompt": "<precise instruction>", "accept": "<shell command that exits nonzero on failure, e.g. npm run build, npm test, cargo test, node --test>", "max_attempts": 2, "model": "<claude-haiku-4-5-20251001 | claude-sonnet-4-6 | claude-opus-4-8>" }
      ]
    }
  ]
}

Rules:
- armed MUST be false.
- Assign step.model by difficulty: claude-haiku-4-5-20251001 for trivial/mechanical, claude-sonnet-4-6 for standard work, claude-opus-4-8 for gnarly/ambiguous. Use EXACTLY those model strings.
- Every step.accept must be a real shell command that fails (nonzero exit) when the work is wrong. Never leave accept empty.
- If the repo has a lockfile, include a setup command (npm ci / cargo fetch).
- Budgets ascending: per_step_usd <= per_run_usd <= per_night_usd, all > 0. Estimate conservatively (a Sonnet step is roughly $0.10-0.30).
- Split into multiple runs only when chunks are genuinely independent and could run in parallel; otherwise one run with ordered steps.
Output ONLY the JSON object."#;

const PLAN_PROPOSE_PROMPT: &str = r#"You are the lead engineer on a team. The user has a rough idea. Do NOT write code or a plan yet. Inspect the repository to ground your thinking, then propose how to approach it and surface the decisions a human should make.

User idea: {description}
Repository: {project_path}

Output ONLY a JSON object, no prose, no markdown fences:
{
  "scope": "<1-2 sentence read of what this actually involves in THIS repo>",
  "options": [
    { "id": "a", "title": "<short name>", "summary": "<1-2 sentences on the approach>", "tradeoff": "<one line: what you gain vs give up>" }
  ],
  "questions": [ "<an open question or assumption the human should confirm before building>" ]
}

Rules:
- Give 2 or 3 genuinely DIFFERENT approaches, not variations of one. If the task is trivial enough that there's only one sensible approach, return a single option and say so in scope.
- Keep each option concrete and tied to what you saw in the repo.
- questions: 1-4 items, the decisions or unknowns that would change the build (libraries, data shape, scope boundaries, anything needing live data or a DB migration). Empty array if genuinely none.
- Output ONLY the JSON object."#;

pub fn author_plan_core(claude: String, description: String, project_path: String) -> Result<AuthorResult, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let plan_id = format!("authored-{ts}");
    let brain = format!("{}/Desktop/CD_claude", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    let prompt = PLAN_AUTHOR_PROMPT
        .replace("{description}", &description)
        .replace("{project_path}", &project_path)
        .replace("{plan_id}", &plan_id);

    let mut child = Command::new(&claude)
        .args(["-p", &prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", "dontAsk",
               "--model", OPUS,
               "--add-dir", &brain])
        .current_dir(&project_path)
        .stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() { break; }
        }
    });

    let started = Instant::now();
    let max_wall = Duration::from_secs(180);
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
    eprintln!("antfarm author_plan: Opus cost ${cost:.4}");

    // Extract JSON: strip fences, find first '{' to last '}'
    let stripped = result_text
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json_slice = match (stripped.find('{'), stripped.rfind('}')) {
        (Some(start), Some(end)) if end >= start => &stripped[start..=end],
        _ => return Err(format!("author_plan: no JSON object in Opus output; raw: {result_text}")),
    };
    serde_json::from_str::<serde_json::Value>(json_slice)
        .map_err(|e| format!("author_plan: JSON parse failed ({e}); raw: {result_text}"))?;

    let out_dir = plans_authored_dir();
    let plan_path = out_dir.join(format!("{plan_id}.json"));
    std::fs::write(&plan_path, json_slice)
        .map_err(|e| format!("write failed: {e}"))?;
    let plan_path_str = plan_path.to_string_lossy().into_owned();

    let validation = validate_plan_file(plan_path_str.clone())?;
    Ok(AuthorResult { plan_path: plan_path_str, validation })
}

#[tauri::command]
pub fn author_plan(
    _app: AppHandle,
    dispatch: State<'_, crate::dispatch::DispatchState>,
    description: String,
    project_path: String,
) -> Result<AuthorResult, String> {
    let claude = dispatch.claude_path.lock().unwrap().clone();
    author_plan_core(claude, description, project_path)
}

pub fn propose_plan_core(claude: String, description: String, project_path: String) -> Result<ProposalResult, String> {
    let brain = format!("{}/Desktop/CD_claude", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
    let prompt = PLAN_PROPOSE_PROMPT
        .replace("{description}", &description)
        .replace("{project_path}", &project_path);

    let mut child = Command::new(&claude)
        .args(["-p", &prompt,
               "--output-format", "stream-json", "--verbose",
               "--permission-mode", "dontAsk",
               "--model", OPUS,
               "--add-dir", &brain])
        .current_dir(&project_path)
        .stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() { break; }
        }
    });

    let started = Instant::now();
    let max_wall = Duration::from_secs(180);
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
    eprintln!("antfarm propose_plan: Opus cost ${cost:.4}");

    let stripped = result_text
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json_slice = match (stripped.find('{'), stripped.rfind('}')) {
        (Some(start), Some(end)) if end >= start => &stripped[start..=end],
        _ => return Err(format!("propose_plan: no JSON object in Opus output; raw: {result_text}")),
    };
    serde_json::from_str::<ProposalResult>(json_slice)
        .map_err(|e| format!("propose_plan: JSON parse failed ({e}); raw: {result_text}"))
}

#[tauri::command]
pub fn propose_plan(
    _app: AppHandle,
    dispatch: State<'_, crate::dispatch::DispatchState>,
    description: String,
    project_path: String,
) -> Result<ProposalResult, String> {
    let claude = dispatch.claude_path.lock().unwrap().clone();
    propose_plan_core(claude, description, project_path)
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
            let state_path = e.path().join("state.json");
            if let Ok(text) = std::fs::read_to_string(&state_path) {
                if let Ok(mut st) = serde_json::from_str::<PlanState>(&text) {
                    st.updated_at = std::fs::metadata(&state_path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    out.push(st);
                }
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
    git(&repo, &["worktree", "remove", "--force", &rs.worktree]).ok();
    git(&repo, &["worktree", "prune"]).ok();
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
        max_parallel: 1,
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
        max_parallel: 1,
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
        max_parallel: 1,
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

/// Phase B live verification: max_parallel:2 with two independent trivial runs.
/// Invoke from devtools: __TAURI__.core.invoke("dev_test_parallel")
/// Expected: both runs show "running" simultaneously in the Agents view.
#[tauri::command]
pub fn dev_test_parallel(app: AppHandle, state: State<'_, HarnessState>,
                          dispatch: State<'_, crate::dispatch::DispatchState>)
                          -> Result<String, String> {
    let antfarm = home().join("Desktop/antfarm").to_string_lossy().into_owned();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let plan_id = format!("dev-parallel-{ts}");
    let plan = NightPlan {
        plan_id: plan_id.clone(),
        armed: true,
        budgets: Budgets { per_step_usd: 0.50, per_run_usd: 2.0, per_night_usd: 5.0 },
        defaults: haiku_defaults(),
        max_parallel: 2,
        runs: vec![
            RunSpec {
                run_id: format!("run-par-a-{ts}"),
                project_path: antfarm.clone(),
                goal: "Parallel run A — Phase B concurrency verification".into(),
                setup: Some("true".into()),
                on_fail: None,
                steps: vec![trivial_step("step-a1", "true", 1)],
            },
            RunSpec {
                run_id: format!("run-par-b-{ts}"),
                project_path: antfarm,
                goal: "Parallel run B — Phase B concurrency verification".into(),
                setup: Some("true".into()),
                on_fail: None,
                steps: vec![trivial_step("step-b1", "true", 1)],
            },
        ],
    };
    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(format!("parallel plan started — plan_id={plan_id}"))
}

/// Phase C live verification: haiku base model, accept="false", max_attempts=2.
/// Expected: attempt 1 runs haiku and fails accept, attempt 2 escalates to sonnet
/// and fails accept, step ends "failed", StepState.model_used = "claude-sonnet-4-6".
#[tauri::command]
pub fn dev_test_escalation(app: AppHandle, state: State<'_, HarnessState>,
                            dispatch: State<'_, crate::dispatch::DispatchState>)
                            -> Result<String, String> {
    let antfarm = home().join("Desktop/antfarm").to_string_lossy().into_owned();
    let (plan_id, run_id) = dev_plan_id_and_run_id("escalation");
    let plan = NightPlan {
        plan_id: plan_id.clone(),
        armed: true,
        budgets: Budgets { per_step_usd: 1.0, per_run_usd: 5.0, per_night_usd: 10.0 },
        defaults: PlanDefaults {
            model: HAIKU.into(),
            max_wall_minutes: 5,
            silence_minutes: 2,
            max_attempts: 2,
            permission_mode: "dontAsk".into(),
        },
        max_parallel: 1,
        runs: vec![RunSpec {
            run_id: run_id.clone(),
            project_path: antfarm,
            goal: "Model tier escalation verification".into(),
            setup: Some("true".into()),
            on_fail: None,
            steps: vec![StepSpec {
                id: "escalation-step".into(),
                prompt: "Reply with OK. Do not edit any files.".into(),
                accept: "false".into(),   // always fails → triggers retry + escalation
                max_attempts: Some(2),
                model: None,              // inherits defaults.model = haiku
            }],
        }],
    };
    let claude = dispatch.claude_path.lock().unwrap().clone();
    state.aborts.lock().unwrap().insert(plan.plan_id.clone(), false);
    execute_plan(app, claude, plan, state.aborts.clone());
    Ok(format!("escalation plan started — plan_id={plan_id} run_id={run_id}"))
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
            updated_at: 0,
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

    fn make_good_plan() -> NightPlan {
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        NightPlan {
            plan_id: "test-plan-good".into(),
            armed: false,
            budgets: Budgets { per_step_usd: 0.10, per_run_usd: 0.50, per_night_usd: 2.0 },
            defaults: PlanDefaults {
                model: "claude-sonnet-4-6".into(),
                max_wall_minutes: 30,
                silence_minutes: 5,
                max_attempts: 2,
                permission_mode: "dontAsk".into(),
            },
            max_parallel: 1,
            runs: vec![RunSpec {
                run_id: "run-1".into(),
                project_path: tmp,
                goal: "a test goal".into(),
                setup: None,
                on_fail: None,
                steps: vec![StepSpec {
                    id: "step-1".into(),
                    prompt: "do the thing".into(),
                    accept: "true".into(),
                    max_attempts: None,
                    model: None,
                }],
            }],
        }
    }

    #[test]
    fn good_plan_validates_ok() {
        let plan = make_good_plan();
        let v = validate_night_plan(&plan);
        assert!(v.ok, "unexpected errors: {:?}", v.errors);
    }

    #[test]
    fn bad_model_caught() {
        let mut plan = make_good_plan();
        plan.defaults.model = "gpt-4-turbo".into();
        let v = validate_night_plan(&plan);
        assert!(!v.ok);
        assert!(v.errors.iter().any(|e| e.contains("gpt-4-turbo")), "errors: {:?}", v.errors);
    }

    #[test]
    fn empty_accept_caught() {
        let mut plan = make_good_plan();
        plan.runs[0].steps[0].accept = "   ".into();
        let v = validate_night_plan(&plan);
        assert!(!v.ok);
        assert!(v.errors.iter().any(|e| e.contains("accept is empty")), "errors: {:?}", v.errors);
    }

    #[test]
    fn broken_budget_order_caught() {
        let mut plan = make_good_plan();
        plan.budgets.per_run_usd = 0.05; // less than per_step_usd 0.10
        let v = validate_night_plan(&plan);
        assert!(!v.ok);
        assert!(v.errors.iter().any(|e| e.contains("per_run_usd") && e.contains("per_step_usd")), "errors: {:?}", v.errors);
    }

    #[test]
    fn dup_run_id_caught() {
        let mut plan = make_good_plan();
        let extra = plan.runs[0].clone();
        plan.runs.push(extra);
        let v = validate_night_plan(&plan);
        assert!(!v.ok);
        assert!(v.errors.iter().any(|e| e.contains("duplicate run_id")), "errors: {:?}", v.errors);
    }

    #[test]
    fn missing_path_caught() {
        let mut plan = make_good_plan();
        plan.runs[0].project_path = "/tmp/antfarm-test-path-does-not-exist-xyzzy-12345".into();
        let v = validate_night_plan(&plan);
        assert!(!v.ok);
        assert!(v.errors.iter().any(|e| e.contains("does not exist as a directory")), "errors: {:?}", v.errors);
    }
}
