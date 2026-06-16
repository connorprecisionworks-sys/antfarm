import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type VoiceState = "idle" | "recording" | "transcribing" | "speaking" | "error";

export interface UseVoiceOptions {
  voice?: string;
  onTranscript?: (text: string) => Promise<void> | void;
}

export function useVoice({ voice = "ash", onTranscript }: UseVoiceOptions = {}) {
  const [state, setState]   = useState<VoiceState>("idle");
  const [error, setError]   = useState<string | null>(null);
  const mediaRef  = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef  = useRef<HTMLAudioElement | null>(null);

  const isSupported = typeof window !== "undefined" && typeof MediaRecorder !== "undefined";

  const startRecording = useCallback(async () => {
    if (!isSupported || state !== "idle") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        try {
          const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
          const buf  = await blob.arrayBuffer();
          // btoa on large buffers: chunk to avoid call-stack limit
          const u8 = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < u8.length; i += 8192) {
            binary += String.fromCharCode(...u8.subarray(i, i + 8192));
          }
          const audioBase64 = btoa(binary);
          const transcript = await invoke<string>("voice_stt", {
            audioBase64,
            contentType: mr.mimeType || "audio/webm",
          });
          setState("idle");
          if (transcript.trim()) await onTranscript?.(transcript.trim());
        } catch (e) {
          setError(String(e));
          setState("error");
          setTimeout(() => setState("idle"), 3000);
        }
      };
      mr.start();
      mediaRef.current = mr;
      setState("recording");
    } catch (e) {
      setError(String(e));
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  }, [isSupported, state, onTranscript]);

  const stopRecording = useCallback(() => {
    if (mediaRef.current && mediaRef.current.state === "recording") {
      mediaRef.current.stop();
      mediaRef.current = null;
    }
  }, []);

  const speak = useCallback(async (text: string, speakVoice?: string) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setState("speaking");
    try {
      const base64Mp3 = await invoke<string>("voice_tts", {
        text,
        voice: speakVoice ?? voice,
      });
      const binary = atob(base64Mp3);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url  = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); audioRef.current = null; setState("idle"); };
      audio.onerror = () => { URL.revokeObjectURL(url); audioRef.current = null; setState("idle"); };
      await audio.play();
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  }, [voice]);

  const stopAll = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (mediaRef.current) {
      try { mediaRef.current.stop(); } catch {}
      mediaRef.current = null;
    }
    setState("idle");
  }, []);

  return { state, error, isSupported, startRecording, stopRecording, speak, stopAll };
}
