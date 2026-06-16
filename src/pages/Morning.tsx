import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import { RefreshCw } from "lucide-react";

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; markdown: string }
  | { phase: "error"; message: string };

export function Morning() {
  const [state, setState] = useState<State>({ phase: "idle" });

  function run() {
    setState({ phase: "loading" });
    invoke<string>("generate_morning_briefing")
      .then((md) => setState({ phase: "done", markdown: md }))
      .catch((e) => setState({ phase: "error", message: String(e) }));
  }

  useEffect(() => {
    run();
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
        <h1 className="text-base font-semibold text-zinc-100">Morning</h1>
        {state.phase !== "loading" && (
          <button
            onClick={run}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <RefreshCw size={13} strokeWidth={1.75} />
            Refresh
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {state.phase === "loading" && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-zinc-400">
            <svg
              className="animate-spin"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <p className="text-sm">Pulling your Whoop and your day...</p>
          </div>
        )}

        {state.phase === "done" && (
          <div className="prose prose-invert prose-sm max-w-2xl mx-auto">
            <ReactMarkdown>{state.markdown}</ReactMarkdown>
          </div>
        )}

        {state.phase === "error" && (
          <div className="max-w-lg mx-auto mt-8 rounded-xl border border-red-900/50 bg-red-950/20 p-4">
            <p className="text-sm font-medium text-red-400 mb-1">Briefing failed</p>
            <p className="text-xs text-red-300/70 font-mono break-all">{state.message}</p>
            <button
              onClick={run}
              className="mt-3 text-xs text-red-400 hover:text-red-200 underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
