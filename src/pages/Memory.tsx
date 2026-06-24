import { useEffect, useMemo, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import {
  FileText,
  Folder,
  FolderOpen,
  Search,
  Pencil,
  Save,
  X,
  Brain,
} from "lucide-react";

interface MemoryFile {
  path: string; // vault-relative, e.g. "tools-built/roastlytics/README.md"
  name: string;
}

interface MemoryHit {
  path: string;
  line: number;
  text: string;
}

// ── Folder tree built from flat relative paths ──────────────────────────────
interface TreeNode {
  name: string;
  path: string; // full relative path for files; folder path for dirs
  children: TreeNode[];
  isFile: boolean;
}

function buildTree(files: MemoryFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], isFile: false };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.isFile === isFile);
      if (!child) {
        child = { name: part, path: acc, children: [], isFile };
        node.children.push(child);
      }
      node = child;
    });
  }
  // folders first, then files, each alphabetical
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

// Turn [[target|label]] / [[target]] into markdown links with a wiki: scheme
// so the custom <a> renderer can intercept clicks and open the note.
function wikilinksToMarkdown(src: string): string {
  return src.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
    const t = String(target).trim();
    const l = (label ? String(label) : t).trim();
    return `[${l}](wiki:${encodeURIComponent(t)})`;
  });
}

export function Memory() {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "tools-built": true,
    active: true,
  });

  const tree = useMemo(() => buildTree(files), [files]);

  const openNote = useCallback((path: string) => {
    setError(null);
    invoke<string>("memory_read", { path })
      .then((c) => {
        setActivePath(path);
        setContent(c);
        setEditing(false);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    invoke<MemoryFile[]>("memory_list")
      .then((f) => {
        setFiles(f);
        const home = f.find((x) => x.path === "Home.md") || f[0];
        if (home) openNote(home.path);
      })
      .catch((e) => setError(String(e)));
  }, [openNote]);

  // Debounced search
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      invoke<MemoryHit[]>("memory_search", { query: q })
        .then(setHits)
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  function resolveWiki(target: string) {
    const t = decodeURIComponent(target).toLowerCase();
    const candidates = [t, `${t}.md`];
    const match =
      files.find((f) => candidates.includes(f.path.toLowerCase())) ||
      files.find((f) => f.path.toLowerCase().replace(/\.md$/, "").endsWith(`/${t}`)) ||
      files.find((f) => f.name.toLowerCase().replace(/\.md$/, "") === t);
    if (match) openNote(match.path);
    else setError(`No note found for [[${decodeURIComponent(target)}]]`);
  }

  function startEdit() {
    setDraft(content);
    setEditing(true);
  }

  function save() {
    if (!activePath) return;
    setSaving(true);
    setError(null);
    invoke("memory_write", { path: activePath, content: draft })
      .then(() => {
        setContent(draft);
        setEditing(false);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  }

  function toggle(path: string) {
    setExpanded((p) => ({ ...p, [path]: !p[path] }));
  }

  function renderTree(node: TreeNode, depth = 0) {
    return node.children.map((child) => {
      if (child.isFile) {
        const isActive = child.path === activePath;
        return (
          <button
            key={child.path}
            onClick={() => openNote(child.path)}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={[
              "flex items-center gap-2 w-full text-left px-2 py-1 rounded text-xs transition-colors",
              isActive
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50",
            ].join(" ")}
          >
            <FileText size={13} strokeWidth={1.75} className="shrink-0 opacity-70" />
            <span className="truncate">{child.name.replace(/\.md$/, "")}</span>
          </button>
        );
      }
      const open = expanded[child.path] ?? false;
      return (
        <div key={child.path}>
          <button
            onClick={() => toggle(child.path)}
            style={{ paddingLeft: 8 + depth * 14 }}
            className="flex items-center gap-2 w-full text-left px-2 py-1 rounded text-xs text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            {open ? (
              <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-indigo-400" />
            ) : (
              <Folder size={13} strokeWidth={1.75} className="shrink-0 text-zinc-500" />
            )}
            <span className="truncate font-medium">{child.name}</span>
          </button>
          {open && renderTree(child, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div className="flex h-full">
      {/* Left: tree + search */}
      <div className="w-[280px] shrink-0 h-full border-r border-zinc-800/80 flex flex-col bg-surface-1">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-zinc-800/60 shrink-0">
          <Brain size={16} strokeWidth={1.75} className="text-indigo-400" />
          <span className="text-sm font-semibold text-zinc-100">Memory</span>
          <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{files.length}</span>
        </div>
        <div className="px-3 py-2 border-b border-zinc-800/60">
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5">
            <Search size={13} className="text-zinc-500 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes…"
              className="bg-transparent text-xs text-zinc-200 outline-none w-full placeholder:text-zinc-600"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-zinc-500 hover:text-zinc-300">
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-1.5">
          {query.trim() ? (
            hits.length === 0 ? (
              <p className="text-xs text-zinc-600 px-2 py-2">No matches</p>
            ) : (
              hits.map((h, i) => (
                <button
                  key={`${h.path}:${h.line}:${i}`}
                  onClick={() => openNote(h.path)}
                  className="block w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="text-[11px] text-indigo-400 truncate">
                    {h.path.replace(/\.md$/, "")}
                  </div>
                  <div className="text-[11px] text-zinc-500 truncate">{h.text}</div>
                </button>
              ))
            )
          ) : (
            renderTree(tree)
          )}
        </div>
      </div>

      {/* Right: note */}
      <div className="flex-1 h-full flex flex-col min-w-0">
        <div className="flex items-center gap-3 px-5 h-14 border-b border-zinc-800/60 shrink-0">
          <span className="text-sm text-zinc-300 truncate">
            {activePath ? activePath.replace(/\.md$/, "") : "Select a note"}
          </span>
          {activePath && (
            <div className="ml-auto flex items-center gap-2">
              {editing ? (
                <>
                  <button
                    onClick={save}
                    disabled={saving}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
                  >
                    <Save size={13} /> {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                  >
                    <X size={13} /> Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={startEdit}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  <Pencil size={13} /> Edit
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mx-5 mt-3 text-xs text-red-400 bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {!activePath ? (
            <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
              Pick a note from the left to read or edit it.
            </div>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="w-full h-full bg-zinc-950 text-zinc-200 text-sm font-mono p-5 outline-none resize-none leading-relaxed"
            />
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-6 prose-dark">
              <ReactMarkdown
                components={{
                  a: ({ href, children }) => {
                    if (href && href.startsWith("wiki:")) {
                      return (
                        <button
                          onClick={() => resolveWiki(href.slice("wiki:".length))}
                          className="text-indigo-400 hover:text-indigo-300 underline-offset-2 hover:underline"
                        >
                          {children}
                        </button>
                      );
                    }
                    return <span className="text-indigo-400">{children}</span>;
                  },
                  h1: ({ children }) => (
                    <h1 className="text-xl font-bold text-zinc-100 mb-3 mt-5 first:mt-0">{children}</h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-base font-semibold text-zinc-200 mb-2 mt-5">{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-sm font-semibold text-zinc-300 mb-2 mt-4">{children}</h3>
                  ),
                  p: ({ children }) => (
                    <p className="text-sm text-zinc-300 mb-3 leading-relaxed">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc list-inside mb-3 space-y-1 pl-1">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="list-decimal list-inside mb-3 space-y-1 pl-1">{children}</ol>
                  ),
                  li: ({ children }) => (
                    <li className="text-sm text-zinc-300 leading-relaxed">{children}</li>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-semibold text-zinc-100">{children}</strong>
                  ),
                  em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-zinc-700 pl-4 my-3 text-zinc-400 italic">
                      {children}
                    </blockquote>
                  ),
                  code: ({ children }) => (
                    <code className="bg-zinc-800 text-zinc-200 px-1.5 py-0.5 rounded text-xs font-mono">
                      {children}
                    </code>
                  ),
                  pre: ({ children }) => (
                    <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 overflow-x-auto mb-3 text-xs font-mono text-zinc-200">
                      {children}
                    </pre>
                  ),
                  hr: () => <hr className="border-zinc-800 my-4" />,
                }}
              >
                {wikilinksToMarkdown(content)}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
