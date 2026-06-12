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
import {
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  DockviewApi,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { BookOpen, ChevronDown, Globe, Layout, Plus, X } from "lucide-react";
import { Project, ProjectDetail as PD, WorkspaceEntry } from "../types";
import { MarkdownView } from "../components/MarkdownView";

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

const DOCK_COMPONENTS = {
  web: WebPane,
  project_info: ProjectInfoPane,
} as const;

// ── DockArea ───────────────────────────────────────────────────────────────

interface DockAreaHandle {
  addPane(type: "web" | "project_info", slug: string | null): void;
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

  useImperativeHandle(ref, () => ({
    addPane(type, slug) {
      if (!apiRef.current) return;
      const id = crypto.randomUUID();
      if (type === "web") {
        apiRef.current.addPanel({
          id,
          component: "web",
          params: { url: "" } as WebParams,
          title: "Web",
        });
      } else {
        apiRef.current.addPanel({
          id,
          component: "project_info",
          params: { project_slug: slug } as InfoParams,
          title: "Project Info",
        });
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

// ── Add pane dropdown ──────────────────────────────────────────────────────

function AddPaneMenu({ onAdd }: { onAdd: (type: "web" | "project_info") => void }) {
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
        <div className="absolute right-0 top-full mt-1.5 w-44 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 z-50">
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

// ── Main Workspace page ────────────────────────────────────────────────────

export function WorkspacePage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const dockRef = useRef<DockAreaHandle>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

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
  const handleLayoutChange = useCallback((layoutJson: string) => {
    const id = activeIdRef.current;
    if (!id) return;
    setWorkspaces(prev => {
      const updated = prev.map(w => w.id === id ? { ...w, layout_json: layoutJson } : w);
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

  function handleAddPane(type: "web" | "project_info") {
    const ws = workspaces.find(w => w.id === activeId);
    dockRef.current?.addPane(type, ws?.project_slug ?? null);
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
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 border-b border-zinc-800 bg-zinc-900/50 shrink-0 h-11 overflow-x-auto">
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
        {activeWorkspace && (
          <div className="ml-auto pl-3 shrink-0">
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

      {/* Dock area — key remounts dockview when switching workspaces */}
      {activeWorkspace && (
        <div className="flex-1 min-h-0">
          <DockArea
            key={activeWorkspace.id}
            ref={dockRef}
            workspace={activeWorkspace}
            onLayoutChange={handleLayoutChange}
          />
        </div>
      )}
    </div>
  );
}
