#!/usr/bin/env node
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
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
// as-is, a bare name resolves under ~/Desktop/<name>.
function resolveRepo(value) {
  const raw =
    value.startsWith("/") || value.startsWith("~")
      ? value
      : path.join(os.homedir(), "Desktop", value);
  return expandTilde(raw);
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

async function processQueued() {
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
    const { stdout } = await execFileAsync(ANTFARM_BIN, args, EXEC_OPTS);
    const { commitHash, reviewerNote, diff } = parseForgeOutput(stdout);
    await setJob(job.id, {
      status: "done",
      result_summary: stdout,
      commit_hash: commitHash,
      reviewer_note: reviewerNote,
      diff,
    });
    log(`job ${job.id} -> done`);
  } catch (err) {
    const stderrText = (err.stderr && err.stderr.trim()) || "";
    if (stderrText.includes("NEEDS YOU")) {
      await setJob(job.id, { status: "needs_you", result_summary: stderrText });
      log(`job ${job.id} -> needs_you`);
    } else {
      const text = stderrText || err.message || "unknown error";
      await setJob(job.id, { status: "error", error: text });
      log(`job ${job.id} -> error: ${text}`);
    }
  }

  return true;
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

  // Run a single job at a time: the pod loop clears a shared builder session,
  // so concurrent runs would clobber each other. Each tick fully awaits
  // before the next is scheduled.
  for (;;) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
