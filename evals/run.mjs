#!/usr/bin/env node
// Antfarm eval suite runner — see /Users/connordore/Desktop/antfarm-memory/tools-built/ant-farm/eval-suite-v1.md
// for the case spec this implements. Each case runs in a fresh, disposable
// git worktree of a dogfood repo (never a live project repo) so the crew's
// real writes/commits can be inspected and thrown away.

import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CASES_DIR = path.join(HERE, "cases");
const RESULTS_DIR = path.join(HERE, "results");

const ANTFARM_BIN =
  process.env.ANTFARM_BIN ||
  "/Users/connordore/Desktop/antfarm/src-tauri/target/release/ant-farm";

const DEFAULT_TIMEOUT_MS = 1200000; // 20 min — pod loops run real agent turns
const EXEC_MAX_BUFFER = 50 * 1024 * 1024;

// `delegate` (jack/scout/scribe/...) takes no --repo — it reads/writes
// agents.rs's vault_root(), which now honors ANTFARM_VAULT_ROOT. By default,
// livesInVault cases run against a throwaway copy of the real vault (made
// once per eval run — see makeScratchVault) so real delegate read/write
// behavior gets exercised without ever touching Connor's live vault. Set
// EVAL_ALLOW_LIVE_VAULT=1 as an escape hatch to target the real vault instead.
const ALLOW_LIVE_VAULT = process.env.EVAL_ALLOW_LIVE_VAULT === "1";
const VAULT_ROOT = path.join(os.homedir(), "Desktop", "antfarm-memory");

function makeScratchVault() {
  const dir = path.join(os.tmpdir(), `antfarm-eval-vault-${randomUUID()}`);
  execFileSync("cp", ["-R", VAULT_ROOT, dir]);
  return dir;
}

function removeScratchVault(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ── Safety: resolve + guard the dogfood repo ─────────────────────────────────

function resolveDogfood() {
  const raw = process.env.EVAL_DOGFOOD || "antfarm-write-test";
  const expanded =
    raw.startsWith("/") || raw.startsWith("~")
      ? expandTilde(raw)
      : path.join(os.homedir(), "Desktop", raw);
  const resolved = path.resolve(expanded);

  if (resolved === REPO_ROOT) {
    throw new Error(
      `refusing to run evals against the live antfarm repo itself (${resolved}). ` +
        `Set EVAL_DOGFOOD to a disposable repo.`
    );
  }
  if (!fs.existsSync(path.join(resolved, ".git"))) {
    throw new Error(`dogfood repo not found or not a git repo: ${resolved}`);
  }
  return resolved;
}

function isDogfoodWebApp(dogfoodPath) {
  const pkgPath = path.join(dogfoodPath, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return false;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const webDeps = ["react", "vue", "svelte", "next", "vite", "@angular/core"];
  const hasWebDep = webDeps.some((d) => deps[d]);
  const hasDevScript = !!(pkg.scripts && (pkg.scripts.dev || pkg.scripts.start));
  const hasRoutesDir = ["routes", "pages", "src/routes", "src/pages"].some((d) =>
    fs.existsSync(path.join(dogfoodPath, d))
  );
  return hasWebDep && (hasDevScript || hasRoutesDir);
}

// ── Worktree lifecycle ────────────────────────────────────────────────────────

function createWorktree(dogfoodPath) {
  try {
    execFileSync("git", ["-C", dogfoodPath, "worktree", "prune"]);
  } catch {
    // best effort
  }
  const dir = path.join(os.tmpdir(), `antfarm-eval-${randomUUID()}`);
  execFileSync("git", ["-C", dogfoodPath, "worktree", "add", "--detach", dir, "HEAD"]);
  return dir;
}

function removeWorktree(dogfoodPath, dir) {
  try {
    execFileSync("git", ["-C", dogfoodPath, "worktree", "remove", "--force", dir]);
  } catch (e) {
    log(`warning: git worktree remove failed for ${dir}: ${e.message}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ── Setup DSL ─────────────────────────────────────────────────────────────────
// setup[] entries: { op: "write"|"mkdir"|"rm", path, content?, root? }
// root defaults to "repo" (the disposable worktree); root: "vault" targets
// whichever vault root the case resolved to (the scratch copy by default,
// or VAULT_ROOT itself under EVAL_ALLOW_LIVE_VAULT=1). Any file written under
// "vault" is tracked in vaultWrites so it can be deleted again after the case
// runs — the real vault has no worktree to throw away (the scratch copy is
// deleted wholesale after the run instead, so this only matters for the
// EVAL_ALLOW_LIVE_VAULT=1 escape hatch).

function applySetup(dirs, setup, vaultWrites) {
  for (const step of setup || []) {
    const base = dirs[step.root || "repo"];
    const target = path.join(base, step.path);
    if (step.op === "write") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, step.content ?? "");
      if (step.root === "vault") vaultWrites.push(target);
    } else if (step.op === "mkdir") {
      fs.mkdirSync(target, { recursive: true });
    } else if (step.op === "rm") {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      throw new Error(`unknown setup op: ${step.op}`);
    }
  }
}

// Commits whatever setup[] produced so the run has a clean baseline to diff
// against. No-op if setup left the tree clean (e.g. cases with no setup).
function commitBaseline(worktreeDir) {
  const status = execFileSync("git", ["-C", worktreeDir, "status", "--porcelain"]).toString();
  if (status.trim()) {
    execFileSync("git", ["-C", worktreeDir, "add", "-A"]);
    execFileSync("git", [
      "-C",
      worktreeDir,
      "-c",
      "user.email=eval@antfarm.local",
      "-c",
      "user.name=antfarm-eval",
      "commit",
      "-m",
      "eval setup",
      "--no-verify",
    ]);
  }
  return execFileSync("git", ["-C", worktreeDir, "rev-parse", "HEAD"]).toString().trim();
}

// Everything the run touched relative to the baseline, committed or not.
function computeChangedFiles(worktreeDir, baselineSha) {
  execFileSync("git", ["-C", worktreeDir, "add", "-A"]);
  const out = execFileSync("git", [
    "-C",
    worktreeDir,
    "diff",
    "--cached",
    "--name-only",
    baselineSha,
  ]).toString();
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Glob helpers (no deps) ───────────────────────────────────────────────────

function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

function matchesAnyGlob(filePath, patterns) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  return pats.some((p) => globToRegExp(p).test(filePath));
}

function findFiles(root, pattern) {
  const re = globToRegExp(pattern);
  const matches = [];
  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, relPath);
      } else if (re.test(relPath)) {
        matches.push(relPath);
      }
    }
  }
  walk(root, "");
  return matches;
}

// ── Running the antfarm CLI ──────────────────────────────────────────────────

function runCli(bin, args, cwd, envExtra, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: { ...process.env, ...(envExtra || {}) },
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut: !!(error && error.killed),
        });
      }
    );
  });
}

async function runLlmGrader(combined, promptTemplate) {
  const filled = promptTemplate.replace("{output}", combined.slice(0, 8000));
  const fullPrompt = `${filled}\n\nReply PASS or FAIL and one short reason.`;
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["-p", fullPrompt, "--model", "claude-haiku-4-5-20251001"],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ pass: false, evidence: `llm grader failed to run: ${error.message}` });
          return;
        }
        const text = stdout.trim();
        const m = text.match(/\b(PASS|FAIL)\b/i);
        const verdict = m ? m[1].toUpperCase() : null;
        resolve({
          pass: verdict === "PASS",
          evidence: text.slice(0, 240) || "(empty llm grader response)",
        });
      }
    );
  });
}

// ── Grader registry — declarative primitives referenced from case JSON ──────

const GRADERS = {
  output_matches: (ctx, [pattern, flags]) => {
    const re = new RegExp(pattern, flags || "i");
    const hit = re.test(ctx.combined);
    return { pass: hit, evidence: hit ? `matched /${pattern}/` : `no match for /${pattern}/` };
  },
  output_not_matches: (ctx, [pattern, flags]) => {
    const re = new RegExp(pattern, flags || "i");
    const hit = re.test(ctx.combined);
    return {
      pass: !hit,
      evidence: hit ? `unexpected match for /${pattern}/` : `no match for /${pattern}/ (as required)`,
    };
  },
  has_marker: (ctx, args) => GRADERS.output_matches(ctx, args),
  no_marker: (ctx, args) => GRADERS.output_not_matches(ctx, args),
  exit_code: (ctx, [n]) => ({
    pass: ctx.exitCode === n,
    evidence: `exit code ${ctx.exitCode} (expected ${n})`,
  }),
  diff_only: (ctx, [patterns]) => {
    const bad = ctx.changedFiles.filter((f) => !matchesAnyGlob(f, patterns));
    return {
      pass: bad.length === 0,
      evidence: bad.length
        ? `unexpected changed files: ${bad.join(", ")}`
        : `changed files (${ctx.changedFiles.join(", ") || "none"}) all match ${
            Array.isArray(patterns) ? patterns.join("|") : patterns
          }`,
    };
  },
  diff_file_count_max: (ctx, [n]) => ({
    pass: ctx.changedFiles.length <= n,
    evidence: `${ctx.changedFiles.length} file(s) changed (max ${n})`,
  }),
  diff_file_count_min: (ctx, [n]) => ({
    pass: ctx.changedFiles.length >= n,
    evidence: `${ctx.changedFiles.length} file(s) changed (min ${n})`,
  }),
  plan_steps_max: (ctx, [n]) => {
    const matches = ctx.combined.match(/^\s*\d+[.)]\s+.+$/gm) || [];
    return {
      pass: matches.length <= n,
      evidence: `${matches.length} numbered step line(s) found in output (max ${n})`,
    };
  },
  file_absent: (ctx, [pattern]) => {
    const found = findFiles(ctx.worktreeDir, pattern);
    return {
      pass: found.length === 0,
      evidence: found.length ? `found unexpected file(s): ${found.join(", ")}` : `no files matching ${pattern}`,
    };
  },
  dir_count_stable: (ctx, [pattern]) => {
    const before = ctx.preRunCounts[pattern] ?? 0;
    const after = findFiles(ctx.worktreeDir, pattern).length;
    return { pass: before === after, evidence: `${pattern}: ${before} file(s) before run, ${after} after` };
  },
  dir_count_stable_vault: (ctx, [pattern]) => {
    const before = ctx.preRunVaultCounts[pattern] ?? 0;
    const after = findFiles(ctx.vaultRoot, pattern).length;
    return { pass: before === after, evidence: `${pattern} (vault): ${before} file(s) before run, ${after} after` };
  },
  llm_grade: async (ctx, [prompt]) => {
    if (!ctx.case.llm_grader) {
      return { pass: true, skipped: true, evidence: "skipped (case.llm_grader is not true)" };
    }
    return runLlmGrader(ctx.combined, prompt);
  },
};

// Engine diagnostic lines ([pod]/[antfarm]/[STEP] narration, dispatch's
// claude-path resolution log, the worktree-add banner) share stderr with
// planner/builder/reviewer prose. Several of those engine lines legitimately
// use em dashes themselves (e.g. "READY TO PUSH — commit=..."), so scanning
// raw combined output for voice violations false-fails every case regardless
// of what the agents actually wrote. Strip those lines out before grading
// voice — everything else (agent prose, commit message, reviewer note, diff)
// passes through untouched.
const ENGINE_LOG_PREFIXES = ["[pod]", "[antfarm]", "[STEP]", "antfarm dispatch:", "Preparing worktree"];

function stripAgentText(combined) {
  const lines = combined
    .split("\n")
    .filter((line) => !ENGINE_LOG_PREFIXES.some((p) => line.replace(/^\s+/, "").startsWith(p)));

  // main.rs prints the raw `git diff HEAD` output under a standalone "Diff:"
  // line — that's committed file content (e.g. a README bullet the Builder
  // wrote), not agent voice, so cut it before grading the voice check.
  const diffIdx = lines.findIndex((line) => line.trim() === "Diff:");
  const voiceLines = diffIdx === -1 ? lines : lines.slice(0, diffIdx);

  return voiceLines.join("\n");
}

// Cross-cutting case 12 (no-ai-tell): applied to every case's captured
// output, not a standalone case file. Any hit anywhere fails that case.
// Graded against agent-authored text only (see stripAgentText above) — NOT
// raw combined, which is reserved for marker graders (NEEDS YOU, "Committed
// locally:", exit_code) that legitimately need the engine's own output.
const NO_AI_TELL_PATTERNS = [
  { name: "em dash character", re: /—/ },
  { name: "banned AI-tell phrase", re: /\b(delve|it's important to note|game-changer|in the realm of)\b/i },
];

function checkNoAiTell(agentText) {
  for (const p of NO_AI_TELL_PATTERNS) {
    if (p.re.test(agentText)) {
      return { pass: false, evidence: `no-ai-tell: found ${p.name}` };
    }
  }
  return { pass: true, evidence: "no-ai-tell: clean" };
}

// ── Case loading ──────────────────────────────────────────────────────────────

function loadCases() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), "utf8")));
}

// ── Per-case execution ────────────────────────────────────────────────────────

async function runCase(kase, dogfoodPath, scratchVaultRoot) {
  const result = {
    id: kase.id,
    guards: kase.guards || [],
    status: "PASS",
    evidence: [],
    startedAt: new Date().toISOString(),
  };

  if (kase.requiresWebApp && !isDogfoodWebApp(dogfoodPath)) {
    result.status = "SKIPPED";
    result.evidence.push(
      `dogfood repo (${dogfoodPath}) is not a web app with routes — a web dogfood repo is needed to run this case (set EVAL_DOGFOOD).`
    );
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // livesInVault cases target a throwaway copy of the vault by default (see
  // makeScratchVault in main) so delegate's real read/write behavior gets
  // exercised without touching Connor's live vault. If the fixture couldn't
  // be created, skip rather than fall back to the real vault silently.
  const vaultRootForCase = kase.livesInVault
    ? ALLOW_LIVE_VAULT
      ? VAULT_ROOT
      : scratchVaultRoot
    : VAULT_ROOT;

  if (kase.livesInVault && !ALLOW_LIVE_VAULT && !vaultRootForCase) {
    result.status = "SKIPPED";
    result.evidence.push(
      `vault fixture unavailable — could not create a throwaway copy of ${VAULT_ROOT} for this run.`
    );
    result.finishedAt = new Date().toISOString();
    return result;
  }

  let worktreeDir = null;
  const vaultWrites = [];
  try {
    worktreeDir = createWorktree(dogfoodPath);
    applySetup({ repo: worktreeDir, vault: vaultRootForCase }, kase.setup, vaultWrites);
    const baselineSha = commitBaseline(worktreeDir);

    const preRunCounts = {};
    const preRunVaultCounts = {};
    for (const p of kase.pass || []) {
      if (p.grader === "dir_count_stable") {
        preRunCounts[p.args[0]] = findFiles(worktreeDir, p.args[0]).length;
      } else if (p.grader === "dir_count_stable_vault") {
        preRunVaultCounts[p.args[0]] = findFiles(vaultRootForCase, p.args[0]).length;
      }
    }

    const args = (kase.cli || []).map((tok) => (tok === "{repo}" ? worktreeDir : tok));
    const envExtra = { ...(kase.env || {}) };
    if (kase.livesInVault && !ALLOW_LIVE_VAULT) {
      envExtra.ANTFARM_VAULT_ROOT = vaultRootForCase;
    }
    const run = await runCli(ANTFARM_BIN, args, worktreeDir, envExtra, kase.timeoutMs);
    const combined = `${run.stdout}\n${run.stderr}`;
    const agentText = stripAgentText(combined);
    const changedFiles = computeChangedFiles(worktreeDir, baselineSha);

    const ctx = {
      case: kase,
      ...run,
      combined,
      changedFiles,
      worktreeDir,
      vaultRoot: vaultRootForCase,
      preRunCounts,
      preRunVaultCounts,
    };

    let allPass = true;
    for (const p of kase.pass || []) {
      const fn = GRADERS[p.grader];
      if (!fn) {
        allPass = false;
        result.evidence.push(`FAIL unknown grader "${p.grader}"`);
        continue;
      }
      const verdict = await fn(ctx, p.args || []);
      if (verdict.skipped) {
        result.evidence.push(`(skipped) ${p.grader}: ${verdict.evidence}`);
        continue;
      }
      result.evidence.push(`${verdict.pass ? "ok" : "FAIL"} ${p.grader}: ${verdict.evidence}`);
      if (!verdict.pass) allPass = false;
    }

    const tellCheck = checkNoAiTell(agentText);
    result.evidence.push(`${tellCheck.pass ? "ok" : "FAIL"} ${tellCheck.evidence}`);
    if (!tellCheck.pass) allPass = false;

    result.status = allPass ? "PASS" : "FAIL";
    result.exitCode = run.exitCode;
    result.changedFiles = changedFiles;
    // Tail, not head: the meaningful verdict (Committed locally / NEEDS YOU /
    // an error) lands at the end of the captured output.
    result.stdoutExcerpt = run.stdout.slice(-4000);
    result.stderrExcerpt = run.stderr.slice(-4000);
  } catch (e) {
    result.status = "FAIL";
    result.evidence.push(`FAIL runner error: ${e.message}`);
  } finally {
    if (worktreeDir) removeWorktree(dogfoodPath, worktreeDir);
    // The vault has no worktree to throw away — undo exactly the files this
    // case's setup wrote there, and nothing else.
    for (const f of vaultWrites) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort
      }
    }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dogfoodPath = resolveDogfood();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  if (!fs.existsSync(ANTFARM_BIN)) {
    console.error(`antfarm binary not found at ${ANTFARM_BIN} (set ANTFARM_BIN to override)`);
    process.exit(1);
  }

  const cases = loadCases();
  if (!cases.length) {
    console.error(`no eval cases found under ${CASES_DIR}/*.json`);
    process.exit(1);
  }

  log(`antfarm eval suite — ${cases.length} case(s), dogfood=${dogfoodPath}`);

  // One throwaway vault copy for the whole run, shared by every livesInVault
  // case — cheaper than re-copying per case and matches how a real vault
  // accumulates state across a session.
  let scratchVaultRoot = null;
  if (cases.some((k) => k.livesInVault) && !ALLOW_LIVE_VAULT) {
    try {
      scratchVaultRoot = makeScratchVault();
      log(`vault fixture: copied ${VAULT_ROOT} -> ${scratchVaultRoot} for livesInVault cases`);
    } catch (e) {
      log(`warning: could not create vault fixture (${e.message}) — livesInVault cases will be skipped`);
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsPath = path.join(RESULTS_DIR, `${runId}.json`);
  const results = [];

  try {
    for (const kase of cases) {
      log(`▸ running ${kase.id}...`);
      const result = await runCase(kase, dogfoodPath, scratchVaultRoot);
      results.push(result);
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      log(`  ${result.status} — ${result.evidence[result.evidence.length - 1] || ""}`);
    }
  } finally {
    if (scratchVaultRoot) removeScratchVault(scratchVaultRoot);
  }

  console.log("\n── scorecard ──");
  let failures = 0;
  for (const r of results) {
    const evidence = r.evidence.find((e) => e.startsWith("FAIL")) || r.evidence[0] || "";
    console.log(`[${r.status}] ${r.id} — ${evidence}`);
    if (r.status === "FAIL") failures++;
  }
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  console.log(`\n${passed}/${results.length} passed, ${skipped} skipped, ${failures} failed`);
  console.log(`results written to ${resultsPath}`);

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("eval runner crashed:", e);
  process.exit(1);
});
