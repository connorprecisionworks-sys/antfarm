# antfarm-engine MCP server

Local stdio MCP server that wraps the `ant-farm` headless CLI so Claude Code
and Cowork can trigger the Forge agent crew as native tools, with no GUI and
no networking.

## What it exposes

- `forge_run_pod { repo, task }` — runs the Planner/Builder/Reviewer pod loop. Commits locally only, never pushes.
- `forge_run_spec { repo, scope }` — auto-decomposes a scope and runs the pod loop per item. Commits locally only, never pushes.
- `delegate_agent { agent, task }` — runs a single read/connector agent (jack, clerk, scout, scribe, pulitzer, scholar).
- `list_agents {}` — lists agents from `~/Desktop/antfarm-memory/agents/*/agent.json`. Pure file read, no CLI call.
- `approve_and_push { repo }` — the only tool that pushes. Run this after reviewing the local commit(s) from `forge_run_pod` / `forge_run_spec`.

## Setup

```
cd ~/Desktop/antfarm/src-tauri
cargo build --release
cd ../mcp-server
npm install
```

The server reads `ANTFARM_BIN` to locate the CLI binary, defaulting to
`/Users/connordore/Desktop/antfarm/src-tauri/target/release/ant-farm`. If the
binary is missing at startup the server still starts; each tool call reports
the missing-binary error instead of crashing.

## Register with Claude Code

```
claude mcp add antfarm-engine -- node /Users/connordore/Desktop/antfarm/mcp-server/index.mjs
```

## Register with Cowork desktop

Add an MCP server entry with:

```
command: node
args: ["/Users/connordore/Desktop/antfarm/mcp-server/index.mjs"]
```
