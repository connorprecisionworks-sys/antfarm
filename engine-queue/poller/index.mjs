#!/usr/bin/env node
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTFARM_BIN =
  process.env.ANTFARM_BIN ||
  "/Users/connordore/Desktop/antfarm/src-tauri/target/release/ant-farm";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;

// Chat (Agents tab): how far back to pull prior messages as context, and how
// long messages live before periodic cleanup deletes them.
const CHAT_MEMORY_HOURS = Number(process.env.CHAT_MEMORY_HOURS) || 12;
const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS) || 3;

// Roots scanned for git repos that get published to the `repos` table so the
// console can show a dropdown. Override with REPO_ROOTS (comma-separated).
const REPO_ROOTS = (process.env.REPO_ROOTS || path.join(os.homedir(), "Desktop"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REPO_SCAN_INTERVAL_MS = 60000;

// Friendly labels shown in the dropdown, and name aliases so "roastlytics"
// resolves to the roast-dash folder. Extend freely.
const REPO_LABELS = {
  "roast-dash": "Roastlytics",
  antfarm: "Antfarm",
  "antfarm-write-test": "Antfarm Test",
  "connordore-com": "connordore.com",
};
const REPO_ALIASES = { roastlytics: "roast-dash" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[antfarm-poller] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const EXEC_OPTS = { maxBuffer: 50 * 1024 * 1024, timeout: 1200000 };

function log(...parts) {
  console.error(`[${new Date().toISOString()}]`, ...parts);
}

function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Mirrors resolve_cli_repo in src-tauri/src/main.rs: absolute/~ paths are used
// as-is, a bare name resolves under ~/Desktop/<name>. Also applies friendly
// aliases (e.g. "roastlytics" -> "roast-dash") before resolving.
function resolveRepo(value) {
  const trimmed = (value || "").trim();
  const aliased = REPO_ALIASES[trimmed.toLowerCase()] || trimmed;
  const raw =
    aliased.startsWith("/") || aliased.startsWith("~")
      ? aliased
      : path.join(os.homedir(), "Desktop", aliased);
  return expandTilde(raw);
}

// Scan the configured roots for git repos and publish them to the `repos`
// table so the console can offer a dropdown instead of free-text entry.
function findRepos() {
  const found = [];
  for (const root of REPO_ROOTS) {
    const dir = expandTilde(root);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, ".git"))) {
        found.push({ name: e.name, path: full, label: REPO_LABELS[e.name] || e.name });
      }
    }
  }
  return found;
}

async function publishRepos() {
  const repos = findRepos();
  if (!repos.length) return;
  const rows = repos.map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const { error } = await supabase.from("repos").upsert(rows, { onConflict: "name" });
  if (error) log("repo publish failed:", error.message);
  else log(`published ${rows.length} repos`);
}

// Best-effort scrape of the antfarm CLI's stdout for forge runs. See
// run_cli's "forge" branch in src-tauri/src/main.rs for the exact format:
// "Committed locally: <hash>\n\nCommit message: ...\n\nReviewer note:\n<note>\n\nDiff:\n<diff>"
function parseForgeOutput(stdout) {
  let commitHash = null;
  let reviewerNote = null;
  let diff = null;

  const commitMatch = stdout.match(/Committed locally:\s*([^\n]+)/);
  if (commitMatch) commitHash = commitMatch[1].trim();

  const noteIdx = stdout.indexOf("Reviewer note:");
  const diffIdx = stdout.indexOf("Diff:");
  if (noteIdx !== -1) {
    const noteEnd = diffIdx !== -1 ? diffIdx : stdout.length;
    reviewerNote = stdout.slice(noteIdx + "Reviewer note:".length, noteEnd).trim();
  }
  if (diffIdx !== -1) {
    diff = stdout.slice(diffIdx + "Diff:".length).trim();
  }

  return { commitHash, reviewerNote, diff };
}

// Deletes messages older than CHAT_RETENTION_DAYS so the Agents tab's chat
// memory stays short-lived. Run on the same interval as the repo scan.
async function cleanupMessages() {
  const cutoff = new Date(Date.now() - CHAT_RETENTION_DAYS * 86400 * 1000).toISOString();
  const { error } = await supabase.from("messages").delete().lt("created_at", cutoff);
  if (error) log("message cleanup failed:", error.message);
}

async function setJob(id, fields) {
  const { error } = await supabase.from("jobs").update(fields).eq("id", id);
  if (error) {
    log(`failed to update job ${id}:`, error.message);
  }
}

async function processApproval() {
  const { data: rows, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    log("approval query failed:", error.message);
    return false;
  }
  const job = rows && rows[0];
  if (!job) return false;

  const repoPath = resolveRepo(job.repo);
  log(`job ${job.id} [${job.kind}] repo=${job.repo} -> pushing`);

  try {
    await execFileAsync("git", ["-C", repoPath, "push"], EXEC_OPTS);
    await setJob(job.id, { status: "pushed" });
    log(`job ${job.id} -> pushed`);
  } catch (err) {
    const text = (err.stderr && err.stderr.trim()) || err.message || "unknown push error";
    await setJob(job.id, { status: "error", error: text });
    log(`job ${job.id} -> error (push failed): ${text}`);
  }

  return true;
}

// Chat jobs (Agents tab) are handled ahead of forge/spec/delegate so
// conversation stays snappy even when a long pod/spec run is queued behind
// it — the poller is still strictly one job at a time overall.
async function processChatQueued() {
  const { data: rows, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "queued")
    .eq("kind", "chat")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    log("chat queued query failed:", error.message);
    return false;
  }
  const job = rows && rows[0];
  if (!job) return false;

  await setJob(job.id, { status: "running" });
  log(`job ${job.id} [chat] agent=${job.agent} -> running`);

  const sinceIso = new Date(Date.now() - CHAT_MEMORY_HOURS * 3600 * 1000).toISOString();
  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("*")
    .eq("agent", job.agent)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (historyError) {
    await setJob(job.id, { status: "error", error: historyError.message });
    log(`job ${job.id} -> error (history fetch failed): ${historyError.message}`);
    return true;
  }

  const transcript = (history || [])
    .map((m) => `${m.role === "user" ? "User" : job.agent}: ${m.content}`)
    .join("\n\n");

  try {
    const { stdout } = await execFileAsync(ANTFARM_BIN, ["delegate", job.agent, transcript], EXEC_OPTS);
    const reply = stdout.trim();
    await supabase.from("messages").insert({ agent: job.agent, role: "assistant", content: reply });
    await setJob(job.id, { status: "done", result_summary: reply });
    log(`job ${job.id} -> done`);
  } catch (err) {
    const text = (err.stderr && err.stderr.trim()) || err.message || "unknown error";
    await supabase.from("messages").insert({ agent: job.agent, role: "assistant", content: text });
    await setJob(job.id, { status: "error", error: text });
    log(`job ${job.id} -> error: ${text}`);
  }

  return true;
}

async function processQueued() {
  const handledChat = await processChatQueued();
  if (handledChat) return true;

  const { data: rows, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) {
    log("queued query failed:", error.message);
    return false;
  }
  const job = rows && rows[0];
  if (!job) return false;

  await setJob(job.id, { status: "running" });
  log(`job ${job.id} [${job.kind}] repo=${job.repo} -> running`);

  let args;
  if (job.kind === "forge") {
    args = ["forge", job.task, "--repo", job.repo];
  } else if (job.kind === "spec") {
    args = ["spec", job.task, "--repo", job.repo];
  } else if (job.kind === "delegate") {
    args = ["delegate", job.agent, job.task];
  } else {
    await setJob(job.id, { status: "error", error: `unknown job kind: ${job.kind}` });
    log(`job ${job.id} -> error (unknown kind ${job.kind})`);
    return true;
  }

  try {
    const { code, stdout, stderr } = await runAntfarmStreamed(args, job.id);
    if (code === 0) {
      const { commitHash, reviewerNote, diff } = parseForgeOutput(stdout);
      await setJob(job.id, {
        status: "done",
        result_summary: stdout,
        commit_hash: commitHash,
        reviewer_note: reviewerNote,
        diff,
        current_phase: "done",
      });
      log(`job ${job.id} -> done`);
    } else if (stderr.includes("NEEDS YOU")) {
      await setJob(job.id, { status: "needs_you", result_summary: stderr });
      log(`job ${job.id} -> needs_you`);
    } else {
      const text = stderr || `antfarm exited with code ${code}`;
      await setJob(job.id, { status: "error", error: text });
      log(`job ${job.id} -> error: ${text}`);
    }
  } catch (err) {
    const text = err.message || "unknown error";
    await setJob(job.id, { status: "error", error: text });
    log(`job ${job.id} -> error: ${text}`);
  }

  return true;
}

// Spawns the antfarm binary and streams stderr line-by-line, watching for
// "[STEP]\t<phase>\t<text>" lines emitted by pod.rs/spec.rs so the console's
// current_phase/steps columns update live while the job runs.
function runAntfarmStreamed(args, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(ANTFARM_BIN, args, EXEC_OPTS);

    let stdout = "";
    let stderr = "";
    let stderrBuf = "";
    const steps = [];

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrBuf += text;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop();
      for (const line of lines) {
        const match = line.match(/^\[STEP\]\t([^\t]*)\t(.*)$/);
        if (!match) continue;
        const [, phase, stepText] = match;
        steps.push({ phase, text: stepText, ts: new Date().toISOString() });
        supabase
          .from("jobs")
          .update({ current_phase: phase, steps })
          .eq("id", jobId)
          .then(({ error }) => {
            if (error) log(`failed to update job ${jobId} step:`, error.message);
          });
      }
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function tick() {
  try {
    const pushed = await processApproval();
    if (pushed) return;

    await processQueued();
  } catch (err) {
    log("unexpected error in poll tick:", err.message || err);
  }
}

async function main() {
  if (!fs.existsSync(ANTFARM_BIN)) {
    log(`warning: antfarm binary not found at ${ANTFARM_BIN}. Jobs will error until it is built.`);
  }
  log(`antfarm engine queue poller started. polling every ${POLL_INTERVAL_MS}ms.`);

  // Publish the repo list now and refresh it periodically. Reuse the same
  // interval to sweep out expired chat messages.
  await publishRepos();
  await cleanupMessages();
  setInterval(() => {
    publishRepos().catch((e) => log("repo scan error:", e.message || e));
    cleanupMessages().catch((e) => log("message cleanup error:", e.message || e));
  }, REPO_SCAN_INTERVAL_MS);

  // Run a single job at a time: the pod loop clears a shared builder session,
  // so concurrent runs would clobber each other. Each tick fully awaits
  // before the next is scheduled.
  for (;;) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
