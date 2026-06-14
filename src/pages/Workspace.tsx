import React, {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  DockviewReact,
  DockviewDefaultTab,
  DockviewReadyEvent,
  IDockviewPanelProps,
  IDockviewPanelHeaderProps,
  DockviewApi,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Activity, BarChart2, Bell, BookOpen, ChevronDown, Globe, Layout, Monitor, Plus, SquareTerminal, X, Zap } from "lucide-react";
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

// ── Skills / slash-command menu ────────────────────────────────────────────

interface SlashCommand {
  name: string;
  description: string;
}

function SkillsMenu({ paneId }: { paneId: string }) {
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<SlashCommand[]>("list_slash_commands")
      .then(cmds => setCommands(cmds))
      .catch(() => setCommands([]));
  }, []);

  // Autofocus search and reset query each time the popover opens
  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  function openMenu() {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(o => !o);
  }

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  // Insert the command with a trailing space so the user can add args before pressing Enter
  function insertSkill(name: string) {
    invoke("write_pty", { paneId, data: `/${name} ` }).catch(() => {});
    setOpen(false);
  }

  const SHIP_NOTE = "Opens PRs — not available in this flow";

  const q = query.trim().toLowerCase();
  const filtered = commands
    ? commands.filter(cmd => {
        if (!q) return true;
        return cmd.name.toLowerCase().includes(q) || cmd.description.toLowerCase().includes(q);
      })
    : [];

  const dropdown = open && createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        width: 340,
        background: "#1c1c1e",
        border: "1px solid #3f3f46",
        borderRadius: 10,
        boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Search input */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #2d2d30", flexShrink: 0 }}>
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search skills…"
          style={{
            width: "100%",
            background: "#27272a",
            border: "1px solid #3f3f46",
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 12,
            color: "#e4e4e7",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {/* Skill list */}
      <div style={{ overflowY: "auto", maxHeight: 360 }}>
        {commands === null ? (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "#52525b" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "#52525b" }}>
            {q ? "No matches" : "No skills found"}
          </div>
        ) : (
          filtered.map(cmd => {
            const isShip = cmd.name === "ship";
            const desc = isShip ? SHIP_NOTE : cmd.description;
            return (
              <button
                key={cmd.name}
                disabled={isShip}
                onClick={() => { if (!isShip) insertSkill(cmd.name); }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 12px",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid #27272a",
                  cursor: isShip ? "not-allowed" : "pointer",
                  opacity: isShip ? 0.4 : 1,
                }}
                className="hover:bg-zinc-800"
              >
                <div style={{ fontSize: 12, color: "#e4e4e7", fontFamily: "monospace", fontWeight: 600 }}>
                  /{cmd.name}
                </div>
                {desc && (
                  <div style={{
                    fontSize: 11,
                    color: "#71717a",
                    marginTop: 2,
                    lineHeight: 1.4,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  } as React.CSSProperties}>
                    {desc}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={openMenu}
        title="Browse and insert a skill"
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 3,
          fontSize: 10,
          color: open ? "#a1a1aa" : "#71717a",
          background: "transparent",
          border: "1px solid #3f3f46",
          borderRadius: 4,
          padding: "1px 6px",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <Zap size={9} />
        Skills
        <ChevronDown size={8} style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }} />
      </button>
      {dropdown}
    </>
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
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 6px", background: meta.tint, borderBottom: "1px solid #18181b", flexShrink: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.accent, flexShrink: 0 }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: meta.accent }}>
            {meta.label}
          </span>
          {role === "orchestrator" && (
            <span style={{ fontSize: 10, color: "#71717a" }}>plans and reviews, has brain memory</span>
          )}
          <SkillsMenu paneId={paneId} />
        </div>
      )}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "4px", boxSizing: "border-box" }}
      />
    </div>
  );
}

// ── Custom tab: double-click to maximize/restore ───────────────────────────

function PanelTab(props: IDockviewPanelHeaderProps) {
  function handleDoubleClick() {
    if (props.api.isMaximized()) {
      props.api.exitMaximized();
    } else {
      props.api.maximize();
    }
  }
  return <DockviewDefaultTab {...props} onDoubleClick={handleDoubleClick} />;
}

// ── Even-out layout helper ─────────────────────────────────────────────────
// Accesses the internal gridview directly to call BranchNode.resizeChild(),
// which routes to splitview.resizeView() — the real in-place resize path.
// fromJSON(reuseExistingPanels) ignores serialized sizes so it cannot be used.

function evenOutPanes(api: DockviewApi) {
  if (api.groups.length <= 1) return;

  const gridview = (api as any).component?.gridview;
  if (!gridview) return;

  const root = (api.toJSON() as any)?.grid?.root;
  if (!root) return;

  // Walk the JSON tree top-down. For each branch node, get the matching
  // BranchNode from gridview (by location = path of child indices from root)
  // and redistribute its children to equal sizes via resizeChild().
  // Top-down order is required: resizing an outer branch propagates new
  // orthogonal sizes to inner branches proportionally, then we redistribute
  // those inner branches' children on the next step.
  function processNode(node: any, location: number[]) {
    if (node.type !== 'branch') return;
    const children: any[] = node.data ?? [];
    const n = children.length;

    if (n >= 2) {
      try {
        const [, branchNode] = gridview.getNode(location) as [any, any];
        let total = 0;
        for (let i = 0; i < n; i++) total += (branchNode.getChildSize(i) as number);
        const each = Math.floor(total / n);
        // Set children 0..N-2 to equal size; N-1 absorbs the rounding remainder.
        for (let i = 0; i < n - 1; i++) {
          branchNode.resizeChild(i, each);
        }
      } catch {
        // getNode can throw for stale locations; skip silently
      }
    }

    // Recurse into child branches AFTER resizing (top-down order)
    children.forEach((child: any, i: number) => processNode(child, [...location, i]));
  }

  processNode(root, []);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function slugToTitle(slug: string) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function fmtLines(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const DOCK_COMPONENTS = {
  web: WebPane,
  project_info: ProjectInfoPane,
  terminal: TerminalPane,
} as const;

// ── DockArea ───────────────────────────────────────────────────────────────

type PaneType = "web" | "project_info" | "terminal" | "orchestrator" | "executor";
type GridKind = "2across" | "3across" | "2x2" | "conductor";

interface DockAreaHandle {
  addPane(type: PaneType, slug: string | null): void;
  buildGrid(kind: GridKind, slug: string | null): void;
  evenOut(): void;
}

interface DockAreaProps {
  workspace: WorkspaceEntry;
  onLayoutChange: (json: string) => void;
}

const TERM_CONSTRAINTS = { minimumWidth: 320, minimumHeight: 160 } as const;

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
    } else {
      const role: PaneRole = type === "orchestrator" ? "orchestrator" : type === "executor" ? "executor" : "shell";
      const panel = api.addPanel({ id, component: "terminal", params: { project_slug: slug, role } as TerminalParams, title: ROLE_META[role].label, position });
      panel.api.setConstraints(TERM_CONSTRAINTS);
    }
  }

  // Lay out tiled panes as a grid (no manual dragging needed).
  function buildGridLayout(api: DockviewApi, kind: GridKind, slug: string | null) {
    const totalWidth = api.width || 800;
    api.clear();
    const add = (role: PaneRole, position?: { referencePanel: string; direction: "right" | "below" }, initialWidth?: number) => {
      const id = crypto.randomUUID();
      const panel = api.addPanel({ id, component: "terminal", params: { project_slug: slug, role } as TerminalParams, title: ROLE_META[role].label, position, initialWidth });
      panel.api.setConstraints(TERM_CONSTRAINTS);
      return id;
    };
    if (kind === "conductor") {
      // Orchestrator gets ~50% width; two executors split the other half.
      const half = Math.round(totalWidth * 0.5);
      const o = add("orchestrator", undefined, half);
      const e1 = add("executor", { referencePanel: o, direction: "right" }, half);
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
    evenOut() {
      if (!apiRef.current) return;
      try {
        evenOutPanes(apiRef.current);
      } catch (err) {
        console.error("[DockArea] evenOut failed:", err);
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
        defaultTabComponent={PanelTab}
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

function GridMenu({ onPick, onEvenOut }: { onPick: (kind: GridKind) => void; onEvenOut: () => void }) {
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
          <button
            onClick={() => { onEvenOut(); setOpen(false); }}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <Layout size={13} className="shrink-0 text-zinc-400" />
            Even out panes
          </button>
          <div className="my-1 border-t border-zinc-700" />
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
        </div>
      )}
    </div>
  );
}

// ── Open localhost button ──────────────────────────────────────────────────

function OpenLocalhostButton({ wsId }: { wsId: string }) {
  const storageKey = `localhost-port-${wsId}`;
  const [port, setPort] = useState<number>(() => {
    const n = parseInt(localStorage.getItem(storageKey) ?? "", 10);
    return !isNaN(n) && n >= 1 && n <= 65535 ? n : 5173;
  });
  const [portInput, setPortInput] = useState(String(port));

  function commitPort(raw: string) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= 65535) {
      setPort(n);
      setPortInput(String(n));
      localStorage.setItem(storageKey, String(n));
    } else {
      setPortInput(String(port));
    }
  }

  function openInBrowser() {
    shellOpen(`http://localhost:${port}`).catch(() => {});
  }

  return (
    <div className="flex items-center h-7 rounded-md bg-zinc-800/60 border border-zinc-700/50 overflow-hidden">
      <button
        onClick={openInBrowser}
        title={`Open http://localhost:${port} in browser`}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 px-2 h-full transition-colors"
      >
        <Monitor size={12} />
        <span>localhost:</span>
      </button>
      <input
        value={portInput}
        onChange={e => setPortInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={() => commitPort(portInput)}
        className="w-10 bg-transparent text-xs text-zinc-300 outline-none tabular-nums text-center"
        title="Edit port"
      />
      <button
        onClick={openInBrowser}
        title={`Open http://localhost:${port} in browser`}
        className="flex items-center px-2 h-full text-xs text-zinc-500 hover:text-zinc-200 border-l border-zinc-700/50 transition-colors"
      >
        ↗
      </button>
    </div>
  );
}

// ── Workspace HUD ──────────────────────────────────────────────────────────

function WorkspaceHud() {
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [gitData, setGitData] = useState<GitMetricsRollup | null>(null);

  function loadUsage() {
    Promise.all([invoke<UsageRollup>("usage_rollup"), invoke<Settings>("get_settings")])
      .then(([r, s]) => { setRollup(r); setSettings(s); })
      .catch(() => {});
  }
  function loadSessions() {
    invoke<SessionMeta[]>("list_sessions").then(setSessions).catch(() => {});
  }
  function loadGit() {
    invoke<GitMetricsRollup>("git_metrics_rollup").then(setGitData).catch(() => {});
  }

  useEffect(() => {
    loadUsage();
    loadSessions();
    loadGit();
    const ids = [setInterval(loadUsage, 30_000), setInterval(loadSessions, 30_000), setInterval(loadGit, 30_000)];
    let unlisten: UnlistenFn | null = null;
    listen("antfarm-events-updated", loadSessions).then(fn => { unlisten = fn; });
    return () => { ids.forEach(clearInterval); unlisten?.(); };
  }, []);

  const capPct = settings && settings.weekly_cap_tokens > 0 && rollup
    ? Math.min(100, (rollup.week.total_tokens / settings.weekly_cap_tokens) * 100)
    : 0;

  const attentionSessions = sessions?.filter(s => s.attention) ?? [];
  const activeSessions = sessions?.filter(s => s.status === "running" || s.status === "needs_permission" || s.status === "waiting") ?? [];
  const hasAttention = attentionSessions.length > 0;

  const topProject = gitData?.by_project
    .filter(p => !p.no_data && p.week.commits > 0)
    .sort((a, b) => b.week.commits - a.week.commits)[0] ?? null;

  const divider = <div className="w-px h-4 bg-zinc-800 shrink-0 mx-2" />;

  return (
    <div className="flex items-center h-10 px-3 border-b border-zinc-800 bg-[#0d0d0f] shrink-0 overflow-hidden">

      {/* ── Usage ── */}
      <div className="flex items-center gap-2 shrink-0">
        <BarChart2 size={11} className="text-zinc-600 shrink-0" />
        {rollup && settings ? (
          <>
            <span className="text-xs text-zinc-300 tabular-nums font-medium">{fmtTokens(rollup.week.total_tokens)}</span>
            <span className="text-[11px] text-zinc-500 tabular-nums">{fmtDollars(rollup.week.est_dollars)}</span>
            {settings.weekly_cap_tokens > 0 && (
              <div className="flex items-center gap-1.5">
                <div className="w-14 h-[3px] bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all"
                    style={{ width: `${capPct}%` }}
                  />
                </div>
                <span className="text-[10px] text-zinc-600 tabular-nums">{capPct.toFixed(0)}%</span>
              </div>
            )}
          </>
        ) : (
          <span className="text-[11px] text-zinc-700">—</span>
        )}
      </div>

      {divider}

      {/* ── Needs attention ── */}
      <div className={["flex items-center gap-1.5 shrink-0", hasAttention ? "text-amber-400" : "text-zinc-500"].join(" ")}>
        <Bell size={11} className="shrink-0" />
        {sessions !== null ? (
          <span className="text-[11px] tabular-nums">
            {hasAttention
              ? `${attentionSessions.length} needs you`
              : activeSessions.length > 0
                ? `${activeSessions.length} running`
                : "quiet"}
          </span>
        ) : (
          <span className="text-[11px]">—</span>
        )}
      </div>

      {divider}

      {/* ── Activity (most active project) — can truncate ── */}
      <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
        <Activity size={11} className="text-zinc-600 shrink-0" />
        {topProject ? (
          <span className="text-[11px] text-zinc-400 truncate tabular-nums">
            {slugToTitle(topProject.slug)}&nbsp;{topProject.week.commits}c&nbsp;+{fmtLines(topProject.week.lines_added)}
          </span>
        ) : (
          <span className="text-[11px] text-zinc-700">—</span>
        )}
      </div>

    </div>
  );
}

// ── Harness types ─────────────────────────────────────────────────────────────

interface HStepState {
  stepId: string;
  status: string;
  attempts: number;
  costUsd: number;
  sessionId?: string;
  acceptOutputTail?: string;
  permissionDenials: number;
  prompt: string;
}

interface HRunState {
  runId: string;
  status: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  costUsd: number;
  steps: HStepState[];
  goal: string;
  summary: string;
  reviewVerdict: string;
  reviewNotes: string;
}

interface HPlanState {
  planId: string;
  status: string;
  costUsd: number;
  runs: HRunState[];
  updatedAt: number;
}

interface RunEntry {
  planId: string;
  run: HRunState;
  sortKey: number;
}

const RUN_STATUS_CHIP: Record<string, { bg: string; fg: string; label: string }> = {
  queued:      { bg: "#27272a", fg: "#a1a1aa", label: "queued" },
  pending:     { bg: "#27272a", fg: "#a1a1aa", label: "pending" },
  running:     { bg: "#3730a3", fg: "#a5b4fc", label: "running" },
  done:        { bg: "#14532d", fg: "#86efac", label: "done" },
  failed:      { bg: "#7f1d1d", fg: "#fca5a5", label: "failed" },
  blocked:     { bg: "#78350f", fg: "#fcd34d", label: "blocked" },
  approved:    { bg: "#14532d", fg: "#86efac", label: "approved" },
  flagged:     { bg: "#78350f", fg: "#fcd34d", label: "flagged" },
  merged:      { bg: "#14532d", fg: "#6ee7b7", label: "merged" },
  rejected:    { bg: "#27272a", fg: "#71717a", label: "rejected" },
  interrupted: { bg: "#27272a", fg: "#71717a", label: "interrupted" },
  conflict:    { bg: "#7f1d1d", fg: "#fca5a5", label: "conflict" },
  accepted:    { bg: "#14532d", fg: "#6ee7b7", label: "accepted" },
  budget_skip: { bg: "#78350f", fg: "#fcd34d", label: "budget skip" },
};

function HStatusChip({ status }: { status: string }) {
  const c = RUN_STATUS_CHIP[status] ?? {
    bg: "#27272a", fg: "#71717a",
    label: status.replace(/_/g, " ").replace(/^setup_failed.*/, "setup failed"),
  };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 7px", borderRadius: 99,
      fontSize: 10, fontWeight: 600, letterSpacing: "0.03em",
      background: c.bg, color: c.fg,
      textTransform: "uppercase" as const, whiteSpace: "nowrap" as const,
    }}>
      {c.label}
    </span>
  );
}

// ── Agents view ────────────────────────────────────────────────────────────────

// ── Validator types ────────────────────────────────────────────────────────

interface PlanRunSummary {
  runId: string;
  goal: string;
  projectPath: string;
  pathExists: boolean;
  isGit: boolean;
  stepCount: number;
  models: string[];
}
interface PlanSummary {
  planId: string;
  runCount: number;
  stepCount: number;
  models: string[];
  perStepUsd: number;
  perRunUsd: number;
  perNightUsd: number;
  runs: PlanRunSummary[];
}
interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: PlanSummary;
}
interface AuthorResult {
  planPath: string;
  validation: PlanValidation;
}
interface ProposalOption {
  id: string;
  title: string;
  summary: string;
  tradeoff: string;
}
interface ProposalResult {
  scope: string;
  options: ProposalOption[];
  questions: string[];
}

// ── Chat types ─────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  ts: number;
  planPath?: string;
  planId?: string;
  armed: boolean;
  error?: string;
}
interface ChatThread {
  key: string;
  projectPath: string;
  messages: ChatMessage[];
  sessionId?: string;
}

// ── ChatPlanCard component ─────────────────────────────────────────────────

function ChatPlanCard({
  armed, validation, armError, onArm,
}: {
  armed: boolean;
  validation: PlanValidation | "loading" | "error" | undefined;
  armError?: string;
  onArm: () => void;
}) {
  if (armed) {
    return (
      <div style={{ background: "#052e16", border: "1px solid #166534", borderRadius: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: 12, color: "#86efac", fontWeight: 600 }}>Armed / started</span>
      </div>
    );
  }
  if (!validation || validation === "loading") {
    return (
      <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: 11, color: "#71717a" }}>Loading plan…</span>
      </div>
    );
  }
  if (validation === "error") {
    return (
      <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px" }}>
        <span style={{ fontSize: 11, color: "#fca5a5" }}>Could not load plan</span>
      </div>
    );
  }
  const s = validation.summary;
  return (
    <div style={{ background: "#0d0f14", border: "1px solid #2d3748", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6, fontWeight: 600 }}>
        {s.planId} · {s.runCount} run{s.runCount !== 1 ? "s" : ""} · {s.stepCount} steps · ${s.perNightUsd.toFixed(2)} night cap
      </div>
      {validation.errors.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {validation.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: "#fca5a5" }}>{e}</div>)}
        </div>
      )}
      {validation.warnings.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {validation.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: "#fbbf24" }}>{w}</div>)}
        </div>
      )}
      {armError && <div style={{ fontSize: 11, color: "#fca5a5", marginBottom: 6 }}>{armError}</div>}
      <button
        onClick={onArm}
        disabled={!validation.ok}
        style={{
          width: "100%", padding: "6px 0", borderRadius: 6, fontSize: 12, fontWeight: 600,
          border: "none", cursor: validation.ok ? "pointer" : "not-allowed",
          background: validation.ok ? "#14532d" : "#27272a",
          color: validation.ok ? "#86efac" : "#52525b",
        }}
      >
        {validation.ok ? "Arm plan" : "Fix errors before arming"}
      </button>
    </div>
  );
}

// ── ChatView component ─────────────────────────────────────────────────────

function ChatView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [chatProject, setChatProject] = useState<Project | null>(null);
  const [chatCustomPath, setChatCustomPath] = useState("");
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [buildLoading, setBuildLoading] = useState(false);
  const [planValidations, setPlanValidations] = useState<Record<string, PlanValidation | "loading" | "error">>({});
  const [armErrors, setArmErrors] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<Project[]>("list_projects").then(setProjects).catch(() => {});
  }, []);

  function chatKey(): string {
    if (chatProject) return chatProject.slug;
    if (!chatCustomPath) return "";
    return chatCustomPath.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  async function resolveProjectPath(): Promise<string> {
    if (chatProject) {
      return invoke<RepoPath[]>("get_project_paths", { slug: chatProject.slug })
        .then(paths => paths[0]?.path ?? chatCustomPath)
        .catch(() => chatCustomPath);
    }
    return chatCustomPath;
  }

  useEffect(() => {
    const key = chatKey();
    if (!key) { setThread(null); return; }
    invoke<ChatThread>("load_chat", { key }).then(setThread).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatProject?.slug, chatCustomPath]);

  useEffect(() => {
    if (!thread) return;
    thread.messages.forEach(msg => {
      if (msg.planPath && !(msg.planPath in planValidations)) {
        setPlanValidations(prev => ({ ...prev, [msg.planPath!]: "loading" }));
        invoke<PlanValidation>("validate_plan_file", { planPath: msg.planPath! })
          .then(v => setPlanValidations(prev => ({ ...prev, [msg.planPath!]: v })))
          .catch(() => setPlanValidations(prev => ({ ...prev, [msg.planPath!]: "error" })));
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages.length]);

  async function handleSend() {
    const text = chatInput.trim();
    const key = chatKey();
    if (!text || chatLoading || !key) return;
    const projectPath = await resolveProjectPath();
    if (!projectPath) return;
    setChatInput("");
    setChatLoading(true);
    // Optimistically show user message while agent turn runs
    setThread(prev => {
      const userMsg: ChatMessage = {
        id: `opt-${Date.now()}`, role: "user", text,
        ts: Math.floor(Date.now() / 1000), armed: false,
      };
      return prev
        ? { ...prev, messages: [...prev.messages, userMsg] }
        : { key, projectPath, messages: [userMsg] };
    });
    try {
      const t = await invoke<ChatThread>("send_chat_message", { key, projectPath, text });
      setThread(t);
    } catch (e) {
      setThread(prev => {
        if (!prev) return prev;
        const errMsg: ChatMessage = {
          id: `err-${Date.now()}`, role: "agent",
          text: `Something went wrong: ${String(e)}`,
          ts: Math.floor(Date.now() / 1000), armed: false,
        };
        return { ...prev, messages: [...prev.messages.filter(m => !m.id.startsWith("opt-")), errMsg] };
      });
    } finally {
      setChatLoading(false);
    }
  }

  async function handleBuild() {
    const key = chatKey();
    if (!key || buildLoading || chatLoading) return;
    const projectPath = await resolveProjectPath();
    if (!projectPath) return;
    setBuildLoading(true);
    try {
      const t = await invoke<ChatThread>("build_from_chat", { key, projectPath });
      setThread(t);
    } catch (e) {
      setThread(prev => {
        if (!prev) return prev;
        const errMsg: ChatMessage = {
          id: `err-${Date.now()}`, role: "agent",
          text: `Build failed: ${String(e)}`,
          ts: Math.floor(Date.now() / 1000), armed: false,
        };
        return { ...prev, messages: [...prev.messages, errMsg] };
      });
    } finally {
      setBuildLoading(false);
    }
  }

  async function handleArm(msg: ChatMessage) {
    if (!msg.planPath || msg.armed) return;
    const key = chatKey();
    try {
      const t = await invoke<ChatThread>("arm_chat_plan", { key, messageId: msg.id });
      setThread(t);
    } catch (e) {
      setArmErrors(prev => ({ ...prev, [msg.id]: String(e) }));
    }
  }

  const key = chatKey();
  const hasTarget = !!key;
  const hasAgentMsg = (thread?.messages ?? []).some(m => m.role === "agent");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Project picker */}
      <div style={{ padding: "10px 14px 0", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={chatProject?.slug ?? ""}
            onChange={e => {
              const p = projects.find(p => p.slug === e.target.value) ?? null;
              setChatProject(p);
              if (p) setChatCustomPath("");
            }}
            style={{ flex: 1, background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "6px 8px", outline: "none" }}
          >
            <option value="">— pick project —</option>
            {projects.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
          <input
            value={chatCustomPath}
            onChange={e => { setChatCustomPath(e.target.value); setChatProject(null); }}
            placeholder="or paste path"
            style={{ flex: 1, background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "6px 10px", outline: "none" }}
          />
        </div>
      </div>

      {/* Thread */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "12px 14px" }}>
        {!hasTarget ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 6 }}>
            <p style={{ fontSize: 13, color: "#52525b" }}>Pick a project to start chatting</p>
          </div>
        ) : !thread || thread.messages.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 6 }}>
            <p style={{ fontSize: 13, color: "#71717a" }}>Describe what you want to build</p>
            <p style={{ fontSize: 11, color: "#52525b" }}>The agent reads the repo and helps you scope it</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {thread.messages.map(msg => (
              <div
                key={msg.id}
                style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}
              >
                {msg.role === "user" ? (
                  <div style={{
                    maxWidth: "72%", background: "#1e3a5f", borderRadius: "12px 12px 3px 12px",
                    padding: "8px 12px", fontSize: 13, color: "#bfdbfe", lineHeight: 1.5,
                  }}>
                    {msg.text}
                  </div>
                ) : (
                  <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{
                      background: "#111113", border: "1px solid #27272a",
                      borderRadius: "12px 12px 12px 3px", padding: "8px 12px",
                      fontSize: 13, color: "#e4e4e7", lineHeight: 1.6,
                    }}>
                      {msg.text}
                    </div>
                    {msg.error && (
                      <div style={{ fontSize: 11, color: "#fbbf24", padding: "6px 10px", background: "#1a1207", borderRadius: 6 }}>
                        couldn't author a plan: {msg.error}
                      </div>
                    )}
                    {msg.planPath && (
                      <ChatPlanCard
                        armed={msg.armed}
                        validation={planValidations[msg.planPath]}
                        armError={armErrors[msg.id]}
                        onArm={() => handleArm(msg)}
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
            {chatLoading && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div style={{
                  background: "#111113", border: "1px solid #27272a",
                  borderRadius: "12px 12px 12px 3px", padding: "10px 14px",
                }}>
                  <span style={{ fontSize: 12, color: "#52525b" }}>thinking…</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: "8px 14px 12px", flexShrink: 0, borderTop: "1px solid #18181b" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={hasTarget ? "What do you want to build?" : "Pick a project first"}
            disabled={!hasTarget || chatLoading || buildLoading}
            style={{
              flex: 1, background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7,
              color: "#e4e4e7", fontSize: 13, padding: "8px 12px", outline: "none",
            }}
          />
          <button
            onClick={handleSend}
            disabled={!hasTarget || chatLoading || buildLoading || !chatInput.trim()}
            style={{
              padding: "8px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, border: "none",
              cursor: !hasTarget || chatLoading || buildLoading || !chatInput.trim() ? "not-allowed" : "pointer",
              background: !hasTarget || chatLoading || buildLoading || !chatInput.trim() ? "#27272a" : "#3730a3",
              color: !hasTarget || chatLoading || buildLoading || !chatInput.trim() ? "#52525b" : "#a5b4fc",
            }}
          >
            Send
          </button>
        </div>
        <button
          onClick={handleBuild}
          disabled={!hasAgentMsg || buildLoading || chatLoading}
          style={{
            width: "100%", padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 600,
            border: "none",
            cursor: !hasAgentMsg || buildLoading || chatLoading ? "not-allowed" : "pointer",
            background: buildLoading ? "#27272a" : !hasAgentMsg || chatLoading ? "#27272a" : "#14532d",
            color: buildLoading ? "#52525b" : !hasAgentMsg || chatLoading ? "#52525b" : "#86efac",
          }}
        >
          {buildLoading ? "Building plan… (~30s)" : "Build from this chat"}
        </button>
      </div>
    </div>
  );
}

// ── ValidationReadout component ────────────────────────────────────────────

function ValidationReadout({ result, onArm, armError }: { result: AuthorResult; onArm: (path: string) => void; armError: string }) {
  const { validation, planPath } = result;
  const s = validation.summary;
  return (
    <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 10, padding: "12px 14px", marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#a1a1aa" }}>
          {s.planId} · {s.runCount} run{s.runCount !== 1 ? "s" : ""} · {s.stepCount} steps · ${s.perNightUsd.toFixed(2)} night cap
        </span>
        <span style={{ fontSize: 10, color: "#3f3f46", fontFamily: "monospace", marginLeft: "auto" }}>{planPath.split("/").pop()}</span>
      </div>
      {validation.errors.length > 0 && (
        <div style={{ background: "#450a0a", borderRadius: 6, padding: "6px 10px", marginBottom: 6 }}>
          {validation.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: "#fca5a5" }}>{e}</div>)}
        </div>
      )}
      {validation.warnings.length > 0 && (
        <div style={{ background: "#1a1207", borderRadius: 6, padding: "6px 10px", marginBottom: 6 }}>
          {validation.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: "#fcd34d" }}>{w}</div>)}
        </div>
      )}
      {s.runs.map(r => (
        <div key={r.runId} style={{ borderTop: "1px solid #27272a", paddingTop: 6, marginTop: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#e4e4e7", marginBottom: 3 }}>{r.goal}</div>
          <div style={{ fontSize: 11, color: "#71717a", marginBottom: 4 }}>{r.projectPath} · {r.pathExists ? (r.isGit ? "git repo" : "exists, no git") : "⚠ path missing"}</div>
          <div style={{ fontSize: 10, color: "#52525b", fontFamily: "monospace" }}>models: {r.models.join(", ")}</div>
        </div>
      ))}
      {armError && <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 6 }}>{armError}</div>}
      <button
        disabled={!validation.ok}
        onClick={() => onArm(planPath)}
        style={{
          marginTop: 10, width: "100%", padding: "7px 0", borderRadius: 7,
          fontSize: 12, fontWeight: 600, border: "none", cursor: validation.ok ? "pointer" : "not-allowed",
          background: validation.ok ? "#14532d" : "#27272a",
          color: validation.ok ? "#86efac" : "#52525b",
        }}
      >
        {validation.ok ? "Arm plan" : "Fix errors before arming"}
      </button>
    </div>
  );
}

function AgentsView() {
  const [plans, setPlans] = useState<HPlanState[]>([]);
  const [loading, setLoading] = useState(true);
  const [hideDev, setHideDev] = useState(true);
  const [diffState, setDiffState] = useState<{ planId: string; runId: string; content: string } | null>(null);
  const [staleWorktrees, setStaleWorktrees] = useState<string[]>([]);
  const [msgs, setMsgs] = useState<Record<string, { text: string; error: boolean }>>({});
  const [stats, setStats] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [authorDesc, setAuthorDesc] = useState("");
  const [authorProject, setAuthorProject] = useState<Project | null>(null);
  const [authorCustomPath, setAuthorCustomPath] = useState("");
  const [authorResult, setAuthorResult] = useState<AuthorResult | null>(null);
  const [authorError, setAuthorError] = useState("");
  const [authorLoading, setAuthorLoading] = useState(false);
  const [loadPlanPath, setLoadPlanPath] = useState("");
  const [loadResult, setLoadResult] = useState<AuthorResult | null>(null);
  const [loadError, setLoadError] = useState("");
  const [proposeLoading, setProposeLoading] = useState(false);
  const [proposeError, setProposeError] = useState("");
  const [proposeResult, setProposeResult] = useState<ProposalResult | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [proposeNotes, setProposeNotes] = useState("");

  async function refresh() {
    try {
      const [ps, sw] = await Promise.all([
        invoke<HPlanState[]>("list_plan_states"),
        invoke<string[]>("list_stale_worktrees", { days: 7 }),
      ]);
      setPlans(ps);
      setStaleWorktrees(sw);
      const newStats: Record<string, string> = {};
      await Promise.allSettled(
        ps.flatMap(p => p.runs
          .filter(r => r.worktree && ["done", "failed", "interrupted", "conflict", "accepted", "approved", "flagged"].includes(r.status))
          .map(async r => {
            try {
              const stat = await invoke<string>("harness_run_summary", { planId: p.planId, runId: r.runId });
              if (stat) newStats[`${p.planId}:${r.runId}`] = stat;
            } catch { /* ignore */ }
          })
        )
      );
      setStats(newStats);
    } catch {
      // tolerate
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5_000);
    let unlisten: UnlistenFn | null = null;
    listen("antfarm-harness-event", () => refresh()).then(fn => { unlisten = fn; });
    return () => { clearInterval(interval); unlisten?.(); };
  }, []);

  useEffect(() => {
    invoke<Project[]>("list_projects").then(setProjects).catch(() => {});
  }, []);

  async function resolveProjectPath(): Promise<string> {
    return authorProject
      ? invoke<RepoPath[]>("get_project_paths", { slug: authorProject.slug })
          .then(paths => paths[0]?.path ?? authorCustomPath)
          .catch(() => authorCustomPath)
      : Promise.resolve(authorCustomPath);
  }

  async function runAuthorPlan(description: string) {
    const projectPath = await resolveProjectPath();
    if (!projectPath) { setAuthorError("Select a project or enter a path"); return; }
    setAuthorLoading(true);
    setAuthorError("");
    setAuthorResult(null);
    try {
      const result = await invoke<AuthorResult>("author_plan", { description, projectPath });
      setAuthorResult(result);
    } catch (e) {
      setAuthorError(String(e));
    } finally {
      setAuthorLoading(false);
    }
  }

  async function handleAuthorPlan() {
    setProposeResult(null);
    await runAuthorPlan(authorDesc);
  }

  async function handleProposePlan() {
    const projectPath = await resolveProjectPath();
    if (!projectPath) { setAuthorError("Select a project or enter a path"); return; }
    setProposeLoading(true);
    setProposeError("");
    setProposeResult(null);
    setSelectedOptionId("");
    setProposeNotes("");
    setAuthorResult(null);
    try {
      const result = await invoke<ProposalResult>("propose_plan", { description: authorDesc, projectPath });
      setProposeResult(result);
    } catch (e) {
      setProposeError(String(e));
    } finally {
      setProposeLoading(false);
    }
  }

  async function handleBuildApproach() {
    if (!selectedOptionId || !proposeResult) return;
    const opt = proposeResult.options.find(o => o.id === selectedOptionId);
    if (!opt) return;
    const assembled = `${authorDesc}\n\nChosen approach: ${opt.title} — ${opt.summary}\n\nNotes/decisions: ${proposeNotes || "(none)"}`;
    setProposeResult(null);
    await runAuthorPlan(assembled);
  }

  async function handleArmAuthoredPlan(planPath: string) {
    try {
      await invoke<string>("arm_night_plan", { planPath });
      setAuthorResult(null);
      setAuthorDesc("");
      setAuthorProject(null);
      refresh();
    } catch (e) {
      setAuthorError(String(e));
    }
  }

  async function handleLoadPlan() {
    setLoadError("");
    setLoadResult(null);
    try {
      const v = await invoke<PlanValidation>("validate_plan_file", { planPath: loadPlanPath });
      setLoadResult({ planPath: loadPlanPath, validation: v });
    } catch (e) {
      setLoadError(String(e));
    }
  }

  const visiblePlans = hideDev ? plans.filter(p => !p.planId.startsWith("dev-")) : plans;

  const entries: RunEntry[] = visiblePlans
    .flatMap(p => p.runs.map(r => ({ planId: p.planId, run: r, sortKey: p.updatedAt })))
    .sort((a, b) => b.sortKey - a.sortKey);

  function setMsg(runId: string, text: string, error: boolean) {
    setMsgs(prev => ({ ...prev, [runId]: { text, error } }));
  }

  async function handleDiff(planId: string, runId: string) {
    try {
      const diff = await invoke<string>("harness_run_diff", { planId, runId });
      setDiffState({ planId, runId, content: diff });
    } catch (e) {
      setMsg(runId, String(e), true);
    }
  }

  async function handleMerge(planId: string, runId: string) {
    try {
      const result = await invoke<string>("accept_run", { planId, runId });
      setMsg(runId, result === "merged" ? "Merged to main" : result, false);
      refresh();
    } catch (e) {
      setMsg(runId, String(e), true);
    }
  }

  async function handleToss(planId: string, runId: string) {
    if (!window.confirm(`Toss run "${runId}"? Removes worktree and branch.`)) return;
    try {
      await invoke("reject_run", { planId, runId });
      setDiffState(prev => (prev?.planId === planId && prev?.runId === runId) ? null : prev);
      refresh();
    } catch (e) {
      setMsg(runId, String(e), true);
    }
  }

  async function handleTakeOver(planId: string, runId: string) {
    try {
      await invoke("take_over_overnight_run", { planId, runId });
    } catch (e) {
      setMsg(runId, String(e), true);
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ background: "#0a0a0b" }}>
      <div className="flex items-center gap-3 px-4 h-10 border-b border-zinc-800 shrink-0" style={{ background: "#0d0d0f" }}>
        <Monitor size={13} className="text-zinc-500" />
        <span className="text-xs font-semibold text-zinc-300">Agent Runs</span>
        <span className="text-[11px] text-zinc-600">
          {entries.length} run{entries.length !== 1 ? "s" : ""} across {visiblePlans.length} plan{visiblePlans.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={() => setHideDev(h => !h)}
          className="ml-auto text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
        >
          {hideDev ? "Hide dev/test" : "Show all"}
        </button>
        {loading && <span className="text-[10px] text-zinc-700 animate-pulse">loading…</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Author a plan panel */}
        <div style={{ padding: "14px 14px 0" }}>
          <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 12, padding: "14px" }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "#a1a1aa", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>Author a plan</p>
            <textarea
              value={authorDesc}
              onChange={e => setAuthorDesc(e.target.value)}
              placeholder="Describe what you want the agent to do overnight…"
              rows={3}
              style={{ width: "100%", background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "8px 10px", resize: "vertical", fontFamily: "inherit", outline: "none" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <select
                value={authorProject?.slug ?? ""}
                onChange={e => {
                  const p = projects.find(p => p.slug === e.target.value) ?? null;
                  setAuthorProject(p);
                }}
                style={{ flex: 1, background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "6px 8px", outline: "none" }}
              >
                <option value="">— pick project —</option>
                {projects.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}
              </select>
              <input
                value={authorCustomPath}
                onChange={e => setAuthorCustomPath(e.target.value)}
                placeholder="or paste path"
                style={{ flex: 1, background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "6px 10px", outline: "none" }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button
                onClick={handleProposePlan}
                disabled={proposeLoading || authorLoading || !authorDesc.trim()}
                style={{
                  flex: 1, padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 600,
                  border: "none", cursor: proposeLoading || authorLoading || !authorDesc.trim() ? "not-allowed" : "pointer",
                  background: proposeLoading ? "#27272a" : "#312e81", color: proposeLoading ? "#52525b" : "#c7d2fe",
                }}
              >
                {proposeLoading ? "Proposing… (~30s)" : "Propose approaches"}
              </button>
              <button
                onClick={handleAuthorPlan}
                disabled={authorLoading || proposeLoading || !authorDesc.trim()}
                style={{
                  flex: 1, padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 600,
                  border: "none", cursor: authorLoading || proposeLoading || !authorDesc.trim() ? "not-allowed" : "pointer",
                  background: authorLoading ? "#27272a" : "#1e3a5f", color: authorLoading ? "#52525b" : "#93c5fd",
                }}
              >
                {authorLoading ? "Generating… (~30s)" : "Generate plan"}
              </button>
            </div>
            {(authorError || proposeError) && (
              <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 6 }}>{authorError || proposeError}</div>
            )}
            {proposeResult && (
              <div style={{ marginTop: 10, background: "#0d0d10", border: "1px solid #27272a", borderRadius: 10, padding: "12px 14px" }}>
                <p style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 10, lineHeight: 1.6 }}>{proposeResult.scope}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {proposeResult.options.map(opt => (
                    <div
                      key={opt.id}
                      onClick={() => setSelectedOptionId(opt.id)}
                      style={{
                        border: `1px solid ${selectedOptionId === opt.id ? "#6366f1" : "#3f3f46"}`,
                        borderRadius: 8, padding: "10px 12px", cursor: "pointer",
                        background: selectedOptionId === opt.id ? "#1e1b4b" : "#111113",
                        transition: "border-color 0.1s, background 0.1s",
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: selectedOptionId === opt.id ? "#a5b4fc" : "#e4e4e7", marginBottom: 3 }}>
                        {opt.title}
                      </div>
                      <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 4, lineHeight: 1.5 }}>{opt.summary}</div>
                      <div style={{ fontSize: 10, color: "#71717a", fontStyle: "italic" }}>⚖ {opt.tradeoff}</div>
                    </div>
                  ))}
                </div>
                {proposeResult.questions.length > 0 && (
                  <div style={{ background: "#1a1207", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: "#fcd34d", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Open questions</p>
                    {proposeResult.questions.map((q, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#fcd34d", marginBottom: i < proposeResult.questions.length - 1 ? 4 : 0 }}>• {q}</div>
                    ))}
                  </div>
                )}
                <textarea
                  value={proposeNotes}
                  onChange={e => setProposeNotes(e.target.value)}
                  placeholder="Notes / answers to open questions (optional)"
                  rows={2}
                  style={{ width: "100%", background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "8px 10px", resize: "vertical", fontFamily: "inherit", outline: "none", marginBottom: 8 }}
                />
                <button
                  disabled={!selectedOptionId}
                  onClick={handleBuildApproach}
                  style={{
                    width: "100%", padding: "7px 0", borderRadius: 7, fontSize: 12, fontWeight: 600,
                    border: "none", cursor: selectedOptionId ? "pointer" : "not-allowed",
                    background: selectedOptionId ? "#14532d" : "#27272a",
                    color: selectedOptionId ? "#86efac" : "#52525b",
                  }}
                >
                  Build this approach
                </button>
              </div>
            )}
            {authorResult && (
              <ValidationReadout result={authorResult} onArm={handleArmAuthoredPlan} armError={""} />
            )}
          </div>

          {/* Load existing plan */}
          <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 12, padding: "14px", marginTop: 10 }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: "#a1a1aa", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Load existing plan</p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={loadPlanPath}
                onChange={e => setLoadPlanPath(e.target.value)}
                placeholder="~/.antfarm/plans-authored/…json"
                style={{ flex: 1, background: "#0a0a0b", border: "1px solid #3f3f46", borderRadius: 7, color: "#e4e4e7", fontSize: 12, padding: "6px 10px", outline: "none" }}
              />
              <button
                onClick={handleLoadPlan}
                disabled={!loadPlanPath.trim()}
                style={{ padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, border: "none", cursor: loadPlanPath.trim() ? "pointer" : "not-allowed", background: "#27272a", color: "#a1a1aa" }}
              >
                Validate
              </button>
            </div>
            {loadError && <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 6 }}>{loadError}</div>}
            {loadResult && (
              <ValidationReadout result={loadResult} onArm={async (path) => {
                try {
                  await invoke<string>("arm_night_plan", { planPath: path });
                  setLoadResult(null);
                  setLoadPlanPath("");
                  refresh();
                } catch (e) {
                  setLoadError(String(e));
                }
              }} armError={""} />
            )}
          </div>
        </div>

        {!loading && entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <Activity size={32} className="text-zinc-800" />
            <p className="text-sm text-zinc-500">No agent runs yet</p>
            <p className="text-xs text-zinc-700">Arm a night plan to start</p>
          </div>
        ) : (
          <div className="p-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {entries.map(({ planId, run }) => {
              const costStr = run.costUsd > 0.0001 ? `$${run.costUsd.toFixed(4)}` : "—";
              const isDiffOpen = diffState?.planId === planId && diffState?.runId === run.runId;
              const msg = msgs[run.runId];
              const hasWt = !!run.worktree;
              const hasSession = run.steps.some(s => s.sessionId);
              const reviewable = ["done", "failed", "interrupted", "conflict", "approved", "flagged"].includes(run.status);
              const showDiff = hasWt && (reviewable || run.status === "accepted");
              const showMerge = hasWt && ["done", "approved", "flagged"].includes(run.status);
              const showToss = hasWt && reviewable;
              const showTakeOver = reviewable && hasSession;
              const statKey = `${planId}:${run.runId}`;
              const statRaw = stats[statKey];
              const statLine = statRaw
                ? (statRaw.split('\n').filter((l: string) => l.trim()).pop() ?? "")
                : null;

              return (
                <div
                  key={statKey}
                  className="rounded-xl p-4 flex flex-col gap-3"
                  style={{
                    border: `1px solid ${isDiffOpen ? "#52525b" : "#27272a"}`,
                    background: isDiffOpen ? "#1c1c1e" : "#111113",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                >
                  {/* Goal — headline */}
                  {run.goal ? (
                    <p className="text-[13px] font-semibold text-zinc-100 leading-snug">{run.goal}</p>
                  ) : (
                    <p className="text-[13px] text-zinc-600 italic">Untitled run</p>
                  )}

                  {/* Summary paragraph */}
                  {run.summary ? (
                    <p className="text-[12px] text-zinc-400 leading-relaxed">{run.summary}</p>
                  ) : (
                    <p className="text-[11px] text-zinc-700 italic">No summary yet</p>
                  )}

                  {/* Reviewer note (Opus gate) */}
                  {run.reviewNotes && (
                    <div
                      className="text-[11px] leading-relaxed rounded-md px-2.5 py-1.5"
                      style={{ background: "#1a1207", color: "#fcd34d" }}
                    >
                      <span className="font-semibold">Reviewer:</span> {run.reviewNotes}
                    </div>
                  )}

                  {/* Stat · chip · cost */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {statLine && (
                      <span className="text-[10px] text-zinc-600 font-mono">{statLine}</span>
                    )}
                    <HStatusChip status={run.status} />
                    <span className="text-[11px] text-zinc-500 tabular-nums">{costStr}</span>
                  </div>

                  {/* run_id + branch — de-emphasized */}
                  <div className="flex items-center gap-2 flex-wrap -mt-1">
                    <span className="text-[10px] text-zinc-700 font-mono">{run.runId}</span>
                    {run.branch && (
                      <span className="text-[10px] text-zinc-800 font-mono">{run.branch.replace(/^antfarm\//, "")}</span>
                    )}
                  </div>

                  {msg && (
                    <div
                      className="text-[11px] px-2.5 py-1.5 rounded-lg"
                      style={{ background: msg.error ? "#450a0a" : "#052e16", color: msg.error ? "#fca5a5" : "#86efac" }}
                    >
                      {msg.text}
                    </div>
                  )}

                  {(showDiff || showMerge || showToss || showTakeOver) && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {showDiff && (
                        <button
                          onClick={() => isDiffOpen ? setDiffState(null) : handleDiff(planId, run.runId)}
                          className="text-[11px] px-2.5 py-1 rounded-md transition-colors"
                          style={{ background: isDiffOpen ? "#3f3f46" : "#27272a", color: isDiffOpen ? "#e4e4e7" : "#a1a1aa" }}
                        >
                          {isDiffOpen ? "Hide diff" : "Diff"}
                        </button>
                      )}
                      {showMerge && (
                        <button
                          onClick={() => handleMerge(planId, run.runId)}
                          className="text-[11px] px-2.5 py-1 rounded-md transition-colors hover:opacity-80"
                          style={{ background: "#14532d", color: "#86efac" }}
                        >
                          Merge
                        </button>
                      )}
                      {showToss && (
                        <button
                          onClick={() => handleToss(planId, run.runId)}
                          className="text-[11px] px-2.5 py-1 rounded-md transition-colors hover:bg-rose-950 hover:text-rose-300"
                          style={{ background: "#27272a", color: "#71717a" }}
                        >
                          Toss
                        </button>
                      )}
                      {showTakeOver && (
                        <button
                          onClick={() => handleTakeOver(planId, run.runId)}
                          className="text-[11px] px-2.5 py-1 rounded-md transition-colors hover:bg-indigo-950 hover:text-indigo-300"
                          style={{ background: "#27272a", color: "#71717a" }}
                        >
                          Take over
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {staleWorktrees.length > 0 && (
          <div className="px-4 pb-6">
            <p className="text-[11px] font-semibold text-zinc-600 uppercase tracking-wider mb-2">Stale worktrees (&gt;7 days)</p>
            <div className="flex flex-col gap-1">
              {staleWorktrees.map(wt => (
                <div key={wt} className="text-[10px] text-zinc-600 font-mono px-3 py-1.5 rounded-md" style={{ background: "#18181b", border: "1px solid #27272a" }}>
                  {wt}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {diffState && (
        <div className="shrink-0 border-t border-zinc-700 flex flex-col" style={{ height: "42%", background: "#0d0d0f" }}>
          <div className="flex items-center gap-3 px-4 h-9 border-b border-zinc-800 shrink-0">
            <span className="text-[11px] font-medium text-zinc-400 font-mono">{diffState.runId}</span>
            <span className="text-[10px] text-zinc-600 font-mono">{diffState.planId}</span>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-[10px] text-zinc-700">read-only</span>
              <button onClick={() => setDiffState(null)} className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5 rounded">
                <X size={12} />
              </button>
            </span>
          </div>
          <pre className="flex-1 overflow-auto p-4 text-[11px] font-mono leading-relaxed whitespace-pre" style={{ color: "#a1a1aa" }}>
            {diffState.content || "No diff available — worktree may have been removed."}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Main Workspace page ────────────────────────────────────────────────────

export function WorkspacePage() {
  const [mode, setMode] = useState<"live" | "agents" | "chat">(() => {
    const saved = localStorage.getItem("antfarm-workspace-mode");
    return saved === "agents" ? "agents" : saved === "chat" ? "chat" : "live";
  });
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

  function switchMode(m: "live" | "agents" | "chat") {
    setMode(m);
    localStorage.setItem("antfarm-workspace-mode", m);
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

  function handleEvenOut() {
    if (!activeId) return;
    dockRefs.current[activeId]?.evenOut();
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
      {/* Mode toggle — very top */}
      <div className="flex items-center gap-0.5 px-2.5 h-8 border-b border-zinc-800/80 bg-zinc-950 shrink-0">
        {(["live", "agents", "chat"] as const).map(m => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={[
              "px-3 h-5 rounded text-[11px] font-medium transition-colors",
              mode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
            ].join(" ")}
          >
            {m === "live" ? "Live" : m === "agents" ? "Agents" : "Chat"}
          </button>
        ))}
      </div>

      {mode === "agents" ? (
        <AgentsView />
      ) : mode === "chat" ? (
        <ChatView />
      ) : (
        <>
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
                <OpenLocalhostButton wsId={activeWorkspace.id} />
                <GridMenu onPick={handleBuildGrid} onEvenOut={handleEvenOut} />
                <AddPaneMenu onAdd={handleAddPane} />
              </div>
            )}
          </div>

          {/* HUD — always visible when a workspace is active */}
          {activeWorkspace && <WorkspaceHud />}

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
        </>
      )}
    </div>
  );
}
