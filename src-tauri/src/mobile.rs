// mobile.rs — read-only Tailscale/local status view for the antfarm harness.
// Binds a tiny_http server on 127.0.0.1:8787. Token-gated (Bearer or ?token=).
// Token is auto-generated and written to ~/.antfarm/mobile-token on first run.

use std::io::Read;
use std::path::PathBuf;

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
    // Generate 16 random bytes from /dev/urandom, hex-encode — no extra crate needed.
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
      padding-bottom: env(safe-area-inset-bottom);
    }
    #hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: calc(env(safe-area-inset-top) + 12px) 16px 12px;
      border-bottom: 1px solid #27272a; background: #0d0d0f; position: sticky; top: 0; z-index: 10;
    }
    #hdr h1 { font-size: 15px; font-weight: 700; color: #f4f4f5; }
    #status { font-size: 11px; color: #52525b; }
    #list { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .card {
      background: #111113; border: 1px solid #27272a; border-radius: 14px;
      padding: 14px; cursor: pointer; -webkit-tap-highlight-color: transparent;
      transition: background 0.1s;
    }
    .card:active { background: #1c1c1e; }
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

    /* Diff overlay */
    #overlay {
      display: none; position: fixed; inset: 0; background: #0a0a0b;
      z-index: 100; flex-direction: column;
    }
    #overlay.open { display: flex; }
    #ov-hdr {
      display: flex; align-items: center; gap: 10px;
      padding: calc(env(safe-area-inset-top) + 12px) 16px 12px;
      border-bottom: 1px solid #27272a; background: #0d0d0f; shrink: 0;
    }
    #ov-title { flex: 1; font-size: 13px; font-weight: 600; color: #e4e4e7; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    #ov-close {
      background: #27272a; border: none; color: #a1a1aa;
      padding: 6px 16px; border-radius: 8px; font-size: 13px; cursor: pointer;
      flex-shrink: 0;
    }
    #ov-body { flex: 1; overflow: auto; padding: 12px 14px; }
    #ov-pre {
      font-family: "Menlo", "SF Mono", monospace; font-size: 11px;
      color: #a1a1aa; white-space: pre; line-height: 1.5;
    }
  </style>
</head>
<body>
  <div id="hdr">
    <h1>Antfarm Agents</h1>
    <span id="status">connecting…</span>
  </div>
  <div id="list"></div>

  <div id="overlay">
    <div id="ov-hdr">
      <span id="ov-title"></span>
      <button id="ov-close" onclick="closeDiff()">Close</button>
    </div>
    <div id="ov-body"><pre id="ov-pre"></pre></div>
  </div>

  <script>
    // ── Token handling ─────────────────────────────────────────────────────
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('token');
    if (urlToken) localStorage.setItem('af-token', urlToken);
    const TOKEN = localStorage.getItem('af-token') || '';

    // ── Status chip colours (mirrors the desktop AgentsView) ──────────────
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

    function esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Global entry list (indexed by cards' onclick) ─────────────────────
    let ENTRIES = [];

    // ── Render ────────────────────────────────────────────────────────────
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

      list.innerHTML = ENTRIES.map(({ run }, i) => {
        const label = run.status.replace(/_/g, ' ');
        const reviewBlock = run.reviewNotes
          ? `<div class="reviewer"><b>Reviewer:</b> ${esc(run.reviewNotes)}</div>`
          : '';
        return `<div class="card" onclick="showDiff(${i})">
          <div class="goal">${esc(run.goal || 'Untitled run')}</div>
          ${run.summary ? `<div class="summary">${esc(run.summary)}</div>` : ''}
          ${reviewBlock}
          <div class="meta">
            <span class="chip" style="${chipStyle(run.status)}">${esc(label)}</span>
            <span class="cost">${fmtCost(run.costUsd)}</span>
          </div>
          <div class="run-id">${esc(run.runId)}</div>
        </div>`;
      }).join('');
    }

    // ── Poll ──────────────────────────────────────────────────────────────
    async function fetchRuns() {
      try {
        const r = await fetch('/api/runs', {
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        if (!r.ok) {
          document.getElementById('status').textContent = 'auth error ' + r.status;
          return;
        }
        render(await r.json());
        document.getElementById('status').textContent =
          'updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        document.getElementById('status').textContent = 'error';
      }
    }

    // ── Diff overlay ──────────────────────────────────────────────────────
    async function showDiff(i) {
      const { planId, run } = ENTRIES[i];
      document.getElementById('ov-title').textContent = run.goal || run.runId;
      document.getElementById('ov-pre').textContent = 'Loading…';
      document.getElementById('overlay').classList.add('open');
      try {
        const url = '/api/diff?plan=' + encodeURIComponent(planId)
                  + '&run=' + encodeURIComponent(run.runId);
        const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
        const text = await r.text();
        document.getElementById('ov-pre').textContent = text || 'No diff available.';
      } catch (e) {
        document.getElementById('ov-pre').textContent = 'Error: ' + e.message;
      }
    }

    function closeDiff() {
      document.getElementById('overlay').classList.remove('open');
    }

    fetchRuns();
    setInterval(fetchRuns, 5000);
  </script>
</body>
</html>
"###;

// ── Server ────────────────────────────────────────────────────────────────────

pub fn start() {
    std::thread::spawn(|| {
        let token = load_or_create_token();
        let server = match tiny_http::Server::http("127.0.0.1:8787") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("antfarm mobile: bind failed on :8787 — {e}");
                return;
            }
        };
        eprintln!("antfarm mobile: listening on http://127.0.0.1:8787");
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let path: &str = url.split('?').next().unwrap_or("/");
            let auth = is_authorized(&request, &token);
            match path {
                "/" => {
                    respond(request, 200, "text/html; charset=utf-8", MOBILE_HTML.to_string());
                }
                "/api/runs" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    match crate::harness::list_plan_states() {
                        Ok(plans) => {
                            let json = serde_json::to_string(&plans)
                                .unwrap_or_else(|e| format!(r#"{{"error":"{e}"}}"#));
                            respond(request, 200, "application/json", json);
                        }
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/diff" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::harness_run_diff(plan, run) {
                        Ok(diff) => respond(request, 200, "text/plain; charset=utf-8", diff),
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/summary" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::harness_run_summary(plan, run) {
                        Ok(s) => respond(request, 200, "text/plain; charset=utf-8", s),
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
