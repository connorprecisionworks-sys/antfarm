# Pulitzer content system + browser extension — build plan

Scoped 2026-06-28 (Cowork). Pulitzer (content agent) drafts posts; Antfarm serves them over a local API keyed by a secret; a Chrome extension surfaces them in the browser so Connor copies text and grabs image files in one motion while on LinkedIn / Instagram / X. No third-party automation. Connor stays the post gate.

Read all of this before building. Phase order matters. Push to main per phase after acceptance + cargo check + npm run build green. No DB migrations.

## The flow
Idea (Connor's or Pulitzer-generated) -> Pulitzer reads content/ for voice + past posts -> drafts per-platform text + picks pillar -> visual: hands a carousel to Forge OR emits a ChatGPT image prompt -> writes the finished post to content/drafts/ -> Connor reviews/okays -> the extension shows it in-browser -> Connor copies text, drags/downloads images, posts.

## Locked decisions
- No Zapier / third-party poster. A Connor-owned Chrome extension talks to Antfarm over a LOCAL API with an API key.
- MVP = copy buttons + draggable/downloadable image files + "mark posted." Composer auto-insert is a later phase (LinkedIn first; platform DOMs are messy).
- Pulitzer writes drafts only inside the vault content/ (needs the write-guard below). Carousels are built by Forge. Posting is manual for now; the extension just makes it one motion.

---

## Phase 1 — Vault write-guard (foundation + fixes the Clerk regression)

The recent lockdown denied Write/Edit to ALL networked agents to stop them editing app code. That also blocks legit vault writes (Scribe drafts, Clerk commitments, and Pulitzer's post drafts). Replace the blanket deny with a PATH-SCOPED guard.

- Re-allow Write/Edit/MultiEdit for networked agents, but add a PreToolUse hook (same pattern as Builder's Bash guard, ensure_*_hooks) that inspects the target path and BLOCKS any write whose resolved absolute path is outside the vault root (vault_root()). Writes inside the vault pass; writes to any code repo or anywhere else are blocked (exit 2 with a clear reason).
- Keep NotebookEdit denied for networked agents (not needed). Keep Bash denied for networked agents (unchanged).
- This restores Clerk/Scribe/Pulitzer vault writes while keeping Clerk out of app code. Builder write-mode + Forge pods are unaffected (they write to their repo via their own path scope).

**Acceptance:** a networked agent (e.g. pulitzer) can Write a file under the vault (content/drafts/test.md) but is BLOCKED writing to /Users/connordore/Desktop/antfarm/src/anything or any path outside the vault. Unit/integration check of the path guard. cargo check + npm run build green. Commit + push.

---

## Phase 2 — Register Pulitzer + the draft format

- Confirm list_agents discovers agents/pulitzer/. Add pulitzer to KNOWN_AGENT_IDS in Chat.tsx so Jack can delegate to it.
- Define the draft on disk: Pulitzer writes each finished post to content/drafts/post-<unix>/post.json with: { created, idea, pillar, platforms: { linkedin: "...", instagram: { caption, slides: ["...", ...] }, x: "..." }, image: { type: "prompt" | "carousel", prompt?: "...", carouselRef?: "..." }, status: "ready" }. Plus any built carousel asset files in the same folder.
- Pulitzer's prompt already emits the platform copy + visual plan + ---POST-READY---; the app (or Pulitzer via the now-allowed vault Write) persists it to that folder on Connor's okay.

**Acceptance:** @pulitzer "draft a LinkedIn post about the Clerk permission incident" returns platform copy + a visual plan, and on okay a content/drafts/post-*/post.json appears. cargo check + npm run build green. Commit + push.

---

## Phase 3 — Antfarm local posts API (keyed)

Add a tiny local HTTP server in the Tauri app (127.0.0.1, fixed port e.g. 8787), guarded by an API key.

- Settings: generate/show/rotate an API key (store in app-config). The extension sends it as a header (Authorization: Bearer <key> or X-Antfarm-Key).
- Endpoints (all require the key): GET /posts -> list ready posts (parsed post.json from content/drafts/, newest first); GET /posts/:id -> one post; GET /file/:id/:name -> serve an image/carousel asset from that post folder; POST /posts/:id/posted -> mark status posted (and optionally archive the folder).
- CORS: allow the extension origin. Bind to localhost only; never expose externally.

**Acceptance:** with Antfarm running, `curl -H "X-Antfarm-Key: <key>" localhost:8787/posts` returns the ready posts as JSON; a wrong/missing key returns 401; image files serve. cargo check + npm run build green. Commit + push.

---

## Phase 4 — The Chrome extension (new repo, Forge-built)

A new repo `pulitzer-extension` (Manifest V3). Build it with Forge (greenfield web, safe). Set up the repo skeleton + local remote the same way as connordore-com first.

- Options page: paste the Antfarm API key + confirm the local URL. Store in chrome.storage.
- Side panel (or popup): fetch GET /posts from the local API; list ready posts with the pillar + a preview.
- Per post: a tab per platform (LinkedIn / IG / X) with the formatted text and a one-click Copy button; the image(s) as draggable thumbnails + a Download button + a "Copy image prompt" button (for the ChatGPT image path); a "Mark posted" button -> POST /posted.
- Clean, minimal dark UI (house style). Keep it dead simple: open panel, copy, drag image, post, mark done.
- LATER (Phase 5): an "Insert into composer" button using a content script, LinkedIn first.

**Acceptance:** load the unpacked extension, paste the key, see Pulitzer's ready posts, copy text into LinkedIn, drag an image in, mark posted (it disappears from the list). Build green. Commit + push.

## Hard gates
- Local API binds to 127.0.0.1 only, key-required, never exposed. Pulitzer writes only inside the vault (Phase 1 guard). Connor approves every post (no auto-publish in this plan). Carousels via Forge; the app/extension never edits code.

## Out of scope (later)
- Composer auto-insert (Phase 5), real auto-publish, analytics, scheduling.
