import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, LOGIN_EMAIL } from "./supabase.js";

const PIN_LENGTH = 6;
const KINDS = ["forge", "spec"];

const AGENTS = [
  { value: "chief-of-staff", label: "Captain Jack" },
  { value: "clerk", label: "Clerk" },
  { value: "scout", label: "Scout" },
  { value: "scribe", label: "Scribe" },
  { value: "pulitzer", label: "Pulitzer" },
  { value: "scholar", label: "Scholar" },
];

// @mention aliases -> real vault agent folder ids.
const AGENT_ALIASES = {
  jack: "chief-of-staff",
  captain: "chief-of-staff",
  chief: "chief-of-staff",
  "chief-of-staff": "chief-of-staff",
  clerk: "clerk",
  scout: "scout",
  scribe: "scribe",
  pulitzer: "pulitzer",
  scholar: "scholar",
};

/* ─────────────────────────── helpers ─────────────────────────── */

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

const PHASES = [
  { key: "plan", label: "Plan" },
  { key: "build", label: "Build" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

// Map a job to how far along the pipeline it is (index into PHASES, -1 = not started).
function phaseIndex(job) {
  const cp = (job.current_phase || "").toLowerCase();
  if (cp) {
    if (cp.includes("plan")) return 0;
    if (cp.includes("build") || cp.includes("verif")) return 1;
    if (cp.includes("review")) return 2;
    if (cp.includes("ready") || cp.includes("done")) return 3;
  }
  if (["done", "approved", "pushed"].includes(job.status)) return 3;
  if (job.status === "running") return 1;
  return -1;
}

const STATUS_TEXT = {
  queued: "Waiting in line",
  running: "The crew is working on it",
  done: "Done and ready for your review",
  needs_you: "Needs your input",
  error: "Hit a problem",
  approved: "Approved — publishing",
  pushed: "Shipped",
};

// Parse a ```delegate ... ``` block out of an agent reply into editable delegations.
function parseDelegateBlock(content) {
  const m = content.match(/```delegate\s*([\s\S]*?)```/i);
  if (!m) return null;
  const lines = m[1].trim().split("\n");
  const aliasRe = /^([a-z][a-z-]*):\s*(.*)$/i;
  const dels = [];
  let cur = null;
  for (const line of lines) {
    const lm = line.match(aliasRe);
    if (lm && AGENT_ALIASES[lm[1].toLowerCase()]) {
      if (cur) dels.push(cur);
      cur = { agent: AGENT_ALIASES[lm[1].toLowerCase()], task: lm[2] };
    } else if (cur) {
      cur.task += "\n" + line;
    }
  }
  if (cur) dels.push(cur);
  const intro = content.replace(/```delegate[\s\S]*?```/i, "").trim();
  return dels.length ? { intro, delegations: dels } : null;
}

/* ─────────────────────────── login ─────────────────────────── */

function Login() {
  const [seq, setSeq] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(false);

  const submit = useCallback(async (code) => {
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({
      email: LOGIN_EMAIL,
      password: code,
    });
    setBusy(false);
    setSeq([]);
    if (error) {
      setErr(error.message);
      setShake(true);
      setTimeout(() => setShake(false), 480);
    }
  }, []);

  const press = (n) => {
    if (busy || seq.length >= PIN_LENGTH) return;
    const next = [...seq, n];
    setSeq(next);
    if (next.length === PIN_LENGTH) submit(next.join(""));
  };

  return (
    <div className="login">
      <div className={"login-card" + (shake ? " shake" : "")}>
        <div className="logo-dot" />
        <h1 className="brand">Antfarm</h1>
        <p className="brand-sub">Console</p>

        <div className="dots">
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <span key={i} className={"dot" + (i < seq.length ? " on" : "")} />
          ))}
        </div>

        <div className="keypad">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} className="key" onClick={() => press(n)} disabled={busy}>
              {n}
            </button>
          ))}
        </div>

        <p className={"login-msg" + (err ? " err" : "")}>
          {busy ? "Checking…" : err || "Enter your code"}
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────── pipeline ─────────────────────────── */

function Pipeline({ job }) {
  const idx = phaseIndex(job);
  const indeterminate = job.status === "running" && !job.current_phase;
  return (
    <div className={"pipe" + (indeterminate ? " indet" : "")}>
      {PHASES.map((p, i) => {
        const state =
          i < idx ? "done" : i === idx ? "active" : "todo";
        return (
          <React.Fragment key={p.key}>
            <div className={"node " + state}>
              <span className="node-ring" />
              <span className="node-label">{p.label}</span>
            </div>
            {i < PHASES.length - 1 && (
              <div className={"link " + (i < idx ? "done" : "")} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── job card ─────────────────────────── */

function JobCard({ job, onApprove }) {
  const [open, setOpen] = useState(false);
  const showPipe = job.kind === "forge" || job.kind === "spec";
  const liveStep =
    Array.isArray(job.steps) && job.steps.length
      ? job.steps[job.steps.length - 1]?.text
      : null;

  const statusLine =
    job.status === "needs_you"
      ? job.result_summary || STATUS_TEXT.needs_you
      : job.status === "error"
      ? job.error || STATUS_TEXT.error
      : STATUS_TEXT[job.status] || job.status;

  return (
    <div className="job">
      <div className="job-head">
        <span className={"chip k-" + job.kind}>{job.kind}</span>
        <span className="job-repo">{job.repo}</span>
        <span className="job-time">{timeAgo(job.created_at)}</span>
      </div>

      <div className="job-task">{job.task}</div>

      {showPipe && job.status !== "queued" && <Pipeline job={job} />}

      <div className={"status-line s-" + job.status}>
        <span className="status-glow" />
        {liveStep && ["running", "approved"].includes(job.status)
          ? liveStep
          : statusLine}
      </div>

      {job.status === "done" && (
        <>
          {job.reviewer_note && (
            <div className="reviewer">{job.reviewer_note}</div>
          )}
          {job.diff && (
            <button className="link-btn" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide diff" : "View diff"}
            </button>
          )}
          {open && job.diff && <pre className="diff">{job.diff}</pre>}
          <button className="approve" onClick={() => onApprove(job.id)}>
            Approve &amp; ship
          </button>
        </>
      )}

      {job.status === "pushed" && job.commit_hash && (
        <div className="commit">shipped · {job.commit_hash}</div>
      )}
    </div>
  );
}

/* ─────────────────────────── composer ─────────────────────────── */

function Composer({ onQueued }) {
  const [kind, setKind] = useState("forge");
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const taRef = useRef(null);

  useEffect(() => {
    supabase
      .from("repos")
      .select("*")
      .order("label", { ascending: true })
      .then(({ data }) => {
        const list = data || [];
        setRepos(list);
        setRepo((cur) => {
          if (cur) return cur;
          if (list.length) {
            const def = list.find((r) => r.name === "antfarm-write-test") || list[0];
            return def.path;
          }
          return "antfarm-write-test";
        });
      });
  }, []);

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };

  const send = async () => {
    if (!repo.trim() || !task.trim() || busy) return;
    setBusy(true);
    const { error } = await supabase.from("jobs").insert({
      repo: repo.trim(),
      kind,
      task: task.trim(),
    });
    setBusy(false);
    if (error) {
      alert(error.message);
      return;
    }
    setTask("");
    grow();
    onQueued();
  };

  return (
    <div className="composer">
      <div className="kind-row">
        {KINDS.map((k) => (
          <button
            key={k}
            className={"kind" + (kind === k ? " on" : "")}
            onClick={() => setKind(k)}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="meta-row">
        {repos.length ? (
          <select
            className="repo-input repo-select"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.name} value={r.path}>
                {r.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="repo-input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="repo name or path"
            autoCapitalize="off"
            autoCorrect="off"
          />
        )}
      </div>

      <div className="input-bar">
        <textarea
          ref={taRef}
          className="task-input"
          value={task}
          onChange={(e) => {
            setTask(e.target.value);
            grow();
          }}
          placeholder={kind === "spec" ? "Describe the scope…" : "What should the crew do?"}
          rows={1}
        />
        <button className="send" onClick={send} disabled={busy} aria-label="send">
          {busy ? <span className="spin" /> : <ArrowUp />}
        </button>
      </div>
    </div>
  );
}

function ArrowUp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─────────────────────────── forge tab ─────────────────────────── */

function ForgeTab() {
  const [jobs, setJobs] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .in("kind", ["forge", "spec"])
      .order("created_at", { ascending: false })
      .limit(40);
    if (!error) setJobs(data || []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  const approve = async (jobId) => {
    setJobs((js) =>
      js.map((j) => (j.id === jobId ? { ...j, status: "approved" } : j))
    );
    await supabase.from("jobs").update({ status: "approved", approved: true }).eq("id", jobId);
    load();
  };

  return (
    <>
      <div className="feed">
        {!loaded ? (
          <div className="empty">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No jobs yet</div>
            <div className="empty-sub">Queue one below and watch the crew work.</div>
          </div>
        ) : (
          jobs.map((j) => <JobCard key={j.id} job={j} onApprove={approve} />)
        )}
      </div>

      <Composer onQueued={load} />
    </>
  );
}

/* ─────────────────────────── agents tab (chat) ─────────────────────────── */

function ChatBubble({ message }) {
  const mine = message.role === "user";
  return (
    <div className={"bubble-row" + (mine ? " mine" : "")}>
      <div className={"bubble" + (mine ? " mine" : "")}>{message.content}</div>
    </div>
  );
}

function DelegationCard({ delegation, onSend }) {
  const [task, setTask] = useState(delegation.task.trim());
  const [sent, setSent] = useState(false);
  const label = AGENTS.find((a) => a.value === delegation.agent)?.label || delegation.agent;
  return (
    <div className="deleg-card">
      <div className="deleg-head">Delegate to {label}</div>
      <textarea
        className="deleg-task"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={4}
      />
      <button
        className="deleg-send"
        disabled={sent || !task.trim()}
        onClick={() => {
          onSend(delegation.agent, task.trim());
          setSent(true);
        }}
      >
        {sent ? "Sent to " + label : "Send to " + label}
      </button>
    </div>
  );
}

function AgentsTab() {
  const [agent, setAgent] = useState(AGENTS[0].value);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const taRef = useRef(null);
  const threadRef = useRef(null);
  const prevLenRef = useRef(0);
  const sigRef = useRef("");

  const agentLabel = useMemo(
    () => AGENTS.find((a) => a.value === agent)?.label || agent,
    [agent]
  );

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("agent", agent)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) return;
    const rows = data || [];
    const sig = rows.length + ":" + (rows[rows.length - 1]?.id || "");
    if (sig === sigRef.current) return; // nothing changed — skip re-render + scroll
    sigRef.current = sig;
    setMessages(rows);
  }, [agent]);

  useEffect(() => {
    setMessages([]);
    prevLenRef.current = 0;
    sigRef.current = "";
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  // Only auto-scroll when a NEW message arrived AND you're already near the bottom,
  // so scrolling up to read a long reply doesn't snap you back down.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const grew = messages.length > prevLenRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (grew && nearBottom) el.scrollTop = el.scrollHeight;
    prevLenRef.current = messages.length;
  }, [messages]);

  // Highlight text in a reply -> offer to ask about it.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const t = sel ? sel.toString().trim() : "";
      if (
        t &&
        threadRef.current &&
        sel.anchorNode &&
        threadRef.current.contains(sel.anchorNode)
      ) {
        setSelectedText(t);
      } else if (!t) {
        setSelectedText("");
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const askAboutSelection = () => {
    const q = selectedText.length > 240 ? selectedText.slice(0, 240) + "…" : selectedText;
    setText((cur) => `About this: "${q}"\n\n` + cur);
    setSelectedText("");
    window.getSelection()?.removeAllRanges();
    setTimeout(() => {
      taRef.current?.focus();
      grow();
    }, 0);
  };

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  };

  const send = async () => {
    let content = text.trim();
    if (!content || busy) return;
    // A leading @mention routes this message to another agent and switches the thread.
    let target = agent;
    const m = content.match(/^@([a-z-]+)\s+/i);
    if (m) {
      const resolved = AGENT_ALIASES[m[1].toLowerCase()];
      if (resolved) {
        target = resolved;
        content = content.slice(m[0].length).trim();
        if (resolved !== agent) setAgent(resolved);
      }
    }
    if (!content) return;
    setBusy(true);
    const { error: msgError } = await supabase
      .from("messages")
      .insert({ agent: target, role: "user", content });
    if (!msgError) {
      const { error: jobError } = await supabase.from("jobs").insert({
        repo: "-",
        kind: "chat",
        agent: target,
        task: content,
      });
      if (jobError) alert(jobError.message);
    }
    setBusy(false);
    if (msgError) {
      alert(msgError.message);
      return;
    }
    setText("");
    grow();
    load();
  };

  const handleDelegate = async (agentId, task) => {
    if (!task) return;
    await supabase.from("messages").insert({ agent: agentId, role: "user", content: task });
    await supabase.from("jobs").insert({ repo: "-", kind: "chat", agent: agentId, task });
    setAgent(agentId); // jump to that agent's thread to watch the reply
  };

  const waitingReply =
    messages.length > 0 && messages[messages.length - 1].role === "user";

  return (
    <div className="agents-tab">
      <div className="agent-row">
        <select
          className="repo-input repo-select agent-select"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          {AGENTS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      <div className="thread" ref={threadRef}>
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No messages yet</div>
            <div className="empty-sub">Say hi to {agentLabel}.</div>
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === "assistant") {
              const parsed = parseDelegateBlock(m.content);
              if (parsed) {
                return (
                  <div key={m.id}>
                    {parsed.intro && (
                      <ChatBubble message={{ ...m, content: parsed.intro }} />
                    )}
                    {parsed.delegations.map((d, i) => (
                      <DelegationCard key={i} delegation={d} onSend={handleDelegate} />
                    ))}
                  </div>
                );
              }
            }
            return <ChatBubble key={m.id} message={m} />;
          })
        )}
        {waitingReply && (
          <div className="bubble-row">
            <div className="bubble typing">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}
      </div>

      <div className="composer chat-composer">
        {selectedText && (
          <button className="ask-pill" onClick={askAboutSelection}>
            Ask about the highlighted text
          </button>
        )}
        <div className="input-bar">
          <textarea
            ref={taRef}
            className="task-input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              grow();
            }}
            placeholder={`Message ${agentLabel}…`}
            rows={1}
          />
          <button className="send" onClick={send} disabled={busy} aria-label="send">
            {busy ? <span className="spin" /> : <ArrowUp />}
          </button>
        </div>
        <div className="chat-hint">Tip: start with @jack, @clerk, @scout, @scribe, @pulitzer, or @scholar to switch agent.</div>
      </div>
    </div>
  );
}

/* ─────────────────────────── console ─────────────────────────── */

function Console() {
  const [tab, setTab] = useState("forge");

  return (
    <div className="console">
      <header className="topbar">
        <div className="title">
          <span className="logo-dot sm" />
          Antfarm <span className="accent">Console</span>
        </div>
      </header>

      <div className="tabbar">
        <button
          className={"tab" + (tab === "forge" ? " on" : "")}
          onClick={() => setTab("forge")}
        >
          Forge
        </button>
        <button
          className={"tab" + (tab === "agents" ? " on" : "")}
          onClick={() => setTab("agents")}
        >
          Agents
        </button>
      </div>

      {tab === "forge" ? <ForgeTab /> : <AgentsTab />}
    </div>
  );
}

/* ─────────────────────────── root ─────────────────────────── */

export default function App() {
  return <Console />;
}
