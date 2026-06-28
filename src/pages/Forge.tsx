import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, Loader, Paperclip, Send, X, Zap } from "lucide-react";
import {
  type RoleKey,
  type RoleState,
  type ForgeTurn,
  type ForgeTurnTerminal,
  subscribe as subscribeForge,
  getSnapshot as getForgeSnapshot,
  appendTurn,
  markPushed,
} from "../lib/forgeThreadStore";
import {
  type PodRoleKey,
  POD_STEP_ROLE,
  emptyPodRoles,
  PodRoleTabs,
  PodDoneCard,
  PodNeedsYouCard,
} from "../components/ForgePodPanel";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PodStreamPayload {
  podId: string;
  step: string;
  kind: string;
  text: string;
  commitMsg?: string;
  diff?: string;
  reviewerNote?: string;
}

interface AgentStreamPayload {
  runId: string;
  agentId: string;
  kind: string;
  text: string;
  parentRunId?: string;
}

interface ActiveTurn {
  id: string;
  userMessage: string;
  podId: string;
  repoPath: string; // captured at send time — prevents stale-closure issues
  roles: Record<RoleKey, RoleState>;
  podStep: string;
  running: boolean;
  terminal: ForgeTurnTerminal | null;
  pushed: boolean;
  hasCumulativeDiff: boolean;
  userImages?: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RECENTS_KEY = "forge:recentRepos";
const MAX_RECENTS = 5;
const FALLBACK_REPO = "/Users/connordore/Desktop/antfarm-write-test";

function newTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Recents ───────────────────────────────────────────────────────────────────

function loadRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]"); }
  catch { return []; }
}

function saveRecent(path: string): void {
  const prev = loadRecents().filter((p) => p !== path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([path, ...prev].slice(0, MAX_RECENTS)));
}

// ── Conversation context builder ───────────────────────────────────────────────

function buildContext(turns: ForgeTurn[], hasCumulativeDiff: boolean): string | undefined {
  if (turns.length === 0 && !hasCumulativeDiff) return undefined;
  const recent = turns.slice(-6);
  const lines = recent.map((t, i) => {
    let outcome = "in progress";
    if (t.terminal?.kind === "ready_to_push") {
      outcome = t.pushed ? "approved and pushed" : "built, awaiting approval";
    } else if (t.terminal?.kind === "needs_you") {
      outcome = "escalated, needs attention";
    }
    return `Turn ${i + 1}: "${t.userMessage}" → ${outcome}`;
  });
  let ctx = `Prior turns in this coding session:\n${lines.join("\n")}`;
  if (hasCumulativeDiff) {
    ctx +=
      "\n\nIMPORTANT: The previous turn's changes are uncommitted in the working tree. " +
      "The next build continues on top of them cumulatively — this is expected and correct.";
  }
  return ctx;
}

// (PodRoleTabs, PodDoneCard, PodNeedsYouCard are imported from ForgePodPanel)

// ── Image upload helpers ──────────────────────────────────────────────────────

interface AttachedImage {
  key: string;
  file: File;
  previewUrl: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// ── UserBubble ────────────────────────────────────────────────────────────────

function UserBubble({ message, images }: { message: string; images?: string[] }) {
  return (
    <div className="flex justify-end">
      <div className="bg-zinc-800/70 border border-zinc-700/40 rounded-2xl rounded-tr-sm px-3 py-2 text-[13px] text-zinc-200 max-w-[85%] whitespace-pre-wrap leading-relaxed">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {images.map((url, i) => (
              <img
                key={i}
                src={url}
                className="h-24 max-w-[200px] object-cover rounded-lg"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            ))}
          </div>
        )}
        {message}
      </div>
    </div>
  );
}

// ── CompletedTurnView ─────────────────────────────────────────────────────────

function CompletedTurnView({
  turn,
  repoPath,
  onPushed,
}: {
  turn: ForgeTurn;
  repoPath: string;
  onPushed: (turnId: string) => void;
}) {
  const [activeRole, setActiveRole] = useState<RoleKey>(turn.activeRole);

  return (
    <div className="space-y-2">
      <UserBubble message={turn.userMessage} images={turn.userImages} />
      <PodRoleTabs
        roles={turn.roleEntries}
        activeRole={activeRole}
        onSetRole={setActiveRole}
      />
      {turn.terminal?.kind === "ready_to_push" && (
        <PodDoneCard
          repoPath={repoPath}
          commitMsg={turn.terminal.commitMsg}
          diff={turn.terminal.diff}
          reviewerNote={turn.terminal.reviewerNote}
          pushed={turn.pushed}
          hasCumulativeDiff={false}
          onPush={() => onPushed(turn.id)}
        />
      )}
      {turn.terminal?.kind === "needs_you" && (
        <PodNeedsYouCard text={turn.terminal.text} />
      )}
    </div>
  );
}

// ── ActiveTurnView ────────────────────────────────────────────────────────────

function ActiveTurnView({
  turn,
  textRef,
  onPushed,
}: {
  turn: ActiveTurn;
  textRef: React.RefObject<HTMLPreElement>;
  onPushed: () => void;
}) {
  const [activeRole, setActiveRole] = useState<RoleKey>("planner");

  // Auto-advance tab while the pod is running, respect user's choice when done.
  useEffect(() => {
    if (!turn.running) return;
    const suggested = POD_STEP_ROLE[turn.podStep];
    if (suggested) setActiveRole(suggested);
  }, [turn.podStep, turn.running]);

  return (
    <div className="space-y-2">
      <UserBubble message={turn.userMessage} images={turn.userImages} />
      <PodRoleTabs
        roles={turn.roles}
        activeRole={activeRole}
        onSetRole={setActiveRole}
        textRef={textRef}
        podStep={turn.podStep}
        running={turn.running}
      />
      {turn.terminal?.kind === "ready_to_push" && (
        <PodDoneCard
          repoPath={turn.repoPath}
          commitMsg={turn.terminal.commitMsg}
          diff={turn.terminal.diff}
          reviewerNote={turn.terminal.reviewerNote}
          pushed={turn.pushed}
          hasCumulativeDiff={turn.hasCumulativeDiff}
          onPush={onPushed}
        />
      )}
      {turn.terminal?.kind === "needs_you" && (
        <PodNeedsYouCard text={turn.terminal.text} />
      )}
    </div>
  );
}

// ── Forge page ────────────────────────────────────────────────────────────────

export function Forge() {
  const forgeSnapshot = useSyncExternalStore(subscribeForge, getForgeSnapshot);

  const [repoPath, setRepoPath]     = useState(() => loadRecents()[0] ?? FALLBACK_REPO);
  const [recents, setRecents]       = useState<string[]>(() => loadRecents());
  const [showRecents, setShowRecents] = useState(false);
  const [draft, setDraft]           = useState("");
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const threadRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const textAreaRef = useRef<HTMLPreElement>(null);

  const completedTurns = forgeSnapshot.threads[repoPath] ?? [];
  // Filter out the active turn so it doesn't appear twice (it's appended to the
  // store on terminal event while still living in local activeTurn state).
  const displayTurns = activeTurn
    ? completedTurns.filter((t) => t.id !== activeTurn.id)
    : completedTurns;

  const podRunning = activeTurn?.running ?? false;

  // Close recents on outside click.
  useEffect(() => {
    if (!showRecents) return;
    function close(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-recents-anchor]")) setShowRecents(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showRecents]);

  // On repo switch, clear the in-flight active turn (it belongs to the old repo).
  useEffect(() => {
    setActiveTurn(null);
    setLaunchError(null);
  }, [repoPath]);

  // Subscribe to pod events for the currently active pod.
  useEffect(() => {
    const podId = activeTurn?.podId;
    if (!podId) return;
    const subs: Array<() => void> = [];

    listen<PodStreamPayload>("pod-stream", (ev) => {
      const p = ev.payload;
      if (p.podId !== podId) return;

      setActiveTurn((prev) => {
        if (!prev || prev.podId !== podId) return prev;
        const suggestedRole = POD_STEP_ROLE[p.step];

        if (p.kind === "ready_to_push") {
          const terminal: ForgeTurnTerminal = {
            kind: "ready_to_push",
            commitMsg: p.commitMsg ?? "",
            diff: p.diff ?? "",
            reviewerNote: p.reviewerNote,
          };
          const finished: ActiveTurn = { ...prev, podStep: p.step, running: false, terminal };
          // Persist completed turn immediately so it survives a reload.
          appendTurn(prev.repoPath, {
            id: prev.id,
            userMessage: prev.userMessage,
            podId: prev.podId,
            roleEntries: { ...prev.roles },
            activeRole: "reviewer",
            terminal,
            pushed: false,
            userImages: prev.userImages,
          });
          return finished;
        }

        if (p.kind === "needs_you") {
          const terminal: ForgeTurnTerminal = { kind: "needs_you", text: p.text };
          const step = p.step === "needs_you" ? prev.podStep : p.step;
          const finished: ActiveTurn = { ...prev, podStep: step, running: false, terminal };
          appendTurn(prev.repoPath, {
            id: prev.id,
            userMessage: prev.userMessage,
            podId: prev.podId,
            roleEntries: { ...prev.roles },
            activeRole: (POD_STEP_ROLE[step] ?? "builder"),
            terminal,
            pushed: false,
            userImages: prev.userImages,
          });
          return finished;
        }

        return {
          ...prev,
          podStep: p.step,
          ...(suggestedRole ? {} : {}), // role advance handled in ActiveTurnView
        };
      });
    }).then((u) => subs.push(u));

    listen<AgentStreamPayload>("agent-stream", (ev) => {
      const p = ev.payload;
      if (p.parentRunId !== podId) return;
      const role = p.agentId as PodRoleKey;
      if (!["planner", "builder", "reviewer"].includes(role)) return;

      setActiveTurn((prev) => {
        if (!prev || prev.podId !== podId) return prev;
        const r = prev.roles[role];
        let nextRoles = prev.roles;
        switch (p.kind) {
          case "start":
            nextRoles = { ...prev.roles, [role]: { status: "running" as const, activity: "", text: "" } };
            break;
          case "text":
            nextRoles = { ...prev.roles, [role]: { ...r, text: r.text + p.text, status: "running" as const } };
            break;
          case "activity":
            nextRoles = { ...prev.roles, [role]: { ...r, activity: p.text } };
            break;
          case "done":
            nextRoles = { ...prev.roles, [role]: { ...r, status: "done" as const, activity: "" } };
            break;
          case "error":
          case "timeout":
          case "stopped":
            nextRoles = { ...prev.roles, [role]: { ...r, status: "error" as const, activity: "" } };
            break;
        }
        return { ...prev, roles: nextRoles };
      });
    }).then((u) => subs.push(u));

    return () => subs.forEach((f) => f());
  // Re-subscribe only when a new pod starts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTurn?.podId]);

  // Auto-scroll the active role's text pane.
  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  }, [activeTurn?.roles]);

  // Scroll thread to bottom when a new turn starts or a terminal event lands.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (threadRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    });
  }, [completedTurns.length, activeTurn?.id, activeTurn?.terminal]);

  async function handleChooseRepo() {
    const selected = await openDialog({ directory: true, multiple: false, title: "Choose repo folder" });
    if (typeof selected === "string" && selected) {
      setRepoPath(selected);
      setShowRecents(false);
    }
  }

  function pickRecent(path: string) {
    setRepoPath(path);
    setShowRecents(false);
  }

  function addImagesFromFileList(files: File[]) {
    setImageError(null);
    const toAdd: AttachedImage[] = [];
    for (const file of files) {
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        setImageError(`${file.name}: only png, jpg, webp, gif accepted`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError(`${file.name}: too large (max 10 MB)`);
        continue;
      }
      toAdd.push({ key: `${Date.now()}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) });
    }
    if (toAdd.length > 0) setAttachedImages((prev) => [...prev, ...toAdd]);
  }

  async function handleSend() {
    const message = draft.trim();
    if (!message || !repoPath.trim() || podRunning) return;

    const path = repoPath.trim();
    saveRecent(path);
    setRecents(loadRecents());
    setDraft("");
    setLaunchError(null);
    const capturedImages = attachedImages;
    setAttachedImages([]);
    setImageError(null);

    // Detect cumulative diff: last completed turn is ready_to_push but not yet pushed.
    const repoTurns = forgeSnapshot.threads[path] ?? [];
    const lastTurn  = repoTurns[repoTurns.length - 1];
    const hasCumulativeDiff =
      lastTurn?.terminal?.kind === "ready_to_push" && !lastTurn.pushed;

    const context = buildContext(repoTurns, hasCumulativeDiff);

    // Upload attached images and append vault paths to the task.
    let task = message;
    const blobUrls = capturedImages.map((img) => img.previewUrl);
    if (capturedImages.length > 0) {
      const paths: string[] = [];
      for (const img of capturedImages) {
        try {
          const b64 = await fileToBase64(img.file);
          const savedPath = await invoke<string>("save_upload", { filename: img.file.name, dataBase64: b64 });
          paths.push(savedPath);
        } catch (e) {
          setImageError(`Upload failed: ${e}`);
        }
      }
      if (paths.length > 0) {
        const count = paths.length;
        const joined = paths.map((p) => `  ${p}`).join("\n");
        task += `\n\nUser attached ${count} image${count > 1 ? "s" : ""} — use the Read tool to view ${count > 1 ? "them" : "it"}:\n${joined}`;
      }
    }

    const turnId: string = newTurnId();
    const newTurn: ActiveTurn = {
      id: turnId,
      userMessage: message,
      podId: "", // filled in after invoke
      repoPath: path,
      roles: emptyPodRoles(),
      podStep: "planning",
      running: true,
      terminal: null,
      pushed: false,
      hasCumulativeDiff,
      userImages: blobUrls.length > 0 ? blobUrls : undefined,
    };
    setActiveTurn(newTurn);

    try {
      const podId = await invoke<string>("run_pod", {
        repoPath: path,
        task,
        context: context ?? null,
      });
      setActiveTurn((prev) => (prev?.id === turnId ? { ...prev, podId } : prev));
    } catch (e) {
      setLaunchError(String(e));
      setActiveTurn((prev) =>
        prev?.id === turnId ? { ...prev, running: false } : prev
      );
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handlePushed(turnId: string) {
    markPushed(repoPath, turnId);
    setActiveTurn((prev) => (prev?.id === turnId ? { ...prev, pushed: true } : prev));
  }

  const hasThread = displayTurns.length > 0 || activeTurn !== null;

  return (
    <div className="flex flex-col h-full bg-zinc-950 overflow-hidden">
      {/* ── Header + repo picker ─────────────────────────────────────── */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-zinc-800">
        <div className="mb-3 flex items-baseline gap-2">
          <h1 className="text-sm font-semibold text-zinc-100 leading-none">Forge</h1>
          {repoPath && (
            <span className="text-[11px] text-zinc-500 font-mono truncate max-w-[180px]" title={repoPath}>
              {repoPath.split("/").filter(Boolean).slice(-1)[0] ?? repoPath}
            </span>
          )}
        </div>

        {/* Repo picker */}
        <div className="flex gap-1.5 items-stretch">
          <input
            value={repoPath}
            onChange={(e) => { setRepoPath(e.target.value); setShowRecents(false); }}
            disabled={podRunning}
            placeholder="/path/to/repo"
            className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 transition-colors font-mono"
          />
          {recents.length > 0 && (
            <div className="relative" data-recents-anchor>
              <button
                onClick={() => setShowRecents((v) => !v)}
                disabled={podRunning}
                title="Recent repos"
                className="h-full px-2 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center"
              >
                <ChevronDown size={13} />
              </button>
              {showRecents && (
                <div className="absolute top-full mt-1 right-0 z-20 w-72 bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl py-1 overflow-hidden">
                  {recents.map((p) => (
                    <button
                      key={p}
                      onClick={() => pickRecent(p)}
                      className={`w-full text-left px-3 py-1.5 text-[11px] font-mono truncate transition-colors ${
                        p === repoPath
                          ? "text-zinc-100 bg-zinc-800"
                          : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleChooseRepo}
            disabled={podRunning}
            title="Choose repo folder"
            className="px-2.5 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center gap-1.5 text-xs whitespace-nowrap"
          >
            <FolderOpen size={13} />
            Browse
          </button>
        </div>
      </div>

      {/* ── Thread scroll area ───────────────────────────────────────── */}
      <div
        ref={threadRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-6"
      >
        {!hasThread ? (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
              <Zap size={16} className="text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">No thread yet</p>
            <p className="text-xs text-zinc-600 mt-1">Type a task below and press Enter to kick off a pod</p>
          </div>
        ) : (
          <>
            {displayTurns.map((turn) => (
              <CompletedTurnView
                key={turn.id}
                turn={turn}
                repoPath={repoPath}
                onPushed={handlePushed}
              />
            ))}
            {activeTurn && (
              <ActiveTurnView
                turn={activeTurn}
                textRef={textAreaRef}
                onPushed={() => handlePushed(activeTurn.id)}
              />
            )}
          </>
        )}

        {launchError && (
          <p className="text-[11px] text-red-400 px-1">{launchError}</p>
        )}
      </div>

      {/* ── Message input ────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-zinc-800 px-5 py-3">
        {attachedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachedImages.map((img) => (
              <div key={img.key} className="relative">
                <img src={img.previewUrl} className="h-14 w-14 object-cover rounded-lg border border-zinc-700/50" />
                <button
                  onClick={() => {
                    URL.revokeObjectURL(img.previewUrl);
                    setAttachedImages((prev) => prev.filter((i) => i.key !== img.key));
                  }}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-zinc-700 rounded-full flex items-center justify-center hover:bg-red-700/80 transition-colors"
                >
                  <X size={8} />
                </button>
              </div>
            ))}
          </div>
        )}
        {imageError && <p className="text-[10px] text-red-400 mb-2">{imageError}</p>}
        <div
          className="flex gap-2 items-end"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
          onDrop={(e) => {
            e.preventDefault();
            addImagesFromFileList(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/")));
          }}
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items ?? []).filter((i) => i.type.startsWith("image/"));
              if (items.length === 0) return;
              e.preventDefault();
              addImagesFromFileList(items.map((i) => i.getAsFile()).filter(Boolean) as File[]);
            }}
            onKeyDown={handleKeyDown}
            disabled={podRunning}
            placeholder={
              podRunning
                ? "Pod is running…"
                : "Describe what to build… (Enter to send, Shift+Enter for newline)"
            }
            rows={2}
            className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none transition-colors"
          />
          <div className="flex flex-col gap-1.5 items-center">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={podRunning}
              title="Attach image"
              className="text-zinc-600 hover:text-zinc-400 disabled:opacity-40 transition-colors"
            >
              <Paperclip size={14} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                addImagesFromFileList(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={podRunning || !draft.trim() || !repoPath.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-zinc-700 whitespace-nowrap"
            >
              {podRunning
                ? <Loader size={12} className="animate-spin" />
                : <Send size={12} />}
              {podRunning ? "Running…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
