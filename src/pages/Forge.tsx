import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, Loader, Paperclip, Send, X, Zap } from "lucide-react";
import {
  type RoleKey,
  type RoleState,
  type ForgeTurn,
  type ForgeTurnTerminal,
  type ActivePodEntry,
  subscribe as subscribeForge,
  getSnapshot as getForgeSnapshot,
  markPushed,
  appendSpecRun,
  markSpecRunPushed,
  registerActivePod,
  markActivePodPushed,
} from "../lib/forgeThreadStore";
import {
  type PodRoleKey,
  POD_STEP_ROLE,
  emptyPodRoles,
  PodRoleTabs,
  PodDoneCard,
  PodNeedsYouCard,
} from "../components/ForgePodPanel";
import {
  type ActiveSpecRun,
  type SpecItemLive,
  SpecRunView,
  SpecRunSummary,
} from "../components/ForgeSpecPanel";

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

interface SpecStreamPayload {
  specId: string;
  phase: string;
  itemIndex?: number;
  itemText?: string;
  items?: Array<{ index: number; text: string; status: string; commitHash?: string; flagReason?: string }>;
  commitHash?: string;
  flagReason?: string;
  gitLog?: string;
  diff?: string;
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

// ── Image upload helpers ──────────────────────────────────────────────────────

interface AttachedImage {
  key: string;
  file?: File;        // picker / paste — upload on send
  vaultPath?: string; // native Tauri drop — already in vault
  previewUrl: string; // blob URL (picker) or data URL (native drop)
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

  const [repoPath, setRepoPath]       = useState(() => loadRecents()[0] ?? FALLBACK_REPO);
  const [recents, setRecents]         = useState<string[]>(() => loadRecents());
  const [showRecents, setShowRecents] = useState(false);

  // ── Task mode ─────────────────────────────────────────────────────────────
  const [draft, setDraft]             = useState("");
  // startingTurn: brief pre-podId window between Send and run_pod resolve.
  const [startingTurn, setStartingTurn] = useState<{
    id: string; userMessage: string; repoPath: string;
    hasCumulativeDiff: boolean; userImages?: string[];
  } | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Spec mode ─────────────────────────────────────────────────────────────
  const [inputMode, setInputMode]       = useState<"task" | "spec">("task");
  const [specDraft, setSpecDraft]       = useState("");
  const [activeSpecRun, setActiveSpecRun] = useState<ActiveSpecRun | null>(null);
  const [specLaunchError, setSpecLaunchError] = useState<string | null>(null);

  const threadRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLTextAreaElement>(null);
  const textAreaRef = useRef<HTMLPreElement>(null);

  const completedTurns    = forgeSnapshot.threads[repoPath] ?? [];
  const completedSpecRuns = forgeSnapshot.specRuns?.[repoPath] ?? [];

  // Derive active turn from the global store (or startingTurn while run_pod is in-flight).
  const activePodPair = Object.entries(forgeSnapshot.activePods)
    .find(([, e]) => e.repoPath === repoPath) ?? null;
  const activePodId    = activePodPair?.[0] ?? null;
  const activePodEntry: ActivePodEntry | null = activePodPair?.[1] ?? null;

  const activeTurn: ActiveTurn | null = activePodEntry
    ? {
        id: activePodEntry.turnId,
        userMessage: activePodEntry.userMessage,
        podId: activePodId!,
        repoPath: activePodEntry.repoPath,
        roles: activePodEntry.roles,
        podStep: activePodEntry.podStep,
        running: activePodEntry.running,
        terminal: activePodEntry.terminal,
        pushed: activePodEntry.pushed,
        hasCumulativeDiff: activePodEntry.hasCumulativeDiff,
        userImages: activePodEntry.userImages,
      }
    : startingTurn?.repoPath === repoPath
    ? {
        id: startingTurn.id,
        userMessage: startingTurn.userMessage,
        podId: "",
        repoPath: startingTurn.repoPath,
        roles: emptyPodRoles(),
        podStep: "planning",
        running: true,
        terminal: null,
        pushed: false,
        hasCumulativeDiff: startingTurn.hasCumulativeDiff,
        userImages: startingTurn.userImages,
      }
    : null;

  // Filter out the active turn so it doesn't appear twice (it shows in ActiveTurnView).
  const displayTurns = activeTurn
    ? completedTurns.filter((t) => t.id !== activeTurn.id)
    : completedTurns;

  const podRunning  = activeTurn?.running ?? false;
  const specRunning = activeSpecRun?.phase === "decomposing" || activeSpecRun?.phase === "running";
  const busy        = podRunning || specRunning;

  // Close recents on outside click.
  useEffect(() => {
    if (!showRecents) return;
    function close(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-recents-anchor]")) setShowRecents(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showRecents]);

  // On repo switch, clear in-flight state.
  useEffect(() => {
    setStartingTurn(null);
    setLaunchError(null);
    setActiveSpecRun(null);
    setSpecLaunchError(null);
  }, [repoPath]);

  // Tauri native drag-drop.
  useEffect(() => {
    const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
    let unlisten: (() => void) | null = null;
    getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (p.type === "drop") {
        setIsDragOver(false);
        const imagePaths = p.paths.filter(
          (fp) => IMAGE_EXTS.has(fp.split(".").pop()?.toLowerCase() ?? "")
        );
        if (imagePaths.length === 0) return;
        const results: AttachedImage[] = [];
        for (const fp of imagePaths) {
          try {
            const [previewUrl, vaultPath] = await Promise.all([
              invoke<string>("read_file_as_data_url", { path: fp }),
              invoke<string>("save_upload_from_path", { srcPath: fp }),
            ]);
            results.push({ key: `drop-${Date.now()}-${Math.random()}`, vaultPath, previewUrl });
          } catch (e) {
            setImageError(`Failed to attach: ${e}`);
          }
        }
        if (results.length > 0) setAttachedImages((prev) => [...prev, ...results]);
      } else if (p.type === "over") {
        setIsDragOver(true);
      } else {
        setIsDragOver(false);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Spec event subscription ───────────────────────────────────────────────
  useEffect(() => {
    const specId   = activeSpecRun?.specId;
    const specRepo = activeSpecRun?.repoPath;
    const specScope = activeSpecRun?.scope;
    if (!specId || !specRepo || !specScope) return;
    const subs: Array<() => void> = [];

    listen<SpecStreamPayload>("spec-stream", (ev) => {
      const p = ev.payload;
      if (p.specId !== specId) return;

      // Persist completed run before updating state
      if (p.phase === "spec_done" && p.items) {
        appendSpecRun(specRepo, {
          id: specId,
          scope: specScope,
          completedAt: Date.now(),
          items: p.items.map((si) => ({
            index: si.index,
            text: si.text,
            status: si.status as "done" | "flagged",
            commitHash: si.commitHash,
            flagReason: si.flagReason,
          })),
          gitLog: p.gitLog ?? "",
          diff: p.diff ?? "",
          pushed: false,
        });
      }

      setActiveSpecRun((prev) => {
        if (!prev || prev.specId !== specId) return prev;

        switch (p.phase) {
          case "checklist":
            return {
              ...prev,
              phase: "running" as const,
              items: (p.items ?? []).map((si): SpecItemLive => ({
                index: si.index,
                text: si.text,
                status: "pending" as const,
                roles: emptyPodRoles(),
                podStep: "",
                podRunning: false,
                expanded: false,
              })),
            };
          case "item_start":
            return {
              ...prev,
              items: prev.items.map((item): SpecItemLive => ({
                ...item,
                status: item.index === p.itemIndex ? "building" : item.status,
                podRunning: item.index === p.itemIndex ? true : item.podRunning,
                // Auto-expand the building item; collapse others
                expanded: item.index === p.itemIndex ? true : (item.status !== "pending" ? item.expanded : false),
              })),
            };
          case "item_done":
            return {
              ...prev,
              items: prev.items.map((item): SpecItemLive => (
                item.index === p.itemIndex
                  ? { ...item, status: "done", commitHash: p.commitHash, podRunning: false }
                  : item
              )),
            };
          case "item_flagged":
            return {
              ...prev,
              items: prev.items.map((item): SpecItemLive => (
                item.index === p.itemIndex
                  ? { ...item, status: "flagged", flagReason: p.flagReason, podRunning: false, expanded: true }
                  : item
              )),
            };
          case "spec_done":
            return {
              ...prev,
              phase: "done" as const,
              gitLog: p.gitLog,
              diff: p.diff,
              items: p.items
                ? prev.items.map((item): SpecItemLive => {
                    const update = p.items!.find((si) => si.index === item.index);
                    return update
                      ? { ...item, status: update.status as SpecItemLive["status"], commitHash: update.commitHash, flagReason: update.flagReason, podRunning: false }
                      : item;
                  })
                : prev.items,
            };
          case "needs_you":
            return { ...prev, phase: "error" as const, errorText: p.itemText };
          default:
            return prev;
        }
      });
    }).then((u) => subs.push(u));

    // Pod events for spec items — podId = "{specId}-item-{i}"
    listen<PodStreamPayload>("pod-stream", (ev) => {
      const p = ev.payload;
      const prefix = `${specId}-item-`;
      if (!p.podId.startsWith(prefix)) return;
      const idx = parseInt(p.podId.slice(prefix.length), 10);
      if (isNaN(idx)) return;

      setActiveSpecRun((prev) => {
        if (!prev || prev.specId !== specId) return prev;
        return {
          ...prev,
          items: prev.items.map((item): SpecItemLive =>
            item.index === idx ? { ...item, podStep: p.step } : item
          ),
        };
      });
    }).then((u) => subs.push(u));

    // Agent text events for spec items — parentRunId = "{specId}-item-{i}"
    listen<AgentStreamPayload>("agent-stream", (ev) => {
      const p = ev.payload;
      const prefix = `${specId}-item-`;
      if (!p.parentRunId?.startsWith(prefix)) return;
      const idx = parseInt(p.parentRunId.slice(prefix.length), 10);
      if (isNaN(idx)) return;
      const role = p.agentId as PodRoleKey;
      if (!["planner", "builder", "reviewer"].includes(role)) return;

      setActiveSpecRun((prev) => {
        if (!prev || prev.specId !== specId) return prev;
        return {
          ...prev,
          items: prev.items.map((item): SpecItemLive => {
            if (item.index !== idx) return item;
            const r = item.roles[role];
            let nextRoles = item.roles;
            switch (p.kind) {
              case "start":
                nextRoles = { ...item.roles, [role]: { status: "running" as const, activity: "", text: "" } };
                break;
              case "text":
                nextRoles = { ...item.roles, [role]: { ...r, text: r.text + p.text, status: "running" as const } };
                break;
              case "activity":
                nextRoles = { ...item.roles, [role]: { ...r, activity: p.text } };
                break;
              case "done":
                nextRoles = { ...item.roles, [role]: { ...r, status: "done" as const, activity: "" } };
                break;
              case "error":
              case "timeout":
              case "stopped":
                nextRoles = { ...item.roles, [role]: { ...r, status: "error" as const, activity: "" } };
                break;
            }
            return { ...item, roles: nextRoles };
          }),
        };
      });
    }).then((u) => subs.push(u));

    return () => subs.forEach((f) => f());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpecRun?.specId]);

  // Auto-scroll active role text pane.
  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  }, [activeTurn?.roles]);

  // Scroll thread to bottom on new content.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (threadRef.current) {
        threadRef.current.scrollTop = threadRef.current.scrollHeight;
      }
    });
  }, [completedTurns.length, activeTurn?.id, activeTurn?.terminal, activeSpecRun?.phase, activeSpecRun?.items.length]);

  // ── Actions ───────────────────────────────────────────────────────────────

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
    if (!message || !repoPath.trim() || busy) return;

    const path = repoPath.trim();
    saveRecent(path);
    setRecents(loadRecents());
    setDraft("");
    setLaunchError(null);
    const capturedImages = attachedImages;
    setAttachedImages([]);
    setImageError(null);

    const repoTurns = forgeSnapshot.threads[path] ?? [];
    const lastTurn  = repoTurns[repoTurns.length - 1];
    const hasCumulativeDiff =
      lastTurn?.terminal?.kind === "ready_to_push" && !lastTurn.pushed;

    const context = buildContext(repoTurns, hasCumulativeDiff);

    let task = message;
    const blobUrls = capturedImages.map((img) => img.previewUrl);
    if (capturedImages.length > 0) {
      const paths: string[] = [];
      for (const img of capturedImages) {
        try {
          let savedPath: string;
          if (img.vaultPath) {
            savedPath = img.vaultPath;
          } else if (img.file) {
            const b64 = await fileToBase64(img.file);
            savedPath = await invoke<string>("save_upload", { filename: img.file.name, dataBase64: b64 });
          } else {
            continue;
          }
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

    const turnId = newTurnId();
    const userImages = blobUrls.length > 0 ? blobUrls : undefined;
    setStartingTurn({ id: turnId, userMessage: message, repoPath: path, hasCumulativeDiff, userImages });

    try {
      const podId = await invoke<string>("run_pod", {
        repoPath: path,
        task,
        context: context ?? null,
      });
      setStartingTurn(null);
      registerActivePod(podId, {
        turnId,
        repoPath: path,
        userMessage: message,
        roles: emptyPodRoles(),
        podStep: "planning",
        running: true,
        terminal: null,
        pushed: false,
        hasCumulativeDiff,
        userImages,
      });
    } catch (e) {
      setLaunchError(String(e));
      setStartingTurn(null);
    }
  }

  async function handleRunSpec() {
    const scope = specDraft.trim();
    if (!scope || !repoPath.trim() || busy) return;

    const path = repoPath.trim();
    saveRecent(path);
    setRecents(loadRecents());
    setSpecDraft("");
    setSpecLaunchError(null);

    try {
      const specId = await invoke<string>("run_spec", { repoPath: path, scope });
      setActiveSpecRun({
        specId,
        repoPath: path,
        scope,
        phase: "decomposing",
        items: [],
        pushed: false,
      });
    } catch (e) {
      setSpecLaunchError(String(e));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handleSpecKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleRunSpec();
    }
  }

  function handlePushed(turnId: string) {
    markPushed(repoPath, turnId);
    if (activePodId && activePodEntry?.turnId === turnId) {
      markActivePodPushed(activePodId);
    }
  }

  function toggleSpecItem(index: number) {
    setActiveSpecRun((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((item) =>
          item.index === index ? { ...item, expanded: !item.expanded } : item
        ),
      };
    });
  }

  function handleSpecPushed() {
    if (!activeSpecRun) return;
    markSpecRunPushed(activeSpecRun.repoPath, activeSpecRun.specId);
    setActiveSpecRun((prev) => prev ? { ...prev, pushed: true } : null);
    // Keep the done card visible briefly then clear
    setTimeout(() => setActiveSpecRun(null), 1200);
  }

  function handleSpecDiscard() {
    setActiveSpecRun(null);
  }

  const hasThread =
    displayTurns.length > 0 ||
    activeTurn !== null ||
    activeSpecRun !== null ||
    completedSpecRuns.length > 0;

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
            disabled={busy}
            placeholder="/path/to/repo"
            className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-md px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 transition-colors font-mono"
          />
          {recents.length > 0 && (
            <div className="relative" data-recents-anchor>
              <button
                onClick={() => setShowRecents((v) => !v)}
                disabled={busy}
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
            disabled={busy}
            title="Choose repo folder"
            className="px-2.5 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 transition-colors flex items-center gap-1.5 text-xs whitespace-nowrap"
          >
            <FolderOpen size={13} />
            Browse
          </button>
        </div>
      </div>

      {/* ── Thread scroll area ───────────────────────────────────────── */}
      <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {!hasThread ? (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
              <Zap size={16} className="text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-500">No thread yet</p>
            <p className="text-xs text-zinc-600 mt-1">
              {inputMode === "spec"
                ? "Paste a multi-part scope above and run a spec to kick off auto-decomposition"
                : "Type a task below and press Enter to kick off a pod"}
            </p>
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
            {/* Completed spec runs (collapsed summaries) */}
            {completedSpecRuns.map((sr) => (
              <SpecRunSummary key={sr.id} run={sr} />
            ))}
            {/* Active spec run */}
            {activeSpecRun && (
              <SpecRunView
                run={activeSpecRun}
                textRef={textAreaRef}
                onToggleItem={toggleSpecItem}
                onPushed={handleSpecPushed}
                onDiscard={handleSpecDiscard}
              />
            )}
          </>
        )}

        {launchError && (
          <p className="text-[11px] text-red-400 px-1">{launchError}</p>
        )}
        {specLaunchError && (
          <p className="text-[11px] text-red-400 px-1">{specLaunchError}</p>
        )}
      </div>

      {/* ── Composer ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-zinc-800 px-5 py-3">
        {/* Mode toggle */}
        <div className="flex gap-1 mb-2.5">
          <button
            onClick={() => setInputMode("task")}
            disabled={busy}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
              inputMode === "task"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            }`}
          >
            Task
          </button>
          <button
            onClick={() => setInputMode("spec")}
            disabled={busy}
            className={`px-2.5 py-1 text-[11px] rounded-md transition-colors ${
              inputMode === "spec"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
            }`}
          >
            Spec
          </button>
        </div>

        {inputMode === "task" ? (
          /* ── Task input ──────────────────────────────────────────── */
          <>
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
            <div className={`flex gap-2 items-end transition-shadow${isDragOver ? " ring-2 ring-inset ring-zinc-500/60 rounded-lg" : ""}`}>
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
                disabled={busy}
                placeholder={busy ? "Running…" : "Describe what to build… (Enter to send, Shift+Enter for newline)"}
                rows={2}
                className="flex-1 min-w-0 bg-zinc-900/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none transition-colors"
              />
              <div className="flex flex-col gap-1.5 items-center">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
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
                  disabled={busy || !draft.trim() || !repoPath.trim()}
                  className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-zinc-700 whitespace-nowrap"
                >
                  {podRunning ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
                  {podRunning ? "Running…" : "Send"}
                </button>
              </div>
            </div>
          </>
        ) : (
          /* ── Spec input ──────────────────────────────────────────── */
          <div className="space-y-2">
            <textarea
              value={specDraft}
              onChange={(e) => setSpecDraft(e.target.value)}
              onKeyDown={handleSpecKeyDown}
              disabled={busy}
              placeholder={
                busy
                  ? "Spec is running…"
                  : 'Describe the full scope (e.g. "add a utils.js with slugify, capitalize, truncate"). Planner will break it into a checklist, then run a pod per task.\n\n⌘+Enter to run.'
              }
              rows={5}
              className="w-full bg-zinc-900/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none transition-colors leading-relaxed"
            />
            <div className="flex justify-end">
              <button
                onClick={() => void handleRunSpec()}
                disabled={busy || !specDraft.trim() || !repoPath.trim()}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-zinc-700"
              >
                {specRunning ? <Loader size={12} className="animate-spin" /> : <Zap size={12} />}
                {specRunning ? "Running spec…" : "Run spec"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
