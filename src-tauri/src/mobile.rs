// mobile.rs — Tailscale/local status + Morning view for the antfarm harness.
// Binds a tiny_http server on 127.0.0.1:8787. Token-gated (Bearer or ?token=).
// Token is auto-generated and written to ~/.antfarm/mobile-token on first run.

use std::io::Read;
use std::path::PathBuf;
use tauri::Manager;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

fn load_or_create_token() -> String {
    let antfarm_dir = home().join(".antfarm");
    std::fs::create_dir_all(&antfarm_dir).ok();
    let token_path = antfarm_dir.join("mobile-token");
    if let Ok(t) = std::fs::read_to_string(&token_path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        f.read_exact(&mut bytes).ok();
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    if let Err(e) = std::fs::write(&token_path, &token) {
        eprintln!("antfarm mobile: could not write token: {e}");
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token_path, std::fs::Permissions::from_mode(0o600)).ok();
        }
        eprintln!("antfarm mobile: open http://127.0.0.1:8787/?token={token}");
    }
    token
}

fn is_authorized(request: &tiny_http::Request, token: &str) -> bool {
    for h in request.headers() {
        if h.field.equiv("authorization") {
            if let Some(rest) = h.value.as_str().strip_prefix("Bearer ") {
                if rest == token {
                    return true;
                }
            }
        }
    }
    let url = request.url();
    if let Some(qs) = url.split_once('?').map(|(_, q)| q) {
        for pair in qs.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "token" && v == token {
                    return true;
                }
            }
        }
    }
    false
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let qs = url.split_once('?')?.1;
    for pair in qs.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn url_decode(s: String) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(request: tiny_http::Request, status: u16, content_type: &str, body: String) {
    let header = tiny_http::Header::from_bytes(b"Content-Type", content_type.as_bytes())
        .unwrap_or_else(|_| {
            tiny_http::Header::from_bytes(b"Content-Type", b"text/plain").unwrap()
        });
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    request.respond(response).ok();
}

// ── OpenAI voice helpers ──────────────────────────────────────────────────────

fn openai_api_key() -> Option<String> {
    if let Ok(k) = std::env::var("OPENAI_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() { return Some(k); }
    }
    // Fallback: ~/.antfarm/openai-key
    if let Ok(k) = std::fs::read_to_string(home().join(".antfarm/openai-key")) {
        let k = k.trim().to_string();
        if !k.is_empty() { return Some(k); }
    }
    None
}

fn respond_binary(request: tiny_http::Request, status: u16, content_type: &str, body: Vec<u8>) {
    let header = tiny_http::Header::from_bytes(b"Content-Type", content_type.as_bytes())
        .unwrap_or_else(|_| {
            tiny_http::Header::from_bytes(b"Content-Type", b"application/octet-stream").unwrap()
        });
    let response = tiny_http::Response::from_data(body)
        .with_status_code(status)
        .with_header(header);
    request.respond(response).ok();
}

fn memmem_find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() { return Some(0); }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// Returns (audio_bytes, content_type) from a multipart/form-data body.
fn parse_multipart_file(body: &[u8], content_type_header: &str) -> Option<(Vec<u8>, String)> {
    let boundary = content_type_header.split(';').find_map(|part| {
        let part = part.trim();
        part.strip_prefix("boundary=").map(|b| b.trim_matches('"').to_string())
    })?;

    let bound_bytes = format!("--{}", boundary).into_bytes();
    let start = memmem_find(body, &bound_bytes)?;
    let after_bound = start + bound_bytes.len();

    let header_start = if body.get(after_bound..after_bound + 2) == Some(b"\r\n") {
        after_bound + 2
    } else {
        after_bound
    };

    let sep = b"\r\n\r\n";
    let header_end_rel = memmem_find(&body[header_start..], sep)?;
    let header_block = &body[header_start..header_start + header_end_rel];
    let data_start = header_start + header_end_rel + 4;

    let headers_str = String::from_utf8_lossy(header_block);
    let file_content_type = headers_str.lines()
        .find_map(|line| {
            let lower = line.to_lowercase();
            if lower.starts_with("content-type:") {
                line.splitn(2, ':').nth(1).map(|v| v.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "audio/webm".to_string());

    let end_marker = format!("\r\n--{}", boundary).into_bytes();
    let data_end = memmem_find(&body[data_start..], &end_marker)
        .map(|p| data_start + p)
        .unwrap_or(body.len());

    Some((body[data_start..data_end].to_vec(), file_content_type))
}

fn call_openai_stt(audio_bytes: Vec<u8>, audio_content_type: String, api_key: &str) -> Result<String, String> {
    let ext = if audio_content_type.contains("webm") { "webm" }
        else if audio_content_type.contains("mp4") || audio_content_type.contains("m4a") { "mp4" }
        else if audio_content_type.contains("ogg") { "ogg" }
        else if audio_content_type.contains("wav") { "wav" }
        else if audio_content_type.contains("mpeg") || audio_content_type.contains("mp3") { "mp3" }
        else { "webm" };

    let part = reqwest::blocking::multipart::Part::bytes(audio_bytes)
        .file_name(format!("audio.{ext}"))
        .mime_str(&audio_content_type)
        .map_err(|e| format!("mime error: {e}"))?;

    let form = reqwest::blocking::multipart::Form::new()
        .text("model", "gpt-4o-mini-transcribe")
        .part("file", part);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .map_err(|e| format!("OpenAI STT request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().unwrap_or_default();
        return Err(format!("OpenAI STT HTTP {status}: {body}"));
    }

    let json: serde_json::Value = resp.json().map_err(|e| format!("STT JSON parse: {e}"))?;
    Ok(json.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string())
}

const TTS_MAX_CHARS: usize = 4096;

const VOICE_JARVIS: &str            = "ash";   // Morning / Jarvis persona
#[allow(dead_code)]
const VOICE_DISPATCH: &str          = "onyx";  // reserved for Part C desktop Tauri commands

fn call_openai_tts(text: &str, voice: &str, api_key: &str) -> Result<Vec<u8>, String> {
    let text = if text.len() > TTS_MAX_CHARS { &text[..TTS_MAX_CHARS] } else { text };
    let voice = if voice.is_empty() { VOICE_JARVIS } else { voice };
    let body = serde_json::json!({
        "model": "tts-1",
        "voice": voice,
        "input": text,
        "response_format": "mp3",
    });
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/audio/speech")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("OpenAI TTS request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().unwrap_or_default();
        return Err(format!("OpenAI TTS HTTP {status}: {body_text}"));
    }

    resp.bytes().map(|b| b.to_vec()).map_err(|e| format!("TTS read bytes: {e}"))
}

// ── Dispatch state helpers ────────────────────────────────────────────────────

pub(crate) struct PendingIntent {
    task: String,
    project_slug: String,
}

fn is_affirmative(msg: &str) -> bool {
    let m = msg.trim().to_lowercase();
    let words = ["go", "launch", "do it", "send it", "run it", "yep", "yes", "yeah",
                 "ok", "okay", "sure", "ship it", "let's go", "lets go", "do that"];
    words.iter().any(|w| m == *w || m.starts_with(&format!("{w} ")))
}

fn is_negative(msg: &str) -> bool {
    let m = msg.trim().to_lowercase();
    let words = ["no", "nope", "cancel", "stop", "never mind", "nevermind",
                 "scratch that", "forget it", "discard"];
    words.iter().any(|w| m == *w || m.starts_with(&format!("{w} ")))
}

fn project_slugs_for_prompt() -> String {
    crate::list_projects_pub()
        .into_iter()
        .map(|p| format!("{} ({})", p.slug, p.name))
        .collect::<Vec<_>>()
        .join(", ")
}

fn claude_path(app: &tauri::AppHandle) -> String {
    let dispatch: tauri::State<crate::dispatch::DispatchState> = app.state();
    let p = dispatch.claude_path.lock().unwrap().clone();
    drop(dispatch);
    p
}

fn brain_path() -> String {
    format!("{}/Desktop/CD_claude", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

// ── Mobile HTML page ──────────────────────────────────────────────────────────

const MOBILE_HTML: &str = r###"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Antfarm</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0a0a0b; color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      height: 100dvh; display: flex; flex-direction: column; overflow: hidden;
    }

    /* ── Top nav ── */
    #top-nav {
      display: flex; align-items: center; gap: 2px;
      padding: calc(env(safe-area-inset-top) + 10px) 16px 10px;
      border-bottom: 1px solid #27272a; background: #0d0d0f;
      flex-shrink: 0; z-index: 10;
    }
    .tab {
      flex: 1; padding: 7px 0; border: none; border-radius: 8px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      background: transparent; color: #52525b; transition: all 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .tab.active { background: #1c1c1f; color: #f4f4f5; }
    #nav-status { font-size: 11px; color: #3f3f46; margin-left: 8px; flex-shrink: 0; }

    /* ── View containers ── */
    .view { display: none; flex: 1; min-height: 0; flex-direction: column; }
    .view.active { display: flex; }

    /* ── Morning view ── */
    #morning-scroll {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 14px 14px 0;
    }
    #morning-scroll > * + * { margin-top: 10px; }

    /* loading / error states */
    .morning-state {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; height: 100%; gap: 14px; color: #52525b;
      font-size: 13px; padding-bottom: 60px;
    }
    .spinner {
      width: 22px; height: 22px; border: 2.5px solid #3f3f46;
      border-top-color: #6366f1; border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    /* ── Morning cards ── */
    .m-date { font-size: 10px; font-weight: 700; color: #52525b; letter-spacing: 0.12em; text-transform: uppercase; }
    .m-greeting { font-size: 20px; font-weight: 700; color: #f4f4f5; margin-top: 4px; line-height: 1.2; }

    .card {
      background: #111113; border: 1px solid #27272a; border-radius: 14px;
      padding: 14px; overflow: hidden;
    }

    /* health */
    .health-row { display: flex; align-items: flex-start; gap: 14px; }
    .recovery-ring { flex-shrink: 0; }
    .health-stats { flex: 1; min-width: 0; }
    .metrics-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;
    }
    .metric {
      background: #1a1a1d; border-radius: 8px; padding: 7px 9px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .metric-label { font-size: 9px; color: #52525b; text-transform: uppercase; letter-spacing: 0.06em; }
    .metric-val { font-size: 12px; font-weight: 700; color: #e4e4e7; font-variant-numeric: tabular-nums; }
    .health-read { font-size: 11px; color: #a1a1aa; line-height: 1.55; }

    /* insight */
    .insight-hdr {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .insight-hdr-left { display: flex; align-items: center; gap: 7px; }
    .insight-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #6366f1; flex-shrink: 0;
    }
    .insight-dot.loading { background: #3f3f46; }
    .insight-lbl { font-size: 10px; font-weight: 700; color: #52525b; text-transform: uppercase; letter-spacing: 0.08em; }
    .insight-text { font-size: 13px; color: #e4e4e7; line-height: 1.6; }
    .shimmer-line {
      height: 14px; border-radius: 6px; margin-bottom: 7px;
      background: linear-gradient(90deg, #1c1c1f 25%, #27272a 50%, #1c1c1f 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s linear infinite;
    }
    .shimmer-line.short { width: 70%; margin-bottom: 0; }
    .insight-bar {
      position: absolute; inset-x: 0; top: 0; height: 2px;
      background: linear-gradient(90deg, transparent 0%, #6366f1 50%, transparent 100%);
      background-size: 200% 100%;
      animation: shimmer 1.6s linear infinite;
    }
    .insight-card { position: relative; }

    /* day + commitments */
    .day-line { font-size: 13px; color: #d4d4d8; line-height: 1.55; }
    .commitments { list-style: none; margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
    .commitments li {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: #a1a1aa;
    }
    .commitments li::before {
      content: ''; width: 5px; height: 5px; border-radius: 50%;
      background: #52525b; flex-shrink: 0;
    }

    /* tasks */
    .section-lbl {
      font-size: 10px; font-weight: 700; color: #52525b;
      text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px;
    }
    .task-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 7px 0; border-bottom: 1px solid #1c1c1f;
    }
    .task-row:last-child { border-bottom: none; }
    .task-dot {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #52525b; flex-shrink: 0; margin-top: 1px;
    }
    .task-info { display: flex; flex-direction: column; gap: 2px; }
    .task-text { font-size: 13px; color: #e4e4e7; line-height: 1.4; }
    .task-detail { font-size: 11px; color: #71717a; }

    /* routine */
    .routine-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 0; border-bottom: 1px solid #1c1c1f;
      cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    .routine-row:last-child { border-bottom: none; }
    .routine-circle {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid #52525b; flex-shrink: 0;
      transition: background 0.15s, border-color 0.15s;
    }
    .routine-circle.checked { background: #6366f1; border-color: #6366f1; }
    .routine-label { font-size: 13px; color: #e4e4e7; }
    .routine-label.done { text-decoration: line-through; color: #52525b; }

    /* win / agent note */
    .win-card { border-color: #3f3a1a; background: #16140a; }
    .win-label { font-size: 10px; font-weight: 700; color: #78716c; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 5px; }
    .win-text { font-size: 13px; color: #d4c38a; line-height: 1.5; }
    .agent-note-card { border-color: #1e2a1e; background: #0d130d; }
    .agent-note-text { font-size: 12px; color: #86a886; line-height: 1.55; }

    /* lists */
    .list-card .list-items { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
    .list-item { font-size: 12px; color: #a1a1aa; line-height: 1.5; padding: 3px 0; }

    /* bottom spacer inside scroll */
    .scroll-pad { height: 14px; flex-shrink: 0; }

    /* ── Morning chat panel ── */
    #chat-panel {
      flex-shrink: 0; border-top: 1px solid #27272a;
      background: #0d0d0f;
      padding-bottom: env(safe-area-inset-bottom);
    }
    #chat-toggle-btn {
      display: flex; align-items: center; justify-content: space-between;
      width: 100%; padding: 11px 16px; border: none; background: transparent;
      cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    .chat-title { font-size: 12px; font-weight: 600; color: #71717a; }
    .chat-chevron { font-size: 10px; color: #52525b; transition: transform 0.2s; }
    .chat-chevron.open { transform: rotate(180deg); }
    #chat-body { display: none; }
    #chat-body.open { display: flex; flex-direction: column; }
    #chat-messages {
      max-height: 180px; overflow-y: auto;
      padding: 8px 14px; display: flex; flex-direction: column; gap: 6px;
    }
    .chat-empty { font-size: 12px; color: #3f3f46; text-align: center; padding: 16px 0; }
    .msg-row { display: flex; }
    .msg-row.user { justify-content: flex-end; }
    .msg-row.agent, .msg-row.error { justify-content: flex-start; }
    .bubble {
      max-width: 82%; border-radius: 16px; padding: 8px 12px;
      font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      animation: msgIn 0.2s ease-out both;
    }
    .bubble.user { background: #4338ca; color: #fff; border-bottom-right-radius: 4px; }
    .bubble.agent { background: #1c1c1f; color: #e4e4e7; border-bottom-left-radius: 4px; }
    .bubble.error { background: #1a0a0a; color: #fca5a5; border-bottom-left-radius: 4px; font-size: 12px; }
    .typing {
      background: #1c1c1f; border-radius: 16px; border-bottom-left-radius: 4px;
      padding: 10px 14px; display: flex; align-items: center; gap: 4px;
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #52525b; }
    .dot:nth-child(1) { animation: dotB 1.2s ease-in-out infinite 0ms; }
    .dot:nth-child(2) { animation: dotB 1.2s ease-in-out infinite 160ms; }
    .dot:nth-child(3) { animation: dotB 1.2s ease-in-out infinite 320ms; }
    #chat-input-row {
      display: flex; gap: 8px; padding: 8px 14px 10px;
      border-top: 1px solid #1c1c1f;
    }
    #chat-input {
      flex: 1; background: #1a1a1d; border: 1px solid #3f3f46; border-radius: 10px;
      color: #e4e4e7; font-size: 13px; padding: 9px 12px; outline: none;
      font-family: inherit;
    }
    #chat-input:focus { border-color: #6366f1; }
    #chat-input::placeholder { color: #52525b; }
    #chat-input:disabled { opacity: 0.5; }
    #chat-send-btn {
      width: 36px; height: 36px; border: none; border-radius: 10px;
      background: #4338ca; color: #fff; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; -webkit-tap-highlight-color: transparent;
    }
    #chat-send-btn:disabled { background: #1c1c1f; color: #3f3f46; cursor: default; }
    #mic-btn {
      width: 36px; height: 36px; border: none; border-radius: 10px;
      background: #27272a; color: #71717a;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0; -webkit-tap-highlight-color: transparent;
      transition: background 0.15s, color 0.15s;
    }
    #mic-btn.recording { background: #7f1d1d; color: #fca5a5; animation: micPulse 1s ease-in-out infinite; }
    #mic-btn.transcribing { background: #1e3a5f; color: #7dd3fc; }
    #mic-btn.speaking { background: #14532d; color: #86efac; }
    #voice-state-row { padding: 0 14px 4px; }
    #voice-state-label { font-size: 10px; color: #52525b; letter-spacing: 0.04em; }
    @keyframes micPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

    /* ── Agents view ── */
    #view-agents { overflow-y: auto; padding-bottom: env(safe-area-inset-bottom); }

    #list { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .run-card {
      background: #111113; border: 1px solid #27272a; border-radius: 14px;
      padding: 14px; cursor: pointer; -webkit-tap-highlight-color: transparent;
      transition: background 0.1s;
    }
    .run-card:active { background: #1c1c1e; }
    .goal { font-size: 14px; font-weight: 600; color: #f4f4f5; line-height: 1.35; margin-bottom: 8px; }
    .summary { font-size: 12px; color: #a1a1aa; line-height: 1.55; margin-bottom: 8px; }
    .reviewer {
      font-size: 11px; color: #fcd34d; background: #1a1207;
      border-radius: 6px; padding: 6px 9px; margin-bottom: 8px; line-height: 1.45;
    }
    .reviewer b { font-weight: 600; }
    .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; padding: 2px 8px;
      border-radius: 99px; font-size: 10px; font-weight: 700;
      letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;
    }
    .cost { font-size: 11px; color: #71717a; font-variant-numeric: tabular-nums; }
    .run-id { font-size: 10px; color: #3f3f46; font-family: monospace; margin-top: 6px; }
    .empty { padding: 60px 24px; text-align: center; color: #52525b; font-size: 14px; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    .btn {
      flex: 1; padding: 9px 0; border: none; border-radius: 9px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .btn-merge { background: #3730a3; color: #a5b4fc; }
    .btn-merge:active { background: #312e81; }
    .btn-toss { background: #27272a; color: #a1a1aa; }
    .btn-toss:active { background: #3f3f46; }

    #author-section { padding: 12px; border-top: 1px solid #27272a; }
    #author-hdr { font-size: 11px; font-weight: 700; color: #52525b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
    .author-form { display: flex; flex-direction: column; gap: 8px; }
    .author-form textarea {
      background: #0d0d0f; border: 1px solid #3f3f46; border-radius: 9px;
      color: #e4e4e7; font-size: 13px; padding: 10px 12px; resize: vertical;
      font-family: inherit; outline: none; min-height: 72px;
    }
    .author-form textarea:focus { border-color: #6366f1; }
    .author-form select, .author-form input[type="text"] {
      background: #0d0d0f; border: 1px solid #3f3f46; border-radius: 9px;
      color: #e4e4e7; font-size: 13px; padding: 9px 12px; outline: none; width: 100%;
    }
    .author-form select:focus, .author-form input[type="text"]:focus { border-color: #6366f1; }
    .btn-generate {
      background: #3730a3; color: #a5b4fc; border: none; border-radius: 9px;
      padding: 11px 0; font-size: 13px; font-weight: 600; cursor: pointer;
      width: 100%; -webkit-tap-highlight-color: transparent;
    }
    .btn-generate:active { background: #312e81; }
    .btn-generate:disabled { background: #1c1c1e; color: #3f3f46; cursor: default; }
    .author-result {
      background: #111113; border: 1px solid #27272a; border-radius: 12px;
      padding: 12px 14px; margin-top: 8px;
    }
    .author-errors { background: #450a0a; border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; }
    .author-errors div { font-size: 11px; color: #fca5a5; }
    .author-warnings { background: #1a1207; border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; }
    .author-warnings div { font-size: 11px; color: #fcd34d; }
    .author-run { border-top: 1px solid #27272a; padding-top: 8px; margin-top: 8px; }
    .author-run-goal { font-size: 12px; font-weight: 600; color: #e4e4e7; margin-bottom: 3px; }
    .author-run-meta { font-size: 10px; color: #52525b; font-family: monospace; }

    #plans-section { padding: 12px; border-top: 1px solid #27272a; }
    #plans-hdr { font-size: 11px; font-weight: 700; color: #52525b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
    .plan-card {
      background: #111113; border: 1px solid #27272a; border-radius: 14px;
      padding: 12px 14px; margin-bottom: 8px;
    }
    .plan-goal { font-size: 13px; font-weight: 600; color: #f4f4f5; margin-bottom: 4px; }
    .plan-meta { font-size: 11px; color: #71717a; margin-bottom: 8px; }
    .btn-arm {
      background: #1e3a5f; color: #7dd3fc; border: none; border-radius: 9px;
      padding: 8px 0; font-size: 13px; font-weight: 600; cursor: pointer;
      width: 100%; -webkit-tap-highlight-color: transparent;
    }
    .btn-arm:active { background: #164e63; }

    /* Diff overlay */
    #overlay {
      display: none; position: fixed; inset: 0; background: #0a0a0b;
      z-index: 100; flex-direction: column;
    }
    #overlay.open { display: flex; }
    #ov-hdr {
      display: flex; align-items: center; gap: 10px;
      padding: calc(env(safe-area-inset-top) + 12px) 16px 12px;
      border-bottom: 1px solid #27272a; background: #0d0d0f;
    }
    #ov-title { flex: 1; font-size: 13px; font-weight: 600; color: #e4e4e7; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    #ov-close {
      background: #27272a; border: none; color: #a1a1aa;
      padding: 6px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; flex-shrink: 0;
    }
    #ov-body { flex: 1; overflow: auto; padding: 12px 14px; }
    #ov-pre { font-family: "Menlo", "SF Mono", monospace; font-size: 11px; color: #a1a1aa; white-space: pre; line-height: 1.5; }

    /* ── Keyframes ── */
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @keyframes msgIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes dotB { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-4px); } }
    @keyframes insightIn { from { opacity: 0; } to { opacity: 1; } }
    .insight-in { animation: insightIn 0.3s ease-out both; }
    @keyframes orbPulse { 0%,100%{opacity:.7} 50%{opacity:1} }
    @keyframes orbBreath { 0%,100%{transform:scale(1)} 50%{transform:scale(1.04)} }

    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; border-top-color: #6366f1; }
      .shimmer-line { animation: none; background: #1c1c1f; }
      .insight-bar { animation: none; background: #6366f1; opacity: 0.4; }
      .dot { animation: none; }
      .bubble { animation: none; }
    }

    /* ── Voice overlay ── */
    #voice-overlay {
      position: fixed; inset: 0; z-index: 300;
      background: #07080c;
      display: none; flex-direction: column;
      align-items: center; justify-content: center; gap: 0;
      opacity: 0; transition: opacity 0.3s ease;
    }
    #voice-overlay.active { display: flex; }
    #voice-overlay.visible { opacity: 1; }
    #orb-canvas { display: block; touch-action: none; }
    #voice-chrome {
      position: absolute; top: 0; left: 0; right: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: calc(env(safe-area-inset-top) + 14px) 20px 14px;
    }
    #voice-indicator {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; font-family: ui-monospace,monospace;
      letter-spacing: .08em; color: #52525b;
    }
    #voice-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #52525b;
      transition: background .4s;
    }
    #voice-dot.live { background: #22c55e; animation: orbPulse 2s ease-in-out infinite; }
    #voice-dot.connecting { background: #d4a04d; }
    #voice-timer-wrap { font-size: 11px; font-family: ui-monospace,monospace; color: #3f3f46; }
    #voice-timer { color: #52525b; }
    #voice-cost { color: #3f3f46; margin-left: 6px; }
    #voice-bottom {
      position: absolute; bottom: 0; left: 0; right: 0;
      display: flex; flex-direction: column; align-items: center;
      padding-bottom: calc(env(safe-area-inset-bottom) + 32px); gap: 16px;
    }
    #voice-state-text {
      font-size: 12px; font-family: ui-monospace,monospace;
      letter-spacing: .1em; color: #52525b; min-height: 16px;
      text-transform: uppercase;
    }
    #voice-end-btn {
      background: #18181b; border: 1px solid #27272a;
      color: #a1a1aa; font-size: 13px; font-weight: 500;
      padding: 10px 32px; border-radius: 100px; cursor: pointer;
      transition: background .15s, color .15s;
    }
    #voice-end-btn:hover { background: #27272a; color: #e4e4e7; }
    #voice-captions {
      position: absolute; bottom: 120px; left: 16px; right: 16px;
      background: rgba(13,13,15,.85); backdrop-filter: blur(8px);
      border-radius: 12px; padding: 12px 16px;
      font-size: 13px; color: #d4d4d8; line-height: 1.5;
      display: none;
    }
    #voice-captions.shown { display: block; }
    #voice-captions-btn {
      background: none; border: none; color: #3f3f46;
      font-size: 11px; font-family: ui-monospace,monospace;
      letter-spacing: .08em; cursor: pointer; padding: 4px 8px;
    }
    #voice-captions-btn.on { color: #7c97e8; }
    #rt-debug {
      font-size: 10px; font-family: ui-monospace, monospace;
      color: #3f3f46; letter-spacing: .05em; text-align: center;
      min-height: 14px; margin-top: 6px; padding: 0 20px;
    }

    /* ── Voice nav tab ── */
    .tab-voice {
      background: none; border: none; padding: 0 10px; cursor: pointer;
      font-size: 13px; color: #52525b; display: flex; align-items: center; gap: 5px;
      transition: color .15s;
    }
    .tab-voice:hover { color: #a1a1aa; }
    .tab-voice svg { display: block; }
  </style>
</head>
<body>

  <!-- sticky nav -->
  <div id="top-nav">
    <button class="tab active" id="tab-morning" onclick="switchView('morning')">Morning</button>
    <button class="tab"        id="tab-agents"  onclick="switchView('agents')">Agents</button>
    <span id="nav-status"></span>
    <button class="tab-voice" onclick="openVoiceOverlay('morning')" title="Talk to Captain Jack">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
      Talk
    </button>
  </div>

  <!-- ── Voice overlay ─────────────────────────────────────────────────── -->
  <div id="voice-overlay">
    <!-- top chrome -->
    <div id="voice-chrome">
      <div id="voice-indicator">
        <span id="voice-dot"></span>
        <span id="voice-status-text">ready</span>
      </div>
      <div id="voice-timer-wrap">
        <span id="voice-timer"></span><span id="voice-cost"></span>
      </div>
    </div>
    <!-- orb canvas (sized by JS) -->
    <canvas id="orb-canvas"></canvas>
    <!-- state label under orb -->
    <div id="voice-state-text"></div>
    <!-- mic/rtc debug (visible until confirmed working) -->
    <div id="rt-debug"></div>
    <!-- bottom controls -->
    <div id="voice-bottom">
      <div style="display:flex;gap:12px;align-items:center;">
        <button id="voice-captions-btn" onclick="toggleCaptions()">CC</button>
        <button id="voice-end-btn" onclick="closeVoiceOverlay()">End</button>
      </div>
    </div>
    <!-- live captions (hidden by default) -->
    <div id="voice-captions"></div>
  </div>

  <!-- ── Morning view ────────────────────────────────────────────────── -->
  <div id="view-morning" class="view active">
    <div id="morning-scroll">
      <div id="morning-loader-wrap"></div>
      <div id="morning-content" style="display:none"></div>
    </div>

    <!-- docked chat -->
    <div id="chat-panel">
      <button id="chat-toggle-btn" onclick="toggleChat()">
        <span class="chat-title">Morning agent</span>
        <span class="chat-chevron" id="chat-chevron">▲</span>
      </button>
      <div id="chat-body">
        <div id="chat-messages">
          <div class="chat-empty" id="chat-empty">Ask Captain Jack a follow-up...</div>
        </div>
        <div id="chat-input-row">
          <input id="chat-input" type="text" placeholder="Ask Captain Jack..."
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}">
          <button id="mic-btn" onclick="toggleMic()" title="Voice input" style="display:none">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="21" x2="12" y2="17"/></svg>
          </button>
          <button id="chat-send-btn" onclick="sendChat()" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
        <div id="voice-state-row"><span id="voice-state-label"></span></div>
      </div>
    </div>
  </div>

  <!-- ── Agents view ─────────────────────────────────────────────────── -->
  <div id="view-agents" class="view">
    <div id="list"></div>

    <div id="author-section">
      <div id="author-hdr">Author a plan</div>
      <div class="author-form">
        <textarea id="author-desc" placeholder="Describe what you want the agent to build…" rows="3"></textarea>
        <select id="author-project"><option value="">— pick project —</option></select>
        <input type="text" id="author-path" placeholder="or paste a repo path">
        <button class="btn-generate" id="btn-generate" onclick="generatePlan()" disabled>Generate plan</button>
      </div>
      <div id="author-result-area"></div>
    </div>

    <div id="plans-section">
      <div id="plans-hdr">Start a run</div>
      <div id="plans-list"><div class="empty" style="padding:20px 0;font-size:12px;">Loading plans…</div></div>
    </div>
  </div>

  <!-- diff overlay (shared) -->
  <div id="overlay">
    <div id="ov-hdr">
      <span id="ov-title"></span>
      <button id="ov-close" onclick="closeDiff()">Close</button>
    </div>
    <div id="ov-body"><pre id="ov-pre"></pre></div>
  </div>

  <script>
    // ── Token ─────────────────────────────────────────────────────────────────
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('token');
    if (urlToken) localStorage.setItem('af-token', urlToken);
    const TOKEN = localStorage.getItem('af-token') || '';

    function authHeaders() {
      return { 'Authorization': 'Bearer ' + TOKEN };
    }

    // ── View switching ────────────────────────────────────────────────────────
    let CURRENT_VIEW = 'morning';

    function switchView(v) {
      CURRENT_VIEW = v;
      document.getElementById('view-morning').classList.toggle('active', v === 'morning');
      document.getElementById('view-agents').classList.toggle('active', v === 'agents');
      document.getElementById('tab-morning').classList.toggle('active', v === 'morning');
      document.getElementById('tab-agents').classList.toggle('active', v === 'agents');
      if (v === 'agents' && !AGENTS_LOADED) {
        fetchRuns(); fetchProjects(); fetchPlans();
        AGENTS_LOADED = true;
      }
    }

    // ── Morning particle loader ───────────────────────────────────────────────
    function MorningLoaderFactory(){
      function mount(container, onDone){
        var wrap=document.createElement('div');
        wrap.style.cssText="display:flex;flex-direction:column;align-items:center;padding:28px 0;transition:opacity .4s;";
        var cv=document.createElement('canvas');
        cv.style.cssText="width:250px;height:250px;display:block;";
        var cap=document.createElement('div');
        cap.style.cssText="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;color:#5f6776;text-transform:uppercase;margin-top:12px;";
        cap.textContent='preparing your morning';
        wrap.appendChild(cv);wrap.appendChild(cap);container.appendChild(wrap);

        var ctx=cv.getContext('2d'),DPR=Math.min(window.devicePixelRatio||1,2),SIZE=250;
        cv.width=SIZE*DPR;cv.height=SIZE*DPR;ctx.scale(DPR,DPR);
        var W=SIZE,H=SIZE,cx=W/2,cyS=W/2-18,R=92,N=1500,FOCAL=340;
        var barX0=26,barX1=W-26,barY=H-14,cap_=0.6,maxTaken=Math.floor(N*cap_);

        var sphere=[],galaxy=[],ribbon=[],torus=[],i,PHI=(1+Math.sqrt(5))/2;
        for(i=0;i<N;i++){var ph=Math.acos(1-2*(i+0.5)/N),th=Math.PI*(1+Math.sqrt(5))*i;sphere.push([Math.cos(th)*Math.sin(ph)*82,Math.sin(th)*Math.sin(ph)*82,Math.cos(ph)*82]);}
        for(i=0;i<N;i++){var t=(i+1)/N,r=t*96,arm=(i%3)*(Math.PI*2/3),a=t*Math.PI*4+arm;galaxy.push([Math.cos(a)*r,(Math.random()-0.5)*16,Math.sin(a)*r]);}
        for(i=0;i<N;i++){var gx=i%42,gz=Math.floor(i/42),x=(gx/41-0.5)*186,z=(gz/((N/42)-1)-0.5)*124,y=Math.sin(gx*0.32)*19+Math.cos(gz*0.4)*12;ribbon.push([x,y,z]);}
        for(i=0;i<N;i++){var u=(i*7/N)*Math.PI*2,v=(i*PHI)*Math.PI*2,Rr=64,rr=23;torus.push([(Rr+rr*Math.cos(v))*Math.cos(u),(Rr+rr*Math.cos(v))*Math.sin(u),rr*Math.sin(v)]);}
        function rot(p,ax,ay){var cyy=Math.cos(ay),sy=Math.sin(ay),X=p[0]*cyy-p[2]*sy,Z=p[0]*sy+p[2]*cyy,cxx=Math.cos(ax),sx=Math.sin(ax);return [X,p[1]*cxx-Z*sx,p[1]*sx+Z*cxx];}
        var forms=[{n:'spinner',c:'preparing your morning'},{n:'sphere',c:'reading your sleep'},{n:'galaxy',c:'lining up your agents'},{n:'ribbon',c:'warming up'},{n:'torus',c:'almost ready'}];
        var SHAPES={sphere:sphere,galaxy:galaxy,ribbon:ribbon,torus:torus};
        var rankArr=[];for(i=0;i<N;i++)rankArr.push(i);
        for(i=N-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),tm=rankArr[i];rankArr[i]=rankArr[j];rankArr[j]=tm;}
        var P=[];for(i=0;i<N;i++){P.push({x:cx+(Math.random()-0.5)*70,y:cyS+(Math.random()-0.5)*70,rank:rankArr[i],roff:Math.random(),s:0.6+Math.random()*0.52,bjx:(Math.random()-0.5)*5,bjy:(Math.random()-0.5)*13});}
        function shapeAt(name,i){if(name==='spinner'){var a=(i/N)*Math.PI*1.5+spin,rr=R*(0.80+P[i].roff*0.30);return [cx+Math.cos(a)*rr,cyS+Math.sin(a)*rr,1];}var rp=rot(SHAPES[name][i],ang*0.5,ang),s=FOCAL/(FOCAL-rp[2]);return [cx+rp[0]*s,cyS+rp[1]*s,s];}

        var spin=0,ang=0,idx=0,last=0,HOLD=3000,raf=0,start=0,done=false,doneProg=0,finished=false;
        function frame(t){
          if(!start)start=t; if(!last)last=t;
          var cur=forms[idx];
          if(cur.n==='spinner')spin+=0.040; else ang+=0.009;
          if(t-last>HOLD){idx=(idx+1)%forms.length;last=t;cur=forms[idx];cap.textContent=cur.c;}
          var el=(t-start)/1000, base=Math.min((1-Math.exp(-el/14))*0.9,0.9), prog;
          if(done){doneProg+=(1-doneProg)*0.06; prog=Math.max(base,doneProg);} else prog=base;
          var taken=prog*maxTaken;
          ctx.clearRect(0,0,W,H);
          for(i=0;i<N;i++){var p=P[i],depth,tx,ty;
            if(p.rank<taken){var fx=p.rank/(maxTaken-1);tx=barX0+fx*(barX1-barX0)+p.bjx;ty=barY+p.bjy;depth=1;p.x+=(tx-p.x)*0.10;p.y+=(ty-p.y)*0.10;}
            else{var tg=shapeAt(cur.n,i),dxc=tg[0]-cx,dyc=tg[1]-cyS,dist=Math.sqrt(dxc*dxc+dyc*dyc),rip=Math.sin(dist*0.045-t*0.0015)*3.0,nrx=dist>0.001?dxc/dist:0,nry=dist>0.001?dyc/dist:0;tx=tg[0]+nrx*rip;ty=tg[1]+nry*rip;depth=Math.max(0.45,Math.min(tg[2],1.5));p.x+=(tx-p.x)*0.06;p.y+=(ty-p.y)*0.06;}
            ctx.beginPath();ctx.arc(p.x,p.y,p.s*(0.6+depth*0.5),0,7);ctx.fillStyle='rgba(124,151,232,'+(0.5+(depth-0.45)*0.45)+')';ctx.fill();
          }
          ctx.strokeStyle='rgba(124,151,232,0.14)';ctx.lineWidth=1;ctx.strokeRect(barX0-3,barY-9,(barX1-barX0)+6,18);
          if(done&&doneProg>0.99&&!finished){finished=true;wrap.style.opacity=0;setTimeout(function(){cancelAnimationFrame(raf);if(wrap.parentNode)wrap.parentNode.removeChild(wrap);if(onDone)onDone();},420);}
          raf=requestAnimationFrame(frame);
        }
        raf=requestAnimationFrame(frame);
        return {finish:function(){done=true;},destroy:function(){cancelAnimationFrame(raf);if(wrap.parentNode)wrap.parentNode.removeChild(wrap);}};
      }
      return {mount:mount};
    }
    var MorningLoader=MorningLoaderFactory();

    // ── Morning state ─────────────────────────────────────────────────────────
    let BRIEFING = null;
    let BRIEFING_JSON = '';
    const DATE_KEY = new Date().toISOString().slice(0, 10);
    let CHAT_MSGS = [];
    let CHAT_THINKING = false;
    let CHAT_OPEN = false;

    function esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function parseBriefing(raw) {
      const stripped = raw
        .replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/\s*```$/im, '').trim();
      const s = stripped.indexOf('{');
      const e = stripped.lastIndexOf('}');
      if (s === -1 || e < s) return null;
      try { return JSON.parse(stripped.slice(s, e + 1)); } catch { return null; }
    }

    function recoveryColor(pct) {
      return pct >= 67 ? '#3a9e62' : pct >= 34 ? '#d4a04d' : '#d65b48';
    }

    function recoveryRingSvg(pct) {
      const r = 36, circ = 2 * Math.PI * r;
      const color = recoveryColor(pct);
      const offset = (circ * (1 - Math.min(100, Math.max(0, pct)) / 100)).toFixed(2);
      return `<svg class="recovery-ring" width="80" height="80" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r="${r}" fill="none" stroke="#27272a" stroke-width="7"/>
        <circle cx="44" cy="44" r="${r}" fill="none" stroke="${color}" stroke-width="7"
          stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset}"
          stroke-linecap="round" transform="rotate(-90 44 44)"/>
        <text x="44" y="49" text-anchor="middle" fill="${color}" font-size="20" font-weight="700">${pct}</text>
      </svg>`;
    }

    function renderBriefing(b) {
      const h = b.health || {};
      const pct = h.recovery || 0;

      let html = '';

      // Date + greeting
      html += `<p class="m-date">${esc(b.date_label || '')}</p>`;
      html += `<h2 class="m-greeting">${esc(b.greeting || 'Good morning.')}</h2>`;

      // Health card
      html += `<div class="card">
        <div class="health-row">
          ${recoveryRingSvg(pct)}
          <div class="health-stats">
            <div class="metrics-grid">
              <div class="metric"><span class="metric-label">Sleep</span><span class="metric-val">${h.sleep_hours || 0}h · ${h.sleep_perf || 0}%</span></div>
              <div class="metric"><span class="metric-label">HRV</span><span class="metric-val">${h.hrv || 0}ms</span></div>
              <div class="metric"><span class="metric-label">RHR</span><span class="metric-val">${h.rhr || 0}bpm</span></div>
              <div class="metric"><span class="metric-label">Strain</span><span class="metric-val">${h.strain || 0}</span></div>
            </div>
            <p class="health-read">${esc(h.read || '')}</p>
          </div>
        </div>
      </div>`;

      // Insight card (populated by loadInsight())
      html += `<div class="card insight-card" id="insight-card">
        <div id="insight-bar-el" class="insight-bar"></div>
        <div class="insight-hdr">
          <div class="insight-hdr-left">
            <span class="insight-dot loading" id="insight-dot"></span>
            <span class="insight-lbl">Right now</span>
          </div>
        </div>
        <div id="insight-body">
          <div class="shimmer-line"></div>
          <div class="shimmer-line short"></div>
        </div>
      </div>`;

      // Day line + commitments
      if (b.day_line) {
        html += `<div class="card">
          <p class="day-line">${esc(b.day_line)}</p>`;
        if (b.commitments && b.commitments.length) {
          html += `<ul class="commitments">${b.commitments.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`;
        }
        if (b.week_ahead) {
          html += `<p style="font-size:11px;color:#71717a;margin-top:8px;line-height:1.5">${esc(b.week_ahead)}</p>`;
        }
        html += `</div>`;
      }

      // Morning Routine
      const routineItems = getRoutineItems();
      const routineChecks = getRoutineChecks();
      html += `<div class="card">
        <div class="section-lbl">Morning Routine</div>`;
      routineItems.forEach((item, idx) => {
        const checked = !!routineChecks[idx];
        html += `<div class="routine-row" onclick="toggleRoutine(${idx})" id="routine-row-${idx}">
          <span class="routine-circle${checked ? ' checked' : ''}" id="routine-circle-${idx}"></span>
          <span class="routine-label${checked ? ' done' : ''}" id="routine-label-${idx}">${esc(item)}</span>
        </div>`;
      });
      html += `</div>`;

      // Tasks
      if (b.tasks && b.tasks.length) {
        html += `<div class="card">
          <div class="section-lbl">Today's Priorities</div>`;
        b.tasks.forEach(t => {
          html += `<div class="task-row">
            <span class="task-dot"></span>
            <div class="task-info">
              <span class="task-text">${esc(t.text || '')}</span>
              ${t.detail ? `<span class="task-detail">${esc(t.detail)}</span>` : ''}
            </div>
          </div>`;
        });
        html += `</div>`;
      }

      // Personal items (if present)
      if (b.personal_items && b.personal_items.length) {
        html += `<div class="card list-card">
          <div class="section-lbl">Personal</div>
          <div class="list-items">${b.personal_items.map(i => `<div class="list-item">${esc(i)}</div>`).join('')}</div>
        </div>`;
      }

      // Agent moves (if present)
      if (b.agent_moves && b.agent_moves.length) {
        html += `<div class="card list-card">
          <div class="section-lbl">Agent moves</div>
          <div class="list-items">${b.agent_moves.map(m => `<div class="list-item">${esc(m)}</div>`).join('')}</div>
        </div>`;
      }

      // Win line (if present)
      if (b.win_line) {
        html += `<div class="card win-card">
          <div class="win-label">Win</div>
          <p class="win-text">${esc(b.win_line)}</p>
        </div>`;
      }

      // Agent note
      if (b.agent_note) {
        html += `<div class="card agent-note-card">
          <p class="agent-note-text">${esc(b.agent_note)}</p>
        </div>`;
      }

      html += `<div class="scroll-pad"></div>`;

      document.getElementById('morning-content').innerHTML = html;
      document.getElementById('morning-content').style.display = 'block';
    }

    function showMorningError(msg) {
      const content = document.getElementById('morning-content');
      content.innerHTML = `<div class="morning-state" style="min-height:260px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p style="color:#ef4444;font-size:13px">Briefing failed</p>
        <p style="font-size:11px;color:#71717a;max-width:260px;text-align:center;word-break:break-all">${esc(msg)}</p>
        <button onclick="loadMorning()" style="margin-top:4px;font-size:12px;color:#6366f1;background:none;border:none;cursor:pointer;text-decoration:underline">Try again</button>
      </div>`;
      content.style.display = 'block';
    }

    // ── Morning Routine ───────────────────────────────────────────────────────

    const ROUTINE_DEFAULT = ["Coffee","Breakfast / fuel","Plan / review the day","Reading (20 min)","Workout","Work block"];

    function getRoutineItems() {
      try {
        const raw = localStorage.getItem('antfarm-routine-items');
        if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) return p; }
      } catch {}
      const items = ROUTINE_DEFAULT.slice();
      localStorage.setItem('antfarm-routine-items', JSON.stringify(items));
      return items;
    }

    function getRoutineChecks() {
      const key = 'antfarm-routine-checks-' + new Date().toISOString().slice(0, 10);
      try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      } catch {}
      return {};
    }

    function setRoutineCheck(idx, checked) {
      const key = 'antfarm-routine-checks-' + new Date().toISOString().slice(0, 10);
      const checks = getRoutineChecks();
      checks[idx] = checked;
      localStorage.setItem(key, JSON.stringify(checks));
    }

    function toggleRoutine(idx) {
      const checks = getRoutineChecks();
      const nowChecked = !checks[idx];
      setRoutineCheck(idx, nowChecked);
      const circle = document.getElementById('routine-circle-' + idx);
      const label  = document.getElementById('routine-label-' + idx);
      if (circle) circle.classList.toggle('checked', nowChecked);
      if (label)  label.classList.toggle('done', nowChecked);
    }

    // ── Morning data fetching ─────────────────────────────────────────────────

    var _morningCallId = 0;
    var _morningErr = null;
    var _morningNeedsPlan = false;
    var _activeLoader = null;

    function loadMorning() {
      const content = document.getElementById('morning-content');
      content.style.display = 'none';
      content.innerHTML = '';

      if (_activeLoader) { _activeLoader.destroy(); _activeLoader = null; }

      _morningErr = null;
      _morningNeedsPlan = false;
      const callId = ++_morningCallId;

      fetch('/api/refresh-whoop', { method: 'POST', headers: authHeaders() }).catch(() => {});

      const wrap = document.getElementById('morning-loader-wrap');
      wrap.innerHTML = '';
      const loader = MorningLoader.mount(wrap, function() {
        _activeLoader = null;
        if (callId !== _morningCallId) return;
        if (_morningErr) {
          showMorningError(_morningErr);
        } else if (_morningNeedsPlan) {
          showMorningNeedsPlan();
        } else {
          renderBriefing(BRIEFING);
          document.getElementById('chat-send-btn').disabled = false;
          loadInsight();
        }
      });
      _activeLoader = loader;

      const now = encodeURIComponent(new Date().toLocaleString());
      fetch('/api/morning?now=' + now, { headers: authHeaders() })
        .then(r => r.text().then(text => {
          if (callId !== _morningCallId) return;
          if (!r.ok) throw new Error(text || 'HTTP ' + r.status);
          try {
            const quick = JSON.parse(text);
            if (quick && quick.needs_plan) { _morningNeedsPlan = true; loader.finish(); return; }
          } catch {}
          const b = parseBriefing(text);
          if (!b) throw new Error('Could not parse briefing JSON');
          BRIEFING = b;
          BRIEFING_JSON = JSON.stringify(b);
          loader.finish();
        }))
        .catch(e => {
          if (callId !== _morningCallId) return;
          _morningErr = e.message;
          loader.finish();
        });
    }

    function showMorningNeedsPlan() {
      const content = document.getElementById('morning-content');
      content.style.display = 'block';
      content.innerHTML = `
        <div style="max-width:420px;margin:40px auto;padding:32px 24px;border:1px solid #27272a;border-radius:16px;background:#18181b;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#52525b" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
          </svg>
          <div>
            <p style="font-size:15px;font-weight:600;color:#f4f4f5;margin:0 0 6px;">No plan locked for today</p>
            <p style="font-size:13px;color:#71717a;margin:0;max-width:260px;">Lock a plan the night before to get a focused morning briefing.</p>
          </div>
          <button onclick="autoplanMorning()" style="margin-top:4px;padding:10px 20px;border-radius:10px;background:#3f3f46;border:none;color:#e4e4e7;font-size:13px;font-weight:600;cursor:pointer;">Auto-plan from yesterday</button>
          <p style="font-size:11px;color:#52525b;margin:0;">To chat through tomorrow, open the desktop app.</p>
        </div>`;
    }

    async function autoplanMorning() {
      _morningNeedsPlan = false;
      const content = document.getElementById('morning-content');
      content.innerHTML = '';
      content.style.display = 'none';
      const now = encodeURIComponent(new Date().toLocaleString());
      const callId = ++_morningCallId;
      const wrap = document.getElementById('morning-loader-wrap');
      wrap.innerHTML = '';
      const loader = MorningLoader.mount(wrap, function() {
        _activeLoader = null;
        if (callId !== _morningCallId) return;
        if (_morningErr) { showMorningError(_morningErr); return; }
        renderBriefing(BRIEFING);
        document.getElementById('chat-send-btn').disabled = false;
        loadInsight();
      });
      _activeLoader = loader;
      fetch('/api/morning?now=' + now + '&force=true', { headers: authHeaders() })
        .then(r => r.text().then(text => {
          if (callId !== _morningCallId) return;
          if (!r.ok) throw new Error(text || 'HTTP ' + r.status);
          const b = parseBriefing(text);
          if (!b) throw new Error('Could not parse briefing JSON');
          BRIEFING = b;
          BRIEFING_JSON = JSON.stringify(b);
          loader.finish();
        }))
        .catch(e => {
          if (callId !== _morningCallId) return;
          _morningErr = e.message;
          loader.finish();
        });
    }

    async function loadInsight() {
      const doneSummary = 'Viewing morning briefing on phone. Time: ' + new Date().toLocaleTimeString() + '.';
      try {
        const r = await fetch('/api/morning-insight', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ doneSummary, now: new Date().toLocaleString() }),
        });
        const text = await r.text();
        if (!r.ok) return;
        const bodyEl = document.getElementById('insight-body');
        const dotEl  = document.getElementById('insight-dot');
        const barEl  = document.getElementById('insight-bar-el');
        if (bodyEl) { bodyEl.innerHTML = `<p class="insight-text insight-in">${esc(text)}</p>`; }
        if (dotEl) { dotEl.classList.remove('loading'); }
        if (barEl) { barEl.style.display = 'none'; }
      } catch { /* keep shimmer */ }
    }

    // ── Morning chat ──────────────────────────────────────────────────────────

    function toggleChat() {
      CHAT_OPEN = !CHAT_OPEN;
      document.getElementById('chat-body').classList.toggle('open', CHAT_OPEN);
      document.getElementById('chat-chevron').classList.toggle('open', CHAT_OPEN);
    }

    function renderChat() {
      const container = document.getElementById('chat-messages');
      const emptyEl   = document.getElementById('chat-empty');
      if (CHAT_MSGS.length === 0 && !CHAT_THINKING) {
        if (emptyEl) emptyEl.style.display = 'block';
        // remove any bubbles
        container.querySelectorAll('.msg-row,.typing-row').forEach(el => el.remove());
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      // rebuild messages
      const rows = container.querySelectorAll('.msg-row,.typing-row');
      rows.forEach(el => el.remove());
      CHAT_MSGS.forEach(m => {
        const div = document.createElement('div');
        div.className = 'msg-row ' + m.role;
        div.innerHTML = `<div class="bubble ${m.role}">${esc(m.text)}</div>`;
        container.appendChild(div);
      });
      if (CHAT_THINKING) {
        const div = document.createElement('div');
        div.className = 'msg-row agent typing-row';
        div.innerHTML = `<div class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
        container.appendChild(div);
      }
      container.scrollTop = container.scrollHeight;
    }

    let PENDING_PLAN = false;

    async function sendChat() {
      const input = document.getElementById('chat-input');
      const text  = (input.value || '').trim();
      if (!text || CHAT_THINKING || !BRIEFING_JSON) return;
      input.value = '';

      // open chat panel if closed
      if (!CHAT_OPEN) toggleChat();

      CHAT_MSGS.push({ role: 'user', text });
      CHAT_THINKING = true;
      renderChat();

      try {
        const r = await fetch('/api/assistant', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            now: new Date().toLocaleString(),
            dateKey: DATE_KEY,
            briefingJson: BRIEFING_JSON,
          }),
        });
        const body = await r.text();
        if (!r.ok) throw new Error(body || 'HTTP ' + r.status);
        const data = JSON.parse(body);
        CHAT_MSGS.push({ role: 'agent', text: data.reply });
        if (data.mode === 'plan_intent') {
          PENDING_PLAN = true;
          document.getElementById('voice-state-label').textContent = "Plan ready — say 'go' to launch";
        } else {
          PENDING_PLAN = false;
          if (data.mode !== 'chat') document.getElementById('voice-state-label').textContent = '';
        }
      } catch (e) {
        CHAT_MSGS.push({ role: 'error', text: e.message });
      }

      CHAT_THINKING = false;
      renderChat();
      setTimeout(() => input.focus(), 50);
    }

    // ── Morning status (top-right) ────────────────────────────────────────────

    function setNavStatus(text) {
      document.getElementById('nav-status').textContent = text;
    }

    // ── Agents view (existing logic) ──────────────────────────────────────────

    let AGENTS_LOADED = false;
    let ENTRIES = [];

    const CHIP = {
      running:     { bg: '#3730a3', fg: '#a5b4fc' },
      done:        { bg: '#14532d', fg: '#86efac' },
      failed:      { bg: '#7f1d1d', fg: '#fca5a5' },
      approved:    { bg: '#14532d', fg: '#86efac' },
      flagged:     { bg: '#78350f', fg: '#fcd34d' },
      blocked:     { bg: '#78350f', fg: '#fcd34d' },
      interrupted: { bg: '#27272a', fg: '#71717a' },
      conflict:    { bg: '#7f1d1d', fg: '#fca5a5' },
      accepted:    { bg: '#14532d', fg: '#6ee7b7' },
      rejected:    { bg: '#27272a', fg: '#71717a' },
      budget_skip: { bg: '#78350f', fg: '#fcd34d' },
    };

    function chipStyle(status) {
      const s = CHIP[status] || { bg: '#27272a', fg: '#71717a' };
      return `background:${s.bg};color:${s.fg}`;
    }

    function fmtCost(usd) {
      return (usd > 0.0001) ? '$' + usd.toFixed(4) : '—';
    }

    function render(plans) {
      const list = document.getElementById('list');
      ENTRIES = [];
      for (const plan of plans) {
        if (plan.planId.startsWith('dev-')) continue;
        for (const run of plan.runs) {
          ENTRIES.push({ planId: plan.planId, run, sortKey: plan.updatedAt || 0 });
        }
      }
      ENTRIES.sort((a, b) => b.sortKey - a.sortKey);

      if (ENTRIES.length === 0) {
        list.innerHTML = '<div class="empty">No agent runs yet.<br>Arm a night plan to start.</div>';
        return;
      }

      const DONE = new Set(['accepted', 'rejected', 'merged']);
      list.innerHTML = ENTRIES.map(({ run }, i) => {
        const label = run.status.replace(/_/g, ' ');
        const reviewBlock = run.reviewNotes
          ? `<div class="reviewer"><b>Reviewer:</b> ${esc(run.reviewNotes)}</div>` : '';
        const actionable = run.worktree && !DONE.has(run.status);
        const actionsBlock = actionable ? `
          <div class="actions">
            <button class="btn btn-merge" onclick="event.stopPropagation();mergeRun(${i})">Merge</button>
            <button class="btn btn-toss"  onclick="event.stopPropagation();tossRun(${i})">Toss</button>
          </div>` : '';
        return `<div class="run-card" onclick="showDiff(${i})">
          <div class="goal">${esc(run.goal || 'Untitled run')}</div>
          ${run.summary ? `<div class="summary">${esc(run.summary)}</div>` : ''}
          ${reviewBlock}
          <div class="meta">
            <span class="chip" style="${chipStyle(run.status)}">${esc(label)}</span>
            <span class="cost">${fmtCost(run.costUsd)}</span>
          </div>
          <div class="run-id">${esc(run.runId)}</div>
          ${actionsBlock}
        </div>`;
      }).join('');
    }

    async function fetchRuns() {
      try {
        const r = await fetch('/api/runs', { headers: authHeaders() });
        if (!r.ok) { setNavStatus('auth err'); return; }
        render(await r.json());
        if (CURRENT_VIEW === 'agents') setNavStatus(new Date().toLocaleTimeString());
      } catch { setNavStatus('error'); }
    }

    async function showDiff(i) {
      const { planId, run } = ENTRIES[i];
      document.getElementById('ov-title').textContent = run.goal || run.runId;
      document.getElementById('ov-pre').textContent = 'Loading…';
      document.getElementById('overlay').classList.add('open');
      try {
        const url = '/api/diff?plan=' + encodeURIComponent(planId) + '&run=' + encodeURIComponent(run.runId);
        const r = await fetch(url, { headers: authHeaders() });
        document.getElementById('ov-pre').textContent = (await r.text()) || 'No diff available.';
      } catch (e) {
        document.getElementById('ov-pre').textContent = 'Error: ' + e.message;
      }
    }

    function closeDiff() {
      document.getElementById('overlay').classList.remove('open');
    }

    async function mergeRun(i) {
      const { planId, run } = ENTRIES[i];
      if (!window.confirm('Merge this run to main?')) return;
      const url = '/api/merge?plan=' + encodeURIComponent(planId) + '&run=' + encodeURIComponent(run.runId);
      try {
        const r = await fetch(url, { method: 'POST', headers: authHeaders() });
        const text = await r.text();
        if (!r.ok) { alert(text); return; }
        fetchRuns();
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function tossRun(i) {
      const { planId, run } = ENTRIES[i];
      if (!window.confirm('Toss this run?')) return;
      const url = '/api/toss?plan=' + encodeURIComponent(planId) + '&run=' + encodeURIComponent(run.runId);
      try {
        const r = await fetch(url, { method: 'POST', headers: authHeaders() });
        const text = await r.text();
        if (!r.ok) { alert(text); return; }
        fetchRuns();
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function fetchProjects() {
      try {
        const r = await fetch('/api/projects', { headers: authHeaders() });
        if (!r.ok) return;
        const projs = await r.json();
        const sel = document.getElementById('author-project');
        projs.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.path; opt.textContent = p.name; sel.appendChild(opt);
        });
      } catch { /* ignore */ }
    }

    function updateGenerateBtn() {
      const desc = document.getElementById('author-desc').value.trim();
      const proj = document.getElementById('author-project').value;
      const path = document.getElementById('author-path').value.trim();
      document.getElementById('btn-generate').disabled = !desc || (!proj && !path);
    }

    document.getElementById('author-desc').addEventListener('input', updateGenerateBtn);
    document.getElementById('author-project').addEventListener('change', updateGenerateBtn);
    document.getElementById('author-path').addEventListener('input', updateGenerateBtn);

    async function generatePlan() {
      const desc = document.getElementById('author-desc').value.trim();
      const proj = document.getElementById('author-project').value;
      const manualPath = document.getElementById('author-path').value.trim();
      const projectPath = proj || manualPath;
      if (!desc || !projectPath) return;
      const btn = document.getElementById('btn-generate');
      btn.disabled = true; btn.textContent = 'Generating… (~30s)';
      document.getElementById('author-result-area').innerHTML = '';
      try {
        const r = await fetch('/api/author', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: desc, projectPath }),
        });
        const text = await r.text();
        if (!r.ok) {
          document.getElementById('author-result-area').innerHTML =
            `<div class="author-result"><div class="author-errors"><div>${esc(text)}</div></div></div>`;
          return;
        }
        renderAuthorResult(JSON.parse(text));
      } catch (e) {
        document.getElementById('author-result-area').innerHTML =
          `<div class="author-result"><div class="author-errors"><div>${esc(e.message)}</div></div></div>`;
      } finally {
        btn.textContent = 'Generate plan'; updateGenerateBtn();
      }
    }

    function renderAuthorResult(result) {
      const v = result.validation, s = v.summary;
      let html = '<div class="author-result">';
      html += `<div style="font-size:11px;font-weight:600;color:#a1a1aa;margin-bottom:8px">${esc(s.planId)} · ${s.runCount} run${s.runCount !== 1 ? 's' : ''} · $${s.perNightUsd ? s.perNightUsd.toFixed(2) : '?'} night cap</div>`;
      if (v.errors && v.errors.length) html += `<div class="author-errors">${v.errors.map(e => `<div>${esc(e)}</div>`).join('')}</div>`;
      if (v.warnings && v.warnings.length) html += `<div class="author-warnings">${v.warnings.map(w => `<div>${esc(w)}</div>`).join('')}</div>`;
      if (s.runs && s.runs.length) {
        s.runs.forEach(run => {
          html += `<div class="author-run"><div class="author-run-goal">${esc(run.goal)}</div><div class="author-run-meta">${esc(run.projectPath)}${run.pathExists ? (run.isGit ? ' · git' : ' · no git') : ' · ⚠ missing'}</div></div>`;
        });
      }
      if (v.ok) {
        const ep = result.planPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += `<button class="btn-arm" style="margin-top:10px" onclick="armAuthoredPlan('${ep}')">Arm &amp; start</button>`;
      }
      html += '</div>';
      document.getElementById('author-result-area').innerHTML = html;
    }

    async function armAuthoredPlan(planPath) {
      if (!window.confirm('Arm and start this plan?')) return;
      try {
        const r = await fetch('/api/arm', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: planPath }),
        });
        const text = await r.text();
        if (!r.ok) { alert('Error: ' + text); return; }
        document.getElementById('author-result-area').innerHTML = '';
        document.getElementById('author-desc').value = '';
        document.getElementById('author-project').selectedIndex = 0;
        document.getElementById('author-path').value = '';
        updateGenerateBtn();
        alert('Armed! Plan started.'); fetchRuns(); fetchPlans();
      } catch (e) { alert('Error: ' + e.message); }
    }

    async function fetchPlans() {
      try {
        const r = await fetch('/api/plans', { headers: authHeaders() });
        if (!r.ok) return;
        renderPlans(await r.json());
      } catch { /* ignore */ }
    }

    function renderPlans(plans) {
      const el = document.getElementById('plans-list');
      if (!plans || plans.length === 0) {
        el.innerHTML = '<div style="font-size:12px;color:#3f3f46;padding:8px 0;">No authored plans found.</div>';
        return;
      }
      el.innerHTML = plans.map((p, i) => `
        <div class="plan-card">
          <div class="plan-goal">${esc(p.goalPreview || p.planId)}</div>
          <div class="plan-meta">${p.runCount} run${p.runCount !== 1 ? 's' : ''} · $${p.perNightUsd ? p.perNightUsd.toFixed(2) : '?'} night cap${p.ok ? '' : ' · <span style="color:#fca5a5">invalid</span>'}</div>
          <button class="btn-arm" onclick="armPlan(${i})" ${p.ok ? '' : 'disabled style="opacity:0.4"'}>Arm &amp; start</button>
        </div>
      `).join('');
      window._afPlans = plans;
    }

    async function armPlan(i) {
      const p = window._afPlans && window._afPlans[i];
      if (!p) return;
      if (!window.confirm('Arm and start this plan?')) return;
      try {
        const r = await fetch('/api/arm', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p.path }),
        });
        const text = await r.text();
        if (!r.ok) { alert('Error: ' + text); return; }
        alert('Armed! Plan started.'); fetchRuns();
      } catch (e) { alert('Error: ' + e.message); }
    }

    // ── Voice (Press-to-Talk) ─────────────────────────────────────────────────

    let _voiceState = 'idle'; // 'idle' | 'recording' | 'transcribing' | 'speaking'
    let _mediaRecorder = null;
    let _audioChunks = [];
    let _currentAudio = null;

    function setVoiceState(state) {
      _voiceState = state;
      const btn = document.getElementById('mic-btn');
      const lbl = document.getElementById('voice-state-label');
      if (!btn) return;
      btn.classList.remove('recording', 'transcribing', 'speaking');
      if (state === 'recording') {
        btn.classList.add('recording');
        if (lbl) lbl.textContent = 'recording…';
      } else if (state === 'transcribing') {
        btn.classList.add('transcribing');
        if (lbl) lbl.textContent = 'transcribing…';
      } else if (state === 'speaking') {
        btn.classList.add('speaking');
        if (lbl) lbl.textContent = 'speaking…';
      } else {
        if (lbl) lbl.textContent = '';
      }
    }

    function initVoice() {
      if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      const btn = document.getElementById('mic-btn');
      if (btn) btn.style.display = 'flex';
    }

    async function toggleMic() {
      if (_voiceState === 'speaking') { stopVoicePlayback(); return; }
      if (_voiceState === 'transcribing') return;
      if (_voiceState === 'recording') { if (_mediaRecorder) _mediaRecorder.stop(); return; }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (_) {
        const lbl = document.getElementById('voice-state-label');
        if (lbl) { lbl.textContent = 'mic denied — type instead'; setTimeout(() => { lbl.textContent = ''; }, 3000); }
        return;
      }

      _audioChunks = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      _mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      _mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) _audioChunks.push(e.data); };
      _mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        handleRecordingDone();
      };
      _mediaRecorder.start();
      setVoiceState('recording');
    }

    async function handleRecordingDone() {
      setVoiceState('transcribing');
      const mimeType = (_audioChunks[0] && _audioChunks[0].type) || 'audio/webm';
      const blob = new Blob(_audioChunks, { type: mimeType });
      _audioChunks = [];

      let transcript = '';
      try {
        const fd = new FormData();
        fd.append('file', blob, 'audio.webm');
        const r = await fetch('/api/stt', { method: 'POST', headers: authHeaders(), body: fd });
        if (!r.ok) throw new Error(await r.text());
        transcript = ((await r.json()).text || '').trim();
      } catch (e) {
        setVoiceState('idle');
        const lbl = document.getElementById('voice-state-label');
        if (lbl) { lbl.textContent = 'transcription failed'; setTimeout(() => { lbl.textContent = ''; }, 3000); }
        return;
      }

      if (!transcript) { setVoiceState('idle'); return; }

      // Put in input box for visibility then send
      const inp = document.getElementById('chat-input');
      if (inp) inp.value = transcript;
      setVoiceState('idle');
      await sendChatVoice(transcript);
    }

    async function sendChatVoice(text) {
      if (!text.trim() || CHAT_THINKING || !BRIEFING_JSON) return;
      if (!CHAT_OPEN) toggleChat();
      const inp = document.getElementById('chat-input');
      if (inp) inp.value = '';

      CHAT_MSGS.push({ role: 'user', text });
      CHAT_THINKING = true;
      renderChat();

      let replyText = '';
      try {
        const r = await fetch('/api/assistant', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, now: new Date().toLocaleString(), dateKey: DATE_KEY, briefingJson: BRIEFING_JSON }),
        });
        const body = await r.text();
        if (!r.ok) throw new Error(body || 'HTTP ' + r.status);
        const data = JSON.parse(body);
        replyText = data.reply;
        CHAT_MSGS.push({ role: 'agent', text: replyText });
        const lbl = document.getElementById('voice-state-label');
        if (data.mode === 'plan_intent') {
          PENDING_PLAN = true;
          _lastReplyVoice = VOICE_JARVIS;
          lbl.textContent = "Plan ready — say 'go' to launch";
        } else if (data.mode === 'launched') {
          PENDING_PLAN = false;
          _lastReplyVoice = VOICE_DISPATCH;
          lbl.textContent = '';
        } else {
          PENDING_PLAN = false;
          _lastReplyVoice = VOICE_JARVIS;
        }
      } catch (e) {
        CHAT_MSGS.push({ role: 'error', text: e.message });
        CHAT_THINKING = false;
        renderChat();
        return;
      }
      CHAT_THINKING = false;
      renderChat();

      if (replyText) await playVoiceTTS(replyText, _lastReplyVoice);
    }

    const VOICE_JARVIS   = 'ash';
    const VOICE_DISPATCH = 'onyx';
    let _lastReplyVoice  = VOICE_JARVIS;

    const TTS_CHUNK_CHARS = 600;

    function splitTtsChunks(text) {
      if (text.length <= TTS_CHUNK_CHARS) return [text];
      const chunks = [];
      // Split on sentence boundaries; keep the delimiter with preceding text
      const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
      let current = '';
      for (const s of sentences) {
        if ((current + s).length > TTS_CHUNK_CHARS && current) {
          chunks.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim()) chunks.push(current.trim());
      return chunks;
    }

    async function fetchTtsBlob(text, voice) {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });
      if (!r.ok) throw new Error(await r.text() || 'TTS HTTP ' + r.status);
      return r.blob();
    }

    async function playBlob(blob) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        _currentAudio = new Audio(url);
        _currentAudio.onended  = () => { URL.revokeObjectURL(url); _currentAudio = null; resolve(); };
        _currentAudio.onerror  = () => { URL.revokeObjectURL(url); _currentAudio = null; reject(new Error('audio error')); };
        _currentAudio.play().catch(reject);
      });
    }

    async function playVoiceTTS(text, voice = VOICE_JARVIS) {
      if (!text.trim()) return;
      setVoiceState('speaking');
      const chunks = splitTtsChunks(text);
      try {
        for (const chunk of chunks) {
          if (_voiceState !== 'speaking') break; // stopped by tap
          const blob = await fetchTtsBlob(chunk, voice);
          if (_voiceState !== 'speaking') break;
          await playBlob(blob);
        }
      } catch (_) { /* ignore — user may have tapped to stop */ }
      if (_voiceState === 'speaking') setVoiceState('idle');
    }

    function stopVoicePlayback() {
      if (_currentAudio) { _currentAudio.pause(); _currentAudio = null; }
      setVoiceState('idle');
    }

    // Tap anywhere outside mic button to stop playback
    document.addEventListener('click', function(e) {
      if (_voiceState !== 'speaking') return;
      const btn = document.getElementById('mic-btn');
      if (!btn || !btn.contains(e.target)) stopVoicePlayback();
    }, true);

    // ── Realtime voice (WebRTC) ───────────────────────────────────────────────

    let _RT = {
      pc: null, dc: null, stream: null, audioCtx: null,
      micAn: null, outAn: null, orbState: 'idle',
      sessionStart: null, timerInterval: null, orbRaf: null,
      captionsOn: false, pendingDispatch: null, micFreqBuf: null, outFreqBuf: null,
      lastAudioTs: 0, idleTimer: null,
    };

    function setOrbState(s) {
      _RT.orbState = s;
      const dot  = document.getElementById('voice-dot');
      const text = document.getElementById('voice-state-text');
      if (dot) {
        dot.className = s === 'live' || s === 'listening' || s === 'speaking' ? 'live'
                      : s === 'connecting' ? 'connecting' : '';
      }
      const STATUS = document.getElementById('voice-status-text');
      if (STATUS) STATUS.textContent =
        s === 'connecting' ? 'connecting' : s === 'listening' ? 'live' :
        s === 'thinking'   ? 'live'       : s === 'speaking'  ? 'live' : 'ready';
      if (text) text.textContent =
        s === 'connecting' ? 'CONNECTING...' : s === 'listening' ? 'LISTENING' :
        s === 'thinking'   ? 'THINKING...'   : s === 'speaking'  ? 'SPEAKING' : '';
    }

    function rtDebug(msg) {
      const el = document.getElementById('rt-debug');
      if (el) el.textContent = msg;
    }

    async function openVoiceOverlay(mode) {
      // AudioContext MUST be created + resumed synchronously in the user gesture
      // (before any await) — iOS Safari permanently suspends it otherwise.
      if (!_RT.audioCtx || _RT.audioCtx.state === 'closed') {
        _RT.audioCtx = new AudioContext();
      }
      _RT.audioCtx.resume(); // fire-and-forget; unlocks hardware audio on iOS

      // Pre-create the remote <audio> element and call .play() here in the gesture
      // so iOS grants it autoplay permission for when the remote track arrives.
      let remoteAudio = document.getElementById('rt-remote-audio');
      if (!remoteAudio) {
        remoteAudio = document.createElement('audio');
        remoteAudio.id = 'rt-remote-audio';
        remoteAudio.autoplay = true;
        remoteAudio.setAttribute('playsinline', '');
        document.body.appendChild(remoteAudio);
      }
      remoteAudio.play().catch(() => {}); // unlock audio session in gesture

      const ov = document.getElementById('voice-overlay');
      ov.classList.add('active');
      requestAnimationFrame(() => ov.classList.add('visible'));
      startOrbCanvas();
      rtDebug('connecting...');
      await connectRealtime(mode || 'morning');
    }

    function closeVoiceOverlay() {
      stopRealtime();
      stopOrbCanvas();
      const ov = document.getElementById('voice-overlay');
      ov.classList.remove('visible');
      setTimeout(() => ov.classList.remove('active'), 320);
      setOrbState('idle');
    }

    function toggleCaptions() {
      _RT.captionsOn = !_RT.captionsOn;
      const cap = document.getElementById('voice-captions');
      const btn = document.getElementById('voice-captions-btn');
      if (cap) cap.classList.toggle('shown', _RT.captionsOn);
      if (btn) btn.classList.toggle('on', _RT.captionsOn);
    }

    function updateCaptions(text) {
      if (!_RT.captionsOn) return;
      const el = document.getElementById('voice-captions');
      if (el) el.textContent = text;
    }

    async function connectRealtime(mode) {
      _RT.lastAudioTs = Date.now();
      setOrbState('connecting');
      // 1. Mint ephemeral token
      let token, model;
      try {
        const r = await fetch('/api/realtime-token', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: mode || 'morning' }),
        });
        if (!r.ok) throw new Error(await r.text());
        const d = await r.json();
        token = d.token; model = d.model;
        rtDebug('token ok · model: ' + model);
      } catch (e) {
        setOrbState('idle');
        document.getElementById('voice-status-text').textContent = 'token failed: ' + e.message;
        rtDebug('token failed: ' + e.message);
        return;
      }
      // 2. Mic — getUserMedia is safe after awaits inside a user-gesture async chain
      try {
        _RT.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const trk = _RT.stream.getAudioTracks()[0];
        rtDebug('mic: ' + (trk ? trk.readyState + ' en=' + trk.enabled : 'no track'));
      } catch (e) {
        setOrbState('idle');
        document.getElementById('voice-status-text').textContent = 'mic denied';
        rtDebug('mic denied: ' + e.message);
        return;
      }
      // 3. Wire mic → analyser (AudioContext already created + resumed in openVoiceOverlay)
      const micSrc = _RT.audioCtx.createMediaStreamSource(_RT.stream);
      _RT.micAn = _RT.audioCtx.createAnalyser(); _RT.micAn.fftSize = 256;
      _RT.micFreqBuf = new Uint8Array(_RT.micAn.frequencyBinCount);
      micSrc.connect(_RT.micAn); // NOT to destination — avoids mic feedback loop
      rtDebug('mic wired · ctx: ' + _RT.audioCtx.state);
      // 4. RTCPeerConnection
      _RT.pc = new RTCPeerConnection();
      _RT.pc.ontrack = (e) => {
        const s = e.streams[0]; if (!s) return;
        // <audio> element handles remote playback — required for iOS Safari autoplay
        let remoteAudio = document.getElementById('rt-remote-audio');
        if (!remoteAudio) {
          remoteAudio = document.createElement('audio');
          remoteAudio.id = 'rt-remote-audio';
          remoteAudio.autoplay = true;
          remoteAudio.setAttribute('playsinline', '');
          document.body.appendChild(remoteAudio);
        }
        remoteAudio.srcObject = s;
        remoteAudio.play().catch(() => {});
        // Also wire to analyser for orb reactivity (audio element plays, not destination)
        if (_RT.audioCtx && _RT.audioCtx.state !== 'closed') {
          const outSrc = _RT.audioCtx.createMediaStreamSource(s);
          _RT.outAn = _RT.audioCtx.createAnalyser(); _RT.outAn.fftSize = 256;
          _RT.outFreqBuf = new Uint8Array(_RT.outAn.frequencyBinCount);
          outSrc.connect(_RT.outAn);
        }
        rtDebug('remote track received');
      };
      // 5. Add mic track BEFORE creating offer
      for (const track of _RT.stream.getTracks()) _RT.pc.addTrack(track, _RT.stream);
      // 6. Data channel
      _RT.dc = _RT.pc.createDataChannel('oai-events');
      _RT.dc.onopen = () => {
        setOrbState('listening');
        _RT.lastAudioTs = Date.now();
        _RT.sessionStart = Date.now();
        startSessionTimer();
        rtDebug('dc open · ctx: ' + _RT.audioCtx.state);
        _RT.idleTimer = setInterval(() => {
          if (Date.now() - _RT.lastAudioTs > 40000) {
            const s = document.getElementById('voice-status-text');
            if (s) s.textContent = 'ended (idle)';
            const t = document.getElementById('voice-state-text');
            if (t) t.textContent = '';
            setTimeout(() => stopRealtime(), 1800);
          }
        }, 10000);
      };
      _RT.dc.onmessage = (e) => { try { handleRealtimeEvent(JSON.parse(e.data)); } catch {} };
      _RT.dc.onclose = () => setOrbState('idle');
      // 7. SDP exchange
      const offer = await _RT.pc.createOffer();
      await _RT.pc.setLocalDescription(offer);
      try {
        const sdpR = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/sdp' },
          body: offer.sdp,
        });
        if (!sdpR.ok) throw new Error(await sdpR.text());
        await _RT.pc.setRemoteDescription({ type: 'answer', sdp: await sdpR.text() });
        rtDebug('sdp negotiated');
      } catch (e) {
        document.getElementById('voice-status-text').textContent = 'WebRTC failed';
        rtDebug('sdp error: ' + e.message);
        stopRealtime();
      }
    }

    function handleRealtimeEvent(evt) {
      switch (evt.type) {
        case 'input_audio_buffer.speech_started':   _RT.lastAudioTs = Date.now(); setOrbState('listening'); rtDebug('vad: speech'); break;
        case 'response.audio.delta':                _RT.lastAudioTs = Date.now(); setOrbState('speaking');  break;
        case 'response.audio.done':                 setOrbState('listening'); break;
        case 'response.function_call_arguments.done':
          setOrbState('thinking');
          handleToolCall(evt.name, (() => { try { return JSON.parse(evt.arguments || '{}'); } catch { return {}; } })(), evt.call_id);
          break;
        case 'response.done':
          if (_RT.orbState !== 'thinking') setOrbState('listening');
          const tx = evt.response?.output?.[0]?.content?.[0]?.transcript;
          if (tx) updateCaptions(tx);
          break;
      }
    }

    function sendRT(obj) {
      if (_RT.dc && _RT.dc.readyState === 'open') _RT.dc.send(JSON.stringify(obj));
    }

    async function handleToolCall(name, args, callId) {
      let result = 'ok';
      try {
        if (name === 'get_brief') {
          const r = await fetch('/api/morning', { headers: authHeaders() });
          result = r.ok ? (await r.text()).slice(0, 2000) : 'brief unavailable';
        } else if (name === 'draft_dispatch') {
          const r = await fetch('/api/assistant', {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: args.task || '', now: new Date().toLocaleString(), dateKey: DATE_KEY, briefingJson: BRIEFING_JSON || '{}' }),
          });
          const d = await r.json();
          _RT.pendingDispatch = d;
          result = d.reply || 'Plan drafted.';
        } else if (name === 'launch_dispatch') {
          if (!_RT.pendingDispatch) { result = 'No plan drafted yet. Use draft_dispatch first.'; }
          else {
            const r = await fetch('/api/assistant', {
              method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: 'go', now: new Date().toLocaleString(), dateKey: DATE_KEY, briefingJson: BRIEFING_JSON || '{}' }),
            });
            const d = await r.json();
            _RT.pendingDispatch = null;
            result = d.reply || "Running.";
          }
        } else if (name === 'lock_tomorrow_plan') {
          const r = await fetch('/api/lock-plan', {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: '{}',
          });
          result = r.ok ? 'Plan locked. Tomorrow is set.' : 'Failed to lock: ' + (await r.text());
        }
      } catch (e) { result = 'Error: ' + e.message; }
      sendRT({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: result } });
      sendRT({ type: 'response.create' });
      if (_RT.orbState === 'thinking') setOrbState('listening');
    }

    function stopRealtime() {
      if (_RT.idleTimer)     { clearInterval(_RT.idleTimer);     _RT.idleTimer = null; }
      if (_RT.timerInterval) { clearInterval(_RT.timerInterval); _RT.timerInterval = null; }
      if (_RT.dc)     { try { _RT.dc.close();  } catch {} _RT.dc = null; }
      if (_RT.pc)     { try { _RT.pc.close();  } catch {} _RT.pc = null; }
      if (_RT.stream) { _RT.stream.getTracks().forEach(t => t.stop()); _RT.stream = null; }
      if (_RT.audioCtx) { try { _RT.audioCtx.close(); } catch {} _RT.audioCtx = null; }
      _RT.micAn = null; _RT.outAn = null; _RT.sessionStart = null; _RT.pendingDispatch = null;
      const remoteAudio = document.getElementById('rt-remote-audio');
      if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); }
      const t = document.getElementById('voice-timer'); if (t) t.textContent = '';
      const c = document.getElementById('voice-cost');  if (c) c.textContent = '';
      rtDebug('');
    }

    function startSessionTimer() {
      const tEl = document.getElementById('voice-timer');
      const cEl = document.getElementById('voice-cost');
      _RT.timerInterval = setInterval(() => {
        if (!_RT.sessionStart) return;
        const sec = Math.floor((Date.now() - _RT.sessionStart) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        if (tEl) tEl.textContent = m + ':' + s;
        // gpt-4o-mini-realtime: ~$0.06/min audio in + $0.024/min audio out ≈ $0.084/min
        if (cEl) cEl.textContent = ' · ~$' + ((sec / 60) * 0.084).toFixed(3);
      }, 1000);
    }

    // ── Orb particle canvas ───────────────────────────────────────────────────

    function startOrbCanvas() {
      const cv = document.getElementById('orb-canvas');
      if (!cv) return;
      const DPR = Math.min(window.devicePixelRatio || 1, 2);
      const SZ = Math.min(window.innerWidth, window.innerHeight, 320);
      cv.style.width = SZ + 'px'; cv.style.height = SZ + 'px';
      cv.width = SZ * DPR; cv.height = SZ * DPR;
      const ctx = cv.getContext('2d');
      ctx.scale(DPR, DPR);
      const W = SZ, H = SZ, CX = W / 2, CY = H / 2;
      const N = 1000, R = SZ * 0.34, FOCAL = 380;

      // Build fibonacci sphere
      const sph = [];
      for (let i = 0; i < N; i++) {
        const ph = Math.acos(1 - 2 * (i + 0.5) / N);
        const th = Math.PI * (1 + Math.sqrt(5)) * i;
        sph.push([Math.cos(th) * Math.sin(ph) * R, Math.sin(th) * Math.sin(ph) * R, Math.cos(ph) * R]);
      }
      const PX = new Float32Array(N), PY = new Float32Array(N);
      for (let i = 0; i < N; i++) { PX[i] = CX + sph[i][0]; PY[i] = CY + sph[i][1]; }
      const PS = new Float32Array(N).map(() => 0.45 + Math.random() * 0.55);

      let ang = 0, breath = 0;

      function getAmp(an, buf) {
        if (!an || !buf) return 0;
        an.getByteFrequencyData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i];
        return s / (buf.length * 255);
      }

      function rot(x, y, z, ax, ay) {
        const cy = Math.cos(ay), sy = Math.sin(ay);
        const X = x * cy - z * sy, Z = x * sy + z * cy;
        const cx = Math.cos(ax), sx = Math.sin(ax);
        return [X, y * cx - Z * sx, y * sx + Z * cx];
      }

      function frame() {
        const st = _RT.orbState;
        let rsp = 0.004, bsp = 0.007, bamp = 0.05, swirl = 0;
        if      (st === 'connecting') { rsp = 0.003; bsp = 0.005; bamp = 0.03; }
        else if (st === 'listening')  { rsp = 0.007; bsp = 0.014; bamp = 0.09; }
        else if (st === 'thinking')   { rsp = 0.020; bsp = 0.030; bamp = 0.04; swirl = 0.18; }
        else if (st === 'speaking')   { rsp = 0.009; bsp = 0.022; bamp = 0.07; }

        ang += rsp; breath += bsp;
        const micAmp = getAmp(_RT.micAn, _RT.micFreqBuf);
        const outAmp = getAmp(_RT.outAn, _RT.outFreqBuf);
        const reactAmp = st === 'listening' ? micAmp : st === 'speaking' ? outAmp : 0;
        const scale = 1 + Math.sin(breath) * bamp + reactAmp * 0.35;
        const sw = swirl ? Math.sin(breath * 2) * swirl : 0;

        ctx.clearRect(0, 0, W, H);
        for (let i = 0; i < N; i++) {
          const base = sph[i];
          const rp = rot(base[0] * scale, base[1] * scale, base[2] * scale, ang * 0.38 + sw, ang);
          const depth = FOCAL / (FOCAL - rp[2]);
          const px = CX + rp[0] * depth, py = CY + rp[1] * depth;
          const bright = Math.min(0.92, 0.35 + depth * 0.28 + reactAmp * 0.45);
          ctx.beginPath();
          ctx.arc(px, py, PS[i] * depth * 0.65, 0, 6.2832);
          ctx.fillStyle = 'rgba(124,151,232,' + bright.toFixed(2) + ')';
          ctx.fill();
        }
        _RT.orbRaf = requestAnimationFrame(frame);
      }
      frame();
    }

    function stopOrbCanvas() {
      if (_RT.orbRaf) { cancelAnimationFrame(_RT.orbRaf); _RT.orbRaf = null; }
      const cv = document.getElementById('orb-canvas');
      if (cv) { const ctx = cv.getContext('2d'); if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    loadMorning();
    initVoice();
    // agents view polls lazily (only starts when switched to)
    // but keep background poll running for badge-style awareness
    setInterval(() => {
      if (AGENTS_LOADED) fetchRuns();
    }, 10000);
  </script>
</body>
</html>
"###;

// ── Server ────────────────────────────────────────────────────────────────────

// ── Realtime voice session ────────────────────────────────────────────────────

fn read_brief_context() -> String {
    let brain = brain_path();
    let mut ctx = String::new();
    let brief_path = format!("{}/active/today-brief.json", brain);
    if let Ok(raw) = std::fs::read_to_string(&brief_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(briefing) = v.get("briefing") {
                ctx.push_str("TODAY'S BRIEFING:\n");
                ctx.push_str(&briefing.to_string());
                ctx.push_str("\n\n");
            }
        }
    }
    let plan_path = format!("{}/active/tomorrow-plan.md", brain);
    if let Ok(plan) = std::fs::read_to_string(&plan_path) {
        ctx.push_str("TOMORROW'S PLAN:\n");
        ctx.push_str(&plan);
        ctx.push('\n');
    }
    ctx
}

fn realtime_session_body(brief_ctx: &str, mode: &str) -> serde_json::Value {
    let instructions = match mode {
        "morning" => format!(
            "It's morning. Tell Connor what to work on today and WHY, fold in insights from \
his recovery and locked plan, react to what he's done, and name the highest-leverage move. \
Warm, sharp, no em dashes.\n\n{brief_ctx}"
        ),
        "night" => format!(
            "It's night. Be Connor's planning partner: ask sharp questions, push him to decide \
tomorrow's one big rock and commitments, then when it's set, lock it in with lock_tomorrow_plan. \
No em dashes.\n\n{brief_ctx}"
        ),
        _ => format!(
            "You are Captain Jack, Connor's sharp chief of staff and AI operating partner. \
Warm, decisive, concise. No em dashes. No bullet walls. Short punchy sentences. \
You know Connor's day cold and can dispatch coding agents to his projects.\n\n\
ALWAYS confirm before calling launch_dispatch. Say exactly what you will do and \
wait for a clear go before launching. Drafting is cheap; launching spends real money \
and writes real code.\n\n{brief_ctx}"
        ),
    };

    let base_tools = serde_json::json!([
        {
            "type": "function",
            "name": "get_brief",
            "description": "Return today's morning brief and tomorrow's plan as text.",
            "parameters": { "type": "object", "properties": {} }
        },
        {
            "type": "function",
            "name": "draft_dispatch",
            "description": "Draft an autonomous agent coding task for one of Connor's repos. Returns a plan summary. Always call this before launch_dispatch.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "Concrete coding task for the agent to implement" }
                },
                "required": ["task"]
            }
        },
        {
            "type": "function",
            "name": "launch_dispatch",
            "description": "Arm and run the previously drafted plan. Only call after Connor explicitly says go.",
            "parameters": { "type": "object", "properties": {} }
        }
    ]);

    let mut tools = base_tools.as_array().cloned().unwrap_or_default();
    if mode == "night" {
        tools.push(serde_json::json!({
            "type": "function",
            "name": "lock_tomorrow_plan",
            "description": "Lock and save tomorrow's plan once Connor confirms it's ready. Call this when Connor says to lock it in.",
            "parameters": { "type": "object", "properties": {} }
        }));
    }

    serde_json::json!({
        "session": {
            "type": "realtime",
            "model": "gpt-realtime",
            "audio": { "output": { "voice": "ash" } },
            "instructions": instructions,
            "tools": tools,
            "tool_choice": "auto"
        }
    })
}

fn call_openai_realtime_session(api_key: &str, brief_ctx: &str, mode: &str) -> Result<serde_json::Value, String> {
    let body = realtime_session_body(brief_ctx, mode);
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/realtime/client_secrets")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .map_err(|e| format!("realtime session request: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status().as_u16();
        let t = resp.text().unwrap_or_default();
        return Err(format!("OpenAI realtime HTTP {s}: {t}"));
    }
    resp.json::<serde_json::Value>().map_err(|e| format!("parse realtime session: {e}"))
}

fn extract_realtime_token_response(raw: serde_json::Value) -> String {
    let nested = raw.get("session");
    // GA client_secrets: top-level "value"; fallback to older shapes
    let token = raw.get("value")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("client_secret").and_then(|cs| cs.get("value")).and_then(|v| v.as_str()))
        .or_else(|| nested.and_then(|s| s.get("client_secret")).and_then(|cs| cs.get("value")).and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();
    eprintln!("[realtime-token] extracted token prefix: {}", &token.chars().take(6).collect::<String>());
    let model = raw.get("model")
        .or_else(|| nested.and_then(|s| s.get("model")))
        .and_then(|m| m.as_str())
        .unwrap_or("gpt-realtime")
        .to_string();
    let session_id = raw.get("id")
        .or_else(|| nested.and_then(|s| s.get("id")))
        .and_then(|i| i.as_str())
        .unwrap_or_default()
        .to_string();
    serde_json::json!({ "token": token, "model": model, "session_id": session_id }).to_string()
}

#[tauri::command]
pub async fn get_realtime_token(mode: Option<String>) -> Result<serde_json::Value, String> {
    let mode = mode.as_deref().unwrap_or("general");
    let api_key = openai_api_key().ok_or_else(|| "OPENAI_API_KEY not set".to_string())?;
    let brief_ctx = read_brief_context();
    let body = realtime_session_body(&brief_ctx, mode);
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/realtime/client_secrets")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("realtime session: {e}"))?;
    if !resp.status().is_success() {
        let s = resp.status().as_u16();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI realtime HTTP {s}: {t}"));
    }
    let raw = resp.json::<serde_json::Value>().await
        .map_err(|e| format!("parse realtime session: {e}"))?;
    let nested = raw.get("session");
    // GA client_secrets: top-level "value"; fallback to older shapes
    let token = raw.get("value")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("client_secret").and_then(|cs| cs.get("value")).and_then(|v| v.as_str()))
        .or_else(|| nested.and_then(|s| s.get("client_secret")).and_then(|cs| cs.get("value")).and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();
    eprintln!("[realtime-token] extracted token prefix: {}", &token.chars().take(6).collect::<String>());
    let model = raw.get("model")
        .or_else(|| nested.and_then(|s| s.get("model")))
        .and_then(|m| m.as_str())
        .unwrap_or("gpt-realtime")
        .to_string();
    let session_id = raw.get("id")
        .or_else(|| nested.and_then(|s| s.get("id")))
        .and_then(|i| i.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(serde_json::json!({ "token": token, "model": model, "session_id": session_id }))
}

// ── Voice debug log ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn append_voice_log(line: String) {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.antfarm", home);
    let _ = std::fs::create_dir_all(&dir);
    let path = format!("{}/voice-debug.log", dir);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

// ── Voice tool call handlers (Tauri commands for desktop VoiceMode) ──────────

#[derive(Default)]
pub struct VoicePendingState {
    pub intent: std::sync::Mutex<Option<PendingIntent>>,
}

fn brief_json_for_assistant() -> String {
    let brain = brain_path();
    let cache_path = format!("{}/active/today-brief.json", brain);
    std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("briefing").map(|b| b.to_string()))
        .unwrap_or_else(|| "{}".to_string())
}

#[tauri::command]
pub fn tool_get_brief() -> String {
    read_brief_context()
}

#[tauri::command]
pub async fn tool_draft_dispatch(
    app: tauri::AppHandle,
    voice_pending: tauri::State<'_, VoicePendingState>,
    task: String,
) -> Result<String, String> {
    let claude = claude_path(&app);
    let brain  = brain_path();
    let date_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    let now = chrono::Local::now().to_string();
    let briefing_json = brief_json_for_assistant();
    let slugs = project_slugs_for_prompt();
    match crate::morning::assistant_chat_turn(&claude, &brain, &date_key, &briefing_json, &task, &now, &slugs) {
        Err(e) => Err(e),
        Ok((reply, _sid)) => match reply {
            crate::morning::AssistantReply::Chat(text) => Ok(text),
            crate::morning::AssistantReply::Dispatch(intent) => {
                let project_name = crate::list_projects_pub().into_iter()
                    .find(|p| p.slug == intent.project_slug)
                    .map(|p| p.name)
                    .unwrap_or_else(|| intent.project_slug.clone());
                *voice_pending.intent.lock().unwrap() = Some(PendingIntent {
                    task: intent.task,
                    project_slug: intent.project_slug,
                });
                Ok(format!(
                    "Plan drafted for {}. Say go to launch, or cancel to drop it.",
                    project_name
                ))
            }
        }
    }
}

#[tauri::command]
pub async fn tool_launch_dispatch(
    app: tauri::AppHandle,
    voice_pending: tauri::State<'_, VoicePendingState>,
) -> Result<String, String> {
    let (task, slug) = {
        let mut guard = voice_pending.intent.lock().unwrap();
        match guard.take() {
            None => return Ok("No plan pending. Draft one first with draft_dispatch.".to_string()),
            Some(pi) => (pi.task, pi.project_slug),
        }
    };
    let paths = crate::get_project_paths_pub(slug.clone());
    let project_path = paths.into_iter().map(|r| r.path).next().unwrap_or_default();
    if project_path.is_empty() {
        return Err(format!("No repo path for project {slug}. Check registry."));
    }
    let claude = claude_path(&app);
    let authored = crate::harness::author_plan_core(claude.clone(), task, project_path)?;
    let harness: tauri::State<crate::harness::HarnessState> = app.state();
    let aborts = harness.aborts.clone();
    drop(harness);
    let plan_id = crate::harness::arm_plan_from_path(app.clone(), claude, aborts, authored.plan_path)?;
    Ok(format!(
        "It's running, plan {}. Results will land in the Agents view.",
        &plan_id[..plan_id.len().min(12)]
    ))
}

#[tauri::command]
pub async fn tool_lock_tomorrow_plan(app: tauri::AppHandle) -> Result<String, String> {
    let claude = claude_path(&app);
    let now = chrono::Local::now().to_string();
    tauri::async_runtime::spawn_blocking(move || crate::planning::run_lock_now(&claude, &now))
        .await
        .map_err(|e| format!("task panicked: {e}"))?
}

// Fallback: simple Jarvis chat completion for classic voice mode
#[tauri::command]
pub async fn jarvis_chat(message: String) -> Result<String, String> {
    let api_key = openai_api_key().ok_or_else(|| "OPENAI_API_KEY not set".to_string())?;
    let brief = read_brief_context();
    let body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": format!(
                "You are Captain Jack, a concise AI chief of staff. Speak conversationally. \
                 Keep replies to 2-3 sentences unless detail is requested.\n\nContext:\n{brief}"
            )},
            {"role": "user", "content": &message}
        ],
        "max_tokens": 300
    });
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("jarvis_chat: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("jarvis_chat API: {}", resp.text().await.unwrap_or_default()));
    }
    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    val["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "jarvis_chat: no content".into())
}

// ── Desktop Tauri voice commands ─────────────────────────────────────────────

#[tauri::command]
pub fn voice_stt(audio_base64: String, content_type: String) -> Result<String, String> {
    use base64::Engine;
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    let api_key = openai_api_key().ok_or_else(|| "OPENAI_API_KEY not set".to_string())?;
    call_openai_stt(audio_bytes, content_type, &api_key)
}

#[tauri::command]
pub fn voice_tts(text: String, voice: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let api_key = openai_api_key().ok_or_else(|| "OPENAI_API_KEY not set".to_string())?;
    let v = voice.as_deref().unwrap_or(VOICE_JARVIS);
    let bytes = call_openai_tts(&text, v, &api_key)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let token = load_or_create_token();
        let pending_intent: std::sync::Arc<std::sync::Mutex<Option<PendingIntent>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        let server = match tiny_http::Server::http("127.0.0.1:8787") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("antfarm mobile: bind failed on :8787 — {e}");
                return;
            }
        };
        eprintln!("antfarm mobile: listening on http://127.0.0.1:8787");
        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let path: &str = url.split('?').next().unwrap_or("/");
            let auth = is_authorized(&request, &token);
            match path {
                "/" => {
                    respond(request, 200, "text/html; charset=utf-8", MOBILE_HTML.to_string());
                }
                "/api/runs" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    match crate::harness::list_plan_states() {
                        Ok(plans) => {
                            let json = serde_json::to_string(&plans).unwrap_or_else(|e| format!(r#"{{"error":"{e}"}}"#));
                            respond(request, 200, "application/json", json);
                        }
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/diff" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run  = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::harness_run_diff(plan, run) {
                        Ok(diff) => respond(request, 200, "text/plain; charset=utf-8", diff),
                        Err(e)   => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/summary" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run  = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::harness_run_summary(plan, run) {
                        Ok(s) => respond(request, 200, "text/plain; charset=utf-8", s),
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/merge" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run  = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::accept_run(plan, run) {
                        Ok(msg) => respond(request, 200, "text/plain", msg),
                        Err(e)  => respond(request, 409, "text/plain", e),
                    }
                }
                "/api/toss" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run  = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::reject_run(plan, run) {
                        Ok(())  => respond(request, 200, "text/plain", "tossed".into()),
                        Err(e)  => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/projects" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    let projects = crate::list_projects_pub();
                    let mut result: Vec<serde_json::Value> = Vec::new();
                    for proj in projects {
                        let paths = crate::get_project_paths_pub(proj.slug.clone());
                        if let Some(first) = paths.first() {
                            result.push(serde_json::json!({
                                "slug": proj.slug,
                                "name": proj.name,
                                "path": first.path,
                            }));
                        }
                    }
                    let json = serde_json::to_string(&result).unwrap_or_else(|_| "[]".into());
                    respond(request, 200, "application/json", json);
                }
                "/api/author" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let parsed = serde_json::from_str::<serde_json::Value>(&body).ok();
                    let description = parsed.as_ref()
                        .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()))
                        .filter(|s| !s.trim().is_empty());
                    let project_path = parsed.as_ref()
                        .and_then(|v| v.get("projectPath").and_then(|p| p.as_str()).map(|s| s.to_string()))
                        .filter(|s| !s.trim().is_empty());
                    let (desc, proj_path) = match (description, project_path) {
                        (Some(d), Some(p)) => (d, p),
                        _ => { respond(request, 400, "text/plain", "missing description or projectPath".into()); continue; }
                    };
                    let claude = claude_path(&app);
                    match crate::harness::author_plan_core(claude, desc, proj_path) {
                        Ok(result) => match serde_json::to_string(&result) {
                            Ok(json) => respond(request, 200, "application/json", json),
                            Err(e)   => respond(request, 500, "text/plain", e.to_string()),
                        },
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/plans" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    let authored_dir = home().join(".antfarm/plans-authored");
                    let mut result: Vec<serde_json::Value> = Vec::new();
                    if let Ok(entries) = std::fs::read_dir(&authored_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                            let path_str = path.to_string_lossy().into_owned();
                            let plan_id  = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                            match crate::harness::validate_plan_file(path_str.clone()) {
                                Ok(v) => {
                                    let goal_preview = v.summary.runs.first().map(|r| r.goal.clone()).unwrap_or_default();
                                    result.push(serde_json::json!({
                                        "planId": plan_id, "path": path_str,
                                        "ok": v.ok, "runCount": v.summary.run_count,
                                        "perNightUsd": v.summary.per_night_usd, "goalPreview": goal_preview,
                                    }));
                                }
                                Err(_) => {
                                    result.push(serde_json::json!({
                                        "planId": plan_id, "path": path_str,
                                        "ok": false, "runCount": 0, "perNightUsd": 0.0, "goalPreview": "",
                                    }));
                                }
                            }
                        }
                    }
                    let json = serde_json::to_string(&result).unwrap_or_else(|_| "[]".into());
                    respond(request, 200, "application/json", json);
                }
                "/api/arm" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let path = match serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()))
                    {
                        Some(p) => p,
                        None => { respond(request, 400, "text/plain", "missing path".into()); continue; }
                    };
                    match crate::harness::validate_plan_file(path.clone()) {
                        Err(e) => { respond(request, 400, "text/plain", format!("read error: {e}")); continue; }
                        Ok(v) if !v.ok => {
                            let err_json = serde_json::to_string(&v.errors).unwrap_or_default();
                            respond(request, 400, "application/json", err_json);
                            continue;
                        }
                        Ok(_) => {}
                    }
                    let harness: tauri::State<crate::harness::HarnessState> = app.state();
                    let claude  = claude_path(&app);
                    let aborts  = harness.aborts.clone();
                    drop(harness);
                    match crate::harness::arm_plan_from_path(app.clone(), claude, aborts, path) {
                        Ok(plan_id) => respond(request, 200, "application/json", serde_json::json!({ "planId": plan_id }).to_string()),
                        Err(e)      => respond(request, 500, "text/plain", e),
                    }
                }

                // ── Morning endpoints ────────────────────────────────────────

                "/api/morning" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    let now   = url_decode(query_param(&url, "now").unwrap_or_default());
                    let force = query_param(&url, "force").as_deref() == Some("true");
                    let claude = claude_path(&app);
                    let brain  = brain_path();
                    match crate::morning::run_morning(brain, claude, now, force) {
                        Ok(text) => respond(request, 200, "text/plain; charset=utf-8", text),
                        Err(e)   => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/morning-chat" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    let message      = v.get("message").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let now          = v.get("now").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let date_key     = v.get("dateKey").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let briefing_json = v.get("briefingJson").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    if message.is_empty() {
                        respond(request, 400, "text/plain", "missing message".into()); continue;
                    }
                    let claude = claude_path(&app);
                    let brain  = brain_path();
                    match crate::morning::morning_chat_turn(&claude, &brain, &date_key, &briefing_json, &message, &now) {
                        Ok(reply) => respond(request, 200, "text/plain; charset=utf-8", reply),
                        Err(e)    => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/morning-insight" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    let done_summary = v.get("doneSummary").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let now          = v.get("now").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let claude = claude_path(&app);
                    let brain  = brain_path();
                    match crate::morning::run_insight(claude, brain, done_summary, now) {
                        Ok(text) => respond(request, 200, "text/plain; charset=utf-8", text),
                        Err(e)   => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/refresh-whoop" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    match crate::morning::refresh_whoop_blocking() {
                        Ok(msg) => respond(request, 200, "text/plain", msg),
                        Err(e)  => respond(request, 500, "text/plain", e),
                    }
                }

                // ── Assistant (dispatch-aware) endpoint ──────────────────────

                "/api/assistant" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    let message      = v.get("message").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let now          = v.get("now").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let date_key     = v.get("dateKey").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let briefing_json = v.get("briefingJson").and_then(|s| s.as_str()).unwrap_or("").to_string();

                    if message.is_empty() {
                        respond(request, 400, "text/plain", "missing message".into()); continue;
                    }

                    let claude = claude_path(&app);
                    let brain  = brain_path();

                    // Check affirmative/negative against pending intent
                    let has_pending = pending_intent.lock().unwrap().is_some();
                    if has_pending && is_affirmative(&message) {
                        // Extract intent and clear
                        let (task, slug) = {
                            let mut guard = pending_intent.lock().unwrap();
                            let intent = guard.take().unwrap();
                            (intent.task, intent.project_slug)
                        };
                        // Resolve project path
                        let paths = crate::get_project_paths_pub(slug.clone());
                        let project_path = paths.into_iter().map(|r| r.path).next().unwrap_or_default();
                        if project_path.is_empty() {
                            let reply = format!("I couldn't find a path for project {slug}. Check the registry.");
                            respond(request, 200, "application/json",
                                serde_json::json!({ "reply": reply, "mode": "chat" }).to_string());
                            continue;
                        }
                        // Author + arm (blocking, ~30s)
                        match crate::harness::author_plan_core(claude.clone(), task, project_path) {
                            Err(e) => {
                                let reply = format!("Plan authoring failed: {e}");
                                respond(request, 200, "application/json",
                                    serde_json::json!({ "reply": reply, "mode": "chat" }).to_string());
                            }
                            Ok(authored) => {
                                let harness: tauri::State<crate::harness::HarnessState> = app.state();
                                let aborts = harness.aborts.clone();
                                drop(harness);
                                match crate::harness::arm_plan_from_path(app.clone(), claude, aborts, authored.plan_path) {
                                    Ok(plan_id) => {
                                        let reply = format!(
                                            "It's running, plan {}. Results will land in the Agents view.",
                                            &plan_id[..plan_id.len().min(12)]
                                        );
                                        respond(request, 200, "application/json",
                                            serde_json::json!({ "reply": reply, "mode": "launched", "plan_id": plan_id }).to_string());
                                    }
                                    Err(e) => {
                                        let reply = format!("Failed to arm the plan: {e}");
                                        respond(request, 200, "application/json",
                                            serde_json::json!({ "reply": reply, "mode": "chat" }).to_string());
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    if has_pending && is_negative(&message) {
                        pending_intent.lock().unwrap().take();
                        respond(request, 200, "application/json",
                            serde_json::json!({ "reply": "Cancelled. What else?", "mode": "chat" }).to_string());
                        continue;
                    }

                    // Run assistant turn with dispatch detection
                    let slugs = project_slugs_for_prompt();
                    match crate::morning::assistant_chat_turn(
                        &claude, &brain, &date_key, &briefing_json, &message, &now, &slugs,
                    ) {
                        Err(e) => respond(request, 500, "text/plain", e),
                        Ok((reply, _sid)) => {
                            match reply {
                                crate::morning::AssistantReply::Chat(text) => {
                                    respond(request, 200, "application/json",
                                        serde_json::json!({ "reply": text, "mode": "chat" }).to_string());
                                }
                                crate::morning::AssistantReply::Dispatch(intent) => {
                                    let task = intent.task.clone();
                                    let slug = intent.project_slug.clone();
                                    let project_name = crate::list_projects_pub().into_iter()
                                        .find(|p| p.slug == slug)
                                        .map(|p| p.name)
                                        .unwrap_or_else(|| slug.clone());
                                    *pending_intent.lock().unwrap() = Some(PendingIntent {
                                        task,
                                        project_slug: slug,
                                    });
                                    let reply = format!(
                                        "Understood. I'll build a plan for that in {}. Say 'go' to launch or 'cancel' to drop it.",
                                        project_name
                                    );
                                    respond(request, 200, "application/json",
                                        serde_json::json!({ "reply": reply, "mode": "plan_intent" }).to_string());
                                }
                            }
                        }
                    }
                }

                // ── Realtime voice session token ─────────────────────────────

                "/api/realtime-token" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let api_key = match openai_api_key() {
                        Some(k) => k,
                        None => { respond(request, 500, "text/plain", "OPENAI_API_KEY not set".into()); continue; }
                    };
                    let mut body_bytes = Vec::new();
                    let _ = request.as_reader().read_to_end(&mut body_bytes);
                    let mode = serde_json::from_slice::<serde_json::Value>(&body_bytes)
                        .ok()
                        .and_then(|v| v.get("mode").and_then(|m| m.as_str()).map(|s| s.to_string()))
                        .unwrap_or_else(|| "general".to_string());
                    let brief_ctx = read_brief_context();
                    match call_openai_realtime_session(&api_key, &brief_ctx, &mode) {
                        Ok(session) => respond(request, 200, "application/json", extract_realtime_token_response(session)),
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }

                "/api/lock-plan" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let claude = claude_path(&app);
                    let now = chrono::Local::now().to_string();
                    match crate::planning::run_lock_now(&claude, &now) {
                        Ok(md) => respond(request, 200, "application/json",
                            serde_json::json!({ "ok": true, "markdown": md }).to_string()),
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }

                // ── Voice endpoints ──────────────────────────────────────────

                "/api/stt" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let api_key = match openai_api_key() {
                        Some(k) => k,
                        None => { respond(request, 500, "text/plain", "OPENAI_API_KEY not set".into()); continue; }
                    };
                    let content_type_hdr = request.headers().iter()
                        .find(|h| h.field.equiv("content-type"))
                        .map(|h| h.value.as_str().to_string())
                        .unwrap_or_default();
                    let mut body_bytes = Vec::new();
                    let _ = request.as_reader().read_to_end(&mut body_bytes);
                    match parse_multipart_file(&body_bytes, &content_type_hdr) {
                        None => { respond(request, 400, "text/plain", "could not parse multipart audio".into()); }
                        Some((audio_bytes, audio_ct)) => {
                            match call_openai_stt(audio_bytes, audio_ct, &api_key) {
                                Ok(text) => {
                                    let json = serde_json::json!({ "text": text }).to_string();
                                    respond(request, 200, "application/json", json);
                                }
                                Err(e) => respond(request, 500, "text/plain", e),
                            }
                        }
                    }
                }

                "/api/tts" => {
                    if !auth { respond(request, 401, "text/plain", "401 Unauthorized".into()); continue; }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into()); continue;
                    }
                    let api_key = match openai_api_key() {
                        Some(k) => k,
                        None => { respond(request, 500, "text/plain", "OPENAI_API_KEY not set".into()); continue; }
                    };
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let parsed = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    let text = parsed.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    let voice = parsed.get("voice").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if text.trim().is_empty() {
                        respond(request, 400, "text/plain", "missing text".into()); continue;
                    }
                    match call_openai_tts(&text, &voice, &api_key) {
                        Ok(mp3_bytes) => respond_binary(request, 200, "audio/mpeg", mp3_bytes),
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }

                _ => {
                    respond(request, 404, "text/plain", "404 Not Found".into());
                }
            }
        }
    });
}
