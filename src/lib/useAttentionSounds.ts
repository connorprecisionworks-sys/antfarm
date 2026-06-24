import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { SessionMeta, Settings } from "../types";
import codeDingUrl from "../assets/sounds/code-ding.wav";
import coworkPianoUrl from "../assets/sounds/cowork-piano.wav";

export function useAttentionSounds() {
  const codeDingRef = useRef<HTMLAudioElement | null>(null);
  const coworkPianoRef = useRef<HTMLAudioElement | null>(null);
  const settingsRef = useRef({ soundEnabled: true, soundCodeEnabled: true, soundCoworkEnabled: true });
  const coworkWaitingRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  // Preload audio elements once on mount
  useEffect(() => {
    codeDingRef.current = new Audio(codeDingUrl);
    coworkPianoRef.current = new Audio(coworkPianoUrl);
  }, []);

  // Load settings; refresh when Settings page saves (dispatches antfarm-settings-saved)
  useEffect(() => {
    function reload() {
      invoke<Settings>("get_settings").then(s => {
        settingsRef.current = {
          soundEnabled: s.sound_enabled,
          soundCodeEnabled: s.sound_code_enabled,
          soundCoworkEnabled: s.sound_cowork_enabled,
        };
      }).catch(() => {});
    }
    reload();
    window.addEventListener("antfarm-settings-saved", reload);
    return () => window.removeEventListener("antfarm-settings-saved", reload);
  }, []);

  // Claude Code: Rust emits antfarm-sound-cue when a permission_prompt or idle_prompt arrives
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("antfarm-sound-cue", () => {
      const s = settingsRef.current;
      if (s.soundEnabled && s.soundCodeEnabled && codeDingRef.current) {
        codeDingRef.current.currentTime = 0;
        codeDingRef.current.play().catch(() => {});
      }
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Cowork: check for sessions newly entering "waiting" on the same signals used by the UI
  useEffect(() => {
    function check() {
      invoke<SessionMeta[]>("list_sessions").then(sessions => {
        const isInit = !initializedRef.current;
        initializedRef.current = true;
        const nowWaiting = new Set<string>();
        for (const sess of sessions) {
          if (sess.provider === "cowork" && sess.status === "waiting") {
            nowWaiting.add(sess.id);
            // Play only on fresh transition, never on startup
            if (!isInit && !coworkWaitingRef.current.has(sess.id)) {
              const s = settingsRef.current;
              if (s.soundEnabled && s.soundCoworkEnabled && coworkPianoRef.current) {
                coworkPianoRef.current.currentTime = 0;
                coworkPianoRef.current.play().catch(() => {});
              }
            }
          }
        }
        coworkWaitingRef.current = nowWaiting;
      }).catch(() => {});
    }

    check();
    const id = setInterval(check, 30_000);
    let unlisten: (() => void) | undefined;
    listen("antfarm-events-updated", check).then(fn => { unlisten = fn; });
    return () => {
      clearInterval(id);
      unlisten?.();
    };
  }, []);
}
