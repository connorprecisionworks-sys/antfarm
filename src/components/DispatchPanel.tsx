import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RunRecord, RunEvent } from "../types";

interface LogEntry {
  label: string;
  text: string;
}

// Distil a stream-json line into something human-readable.
function summarizeLine(raw: string): LogEntry {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw); } catch { return { label: "raw", text: raw }; }
  if (obj.type === "system" && obj.subtype === "init") {
    return { label: "init", text: `session ${(obj.session_id as string) ?? ""} started` };
  }
  if (obj.type === "assistant") {
    const blocks = ((obj.message as Record<string, unknown>)?.content as unknown[]) ?? [];
    const text = blocks
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        if (block.type === "tool_use") return `[tool: ${block.name}]`;
        return "";
      })
      .join(" ")
      .trim();
    return { label: "agent", text };
  }
  if (obj.type === "result") {
    const cost = obj.total_cost_usd != null ? ` · $${(obj.total_cost_usd as number).toFixed(4)}` : "";
    const dur  = obj.duration_ms  != null ? ` · ${((obj.duration_ms as number) / 1000).toFixed(1)}s` : "";
    return { label: "result", text: `${(obj.subtype as string) ?? "finished"}${cost}${dur}` };
  }
  return { label: (obj.type as string) ?? "event", text: raw.slice(0, 200) };
}

const LABEL_COLOR: Record<string, string> = {
  init:   "text-zinc-500",
  agent:  "text-indigo-400",
  result: "text-emerald-400",
  stderr: "text-rose-400",
  raw:    "text-zinc-600",
};

const STATUS_STYLE: Record<string, string> = {
  running: "bg-emerald-900/50 text-emerald-400",
  done:    "bg-zinc-800 text-zinc-400",
  failed:  "bg-rose-900/50 text-rose-400",
  killed:  "bg-zinc-800 text-zinc-500",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[status] ?? "bg-zinc-800 text-zinc-400"}`}>
      {status}
    </span>
  );
}

interface Props {
  projectPath: string;
}

export function DispatchPanel({ projectPath }: Props) {
  const [prompt,      setPrompt]      = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [permMode,    setPermMode]    = useState("acceptEdits");
  const [run,         setRun]         = useState<RunRecord | null>(null);
  const [log,         setLog]         = useState<LogEntry[]>([]);
  const [error,       setError]       = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const runIdRef  = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<RunEvent>("antfarm-run-event", (event) => {
      const ev = event.payload;
      if (ev.runId !== runIdRef.current) return;
      if (ev.kind === "line") {
        setLog((prev) => [...prev, summarizeLine(ev.payload)]);
      } else if (ev.kind === "stderr") {
        setLog((prev) => [...prev, { label: "stderr", text: ev.payload }]);
      } else if (ev.kind === "status") {
        setRun((prev) => prev ? { ...prev, status: ev.payload as RunRecord["status"] } : prev);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  async function startRun() {
    if (!prompt.trim()) return;
    setError(null);
    setLog([]);
    try {
      const rec = await invoke<RunRecord>("dispatch_run", {
        projectPath,
        prompt,
        useWorktree,
        permissionMode: permMode,
      });
      runIdRef.current = rec.runId;
      setRun(rec);
    } catch (e) { setError(String(e)); }
  }

  async function killRun() {
    if (!run) return;
    try { await invoke("kill_run", { runId: run.runId }); }
    catch (e) { setError(String(e)); }
  }

  async function takeOver() {
    if (!run) return;
    try { await invoke("take_over_run", { runId: run.runId }); }
    catch (e) { setError(String(e)); }
  }

  const isRunning = run?.status === "running";

  return (
    <div className="space-y-4">
      {/* Prompt */}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder='Describe the task — e.g. "Run the test suite and fix any failures."'
        rows={3}
        disabled={isRunning}
        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none focus:border-zinc-500 disabled:opacity-50 transition-colors"
      />

      {/* Controls row */}
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => setUseWorktree(e.target.checked)}
            disabled={isRunning}
            className="rounded accent-indigo-500"
          />
          Isolate in git worktree
        </label>

        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Mode</span>
          <select
            value={permMode}
            onChange={(e) => setPermMode(e.target.value)}
            disabled={isRunning}
            className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 focus:outline-none focus:border-zinc-600 disabled:opacity-50"
          >
            <option value="acceptEdits">Exploratory (acceptEdits)</option>
            <option value="dontAsk">Deterministic (dontAsk)</option>
          </select>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {!isRunning ? (
            <button
              onClick={startRun}
              disabled={!prompt.trim()}
              className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Dispatch
            </button>
          ) : (
            <button
              onClick={killRun}
              className="text-xs px-3 py-1.5 bg-rose-900/60 hover:bg-rose-800/60 text-rose-300 rounded-md transition-colors"
            >
              Stop
            </button>
          )}
          {run?.sessionId && (
            <button
              onClick={takeOver}
              title="Open Terminal and resume this session"
              className="text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
            >
              Take over
            </button>
          )}
        </div>
      </div>

      {/* Status line */}
      {run && (
        <div className="flex items-center gap-2 text-xs">
          <StatusBadge status={run.status} />
          <span className="text-zinc-600 font-mono">{run.runId}</span>
          {run.usedWorktree && <span className="text-zinc-600">· worktree</span>}
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-600">{run.permissionMode}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-rose-400 bg-rose-900/20 rounded-md px-3 py-2">{error}</p>
      )}

      {/* Live log */}
      {log.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 max-h-72 overflow-y-auto font-mono text-xs space-y-0.5">
          {log.map((entry, i) => (
            <div key={i} className="flex gap-2 min-w-0">
              <span className={`shrink-0 w-14 text-right ${LABEL_COLOR[entry.label] ?? "text-zinc-500"}`}>
                {entry.label}
              </span>
              <span className="text-zinc-400 break-all leading-relaxed">{entry.text}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
}
