import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings as SettingsType } from "../types";
import { fmtTokens } from "../lib/relativeTime";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function Settings() {
  const [settings, setSettings] = useState<SettingsType>({
    weekly_cap_tokens: 100_000_000,
    reset_weekday: 0,
    sound_enabled: true,
    sound_code_enabled: true,
    sound_cowork_enabled: true,
    feature_morning: false,
    feature_tonight: false,
    feature_voice: false,
    feature_builder_write: false,
  });
  const [capInput, setCapInput] = useState("100000000");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<SettingsType>("get_settings").then((s) => {
      setSettings(s);
      setCapInput(String(s.weekly_cap_tokens));
      setLoading(false);
    });
  }, []);

  function handleSave() {
    const cap = parseInt(capInput.replace(/[^0-9]/g, ""), 10);
    if (isNaN(cap) || cap <= 0) {
      setError("Enter a valid positive number.");
      return;
    }
    const updated: SettingsType = {
      weekly_cap_tokens: cap,
      reset_weekday: settings.reset_weekday,
      sound_enabled: settings.sound_enabled,
      sound_code_enabled: settings.sound_code_enabled,
      sound_cowork_enabled: settings.sound_cowork_enabled,
      feature_morning: settings.feature_morning,
      feature_tonight: settings.feature_tonight,
      feature_voice: settings.feature_voice,
      feature_builder_write: settings.feature_builder_write,
    };
    setSaving(true);
    setError("");
    invoke<void>("save_settings", { settings: updated })
      .then(() => {
        setSettings(updated);
        window.dispatchEvent(new CustomEvent("antfarm-settings-saved"));
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((e) => {
        setError(String(e));
        setSaving(false);
      });
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500 animate-pulse">Loading settings…</p>
      </div>
    );
  }

  const capNum = parseInt(capInput.replace(/[^0-9]/g, ""), 10);

  return (
    <div className="p-6 max-w-lg">
      <h1 className="text-base font-semibold text-zinc-100 mb-6">Settings</h1>

      <div className="space-y-6">
        {/* Weekly token cap */}
        <div className="rounded-xl border border-zinc-800 bg-surface-2 p-5 space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-1">
              Weekly token cap
            </label>
            <p className="text-xs text-zinc-500">
              All token types (input + output + cache read + cache write) summed. Used to compute % of cap in dashboards.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={capInput}
              onChange={(e) => {
                setCapInput(e.target.value);
                setSaved(false);
              }}
              className="w-44 bg-zinc-900 border border-zinc-700 text-zinc-100 text-sm rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-indigo-600 transition-colors"
              placeholder="100000000"
            />
            <span className="text-xs text-zinc-500">tokens / week</span>
          </div>
          {!isNaN(capNum) && capNum > 0 && (
            <p className="text-xs text-zinc-600">= {fmtTokens(capNum)} tokens</p>
          )}
        </div>

        {/* Reset weekday */}
        <div className="rounded-xl border border-zinc-800 bg-surface-2 p-5 space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-1">
              Reset day
            </label>
            <p className="text-xs text-zinc-500">
              Day the weekly token count resets to zero. Used to compute the current week range.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {WEEKDAYS.map((day, i) => (
              <button
                key={day}
                onClick={() => {
                  setSettings((s) => ({ ...s, reset_weekday: i }));
                  setSaved(false);
                }}
                className={[
                  "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                  settings.reset_weekday === i
                    ? "bg-indigo-700 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200",
                ].join(" ")}
              >
                {day.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>

        {/* Attention sounds */}
        <div className="rounded-xl border border-zinc-800 bg-surface-2 p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-1">
              Attention sounds
            </label>
            <p className="text-xs text-zinc-500">
              Plays a sound when Claude Code needs a response or a Cowork session goes idle.
            </p>
          </div>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.sound_enabled}
                onChange={(e) => setSettings((s) => ({ ...s, sound_enabled: e.target.checked }))}
                className="w-4 h-4 accent-indigo-500"
              />
              <span className="text-sm text-zinc-200">Enable sounds</span>
            </label>
            <div className={settings.sound_enabled ? "" : "opacity-40 pointer-events-none"}>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.sound_code_enabled}
                  onChange={(e) => setSettings((s) => ({ ...s, sound_code_enabled: e.target.checked }))}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-zinc-400">Claude Code notifications</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={settings.sound_cowork_enabled}
                  onChange={(e) => setSettings((s) => ({ ...s, sound_cowork_enabled: e.target.checked }))}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-zinc-400">Cowork waiting</span>
              </label>
            </div>
          </div>
        </div>

        {/* Feature flags */}
        <div className="rounded-xl border border-zinc-800 bg-surface-2 p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-200 mb-1">
              Features
            </label>
            <p className="text-xs text-zinc-500">
              Enable or disable surfaces and capabilities. All default OFF. Restart not required.
            </p>
          </div>
          <div className="space-y-3">
            {([
              { key: "feature_morning"       as const, label: "Morning briefing", desc: "Shows the Morning page and fires its scheduled run." },
              { key: "feature_tonight"       as const, label: "Tonight / night report", desc: "Shows the Tonight planning page." },
              { key: "feature_voice"         as const, label: "Voice (mic / STT)", desc: "Shows mic buttons in Chat and Morning. Does not initialize the mic unless turned on." },
              { key: "feature_builder_write" as const, label: "Builder write mode", desc: "Grants Builder Write, Edit, and Bash access. Required for coding tasks. STOP-before-push enforced." },
            ] as const).map(({ key, label, desc }) => (
              <label key={key} className="flex items-start gap-3 cursor-pointer select-none">
                <div className="relative mt-0.5 shrink-0">
                  <input
                    type="checkbox"
                    checked={settings[key]}
                    onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.checked }))}
                    className="sr-only"
                  />
                  <div className={[
                    "relative w-8 h-4 rounded-full transition-colors",
                    settings[key] ? "bg-indigo-600" : "bg-zinc-700",
                  ].join(" ")}>
                    <div className={[
                      "absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform",
                      settings[key] ? "translate-x-4" : "translate-x-0.5",
                    ].join(" ")} />
                  </div>
                </div>
                <div>
                  <p className="text-sm text-zinc-200">{label}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
          {saved && <span className="text-xs text-emerald-400">Saved ✓</span>}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>
    </div>
  );
}
