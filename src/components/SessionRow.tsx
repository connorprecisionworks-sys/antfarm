import { SessionMeta } from "../types";
import { relativeTime, fmtDollars } from "../lib/relativeTime";

const STATUS_COLORS: Record<string, string> = {
  running: "bg-emerald-400 animate-pulse",
  needs_permission: "bg-amber-400",
  waiting: "bg-amber-300",
  idle: "bg-zinc-500",
  done: "bg-zinc-700",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  needs_permission: "Needs permission",
  waiting: "Waiting on you",
  idle: "Idle",
  done: "Done",
};

const STATUS_TEXT: Record<string, string> = {
  needs_permission: "text-amber-400 font-medium",
  waiting: "text-amber-300",
};

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status] ?? STATUS_COLORS.done}`}
    />
  );
}

export function SessionRow({ session }: { session: SessionMeta }) {
  const title = session.title ?? session.id.slice(0, 8);
  return (
    <div className="flex items-center gap-3 px-3 py-2 hover:bg-zinc-800/40 rounded-lg transition-colors">
      <StatusDot status={session.status} />
      <span className={`text-xs w-[6.5rem] shrink-0 ${STATUS_TEXT[session.status] ?? "text-zinc-500"}`}>
        {STATUS_LABELS[session.status] ?? session.status}
      </span>
      <span className="flex-1 text-sm text-zinc-200 truncate min-w-0">{title}</span>
      <span
        className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
          session.provider === "cowork"
            ? "bg-violet-900/50 text-violet-300"
            : "bg-zinc-800 text-zinc-500"
        }`}
      >
        {session.provider === "cowork" ? "cowork" : "code"}
      </span>
      {session.token_totals ? (
        <span className="text-xs text-zinc-600 w-14 text-right shrink-0">
          {fmtDollars(session.token_totals.est_dollars)}
        </span>
      ) : (
        <span className="w-14 shrink-0" />
      )}
      <span className="text-xs text-zinc-600 w-20 text-right shrink-0">
        {relativeTime(session.last_activity)}
      </span>
    </div>
  );
}
