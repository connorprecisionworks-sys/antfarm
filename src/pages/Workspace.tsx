import React, {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Activity, BarChart2, Bell, BookOpen, ChevronDown, Globe, Layout, Plus, RefreshCw, SquareTerminal, X } from "lucide-react";
import { GitMetricsRollup, Project, ProjectDetail as PD, RepoPath, SessionMeta, Settings, UsageRollup, WorkspaceEntry } from "../types";
import { MarkdownView } from "../components/MarkdownView";
import { fmtDollars, fmtTokens } from "../lib/relativeTime";

// ── YouTube URL → embed URL ────────────────────────────────────────────────

function toEmbedUrl(raw: string): string {
  let m = raw.match(/(?:youtube\.com\/watch[^#]*[?&]v=)([a-zA-Z0-9_-]{11})/);
  if (m) {
    const list = raw.match(/[?&]list=([^&#]+)/);
    return `https://www.youtube.com/embed/${m[1]}${list ? `?list=${list[1]}` : ""}`;
  }
  m = raw.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = raw.match(/youtube\.com\/playlist[^#]*[?&]list=([^&#]+)/);
  if (m) return `https://www.youtube.com/embed/videoseries?list=${m[1]}`;
  return raw;
}

// ── Save context (panels call this after updating their params) ────────────

const SaveTrigger = React.createContext<() => void>(() => {});

// ── Web / Media pane ───────────────────────────────────────────────────────

interface WebParams { url: string }

function WebPane({ params, api }: IDockviewPanelProps<WebParams>) {
  const save = useContext(SaveTrigger);
  const [input, setInput] = useState(params.url ?? "");
  const [src, setSrc] = useState(params.url ? toEmbedUrl(params.url) : "");

  function navigate(raw: string) {
    const url = toEmbedUrl(raw.trim());
    setSrc(url);
    api.updateParameters({ url: raw.trim() });
    save();
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b]">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-zinc-800 bg-[#111113] shrink-0">
        <Globe size={12} className="text-zinc-600 shrink-0" />
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") navigate(input); }}
          placeholder="Enter URL — YouTube links embed automatically"
          className="flex-1 bg-transparent text-xs text-zinc-300 placeholder-zinc-700 outline-none"
        />
        <button
          onClick={() => navigate(input)}
          className="text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 px-2 py-0.5 rounded transition-colors"
        >
          Go
        </button>
      </div>
      {/* Note: full youtube.com/watch browsing is blocked by X-Frame-Options headers on
          youtube.com. Only youtube.com/embed/ paths work inside an iframe.
          Full webview (non-iframe) browsing comes in WP3. */}
      {src ? (
        <iframe
          key={src}
          src={src}
          className="flex-1 w-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-700">
          Enter a URL above and press Enter or Go
        </div>
      )}
    </div>
  );
}

// ── Project Info pane ──────────────────────────────────────────────────────

interface InfoParams { project_slug: string | null }

function ProjectInfoPane({ params }: IDockviewPanelProps<InfoParams>) {
  const [detail, setDetail] = useState<PD | null | "loading">("loading");

  useEffect(() => {
    const slug = params.project_slug;
    if (!slug) { setDetail(null); return; }
    setDetail("loading");
    invoke<PD | null>("get_project_detail", { slug })
      .then(d => setDetail(d))
      .catch(() => setDetail(null));
  }, [params.project_slug]);

  if (!params.project_slug) {
    return (
      <div className="p-4 text-xs text-zinc-600">
        No project is bound to this workspace.
      </div>
    );
  }
  if (detail === "loading") {
    return <div className="p-4 text-xs text-zinc-500 animate-pulse">Loading…</div>;
  }
  if (!detail) {
    return <div className="p-4 text-xs text-zinc-600">Project not found.</div>;
  }
  return (
    <div className="overflow-y-auto h-full p-4 space-y-4">
      {detail.readme && <MarkdownView content={detail.readme} />}
      {detail.ideas && detail.readme && <hr className="border-zinc-800" />}
      {detail.ideas && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Ideas
          </p>
          <MarkdownView content={detail.ideas} />
        </div>
      )}
      {!detail.readme && !detail.ideas && (
        <p className="text-xs text-zinc-700">No README or ideas found.</p>
      )}
    </div>
  );
}

// ── Terminal pane ──────────────────────────────────────────────────────────

type PaneRole = "shell" | "orchestrator" | "executor";

interface TerminalParams { project_slug: string | null; role?: PaneRole }

// Visual identity per role so it's obvious which pane plans vs which execute.
const ROLE_META: Record<PaneRole, { label: string; accent: string; tint: string }> = {
  orchestrator: { label: "Orchestrator", accent: "#6366f1", tint: "rgba(99,102,241,0.12)" },
  executor:     { label: "Executor",     accent: "#10b981", tint: "rgba(16,185,129,0.10)" },
  shell:        { label: "Terminal",     accent: "#3f3f46", tint: "transparent" },
};

const XTERM_THEME = {
  background:    "#0a0a0b",
  foreground:    "#e4e4e7",
  cursor:        "#a1a1aa",
  cursorAccent:  "#0a0a0b",
  selectionBackground: "rgba(99,102,241,0.3)",
  black:         "#18181b",  brightBlack:   "#3f3f46",
  red:           "#f87171",  brightRed:     "#fb923c",
  green:         "#4ade80",  brightGreen:   "#86efac",
  yellow:        "#facc15",  brightYellow:  "#fde047",
  blue:          "#60a5fa",  brightBlue:    "#93c5fd",
  magenta:       "#c084fc",  brightMagenta: "#d8b4fe",
  cyan:          "#22d3ee",  brightCyan:    "#67e8f9",
  white:         "#e4e4e7",  brightWhite:   "#f4f4f5",
};

function TerminalPane({ params, api }: IDockviewPanelProps<TerminalParams>) {
  const paneId = api.id;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: XTERM_THEME,
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    // Keystroke → PTY stdin
    term.onData(data => {
      invoke("write_pty", { paneId, data }).catch(() => {});
    });

    // PTY stdout → xterm (base64-encoded bytes)
    listen<string>(`pty-output-${paneId}`, event => {
      const b64 = event.payload;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      term.write(bytes);
    }).then(fn => {
      if (mounted) unlisten = fn;
      else fn();
    });

    // Resize observer → fit + resize PTY
    const ro = new ResizeObserver(() => {
      fit.fit();
      invoke("resize_pty", { paneId, cols: Math.max(1, term.cols), rows: Math.max(1, term.rows) })
        .catch(() => {});
    });
    ro.observe(el);

    // Resolve cwd from project_slug (if any), then spawn PTY.
    // Panel is already visible — async cwd resolution never blocks panel creation.
    async function startPty() {
      let cwd = "";
      if (params.project_slug) {
        try {
          const paths = await invoke<RepoPath[]>("get_project_paths", { slug: params.project_slug });
          cwd = paths[0]?.path ?? "";
        } catch { /* Rust spawn_pty falls back to $HOME */ }
      }
      if (!mounted) return;
      requestAnimationFrame(() => {
        if (!mounted) return;
        fit.fit();
        invoke<void>("spawn_pty", {
          paneId,
          cwd,
          cols: Math.max(1, term.cols),
          rows: Math.max(1, term.rows),
          kind: params.role ?? "shell",
        }).catch(err => {
          if (mounted) term.write(`\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`);
        });
      });
    }

    startPty();

    return () => {
      mounted = false;
      ro.disconnect();
      unlisten?.();
      invoke("kill_pty", { paneId }).catch(() => {});
      term.dispose();
    };
  }, [paneId, params.project_slug, params.role]);

  const role: PaneRole = params.role ?? "shell";
  const meta = ROLE_META[role];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", borderTop: `2px solid ${meta.accent}`, boxSizing: "border-box" }}>
      {role !== "shell" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", background: meta.tint, borderBottom: "1px solid #18181b", flexShrink: 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.accent, flexShrink: 0 }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: meta.accent }}>
            {meta.label}
          </span>
          {role === "orchestrator" && (
            <span style={{ fontSize: 10, color: "#71717a" }}>plans and reviews, has brain memory</span>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "4px", boxSizing: "border-box" }}
      />
    </div>
  );
}

// ── Block panes (read-only dashboard widgets) ──────────────────────────────

interface BlockParams {}

function slugToTitle(slug: string) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function BlockShell({
  title,
  icon,
  onRefresh,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  onRefresh?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-[#0a0a0b]">
      <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-zinc-800 bg-[#111113] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-600">{icon}</span>
          <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">{title}</span>
        </div>
        {onRefresh && (
          <button onClick={onRefresh} className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5 rounded">
            <RefreshCw size={11} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-3 min-h-0">{children}</div>
    </div>
  );
}

// ── Usage block ─────────────────────────────────────────────────────────────

function UsageBlock(_: IDockviewPanelProps<BlockParams>) {
  const [status, setStatus] = useState<"loading" | "error" | "ok">("loading");
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  function load() {
    Promise.all([
      invoke<UsageRollup>("usage_rollup"),
      invoke<Settings>("get_settings"),
    ])
      .then(([r, s]) => { setRollup(r); setSettings(s); setStatus("ok"); })
      .catch(() => setStatus("error"));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const capPct = settings && settings.weekly_cap_tokens > 0 && rollup
    ? Math.min(100, (rollup.week.total_tokens / settings.weekly_cap_tokens) * 100)
    : 0;

  return (
    <BlockShell title="Usage" icon={<BarChart2 size={12} />} onRefresh={load}>
      {status === "loading" && <p className="text-xs text-zinc-600 animate-pulse">Loading…</p>}
      {status === "error" && <p className="text-xs text-zinc-600">Unavailable</p>}
      {status === "ok" && rollup && settings && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-zinc-200">{fmtTokens(rollup.week.total_tokens)}</span>
            <span className="text-xs text-zinc-400">{fmtDollars(rollup.week.est_dollars)} est.</span>
          </div>
          {settings.weekly_cap_tokens > 0 ? (
            <>
              <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all"
                  style={{ width: `${capPct}%` }}
                />
              </div>
              <p className="text-[11px] text-zinc-600">
                {capPct.toFixed(1)}% of cap
                {" · "}
                {rollup.week.days_until_reset === 0 ? "resets today" : `resets in ${rollup.week.days_until_reset}d`}
              </p>
            </>
          ) : (
            <p className="text-[11px] text-zinc-600">No cap set</p>
          )}
        </div>
      )}
    </BlockShell>
  );
}

// ── Needs-attention block ────────────────────────────────────────────────────

function NeedsAttentionBlock(_: IDockviewPanelProps<BlockParams>) {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);

  function load() {
    invoke<SessionMeta[]>("list_sessions")
      .then(setSessions)
      .catch(() => setSessions(null));
  }

  useEffect(() => {
    load();
    let unlisten: UnlistenFn | null = null;
    listen("antfarm-events-updated", load).then(fn => { unlisten = fn; });
    const id = setInterval(load, 30_000);
    return () => { clearInterval(id); unlisten?.(); };
  }, []);

  const active = (sessions ?? [])
    .filter(s => s.status === "running" || s.status === "needs_permission" || s.status === "waiting")
    .sort((a, b) => (b.attention ? 1 : 0) - (a.attention ? 1 : 0));

  return (
    <BlockShell title="Needs Attention" icon={<Bell size={12} />} onRefresh={load}>
      {sessions === null && <p className="text-xs text-zinc-600 animate-pulse">Loading…</p>}
      {sessions !== null && active.length === 0 && (
        <p className="text-xs text-zinc-600">No active sessions</p>
      )}
      {sessions !== null && active.length > 0 && (
        <div className="space-y-1">
          {active.map(s => (
            <div
              key={s.id}
              className={[
                "flex items-center gap-2 px-2 py-1.5 rounded-md",
                s.attention ? "bg-amber-500/10 border border-amber-500/20" : "bg-zinc-800/40",
              ].join(" ")}
            >
              <span className={["w-1.5 h-1.5 rounded-full shrink-0", s.attention ? "bg-amber-400" : "bg-emerald-400"].join(" ")} />
              <span className="text-xs text-zinc-300 truncate flex-1 min-w-0">
                {s.project_slug ? slugToTitle(s.project_slug) : "Unfiled"}
              </span>
              <span className={["text-[10px] shrink-0", s.attention ? "text-amber-400" : "text-emerald-400"].join(" ")}>
                {s.status === "needs_permission" ? "needs permission" : s.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </BlockShell>
  );
}

// ── Activity block ───────────────────────────────────────────────────────────

function ActivityBlock(_: IDockviewPanelProps<BlockParams>) {
  const [status, setStatus] = useState<"loading" | "error" | "ok">("loading");
  const [data, setData] = useState<GitMetricsRollup | null>(null);

  function load() {
    invoke<GitMetricsRollup>("git_metrics_rollup")
      .then(d => { setData(d); setStatus("ok"); })
      .catch(() => setStatus("error"));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const projects = data
    ? data.by_project.filter(p => !p.no_data && p.week.commits > 0)
        .sort((a, b) => b.week.commits - a.week.commits)
    : [];

  return (
    <BlockShell title="Activity" icon={<Activity size={12} />} onRefresh={load}>
      {status === "loading" && <p className="text-xs text-zinc-600 animate-pulse">Loading…</p>}
      {status === "error" && <p className="text-xs text-zinc-600">Unavailable</p>}
      {status === "ok" && projects.length === 0 && (
        <p className="text-xs text-zinc-600">No commits this week</p>
      )}
      {status === "ok" && projects.length > 0 && (
        <div className="space-y-2.5">
          {projects.map(p => (
            <div key={p.slug} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-zinc-300 truncate flex-1 min-w-0">{slugToTitle(p.slug)}</span>
                <span className="text-[11px] text-zinc-500 shrink-0">{p.week.commits}c</span>
              </div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-emerald-500">+{p.week.lines_added.toLocaleString()}</span>
                <span className="text-red-400">−{p.week.lines_removed.toLocaleString()}</span>
                {p.last_commit_subject && (
                  <span className="text-zinc-600 truncate flex-1 min-w-0">{p.last_commit_subject}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </BlockShell>
  );
}

const DOCK_COMPONENTS = {
  web: WebPane,
  project_info: ProjectInfoPane,
  terminal: TerminalPane,
  usage_block: UsageBlock,
  needs_attention_block: NeedsAttentionBlock,
  activity_block: ActivityBlock,
} as const;

// ── DockArea ───────────────────────────────────────────────────────────────

type PaneType = "web" | "project_info" | "terminal" | "orchestrator" | "executor" | "usage_block" | "needs_attention_block" | "activity_block";
type GridKind = "2across" | "3across" | "2x2" | "conductor";

interface DockAreaHandle {
  addPane(type: PaneType, slug: string | null): void;
  buildGrid(kind: GridKind, slug: string | null): void;
}

interface DockAreaProps {
  workspace: WorkspaceEntry;
  onLayoutChange: (json: string) => void;
}

const DockArea = forwardRef<DockAreaHandle, DockAreaProps>(function DockArea(
  { workspace, onLayoutChange },
  ref
) {
  const apiRef = useRef<DockviewApi | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPanesRef = useRef<Array<{ type: PaneType; slug: string | null }>>([]);
  const onLayoutChangeRef = useRef(onLayoutChange);
  useEffect(() => { onLayoutChangeRef.current = onLayoutChange; }, [onLayoutChange]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (apiRef.current) {
        onLayoutChangeRef.current(JSON.stringify(apiRef.current.toJSON()));
      }
    }, 500);
  }, []);

  function doAddPanel(api: DockviewApi, type: PaneType, slug: string | null) {
    const id = crypto.randomUUID();
    // New panes TILE to the right of the last pane (a split), never stack as a
    // hidden tab in the active group. Omit position when the dock is empty.
    const existing = api.panels;
    const position = existing.length > 0
      ? { referencePanel: existing[existing.length - 1].id, direction: "right" as const }
      : undefined;
    if (type === "web") {
      api.addPanel({ id, component: "web", params: { url: "" } as WebParams, title: "Web", position });
    } else if (type === "project_info") {
      api.addPanel({ id, component: "project_info", params: { project_slug: slug } as InfoParams, title: "Project Info", position });
    } else if (type === "usage_block") {
      api.addPanel({ id, component: "usage_block", params: {} as BlockParams, title: "Usage", position });
    } else if (type === "needs_attention_block") {
      api.addPanel({ id, component: "needs_attention_block", params: {} as BlockParams, title: "Needs Attention", position });
    } else if (type === "activity_block") {
      api.addPanel({ id, component: "activity_block", params: {} as BlockParams, title: "Activity", position });
    } else {
      const role: PaneRole = type === "orchestrator" ? "orchestrator" : type === "executor" ? "executor" : "shell";
      api.addPanel({ id, component: "terminal", params: { project_slug: slug, role } as TerminalParams, title: ROLE_META[role].label, position });
    }
  }

  // Lay out tiled panes as a grid (no manual dragging needed).
  function buildGridLayout(api: DockviewApi, kind: GridKind, slug: string | null) {
    api.clear();
    const add = (role: PaneRole, position?: { referencePanel: string; direction: "right" | "below" }) => {
      const id = crypto.randomUUID();
      api.addPanel({ id, component: "terminal", params: { project_slug: slug, role } as TerminalParams, title: ROLE_META[role].label, position });
      return id;
    };
    if (kind === "conductor") {
      // Orchestrator on the left, two executors stacked on the right.
      const o = add("orchestrator");
      const e1 = add("executor", { referencePanel: o, direction: "right" });
      add("executor", { referencePanel: e1, direction: "below" });
      return;
    }
    const id1 = add("shell");
    if (kind === "2across") {
      add("shell", { referencePanel: id1, direction: "right" });
    } else if (kind === "3across") {
      const id2 = add("shell", { referencePanel: id1, direction: "right" });
      add("shell", { referencePanel: id2, direction: "right" });
    } else {
      const id2 = add("shell", { referencePanel: id1, direction: "right" });
      add("shell", { referencePanel: id1, direction: "below" });
      add("shell", { referencePanel: id2, direction: "below" });
    }
  }

  useImperativeHandle(ref, () => ({
    addPane(type, slug) {
      if (!apiRef.current) {
        // onReady hasn't fired yet (useEffect timing) — queue for immediate dispatch
        pendingPanesRef.current.push({ type, slug });
        return;
      }
      try {
        doAddPanel(apiRef.current, type, slug);
      } catch (err) {
        console.error("[DockArea] addPanel failed:", err);
      }
    },
    buildGrid(kind, slug) {
      if (!apiRef.current) return;
      try {
        buildGridLayout(apiRef.current, kind, slug);
      } catch (err) {
        console.error("[DockArea] buildGrid failed:", err);
      }
    },
  }));

  function handleReady(event: DockviewReadyEvent) {
    apiRef.current = event.api;
    if (workspace.layout_json) {
      try {
        event.api.fromJSON(JSON.parse(workspace.layout_json));
      } catch {
        // corrupt layout — start fresh
      }
    }
    event.api.onDidLayoutChange(() => scheduleSave());
    // Flush any panels that were queued before onReady fired
    const pending = pendingPanesRef.current.splice(0);
    for (const p of pending) {
      try { doAddPanel(event.api, p.type, p.slug); } catch { /* skip */ }
    }
  }

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return (
    <SaveTrigger.Provider value={scheduleSave}>
      <DockviewReact
        className="h-full dockview-theme-abyss"
        onReady={handleReady}
        components={DOCK_COMPONENTS}
      />
    </SaveTrigger.Provider>
  );
});

// ── Workspace tab ──────────────────────────────────────────────────────────

interface WorkspaceTabProps {
  ws: WorkspaceEntry;
  isActive: boolean;
  onActivate: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
}

function WorkspaceTab({ ws, isActive, onActivate, onRename, onClose }: WorkspaceTabProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ws.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(ws.name);
    setEditing(true);
  }

  function commitEdit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== ws.name) onRename(trimmed);
    setEditing(false);
  }

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  return (
    <div
      className={[
        "relative flex items-center gap-1.5 px-3 h-9 rounded-t-md text-xs cursor-pointer select-none transition-colors group shrink-0 max-w-[180px]",
        isActive
          ? "bg-zinc-800 text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50",
      ].join(" ")}
      onClick={onActivate}
      onDoubleClick={startEdit}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={e => e.stopPropagation()}
          className="bg-transparent outline-none text-zinc-100 w-28 min-w-0 text-xs"
        />
      ) : (
        <span className="truncate flex-1">{ws.name}</span>
      )}
      <button
        onClick={e => { e.stopPropagation(); onClose(); }}
        className={[
          "shrink-0 p-0.5 rounded transition-colors",
          isActive
            ? "text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700"
            : "text-zinc-800 hover:text-zinc-400 opacity-0 group-hover:opacity-100",
        ].join(" ")}
      >
        <X size={11} />
      </button>
    </div>
  );
}

// ── Create workspace form ──────────────────────────────────────────────────

interface CreateFormProps {
  projects: Project[];
  onCreate: (name: string, slug: string | null) => void;
  onCancel: () => void;
}

function CreateWorkspaceForm({ projects, onCreate, onCancel }: CreateFormProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, slug || null);
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80 shrink-0">
      <input
        ref={nameRef}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Workspace name"
        className="bg-zinc-800 text-zinc-100 text-xs px-3 py-1.5 rounded-md outline-none placeholder-zinc-600 w-48 border border-zinc-700 focus:border-zinc-500 transition-colors"
      />
      <select
        value={slug}
        onChange={e => setSlug(e.target.value)}
        className="bg-zinc-800 text-zinc-300 text-xs px-2 py-1.5 rounded-md outline-none border border-zinc-700 focus:border-zinc-500 transition-colors"
      >
        <option value="">— No project —</option>
        {projects.map(p => (
          <option key={p.slug} value={p.slug}>{p.name}</option>
        ))}
      </select>
      <button
        onClick={submit}
        disabled={!name.trim()}
        className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-md transition-colors"
      >
        Create
      </button>
      <button
        onClick={onCancel}
        className="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// ── Grid preset dropdown ───────────────────────────────────────────────────

function GridMenu({ onPick }: { onPick: (kind: GridKind) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const item = (label: string, kind: GridKind, accent?: string) => (
    <button
      onClick={() => { onPick(kind); setOpen(false); }}
      className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
    >
      <Layout size={13} className="shrink-0" style={accent ? { color: accent } : undefined} />
      {label}
    </button>
  );

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800/60 hover:bg-zinc-700 px-3 h-7 rounded-md transition-colors"
      >
        <Layout size={12} />
        Grid
        <ChevronDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-60 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 z-50">
          {item("Conductor: orchestrator + 2 executors", "conductor", "#6366f1")}
          <div className="my-1 border-t border-zinc-700" />
          {item("2 terminals across", "2across")}
          {item("3 terminals across", "3across")}
          {item("2x2 grid (4 terminals)", "2x2")}
        </div>
      )}
    </div>
  );
}

// ── Add pane dropdown ──────────────────────────────────────────────────────

function AddPaneMenu({ onAdd }: { onAdd: (type: PaneType) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800/60 hover:bg-zinc-700 px-3 h-7 rounded-md transition-colors"
      >
        <Plus size={12} />
        Add pane
        <ChevronDown
          size={11}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-52 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 z-50">
          <button
            onClick={() => { onAdd("orchestrator"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <SquareTerminal size={13} className="shrink-0" style={{ color: "#6366f1" }} />
            Orchestrator
          </button>
          <button
            onClick={() => { onAdd("executor"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <SquareTerminal size={13} className="shrink-0" style={{ color: "#10b981" }} />
            Executor (Claude Code)
          </button>
          <div className="my-1 border-t border-zinc-700" />
          <button
            onClick={() => { onAdd("terminal"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <SquareTerminal size={13} className="text-zinc-500 shrink-0" />
            Terminal (shell)
          </button>
          <button
            onClick={() => { onAdd("web"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <Globe size={13} className="text-zinc-500 shrink-0" />
            Web / Media
          </button>
          <button
            onClick={() => { onAdd("project_info"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <BookOpen size={13} className="text-zinc-500 shrink-0" />
            Project Info
          </button>
          <div className="my-1 border-t border-zinc-700" />
          <p className="px-3 pb-1 pt-0.5 text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">Blocks</p>
          <button
            onClick={() => { onAdd("usage_block"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <BarChart2 size={13} className="text-zinc-500 shrink-0" />
            Usage
          </button>
          <button
            onClick={() => { onAdd("needs_attention_block"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <Bell size={13} className="text-zinc-500 shrink-0" />
            Needs Attention
          </button>
          <button
            onClick={() => { onAdd("activity_block"); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <Activity size={13} className="text-zinc-500 shrink-0" />
            Activity
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main Workspace page ────────────────────────────────────────────────────

export function WorkspacePage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const dockRefs = useRef<Record<string, DockAreaHandle | null>>({});

  useEffect(() => {
    invoke<WorkspaceEntry[]>("load_workspaces")
      .then(ws => {
        setWorkspaces(ws);
        if (ws.length > 0) setActiveId(ws[0].id);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));

    invoke<Project[]>("list_projects")
      .then(setProjects)
      .catch(() => {});
  }, []);

  function persist(ws: WorkspaceEntry[]) {
    invoke("save_workspaces", { workspaces: ws }).catch(console.error);
  }

  // Layout changes come from the debounced dockview listener
  const handleLayoutChange = useCallback((wsId: string, layoutJson: string) => {
    setWorkspaces(prev => {
      const updated = prev.map(w => w.id === wsId ? { ...w, layout_json: layoutJson } : w);
      invoke("save_workspaces", { workspaces: updated }).catch(console.error);
      return updated;
    });
  }, []);

  function createWorkspace(name: string, slug: string | null) {
    const id = crypto.randomUUID();
    const updated = [...workspaces, { id, name, project_slug: slug, layout_json: null }];
    setWorkspaces(updated);
    setActiveId(id);
    setIsCreating(false);
    persist(updated);
  }

  function renameWorkspace(id: string, name: string) {
    const updated = workspaces.map(w => w.id === id ? { ...w, name } : w);
    setWorkspaces(updated);
    persist(updated);
  }

  function closeWorkspace(id: string) {
    const idx = workspaces.findIndex(w => w.id === id);
    const updated = workspaces.filter(w => w.id !== id);
    setWorkspaces(updated);
    if (activeId === id) {
      const next = updated.length > 0
        ? (updated[Math.max(0, idx - 1)]?.id ?? updated[0].id)
        : null;
      setActiveId(next);
    }
    persist(updated);
  }

  function handleAddPane(type: PaneType) {
    if (!activeId) return;
    try {
      const ws = workspaces.find(w => w.id === activeId) ?? null;
      const slug = ws?.project_slug ?? null;
      const ref = dockRefs.current[activeId];
      if (!ref) {
        console.error("[WorkspacePage] addPane: DockArea ref not ready");
        return;
      }
      ref.addPane(type, slug);
    } catch (err) {
      console.error("[WorkspacePage] handleAddPane failed:", err);
    }
  }

  function handleBuildGrid(kind: GridKind) {
    if (!activeId) return;
    const ws = workspaces.find(w => w.id === activeId) ?? null;
    const slug = ws?.project_slug ?? null;
    dockRefs.current[activeId]?.buildGrid(kind, slug);
  }

  const activeWorkspace = workspaces.find(w => w.id === activeId) ?? null;

  if (!loaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-zinc-600 animate-pulse">Loading workspaces…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar — outer row does NOT clip; only the tab strip scrolls.
          The Add pane dropdown lives OUTSIDE the scroll container so it
          isn't clipped by overflow (that clipping was hiding the menu). */}
      <div className="flex items-center gap-0.5 px-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0 h-11">
        <div className="flex items-center gap-0.5 overflow-x-auto min-w-0 flex-1">
          {workspaces.map(ws => (
            <WorkspaceTab
              key={ws.id}
              ws={ws}
              isActive={ws.id === activeId}
              onActivate={() => setActiveId(ws.id)}
              onRename={name => renameWorkspace(ws.id, name)}
              onClose={() => closeWorkspace(ws.id)}
            />
          ))}
          <button
            onClick={() => setIsCreating(true)}
            title="New workspace"
            className="flex items-center justify-center w-7 h-7 text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 rounded-md transition-colors shrink-0 ml-1"
          >
            <Plus size={14} />
          </button>
        </div>
        {activeWorkspace && (
          <div className="pl-3 shrink-0 flex items-center gap-2">
            <GridMenu onPick={handleBuildGrid} />
            <AddPaneMenu onAdd={handleAddPane} />
          </div>
        )}
      </div>

      {/* New workspace form */}
      {isCreating && (
        <CreateWorkspaceForm
          projects={projects}
          onCreate={createWorkspace}
          onCancel={() => setIsCreating(false)}
        />
      )}

      {/* Empty state */}
      {!activeWorkspace && !isCreating && (
        <div className="flex flex-col flex-1 items-center justify-center gap-4">
          <Layout size={36} className="text-zinc-800" />
          <div className="text-center">
            <p className="text-sm text-zinc-400 mb-1">No workspaces yet</p>
            <p className="text-xs text-zinc-600">Create one to arrange panes for your projects</p>
          </div>
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            <Plus size={13} />
            New Workspace
          </button>
        </div>
      )}

      {/* Dock areas — one per workspace, visibility-toggled so PTYs stay alive */}
      {workspaces.map(ws => (
        <div
          key={ws.id}
          className="flex-1 min-h-0 overflow-hidden"
          style={{ display: ws.id === activeId ? undefined : "none" }}
        >
          <DockArea
            ref={el => { dockRefs.current[ws.id] = el; }}
            workspace={ws}
            onLayoutChange={json => handleLayoutChange(ws.id, json)}
          />
        </div>
      ))}
    </div>
  );
}
