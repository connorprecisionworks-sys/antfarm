import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useVoice } from "../lib/useVoice";

// gpt-4o-mini-realtime audio pricing ($/min): in $0.06 + out $0.024 ≈ $0.084
const COST_PER_MIN = 0.084;

type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking";
type Mode = "realtime" | "fallback";

interface RealtimeTokenResponse {
  token: string;
  model: string;
  session_id: string;
}

export function VoiceMode() {
  const navigate       = useNavigate();
  const [searchParams] = useSearchParams();
  const mode           = (searchParams.get("mode") ?? "general") as "general" | "morning" | "night";

  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const pcRef       = useRef<RTCPeerConnection | null>(null);
  const dcRef       = useRef<RTCDataChannel | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnRef    = useRef<AnalyserNode | null>(null);
  const outAnRef    = useRef<AnalyserNode | null>(null);
  const micBufRef   = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const outBufRef   = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const orbRafRef   = useRef<number | null>(null);
  const timerRef    = useRef<number | null>(null);
  const idleTimerRef    = useRef<number | null>(null);
  const lastAudioRef    = useRef<number>(0);
  const sessionStartRef = useRef<number | null>(null);
  const orbStateRef = useRef<OrbState>("idle");

  // ── Debug log ──────────────────────────────────────────────────────────────
  const debugLogRef       = useRef<string[]>([]);
  const logPanelRef       = useRef<HTMLDivElement>(null);
  const audioDeltaCountRef = useRef(0);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  function log(msg: string) {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const line = `[${ts}] ${msg}`;
    console.log("[VOICE]", line);
    const next = [...debugLogRef.current.slice(-299), line];
    debugLogRef.current = next;
    setDebugLog(next);
    invoke("append_voice_log", { line }).catch(() => {});
  }

  // Auto-scroll log panel to bottom
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [debugLog]);

  // Cmd+Option+I → open devtools
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey && e.altKey && e.key === "i") {
        invoke("open_devtools").catch(() => {});
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const [voiceMode, setVoiceMode]     = useState<Mode>("realtime");
  const [orbState, setOrbStateReact]  = useState<OrbState>("idle");
  const [status, setStatus]           = useState("ready");
  const [elapsed, setElapsed]         = useState("");
  const [cost, setCost]               = useState("");
  const [captions, setCaptions]       = useState("");
  const [captionsOn, setCaptionsOn]   = useState(false);
  const [error, setError]             = useState("");
  const [errorKind, setErrorKind]     = useState<"mic" | "network" | "">("");
  const [planPending, setPlanPending] = useState(false);
  const [fbHolding, setFbHolding]     = useState(false);
  const [idleEnded, setIdleEnded]     = useState(false);

  // Fallback voice hook (batch STT + TTS via Tauri)
  const voice = useVoice({
    voice: "ash",
    onTranscript: async (text) => {
      setStatus("thinking…");
      try {
        const reply = await invoke<string>("jarvis_chat", { message: text });
        setCaptions(reply);
        await voice.speak(reply);
      } catch (e) {
        setError("Jarvis: " + String(e));
      } finally {
        setStatus("ready");
      }
    },
  });

  function setOrbState(s: OrbState) {
    orbStateRef.current = s;
    setOrbStateReact(s);
    setStatus(
      s === "connecting" ? "connecting…"
      : s === "listening" ? "live"
      : s === "thinking"  ? "live"
      : s === "speaking"  ? "live"
      : "ready"
    );
  }

  // ── Orb particle canvas ─────────────────────────────────────────────────────

  const startOrb = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const SZ  = Math.min(window.innerWidth, window.innerHeight - 200, 340);
    cv.style.width  = SZ + "px";
    cv.style.height = SZ + "px";
    cv.width  = SZ * DPR;
    cv.height = SZ * DPR;
    const ctx = cv.getContext("2d")!;
    ctx.scale(DPR, DPR);
    const W = SZ, H = SZ, CX = W / 2, CY = H / 2;
    const N = 1200, R = SZ * 0.34, FOCAL = 400;

    const sph: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      const ph = Math.acos(1 - 2 * (i + 0.5) / N);
      const th = Math.PI * (1 + Math.sqrt(5)) * i;
      sph.push([Math.cos(th) * Math.sin(ph) * R, Math.sin(th) * Math.sin(ph) * R, Math.cos(ph) * R]);
    }
    const PS = Array.from({ length: N }, () => 0.45 + Math.random() * 0.55);
    let ang = 0, breath = 0;

    function getAmp(an: AnalyserNode | null, buf: Uint8Array<ArrayBuffer> | null): number {
      if (!an || !buf) return 0;
      an.getByteFrequencyData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i];
      return s / (buf.length * 255);
    }

    function rot(x: number, y: number, z: number, ax: number, ay: number): [number, number, number] {
      const cy = Math.cos(ay), sy = Math.sin(ay);
      const X = x * cy - z * sy, Z = x * sy + z * cy;
      const cx = Math.cos(ax), sx = Math.sin(ax);
      return [X, y * cx - Z * sx, y * sx + Z * cx];
    }

    function frame() {
      const st = orbStateRef.current;
      let rsp = 0.004, bsp = 0.007, bamp = 0.05, swirl = 0;
      if      (st === "connecting") { rsp = 0.003; bsp = 0.005; bamp = 0.03; }
      else if (st === "listening")  { rsp = 0.007; bsp = 0.014; bamp = 0.09; }
      else if (st === "thinking")   { rsp = 0.020; bsp = 0.030; bamp = 0.04; swirl = 0.18; }
      else if (st === "speaking")   { rsp = 0.009; bsp = 0.022; bamp = 0.07; }

      ang += rsp; breath += bsp;
      const micAmp = getAmp(micAnRef.current, micBufRef.current);
      const outAmp = getAmp(outAnRef.current, outBufRef.current);
      const reactAmp = st === "listening" ? micAmp : st === "speaking" ? outAmp : 0;
      const scale = 1 + Math.sin(breath) * bamp + reactAmp * 0.35;
      const sw = swirl ? Math.sin(breath * 2) * swirl : 0;

      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const base = sph[i];
        const rp = rot(base[0] * scale, base[1] * scale, base[2] * scale, ang * 0.38 + sw, ang);
        const depth = FOCAL / (FOCAL - rp[2]);
        const px = CX + rp[0] * depth, py = CY + rp[1] * depth;
        const bright = Math.min(0.92, 0.35 + depth * 0.28 + reactAmp * 0.45);
        ctx.beginPath();
        ctx.arc(px, py, PS[i] * depth * 0.65, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(124,151,232,${bright.toFixed(2)})`;
        ctx.fill();
      }
      orbRafRef.current = requestAnimationFrame(frame);
    }
    frame();
  }, []);

  const stopOrb = useCallback(() => {
    if (orbRafRef.current) { cancelAnimationFrame(orbRafRef.current); orbRafRef.current = null; }
  }, []);

  // ── WebRTC ──────────────────────────────────────────────────────────────────

  function sendRT(obj: unknown) {
    if (dcRef.current?.readyState === "open") dcRef.current.send(JSON.stringify(obj));
  }

  async function handleToolCall(name: string, args: Record<string, string>, callId: string) {
    log(`tool: ${name} call_id=${callId} args=${JSON.stringify(args)}`);
    let result = "ok";
    try {
      if (name === "get_brief") {
        result = await invoke<string>("tool_get_brief");
      } else if (name === "draft_dispatch") {
        result = await invoke<string>("tool_draft_dispatch", { task: args.task || "" });
        setPlanPending(true);
      } else if (name === "launch_dispatch") {
        result = await invoke<string>("tool_launch_dispatch");
        setPlanPending(false);
      } else if (name === "lock_tomorrow_plan") {
        result = await invoke<string>("tool_lock_tomorrow_plan");
      }
      log(`tool: ${name} result="${result.slice(0, 80)}"`);
    } catch (e) {
      const errStr = e instanceof Error ? `${e.message}${e.stack ? "\n" + e.stack : ""}` : String(e);
      result = "Error: " + errStr;
      log(`tool: ${name} ERROR: ${errStr}`);
    }
    sendRT({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: result } });
    sendRT({ type: "response.create" });
    if (orbStateRef.current === "thinking") setOrbState("listening");
  }

  function handleRealtimeEvent(evt: Record<string, unknown>) {
    const evtType = String(evt.type ?? "");

    // audio.delta fires many times/sec — track count, only log first of each response
    if (evtType === "response.audio.delta") {
      audioDeltaCountRef.current++;
      if (audioDeltaCountRef.current === 1) {
        log("response.audio.delta ×1 (first of response)");
      } else {
        // update the count in-place on the last delta line to avoid flooding
        const arr = debugLogRef.current;
        if (arr.length > 0) {
          const last = arr[arr.length - 1];
          if (last.includes("response.audio.delta")) {
            const updated = last.replace(/×\d+/, `×${audioDeltaCountRef.current}`);
            arr[arr.length - 1] = updated;
            setDebugLog([...arr]);
          }
        }
      }
      lastAudioRef.current = Date.now();
      setOrbState("speaking");
      return;
    }

    log(`evt: ${evtType}`);

    switch (evtType) {
      case "input_audio_buffer.speech_started":
        lastAudioRef.current = Date.now();
        setOrbState("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        break;
      case "response.audio.done":
        audioDeltaCountRef.current = 0;
        setOrbState("listening");
        break;
      case "response.function_call_arguments.done": {
        setOrbState("thinking");
        let args: Record<string, string> = {};
        try { args = JSON.parse(evt.arguments as string || "{}"); } catch {}
        handleToolCall(evt.name as string, args, evt.call_id as string);
        break;
      }
      case "response.done": {
        if (orbStateRef.current !== "thinking") setOrbState("listening");
        const resp = evt.response as Record<string, unknown> | undefined;
        const output = resp?.output as unknown[] | undefined;
        const item = output?.[0] as Record<string, unknown> | undefined;
        const content = item?.content as unknown[] | undefined;
        const tx = (content?.[0] as Record<string, unknown> | undefined)?.transcript;
        if (typeof tx === "string") {
          setCaptions(tx);
          log(`response.done — transcript: "${tx.slice(0, 60)}"`);
        }
        break;
      }
      case "error": {
        const err = evt.error as Record<string, unknown> | undefined;
        log(`SERVER ERROR: ${err?.type} — ${err?.message}`);
        break;
      }
      default:
        break;
    }
  }

  const connect = useCallback(async () => {
    debugLogRef.current = [];
    setDebugLog([]);
    log(`=== connect() mode=${mode}`);
    setError(""); setErrorKind("");
    setOrbState("connecting");
    startOrb();

    // 1. Token
    let session: RealtimeTokenResponse;
    try {
      log("invoking get_realtime_token...");
      session = await invoke<RealtimeTokenResponse>("get_realtime_token", { mode });
      log(`token ok — present:${!!session.token} model:${session.model} sid:${session.session_id}`);
    } catch (e) {
      log("token FAILED: " + String(e));
      setOrbState("idle");
      setError("Token failed: " + String(e));
      setErrorKind("network");
      stopOrb();
      return;
    }

    // 2. Mic
    let stream: MediaStream;
    try {
      log("getUserMedia({audio:true})...");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      log(`getUserMedia ok — tracks:${stream.getAudioTracks().length} readyState:${track?.readyState} enabled:${track?.enabled}`);
    } catch (e) {
      const msg = String(e);
      log("getUserMedia FAILED: " + msg);
      setOrbState("idle");
      if (msg.includes("NotAllowed") || msg.includes("Permission")) {
        setError("Mic access denied — check System Preferences → Privacy → Microphone.");
        setErrorKind("mic");
      } else {
        setError("Mic unavailable: " + msg);
        setErrorKind("network");
      }
      stopOrb();
      return;
    }
    streamRef.current = stream;

    // 3. AudioContext + analyser
    log("creating AudioContext...");
    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    log(`AudioContext state: ${audioCtx.state}`);
    if (audioCtx.state === "suspended") {
      log("AudioContext suspended — calling resume()...");
      await audioCtx.resume();
      log(`AudioContext after resume: ${audioCtx.state}`);
    }
    const micSrc = audioCtx.createMediaStreamSource(stream);
    const micAn = audioCtx.createAnalyser(); micAn.fftSize = 256;
    micAnRef.current = micAn;
    micBufRef.current = new Uint8Array(micAn.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    micSrc.connect(micAn);
    log("mic → analyser wired");

    // 4. PeerConnection
    log("creating RTCPeerConnection...");
    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    pc.onconnectionstatechange = () => log(`pc.connectionState: ${pc.connectionState}`);
    pc.oniceconnectionstatechange = () => log(`pc.iceConnectionState: ${pc.iceConnectionState}`);
    pc.onicegatheringstatechange = () => log(`pc.iceGatheringState: ${pc.iceGatheringState}`);
    pc.onsignalingstatechange = () => log(`pc.signalingState: ${pc.signalingState}`);
    pc.ontrack = (e) => {
      log(`pc.ontrack — streams:${e.streams.length} track.kind:${e.track.kind} track.readyState:${e.track.readyState}`);
      const s = e.streams[0]; if (!s) return;
      const outSrc = audioCtx.createMediaStreamSource(s);
      const outAn = audioCtx.createAnalyser(); outAn.fftSize = 256;
      outAnRef.current = outAn;
      outBufRef.current = new Uint8Array(outAn.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      outSrc.connect(outAn);
      outSrc.connect(audioCtx.destination);
      log("remote audio → analyser + destination wired");
    };

    // 5. Add tracks
    const tracks = stream.getTracks();
    log(`adding ${tracks.length} track(s) to pc...`);
    for (const track of tracks) {
      pc.addTrack(track, stream);
      log(`  addTrack: ${track.kind} / ${track.readyState} / enabled:${track.enabled}`);
    }

    // 6. Data channel
    log("creating data channel 'oai-events'...");
    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    dc.onopen = () => {
      log("DATA CHANNEL OPEN ✓");
      setOrbState("listening");
      lastAudioRef.current = Date.now();
      sessionStartRef.current = Date.now();
      audioDeltaCountRef.current = 0;
      timerRef.current = window.setInterval(() => {
        if (!sessionStartRef.current) return;
        const sec = Math.floor((Date.now() - sessionStartRef.current) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        setElapsed(m + ":" + s);
        setCost("~$" + ((sec / 60) * COST_PER_MIN).toFixed(3));
      }, 1000);
      idleTimerRef.current = window.setInterval(() => {
        if (Date.now() - lastAudioRef.current > 40000) {
          log("idle timeout — disconnecting");
          setIdleEnded(true);
          disconnect();
          setTimeout(() => setIdleEnded(false), 3000);
        }
      }, 10000);
    };
    dc.onmessage = (e) => {
      try { handleRealtimeEvent(JSON.parse(e.data)); } catch {}
    };
    dc.onerror = (e) => log(`dc.onerror: ${JSON.stringify(e)}`);
    dc.onclose = () => { log("data channel closed"); setOrbState("idle"); };

    // 7. SDP offer → exchange
    log("createOffer...");
    const offer = await pc.createOffer();
    log(`offer created — SDP length:${offer.sdp?.length ?? 0}`);
    await pc.setLocalDescription(offer);
    log("setLocalDescription done");

    const sdpUrl = "https://api.openai.com/v1/realtime/calls";
    log(`POST ${sdpUrl}`);
    try {
      const sdpR = await fetch(sdpUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/sdp" },
        body: offer.sdp!,
      });
      log(`SDP response: HTTP ${sdpR.status} ${sdpR.statusText}`);
      if (!sdpR.ok) {
        const errBody = await sdpR.text();
        log(`SDP error body: ${errBody}`);
        throw new Error(`HTTP ${sdpR.status}: ${errBody}`);
      }
      const answerSdp = await sdpR.text();
      log(`SDP answer received — length:${answerSdp.length}`);
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      log("setRemoteDescription done — waiting for dc.onopen...");
    } catch (e) {
      log("SDP exchange FAILED: " + String(e));
      setError("WebRTC failed: " + String(e));
      setErrorKind("network");
      disconnect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startOrb, stopOrb]);

  const disconnect = useCallback(() => {
    log("disconnect()");
    if (idleTimerRef.current) { clearInterval(idleTimerRef.current); idleTimerRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (dcRef.current) { try { dcRef.current.close(); } catch {} dcRef.current = null; }
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} audioCtxRef.current = null; }
    micAnRef.current = null; outAnRef.current = null;
    micBufRef.current = null; outBufRef.current = null;
    sessionStartRef.current = null;
    setOrbState("idle"); setElapsed(""); setCost("");
    stopOrb();
  }, [stopOrb]);

  function switchToFallback() {
    disconnect();
    setVoiceMode("fallback");
    setError(""); setErrorKind("");
    setStatus("ready");
    startOrb();
  }

  // Auto-connect realtime on mount
  useEffect(() => {
    if (voiceMode === "realtime") {
      connect();
      return () => disconnect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode]);

  // Keep orb breathing during fallback voice state
  useEffect(() => {
    if (voiceMode !== "fallback") return;
    if (voice.state === "recording") setOrbState("listening");
    else if (voice.state === "transcribing") setOrbState("thinking");
    else if (voice.state === "speaking") setOrbState("speaking");
    else setOrbState("idle");
  }, [voiceMode, voice.state]);

  const dotColor =
    orbState === "listening" || orbState === "speaking" ? "bg-emerald-400"
    : orbState === "thinking"  ? "bg-amber-400"
    : orbState === "connecting" ? "bg-amber-400"
    : "bg-zinc-600";

  // ── Fallback press-to-talk handlers ────────────────────────────────────────

  function fbPointerDown() {
    if (voice.state !== "idle") return;
    setFbHolding(true);
    voice.startRecording();
  }

  function fbPointerUp() {
    if (!fbHolding) return;
    setFbHolding(false);
    voice.stopRecording();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const isLive = voiceMode === "realtime" && (orbState === "listening" || orbState === "speaking" || orbState === "thinking");

  return (
    <div
      className="h-full flex flex-col items-center justify-center relative overflow-hidden"
      style={{ background: "#07080c" }}
    >
      {/* Top chrome */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4 z-10">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor} ${isLive ? "animate-pulse" : ""}`} />
          <span className="text-xs font-mono text-zinc-500 tracking-wider">
            {idleEnded ? "ENDED (IDLE)" : voiceMode === "fallback" ? "CLASSIC" : status.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono text-zinc-600">
          {elapsed && <span>{elapsed}</span>}
          {cost    && <span className="text-zinc-700">{cost}</span>}
        </div>
      </div>

      {/* Orb canvas */}
      <canvas ref={canvasRef} style={{ display: "block" }} />

      {/* State label */}
      <p className="mt-4 text-xs font-mono tracking-widest text-zinc-600 uppercase h-4">
        {orbState === "connecting" ? "CONNECTING..." : orbState === "listening" ? "LISTENING" : orbState === "thinking" ? "THINKING..." : orbState === "speaking" ? "SPEAKING" : ""}
      </p>

      {/* Plan pending banner */}
      {planPending && (
        <div className="mt-3 px-4 py-2 rounded-xl text-xs font-mono text-amber-300 border border-amber-500/30 bg-amber-950/40 tracking-wide">
          PLAN READY — say "go" to launch
        </div>
      )}

      {/* Error block */}
      {error && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <p className="text-xs text-red-400 font-mono max-w-xs text-center">{error}</p>
          <div className="flex items-center gap-2 mt-1">
            {errorKind === "mic" ? (
              <button
                onClick={() => { setError(""); setErrorKind(""); connect(); }}
                className="text-xs font-mono px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Retry
              </button>
            ) : (
              <>
                <button
                  onClick={() => { setError(""); setErrorKind(""); connect(); }}
                  className="text-xs font-mono px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Retry
                </button>
                <button
                  onClick={switchToFallback}
                  className="text-xs font-mono px-3 py-1.5 rounded-lg border border-indigo-700/60 text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  Classic Voice
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Debug log panel ─────────────────────────────────────────────────── */}
      <div
        className="absolute left-2 right-2 z-20"
        style={{ bottom: "80px" }}
      >
        <div className="flex items-center justify-between px-1 mb-1">
          <span className="text-[9px] font-mono text-zinc-700 tracking-widest uppercase select-none">
            Voice Debug · ⌘⌥I for console
          </span>
          <button
            onClick={() => navigator.clipboard.writeText(debugLog.join("\n")).catch(() => {})}
            className="text-[9px] font-mono text-zinc-700 hover:text-zinc-400 border border-zinc-800 px-2 py-0.5 rounded transition-colors"
          >
            copy all
          </button>
        </div>
        <div
          ref={logPanelRef}
          className="rounded-lg border border-zinc-800/40 p-2 font-mono text-[9px] leading-relaxed overflow-y-auto select-text"
          style={{ height: "108px", background: "rgba(0,0,0,0.55)", wordBreak: "break-all" }}
        >
          {debugLog.length === 0 ? (
            <span className="text-zinc-700">waiting for connect()…</span>
          ) : (
            debugLog.map((line, i) => (
              <div
                key={i}
                style={{
                  color: (line.includes("FAILED") || line.includes("ERROR") || line.includes("error body") || line.includes("denied"))
                    ? "#f87171"
                    : (line.includes(" ok") || line.includes("OPEN") || line.includes(" done") || line.includes("wired") || line.includes("received"))
                    ? "#4ade80"
                    : "#52525b",
                }}
              >
                {line}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center gap-3 pb-8 z-10">
        {captionsOn && captions && (
          <div className="mx-6 rounded-xl px-4 py-3 text-sm text-zinc-200 leading-relaxed max-w-md text-center"
            style={{ background: "rgba(13,13,15,.85)" }}>
            {captions}
          </div>
        )}

        {/* Fallback press-to-talk */}
        {voiceMode === "fallback" && (
          <button
            onPointerDown={fbPointerDown}
            onPointerUp={fbPointerUp}
            onPointerLeave={fbPointerUp}
            className={`w-16 h-16 rounded-full border-2 flex items-center justify-center transition-all select-none ${
              fbHolding
                ? "border-indigo-400 bg-indigo-900/40 scale-110"
                : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
            }`}
            style={{ touchAction: "none" }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={fbHolding ? "text-indigo-300" : "text-zinc-500"}>
              <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
            </svg>
          </button>
        )}

        <div className="flex items-center gap-4">
          <button
            onClick={() => setCaptionsOn((v) => !v)}
            className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-colors ${captionsOn ? "border-indigo-500/60 text-indigo-400" : "border-zinc-800 text-zinc-600 hover:text-zinc-400"}`}
          >
            CC
          </button>
          {voiceMode === "realtime" && !error && (
            <button
              onClick={switchToFallback}
              className="text-xs font-mono px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-700 hover:text-zinc-500 transition-colors"
            >
              Classic
            </button>
          )}
          {orbState !== "idle" ? (
            <button
              onClick={() => { disconnect(); voice.stopAll(); }}
              className="px-8 py-2.5 rounded-full text-sm font-medium text-zinc-200 border border-zinc-800 hover:border-zinc-600 transition-colors"
              style={{ background: "#18181b" }}
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => navigate(-1)}
              className="px-8 py-2.5 rounded-full text-sm font-medium text-zinc-200 border border-zinc-800 hover:border-zinc-600 transition-colors"
              style={{ background: "#18181b" }}
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
