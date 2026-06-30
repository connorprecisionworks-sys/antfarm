#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const ANTFARM_BIN =
  process.env.ANTFARM_BIN ||
  "/Users/connordore/Desktop/antfarm/src-tauri/target/release/ant-farm";
const AGENTS_DIR = path.join(os.homedir(), "Desktop", "antfarm-memory", "agents");
const EXEC_OPTS = { maxBuffer: 50 * 1024 * 1024, timeout: 1200000 };

if (!fs.existsSync(ANTFARM_BIN)) {
  console.error(
    `[antfarm-engine] warning: binary not found at ${ANTFARM_BIN} (set ANTFARM_BIN to override). Tools will report this error when called.`
  );
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

// The CLI prints the result to stdout and diagnostics + the NEEDS YOU reason
// to stderr, exiting 0 on success and 1 on NEEDS YOU/error. Both are valid
// outcomes the caller must see, so this never throws.
async function runBin(args) {
  if (!fs.existsSync(ANTFARM_BIN)) {
    return {
      content: [
        {
          type: "text",
          text: `antfarm binary not found at ${ANTFARM_BIN}. Set ANTFARM_BIN or build it: cd src-tauri && cargo build --release.`,
        },
      ],
    };
  }
  try {
    const { stdout } = await execFileAsync(ANTFARM_BIN, args, EXEC_OPTS);
    return { content: [{ type: "text", text: stdout || "(no output)" }] };
  } catch (err) {
    const text = (err.stderr && err.stderr.trim()) || err.message || "unknown error";
    return { content: [{ type: "text", text }] };
  }
}

const server = new McpServer({ name: "antfarm-engine", version: "1.0.0" });

server.tool(
  "forge_run_pod",
  "Run the Forge Planner/Builder/Reviewer pod loop on a coding task in a repo. " +
    "COMMITS LOCALLY ONLY — it never pushes. On success it leaves a local commit " +
    "with the diff for human review; call approve_and_push afterward to publish. " +
    "May return NEEDS YOU if the pod gets stuck and needs human input — that is a " +
    "normal outcome, not a failure.",
  {
    repo: z.string().describe("Repo name (resolved under ~/Desktop/<name>) or an absolute/~ path"),
    task: z.string().describe("The coding task for the pod to complete"),
  },
  async ({ repo, task }) => runBin(["forge", task, "--repo", repo])
);

server.tool(
  "forge_run_spec",
  "Run spec mode: auto-decomposes a broader scope into items and runs the pod loop " +
    "on each, COMMITTING EACH GREEN ITEM LOCALLY ONLY — it never pushes. Use for " +
    "larger units of work that benefit from being broken down. Review the local " +
    "commits, then call approve_and_push to publish.",
  {
    repo: z.string().describe("Repo name (resolved under ~/Desktop/<name>) or an absolute/~ path"),
    scope: z.string().describe("The broader scope to decompose and implement"),
  },
  async ({ repo, scope }) => runBin(["spec", scope, "--repo", repo])
);

server.tool(
  "delegate_agent",
  "Delegate a task to a read/connector agent (jack, clerk, scout, scribe, pulitzer, " +
    "scholar) for a single response, e.g. research, drafting, or analysis — not code " +
    "writes. Use forge_run_pod for code changes; the builder agent cannot be " +
    "delegated to directly.",
  {
    agent: z.string().describe("Agent id, e.g. jack, clerk, scout, scribe, pulitzer, scholar"),
    task: z.string().describe("The task or question for the agent"),
  },
  async ({ agent, task }) => runBin(["delegate", agent, task])
);

server.tool(
  "list_agents",
  "List the available antfarm agents (id, role, and description) read from local " +
    "agent.json files. Pure local file read, no CLI call.",
  {},
  async () => {
    let entries;
    try {
      entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (err) {
      return {
        content: [{ type: "text", text: `could not read agents dir ${AGENTS_DIR}: ${err.message}` }],
      };
    }
    const agents = [];
    for (const entry of entries) {
      const jsonPath = path.join(AGENTS_DIR, entry.name, "agent.json");
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        agents.push({
          id: entry.name,
          role: data.role ?? null,
          description: data.description ?? data.one_liner ?? null,
        });
      } catch {
        // skip folders without a readable agent.json
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
  }
);

server.tool(
  "approve_and_push",
  "Push the local commits made by forge_run_pod / forge_run_spec to origin. This is " +
    "the ONLY tool that publishes — call it only after the human has reviewed the " +
    "local diff and approves.",
  {
    repo: z.string().describe("Repo name (resolved under ~/Desktop/<name>) or an absolute/~ path"),
  },
  async ({ repo }) => {
    const resolved = resolveRepo(repo);
    if (!fs.existsSync(resolved)) {
      return { content: [{ type: "text", text: `repo not found: ${resolved}` }] };
    }
    try {
      const { stdout, stderr } = await execFileAsync("git", ["-C", resolved, "push"], EXEC_OPTS);
      return {
        content: [{ type: "text", text: [stdout, stderr].filter(Boolean).join("\n") || "(pushed, no output)" }],
      };
    } catch (err) {
      const text = [err.stdout, err.stderr].filter(Boolean).join("\n") || err.message;
      return { content: [{ type: "text", text }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
