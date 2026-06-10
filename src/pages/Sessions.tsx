import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionMeta } from "../types";
import { SessionRow } from "../components/SessionRow";

function prettifySlug(slug: string) {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Sessions() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);

  function fetchSessions() {
    invoke<SessionMeta[]>("list_sessions")
      .then((s) => {
        setSessions(s);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    fetchSessions();
    let unlisten: (() => void) | undefined;
    listen("antfarm-events-updated", () => {
      invoke<SessionMeta[]>("list_sessions")
        .then(setSessions)
        .catch(() => {});
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500 animate-pulse">Loading sessions…</p>
      </div>
    );
  }

  const byProject: Record<string, SessionMeta[]> = {};
  const unfiled: SessionMeta[] = [];
  for (const s of sessions) {
    if (s.project_slug) {
      (byProject[s.project_slug] ??= []).push(s);
    } else {
      unfiled.push(s);
    }
  }

  const slugs = Object.keys(byProject).sort((a, b) => {
    const aMax = Math.max(...byProject[a].map((s) => s.last_activity));
    const bMax = Math.max(...byProject[b].map((s) => s.last_activity));
    return bMax - aMax;
  });

  const needsYouCount = sessions.filter((s) => s.attention).length;
  const activeCount = sessions.filter((s) => s.status === "running").length;

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">Sessions</h1>
          {needsYouCount > 0 && (
            <span className="text-xs bg-amber-900/50 text-amber-400 font-medium px-2 py-0.5 rounded-full">
              {needsYouCount} need you
            </span>
          )}
          {activeCount > 0 && (
            <span className="text-xs bg-emerald-900/50 text-emerald-400 px-2 py-0.5 rounded-full">
              {activeCount} active
            </span>
          )}
          <span className="text-xs text-zinc-600 ml-auto">{sessions.length} total</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-8">
        {slugs.map((slug) => (
          <div key={slug}>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider px-3 mb-1">
              {prettifySlug(slug)}
              <span className="ml-2 font-normal normal-case text-zinc-600">
                {byProject[slug].length}
              </span>
            </h3>
            {byProject[slug].map((s) => (
              <SessionRow key={`${s.provider}:${s.id}`} session={s} />
            ))}
          </div>
        ))}

        <div>
          <h3 className="text-xs font-semibold text-zinc-600 uppercase tracking-wider px-3 mb-1">
            Unfiled
            <span className="ml-2 font-normal normal-case">{unfiled.length}</span>
          </h3>
          {unfiled.length === 0 ? (
            <p className="text-xs text-zinc-700 px-3 py-2">No unfiled sessions.</p>
          ) : (
            unfiled.map((s) => (
              <SessionRow key={`${s.provider}:${s.id}`} session={s} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
