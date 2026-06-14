// mobile.rs — read-only Tailscale/local status view for the antfarm harness.
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

    /* Author section */
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
      background: #1e3a5f; color: #7dd3fc;
      border: none; border-radius: 9px; padding: 8px 0;
      font-size: 13px; font-weight: 600; cursor: pointer;
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

  <div id="author-section">
    <div id="author-hdr">Author a plan</div>
    <div class="author-form">
      <textarea id="author-desc" placeholder="Describe what you want the agent to build…" rows="3"></textarea>
      <select id="author-project">
        <option value="">— pick project —</option>
      </select>
      <input type="text" id="author-path" placeholder="or paste a repo path">
      <button class="btn-generate" id="btn-generate" onclick="generatePlan()" disabled>Generate plan</button>
    </div>
    <div id="author-result-area"></div>
  </div>

  <div id="plans-section">
    <div id="plans-hdr">Start a run</div>
    <div id="plans-list"><div class="empty" style="padding:20px 0;font-size:12px;">Loading plans…</div></div>
  </div>

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

      const DONE = new Set(['accepted', 'rejected', 'merged']);
      list.innerHTML = ENTRIES.map(({ run }, i) => {
        const label = run.status.replace(/_/g, ' ');
        const reviewBlock = run.reviewNotes
          ? `<div class="reviewer"><b>Reviewer:</b> ${esc(run.reviewNotes)}</div>`
          : '';
        const actionable = run.worktree && !DONE.has(run.status);
        const actionsBlock = actionable ? `
          <div class="actions">
            <button class="btn btn-merge" onclick="event.stopPropagation();mergeRun(${i})">Merge</button>
            <button class="btn btn-toss" onclick="event.stopPropagation();tossRun(${i})">Toss</button>
          </div>` : '';
        return `<div class="card" onclick="showDiff(${i})">
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

    // ── Actions ───────────────────────────────────────────────────────────
    async function mergeRun(i) {
      const { planId, run } = ENTRIES[i];
      if (!window.confirm('Merge this run to main?')) return;
      const url = '/api/merge?plan=' + encodeURIComponent(planId)
                + '&run=' + encodeURIComponent(run.runId);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        const text = await r.text();
        if (!r.ok) { alert(text); return; }
        fetchRuns();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function tossRun(i) {
      const { planId, run } = ENTRIES[i];
      if (!window.confirm('Toss this run? This deletes its worktree and branch.')) return;
      const url = '/api/toss?plan=' + encodeURIComponent(planId)
                + '&run=' + encodeURIComponent(run.runId);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        const text = await r.text();
        if (!r.ok) { alert(text); return; }
        fetchRuns();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    fetchRuns();
    setInterval(fetchRuns, 5000);

    // ── Author a plan ──────────────────────────────────────────────────────
    async function fetchProjects() {
      try {
        const r = await fetch('/api/projects', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
        if (!r.ok) return;
        const projs = await r.json();
        const sel = document.getElementById('author-project');
        projs.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.path;
          opt.textContent = p.name;
          sel.appendChild(opt);
        });
      } catch (e) { /* ignore */ }
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
      btn.disabled = true;
      btn.textContent = 'Generating… (~30s)';
      document.getElementById('author-result-area').innerHTML = '';

      try {
        const r = await fetch('/api/author', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
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
        btn.textContent = 'Generate plan';
        updateGenerateBtn();
      }
    }

    function renderAuthorResult(result) {
      const v = result.validation;
      const s = v.summary;
      let html = '<div class="author-result">';
      html += `<div style="font-size:11px;font-weight:600;color:#a1a1aa;margin-bottom:8px">${esc(s.planId)} · ${s.runCount} run${s.runCount !== 1 ? 's' : ''} · $${s.perNightUsd ? s.perNightUsd.toFixed(2) : '?'} night cap</div>`;
      if (v.errors && v.errors.length) {
        html += `<div class="author-errors">${v.errors.map(e => `<div>${esc(e)}</div>`).join('')}</div>`;
      }
      if (v.warnings && v.warnings.length) {
        html += `<div class="author-warnings">${v.warnings.map(w => `<div>${esc(w)}</div>`).join('')}</div>`;
      }
      if (s.runs && s.runs.length) {
        s.runs.forEach(run => {
          html += `<div class="author-run"><div class="author-run-goal">${esc(run.goal)}</div><div class="author-run-meta">${esc(run.projectPath)}${run.pathExists ? (run.isGit ? ' · git' : ' · no git') : ' · ⚠ missing'}</div></div>`;
        });
      }
      if (v.ok) {
        const escapedPath = result.planPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += `<button class="btn-arm" style="margin-top:10px" onclick="armAuthoredPlan('${escapedPath}')">Arm &amp; start</button>`;
      }
      html += '</div>';
      document.getElementById('author-result-area').innerHTML = html;
    }

    async function armAuthoredPlan(planPath) {
      if (!window.confirm('Arm and start this plan?')) return;
      try {
        const r = await fetch('/api/arm', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: planPath }),
        });
        const text = await r.text();
        if (!r.ok) { alert('Error: ' + text); return; }
        document.getElementById('author-result-area').innerHTML = '';
        document.getElementById('author-desc').value = '';
        document.getElementById('author-project').selectedIndex = 0;
        document.getElementById('author-path').value = '';
        updateGenerateBtn();
        alert('Armed! Plan started.');
        fetchRuns();
        fetchPlans();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    fetchProjects();

    async function fetchPlans() {
      try {
        const r = await fetch('/api/plans', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
        if (!r.ok) return;
        renderPlans(await r.json());
      } catch (e) { /* ignore */ }
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
          headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p.path }),
        });
        const text = await r.text();
        if (!r.ok) { alert('Error: ' + text); return; }
        alert('Armed! Plan started.');
        fetchRuns();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }
    fetchPlans();
  </script>
</body>
</html>
"###;

// ── Server ────────────────────────────────────────────────────────────────────

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let token = load_or_create_token();
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
                "/api/merge" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into());
                        continue;
                    }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::accept_run(plan, run) {
                        Ok(msg) => respond(request, 200, "text/plain", msg),
                        Err(e) => respond(request, 409, "text/plain", e),
                    }
                }
                "/api/toss" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into());
                        continue;
                    }
                    let plan = query_param(&url, "plan").unwrap_or_default();
                    let run = query_param(&url, "run").unwrap_or_default();
                    match crate::harness::reject_run(plan, run) {
                        Ok(()) => respond(request, 200, "text/plain", "tossed".into()),
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/projects" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
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
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into());
                        continue;
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
                        _ => {
                            respond(request, 400, "text/plain", "missing description or projectPath".into());
                            continue;
                        }
                    };
                    let dispatch: tauri::State<crate::dispatch::DispatchState> = app.state();
                    let claude = dispatch.claude_path.lock().unwrap().clone();
                    drop(dispatch);
                    match crate::harness::author_plan_core(claude, desc, proj_path) {
                        Ok(result) => {
                            match serde_json::to_string(&result) {
                                Ok(json) => respond(request, 200, "application/json", json),
                                Err(e) => respond(request, 500, "text/plain", e.to_string()),
                            }
                        }
                        Err(e) => respond(request, 500, "text/plain", e),
                    }
                }
                "/api/plans" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    let authored_dir = home().join(".antfarm/plans-authored");
                    let mut result: Vec<serde_json::Value> = Vec::new();
                    if let Ok(entries) = std::fs::read_dir(&authored_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                            let path_str = path.to_string_lossy().into_owned();
                            let plan_id = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                            match crate::harness::validate_plan_file(path_str.clone()) {
                                Ok(v) => {
                                    let goal_preview = v.summary.runs.first().map(|r| r.goal.clone()).unwrap_or_default();
                                    result.push(serde_json::json!({
                                        "planId": plan_id,
                                        "path": path_str,
                                        "ok": v.ok,
                                        "runCount": v.summary.run_count,
                                        "perNightUsd": v.summary.per_night_usd,
                                        "goalPreview": goal_preview,
                                    }));
                                }
                                Err(_) => {
                                    result.push(serde_json::json!({
                                        "planId": plan_id,
                                        "path": path_str,
                                        "ok": false,
                                        "runCount": 0,
                                        "perNightUsd": 0.0,
                                        "goalPreview": "",
                                    }));
                                }
                            }
                        }
                    }
                    let json = serde_json::to_string(&result).unwrap_or_else(|_| "[]".into());
                    respond(request, 200, "application/json", json);
                }
                "/api/arm" => {
                    if !auth {
                        respond(request, 401, "text/plain", "401 Unauthorized".into());
                        continue;
                    }
                    if *request.method() != tiny_http::Method::Post {
                        respond(request, 405, "text/plain", "405 Method Not Allowed".into());
                        continue;
                    }
                    // Read body
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let path = match serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(|s| s.to_string()))
                    {
                        Some(p) => p,
                        None => { respond(request, 400, "text/plain", "missing path".into()); continue; }
                    };
                    // Validate first
                    match crate::harness::validate_plan_file(path.clone()) {
                        Err(e) => { respond(request, 400, "text/plain", format!("read error: {e}")); continue; }
                        Ok(v) if !v.ok => {
                            let err_json = serde_json::to_string(&v.errors).unwrap_or_default();
                            respond(request, 400, "application/json", err_json);
                            continue;
                        }
                        Ok(_) => {}
                    }
                    // Arm it
                    let harness: tauri::State<crate::harness::HarnessState> = app.state();
                    let dispatch: tauri::State<crate::dispatch::DispatchState> = app.state();
                    let claude = dispatch.claude_path.lock().unwrap().clone();
                    let aborts = harness.aborts.clone();
                    drop(harness);
                    drop(dispatch);
                    match crate::harness::arm_plan_from_path(app.clone(), claude, aborts, path) {
                        Ok(plan_id) => {
                            let json = serde_json::json!({ "planId": plan_id }).to_string();
                            respond(request, 200, "application/json", json);
                        }
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
