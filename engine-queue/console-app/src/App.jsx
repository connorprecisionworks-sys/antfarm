import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, LOGIN_EMAIL } from "./supabase.js";

const PIN_LENGTH = 6;
const KINDS = ["forge", "spec", "delegate"];

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
  const [agent, setAgent] = useState("");
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
      agent: kind === "delegate" ? agent.trim() || null : null,
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
        {kind === "delegate" && (
          <input
            className="agent-input"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="agent (jack, clerk…)"
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

/* ─────────────────────────── console ─────────────────────────── */

function Console() {
  const [jobs, setJobs] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(40);
    if (!error) setJobs(data || []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const active = () =>
      jobs.some((j) => ["queued", "running", "approved"].includes(j.status));
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]); // eslint-disable-line

  const approve = async (jobId) => {
    setJobs((js) =>
      js.map((j) => (j.id === jobId ? { ...j, status: "approved" } : j))
    );
    await supabase.from("jobs").update({ status: "approved", approved: true }).eq("id", jobId);
    load();
  };

  return (
    <div className="console">
      <header className="topbar">
        <div className="title">
          <span className="logo-dot sm" />
          Antfarm <span className="accent">Console</span>
        </div>
      </header>

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
    </div>
  );
}

/* ─────────────────────────── root ─────────────────────────── */

export default function App() {
  return <Console />;
}
