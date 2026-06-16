import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";

// gpt-4o-mini-realtime audio pricing ($/min): in $0.06 + out $0.024 ≈ $0.084
const COST_PER_MIN = 0.084;

type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

interface RealtimeTokenResponse {
  token: string;
  model: string;
  session_id: string;
}

export function VoiceMode() {
  const navigate    = useNavigate();
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
  const sessionStartRef = useRef<number | null>(null);
  const orbStateRef = useRef<OrbState>("idle");

  const [orbState, setOrbStateReact] = useState<OrbState>("idle");
  const [status, setStatus]          = useState("ready");
  const [elapsed, setElapsed]        = useState("");
  const [cost, setCost]              = useState("");
  const [captions, setCaptions]      = useState("");
  const [captionsOn, setCaptionsOn]  = useState(false);
  const [error, setError]            = useState("");

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
    let result = "ok";
    try {
      if (name === "get_brief") {
        result = await invoke<string>("tool_get_brief");
      } else if (name === "draft_dispatch") {
        result = await invoke<string>("tool_draft_dispatch", { task: args.task || "" });
      } else if (name === "launch_dispatch") {
        result = await invoke<string>("tool_launch_dispatch");
      }
    } catch (e) { result = "Error: " + String(e); }
    sendRT({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: result } });
    sendRT({ type: "response.create" });
    if (orbStateRef.current === "thinking") setOrbState("listening");
  }

  function handleRealtimeEvent(evt: Record<string, unknown>) {
    switch (evt.type) {
      case "input_audio_buffer.speech_started": setOrbState("listening"); break;
      case "response.audio.delta":              setOrbState("speaking");  break;
      case "response.audio.done":               setOrbState("listening"); break;
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
        if (typeof tx === "string") setCaptions(tx);
        break;
      }
    }
  }

  const connect = useCallback(async () => {
    setError("");
    setOrbState("connecting");
    startOrb();

    let session: RealtimeTokenResponse;
    try {
      session = await invoke<RealtimeTokenResponse>("get_realtime_token");
    } catch (e) {
      setOrbState("idle");
      setError("Token failed: " + String(e));
      stopOrb();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setOrbState("idle");
      setError("Mic permission denied");
      stopOrb();
      return;
    }
    streamRef.current = stream;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const micSrc = audioCtx.createMediaStreamSource(stream);
    const micAn = audioCtx.createAnalyser(); micAn.fftSize = 256;
    micAnRef.current = micAn; micBufRef.current = new Uint8Array(micAn.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    micSrc.connect(micAn);

    const pc = new RTCPeerConnection();
    pcRef.current = pc;
    pc.ontrack = (e) => {
      const s = e.streams[0]; if (!s) return;
      const outSrc = audioCtx.createMediaStreamSource(s);
      const outAn = audioCtx.createAnalyser(); outAn.fftSize = 256;
      outAnRef.current = outAn; outBufRef.current = new Uint8Array(outAn.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      outSrc.connect(outAn);
      outSrc.connect(audioCtx.destination);
    };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    dc.onopen = () => {
      setOrbState("listening");
      sessionStartRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        if (!sessionStartRef.current) return;
        const sec = Math.floor((Date.now() - sessionStartRef.current) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        setElapsed(m + ":" + s);
        setCost("~$" + ((sec / 60) * COST_PER_MIN).toFixed(3));
      }, 1000);
    };
    dc.onmessage = (e) => {
      try { handleRealtimeEvent(JSON.parse(e.data)); } catch {}
    };
    dc.onclose = () => setOrbState("idle");

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    try {
      const sdpR = await fetch(`https://api.openai.com/v1/realtime?model=${session.model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/sdp" },
        body: offer.sdp!,
      });
      if (!sdpR.ok) throw new Error(await sdpR.text());
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpR.text() });
    } catch (e) {
      setError("WebRTC failed: " + String(e));
      disconnect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startOrb, stopOrb]);

  const disconnect = useCallback(() => {
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

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  const dotColor =
    orbState === "listening" || orbState === "speaking" ? "bg-emerald-400"
    : orbState === "thinking"  ? "bg-amber-400"
    : orbState === "connecting" ? "bg-amber-400"
    : "bg-zinc-600";

  return (
    <div
      className="h-full flex flex-col items-center justify-center"
      style={{ background: "#07080c" }}
    >
      {/* Top chrome */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor} ${orbState === "listening" || orbState === "speaking" ? "animate-pulse" : ""}`} />
          <span className="text-xs font-mono text-zinc-500 tracking-wider">{status}</span>
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

      {/* Error */}
      {error && (
        <p className="mt-3 text-xs text-red-400 font-mono max-w-xs text-center">{error}</p>
      )}

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center gap-3 pb-8">
        {captionsOn && captions && (
          <div className="mx-6 rounded-xl px-4 py-3 text-sm text-zinc-200 leading-relaxed max-w-md text-center"
            style={{ background: "rgba(13,13,15,.85)" }}>
            {captions}
          </div>
        )}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setCaptionsOn((v) => !v)}
            className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-colors ${captionsOn ? "border-indigo-500/60 text-indigo-400" : "border-zinc-800 text-zinc-600 hover:text-zinc-400"}`}
          >
            CC
          </button>
          <button
            onClick={() => { disconnect(); navigate(-1); }}
            className="px-8 py-2.5 rounded-full text-sm font-medium text-zinc-200 border border-zinc-800 hover:border-zinc-600 transition-colors"
            style={{ background: "#18181b" }}
          >
            End
          </button>
        </div>
      </div>
    </div>
  );
}
