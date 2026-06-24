use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    pub armed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub key: String,
    pub project_path: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub session_id: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SONNET: &str = "claude-sonnet-4-6";

static MSG_COUNTER: AtomicU64 = AtomicU64::new(0);

fn chats_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let d = PathBuf::from(home).join(".antfarm/chats");
    std::fs::create_dir_all(&d).ok();
    d
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn new_msg_id() -> String {
    let ts = now_secs();
    let n = MSG_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{ts}-{n:04}")
}

fn sanitize_key(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

fn thread_path(key: &str) -> PathBuf {
    chats_dir().join(format!("{}.json", sanitize_key(key)))
}

fn load_thread_from_disk(key: &str, project_path: &str) -> ChatThread {
    if let Ok(text) = std::fs::read_to_string(thread_path(key)) {
        if let Ok(t) = serde_json::from_str::<ChatThread>(&text) {
            return t;
        }
    }
    ChatThread {
        key: key.to_string(),
        project_path: project_path.to_string(),
        messages: vec![],
        session_id: None,
    }
}

fn save_thread(thread: &ChatThread) {
    if let Ok(json) = serde_json::to_string_pretty(thread) {
        let _ = std::fs::write(thread_path(&thread.key), json);
    }
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const CHAT_AGENT_PROMPT: &str = "You are a lead engineer chatting with the user to scope a build for the repository at {project_path}. Inspect the repo. Talk like a sharp, concise teammate — react, ask only the questions that matter, suggest a direction. Do NOT write code.\n\nThe build harness runs offline in an isolated worktree with no network and no DB migrations, so if the idea needs live data or schema changes, say so and scope the buildable part to code only.\n\nWhen you and the user agree on what to build, say so plainly in your reply.";

// ── Shared headless runner ────────────────────────────────────────────────────

// Returns (result_text, captured_session_id). Uses stream-json so we can
// pull the session_id from the init line and cost from the result line.
pub(crate) fn run_headless(
    claude: &str,
    args: Vec<String>,
    cwd: &str,
) -> Result<(String, Option<String>), String> {
    let mut child = Command::new(claude)
        .args(&args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
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
    let max_wall = Duration::from_secs(120);
    let mut result_text = String::new();
    let mut captured_sid: Option<String> = None;
    let mut cost = 0.0_f64;
    loop {
        if started.elapsed() > max_wall {
            child.kill().ok();
            break;
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    // Capture session_id from any stream line (init line carries it)
                    if captured_sid.is_none() {
                        if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                            captured_sid = Some(sid.to_string());
                        }
                    }
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
    eprintln!("antfarm chat_turn: Sonnet cost ${cost:.4}");
    Ok((result_text, captured_sid))
}

// ── Turn logic ────────────────────────────────────────────────────────────────
//
// Turn 1 (no session_id): fresh Sonnet call; embeds CHAT_AGENT_PROMPT + user
//   message; captures session_id from stream-json init line.
// Turn N (session_id present): --resume <id> with ONLY the new user text; the
//   resumed session already holds repo context + conversation, so we send
//   nothing else. This is the speed win — no cold repo re-read.

fn chat_turn_core(
    claude: &str,
    project_path: &str,
    messages: &[ChatMessage],
    session_id: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let brain = format!(
        "{}/Desktop/antfarm-memory",
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
    );

    let user_text = messages.iter().rev()
        .find(|m| m.role == "user")
        .map(|m| m.text.clone())
        .ok_or("no user message in thread")?;

    let args = if let Some(sid) = session_id {
        // Warm resume: only the new user message; session carries context.
        vec![
            "--resume".into(), sid.into(),
            "-p".into(), user_text,
            "--model".into(), SONNET.into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
        ]
    } else {
        // Cold start: embed system prompt + user message in the -p value.
        let base = CHAT_AGENT_PROMPT.replace("{project_path}", project_path);
        let prompt = format!("{base}\n\nUser: {user_text}");
        vec![
            "-p".into(), prompt,
            "--model".into(), SONNET.into(),
            "--output-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(), "dontAsk".into(),
            "--add-dir".into(), brain,
        ]
    };

    let (reply, sid) = run_headless(claude, args, project_path)?;
    if reply.is_empty() {
        return Err("chat_turn: empty reply from model".into());
    }
    Ok((reply, sid))
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn load_chat(key: String) -> ChatThread {
    load_thread_from_disk(&key, "")
}

#[tauri::command]
pub async fn send_chat_message(
    _app: AppHandle,
    dispatch: State<'_, crate::dispatch::DispatchState>,
    key: String,
    project_path: String,
    text: String,
) -> Result<ChatThread, String> {
    // Resolve all State + do non-blocking prep before going off-thread.
    let claude = dispatch.claude_path.lock().unwrap().clone();

    let mut thread = load_thread_from_disk(&key, &project_path);
    thread.key = key.clone();
    thread.project_path = project_path.clone();

    thread.messages.push(ChatMessage {
        id: new_msg_id(),
        role: "user".into(),
        text,
        ts: now_secs(),
        plan_path: None,
        plan_id: None,
        armed: false,
        error: None,
    });

    // Clone owned inputs for the blocking closure (State is !Send).
    let msgs = thread.messages.clone();
    let sid  = thread.session_id.clone();
    let pp   = project_path.clone();

    let (reply, new_sid) = tauri::async_runtime::spawn_blocking(move || {
        chat_turn_core(&claude, &pp, &msgs, sid.as_deref())
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))??;

    if new_sid.is_some() {
        thread.session_id = new_sid;
    }

    thread.messages.push(ChatMessage {
        id: new_msg_id(),
        role: "agent".into(),
        text: reply,
        ts: now_secs(),
        plan_path: None,
        plan_id: None,
        armed: false,
        error: None,
    });

    save_thread(&thread);
    Ok(thread)
}

#[tauri::command]
pub async fn build_from_chat(
    _app: AppHandle,
    dispatch: State<'_, crate::dispatch::DispatchState>,
    key: String,
    project_path: String,
) -> Result<ChatThread, String> {
    // Resolve all State + assemble description before going off-thread.
    let claude = dispatch.claude_path.lock().unwrap().clone();

    let mut thread = load_thread_from_disk(&key, &project_path);
    thread.project_path = project_path.clone();

    let transcript = thread.messages.iter()
        .map(|m| {
            if m.role == "user" { format!("User: {}", m.text) }
            else { format!("Agent: {}", m.text) }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let description = format!(
        "Build what this conversation converged on.\n\nConversation so far:\n{transcript}"
    );

    let pp = project_path.clone();
    let author_result = tauri::async_runtime::spawn_blocking(move || {
        crate::harness::author_plan_core(claude, description, pp)
    })
    .await
    .map_err(|e| format!("task panicked: {e}"))?;

    let mut agent_msg = ChatMessage {
        id: new_msg_id(),
        role: "agent".into(),
        text: "Here's the plan:".into(),
        ts: now_secs(),
        plan_path: None,
        plan_id: None,
        armed: false,
        error: None,
    };

    match author_result {
        Ok(result) => {
            agent_msg.plan_id = Some(result.validation.summary.plan_id.clone());
            agent_msg.plan_path = Some(result.plan_path);
        }
        Err(e) => {
            agent_msg.error = Some(e);
        }
    }

    thread.messages.push(agent_msg);
    save_thread(&thread);
    Ok(thread)
}

#[tauri::command]
pub fn arm_chat_plan(
    app: AppHandle,
    harness_state: State<'_, crate::harness::HarnessState>,
    dispatch: State<'_, crate::dispatch::DispatchState>,
    key: String,
    message_id: String,
) -> Result<ChatThread, String> {
    let mut thread = load_thread_from_disk(&key, "");

    let plan_path = thread.messages.iter()
        .find(|m| m.id == message_id)
        .and_then(|m| m.plan_path.clone())
        .ok_or_else(|| format!("message {message_id} not found or has no plan_path"))?;

    let claude = dispatch.claude_path.lock().unwrap().clone();
    let aborts = harness_state.aborts.clone();
    crate::harness::arm_plan_from_path(app, claude, aborts, plan_path)?;

    if let Some(m) = thread.messages.iter_mut().find(|m| m.id == message_id) {
        m.armed = true;
    }
    save_thread(&thread);
    Ok(thread)
}
