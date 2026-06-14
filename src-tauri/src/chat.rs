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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatTurnResult {
    reply: String,
    ready: bool,
    build_description: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const OPUS: &str = "claude-opus-4-8";

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
    ChatThread { key: key.to_string(), project_path: project_path.to_string(), messages: vec![] }
}

fn save_thread(thread: &ChatThread) {
    if let Ok(json) = serde_json::to_string_pretty(thread) {
        let _ = std::fs::write(thread_path(&thread.key), json);
    }
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const CHAT_AGENT_PROMPT: &str = r#"You are a lead engineer chatting with the user to scope a build for the repository at {project_path}. Inspect the repo to ground yourself, then talk like a sharp, concise teammate: react to what they said, ask only the one or two questions that actually matter, suggest a direction. Do NOT write code or a full plan yet.

The build will run in an automated harness that works in an isolated git worktree and CANNOT access the network or run database migrations. If the idea needs live data or schema changes, say so plainly and scope the buildable part to code only.

When you have enough to build, set ready=true and write build_description: a precise, self-contained instruction covering what to build AND how it should be verified (a test or build command). Until then keep ready=false and keep the conversation going.

Output ONLY a JSON object, no prose, no fences:
{ "reply": "<your chat message to the user>", "ready": <true|false>, "build_description": "<the build instruction; empty string unless ready>" }"#;

// ── Core logic ────────────────────────────────────────────────────────────────

fn chat_turn_core(
    claude: String,
    project_path: String,
    messages: &[ChatMessage],
) -> Result<ChatTurnResult, String> {
    let brain = format!(
        "{}/Desktop/CD_claude",
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
    );
    let base = CHAT_AGENT_PROMPT.replace("{project_path}", &project_path);
    let transcript = messages
        .iter()
        .map(|m| {
            if m.role == "user" {
                format!("User: {}", m.text)
            } else {
                format!("Agent: {}", m.text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!("{base}\n\nConversation so far:\n{transcript}\n\nRespond now as JSON.");

    let mut child = Command::new(&claude)
        .args([
            "-p", &prompt,
            "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk",
            "--model", OPUS,
            "--add-dir", &brain,
        ])
        .current_dir(&project_path)
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
                        result_text = v
                            .get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        cost = v.get("total_cost_usd").and_then(|c| c.as_f64()).unwrap_or(0.0);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    child.wait().ok();
    eprintln!("antfarm chat_turn: Opus cost ${cost:.4}");

    let stripped = result_text
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json_slice = match (stripped.find('{'), stripped.rfind('}')) {
        (Some(start), Some(end)) if end >= start => &stripped[start..=end],
        _ => {
            return Err(format!(
                "chat_turn: no JSON object in Opus output; raw: {result_text}"
            ))
        }
    };
    serde_json::from_str::<ChatTurnResult>(json_slice)
        .map_err(|e| format!("chat_turn: JSON parse failed ({e}); raw: {result_text}"))
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn load_chat(key: String) -> ChatThread {
    load_thread_from_disk(&key, "")
}

#[tauri::command]
pub fn send_chat_message(
    _app: AppHandle,
    dispatch: State<'_, crate::dispatch::DispatchState>,
    key: String,
    project_path: String,
    text: String,
) -> Result<ChatThread, String> {
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

    let claude = dispatch.claude_path.lock().unwrap().clone();
    let turn = chat_turn_core(claude.clone(), project_path.clone(), &thread.messages)?;

    let mut agent_msg = ChatMessage {
        id: new_msg_id(),
        role: "agent".into(),
        text: turn.reply.clone(),
        ts: now_secs(),
        plan_path: None,
        plan_id: None,
        armed: false,
        error: None,
    };

    if turn.ready && !turn.build_description.trim().is_empty() {
        match crate::harness::author_plan_core(claude, turn.build_description, project_path) {
            Ok(result) => {
                agent_msg.plan_id = Some(result.validation.summary.plan_id.clone());
                agent_msg.plan_path = Some(result.plan_path);
            }
            Err(e) => {
                agent_msg.error = Some(e);
            }
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

    let plan_path = thread
        .messages
        .iter()
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
