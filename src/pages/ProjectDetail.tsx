import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, FileText } from "lucide-react";
import { ProjectDetail as PD, SessionMeta, GitMetricsRollup, ProjectGitMetrics } from "../types";
import { relativeTime, fmtNet } from "../lib/relativeTime";
import { MarkdownView } from "../components/MarkdownView";
import { SessionRow } from "../components/SessionRow";

type Tab = "overview" | "ideas" | "notes" | "sessions";

export function ProjectDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [detail, setDetail] = useState<PD | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [noteContent, setNoteContent] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [projSessions, setProjSessions] = useState<SessionMeta[] | null>(null);
  const [gitMetrics, setGitMetrics] = useState<ProjectGitMetrics | null | undefined>(undefined);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setDetail(null);
    setNotFound(false);
    setTab("overview");
    setNoteContent(null);
    setSelectedNote(null);
    setProjSessions(null);
    setGitMetrics(undefined);
    invoke<GitMetricsRollup>("git_metrics_rollup")
      .then((data) => {
        const found = data.by_project.find((m) => m.slug === slug) ?? null;
        setGitMetrics(found);
      })
      .catch(() => setGitMetrics(null));
    invoke<PD | null>("get_project_detail", { slug })
      .then((d) => {
        if (!d) setNotFound(true);
        else setDetail(d);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [slug]);

  useEffect(() => {
    if (tab === "sessions" && slug && projSessions === null) {
      invoke<SessionMeta[]>("list_sessions")
        .then((all) => setProjSessions(all.filter((s) => s.project_slug === slug)))
        .catch(() => setProjSessions([]));
    }
  }, [tab, slug, projSessions]);

  function openNote(filename: string) {
    if (!slug) return;
    setSelectedNote(filename);
    setNoteContent(null);
    invoke<string | null>("get_file_content", { slug, filename }).then((c) => {
      setNoteContent(c ?? "");
    });
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500 animate-pulse">Loading…</p>
      </div>
    );
  }

  if (notFound || !detail) {
    return (
      <div className="p-6">
        <Link to="/projects" className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-4">
          <ChevronLeft size={14} /> Projects
        </Link>
        <p className="text-sm text-zinc-400">Project not found.</p>
      </div>
    );
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "ideas", label: "Ideas" },
    { id: "notes", label: `Notes${detail.notes_files.length ? ` (${detail.notes_files.length})` : ""}` },
    { id: "sessions", label: "Sessions" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-0 border-b border-zinc-800 shrink-0">
        <Link
          to="/projects"
          className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 mb-3 w-fit"
        >
          <ChevronLeft size={14} /> Projects
        </Link>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 mb-1">{detail.name}</h1>
            <div className="flex flex-wrap items-center gap-3">
              {detail.status && (
                <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full">
                  {detail.status}
                </span>
              )}
              <span className="text-xs text-zinc-500">
                {relativeTime(detail.last_activity)}
              </span>
              {detail.repos.map((r) => (
                <span key={r} className="text-xs text-zinc-500 font-mono bg-zinc-900 px-1.5 py-0.5 rounded">
                  {r}
                </span>
              ))}
            </div>
            <GitSummaryLine metrics={gitMetrics} />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => {
                setTab(id);
                if (id !== "notes") {
                  setSelectedNote(null);
                  setNoteContent(null);
                }
              }}
              className={[
                "px-3 py-2 text-xs font-medium rounded-t-md transition-colors",
                tab === id
                  ? "text-zinc-100 border-b-2 border-indigo-500"
                  : "text-zinc-500 hover:text-zinc-300",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "overview" && (
          detail.readme ? (
            <MarkdownView content={detail.readme} className="max-w-2xl" />
          ) : (
            <EmptyState message="No README found for this project." />
          )
        )}

        {tab === "ideas" && (
          detail.ideas ? (
            <MarkdownView content={detail.ideas} className="max-w-2xl" />
          ) : (
            <EmptyState message="No ideas.md found for this project." />
          )
        )}

        {tab === "notes" && (
          <div className="flex gap-6 max-w-4xl">
            {/* File list */}
            <div className="w-56 shrink-0">
              {detail.notes_files.length === 0 ? (
                <EmptyState message="No notes/ folder for this project." />
              ) : (
                <ul className="space-y-1">
                  {detail.notes_files.map((f) => (
                    <li key={f}>
                      <button
                        onClick={() => openNote(f)}
                        className={[
                          "flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors",
                          selectedNote === f
                            ? "bg-zinc-800 text-zinc-100"
                            : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50",
                        ].join(" ")}
                      >
                        <FileText size={12} className="shrink-0" />
                        {f}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* File preview */}
            <div className="flex-1 min-w-0">
              {selectedNote === null && detail.notes_files.length > 0 && (
                <p className="text-sm text-zinc-600">Select a file to preview.</p>
              )}
              {selectedNote !== null && noteContent === null && (
                <p className="text-sm text-zinc-500 animate-pulse">Loading…</p>
              )}
              {selectedNote !== null && noteContent !== null && (
                noteContent === "" ? (
                  <EmptyState message="File is empty." />
                ) : (
                  <MarkdownView content={noteContent} />
                )
              )}
            </div>
          </div>
        )}

        {tab === "sessions" && (
          projSessions === null ? (
            <p className="text-sm text-zinc-500 animate-pulse">Loading…</p>
          ) : projSessions.length === 0 ? (
            <EmptyState message="No sessions found for this project." />
          ) : (
            <div className="-mx-3">
              {projSessions.map((s) => (
                <SessionRow key={`${s.provider}:${s.id}`} session={s} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="text-sm text-zinc-600">{message}</p>;
}

function GitSummaryLine({ metrics }: { metrics: ProjectGitMetrics | null | undefined }) {
  if (metrics === undefined) return null; // still loading
  if (metrics === null || metrics.no_data) {
    return <p className="text-xs text-zinc-600 mt-1">no git data</p>;
  }
  const net = metrics.week.lines_added - metrics.week.lines_removed;
  const parts: string[] = [];
  if (metrics.week.commits > 0) {
    parts.push(`${metrics.week.commits} commit${metrics.week.commits !== 1 ? "s" : ""} this week`);
    parts.push(`${fmtNet(net)} lines`);
  }
  if (metrics.last_commit_ts) {
    const subj = metrics.last_commit_subject
      ? ` — ${metrics.last_commit_subject.slice(0, 72)}`
      : "";
    parts.push(`${relativeTime(metrics.last_commit_ts)}${subj}`);
  }
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-zinc-500 mt-1 truncate max-w-lg">
      {parts.join(" · ")}
    </p>
  );
}
