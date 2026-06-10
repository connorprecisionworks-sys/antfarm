import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings as SettingsType } from "../types";
import { fmtTokens } from "../lib/relativeTime";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function Settings() {
  const [settings, setSettings] = useState<SettingsType>({
    weekly_cap_tokens: 100_000_000,
    reset_weekday: 0,
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
    const updated: SettingsType = { weekly_cap_tokens: cap, reset_weekday: settings.reset_weekday };
    setSaving(true);
    setError("");
    invoke<void>("save_settings", { settings: updated })
      .then(() => {
        setSettings(updated);
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
