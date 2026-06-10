import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  Home,
  Layers,
  Activity,
  BarChart2,
  Settings,
  Hexagon,
} from "lucide-react";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/projects", label: "Projects", icon: Layers, end: false },
  { to: "/sessions", label: "Sessions", icon: Activity, end: false },
  { to: "/usage", label: "Usage", icon: BarChart2, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

export function Sidebar() {
  const [liveCount, setLiveCount] = useState(0);

  useEffect(() => {
    function refresh() {
      invoke<number>("active_session_count")
        .then((n) => setLiveCount(n))
        .catch(() => setLiveCount(0));
    }
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside className="flex flex-col w-[220px] shrink-0 h-full bg-surface-1 border-r border-zinc-800/80">
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-zinc-800/60 shrink-0">
        <Hexagon size={18} strokeWidth={1.5} className="text-zinc-400 shrink-0" />
        <span className="text-sm font-semibold text-zinc-100 tracking-tight">Ant Farm</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              [
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors duration-100",
                isActive
                  ? "bg-zinc-800 text-zinc-100 font-medium"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50",
              ].join(" ")
            }
          >
            <Icon size={16} strokeWidth={1.75} className="shrink-0" />
            <span className="flex-1">{label}</span>
            {label === "Sessions" && liveCount > 0 && (
              <span className="text-xs bg-emerald-900/60 text-emerald-400 px-1.5 py-0.5 rounded-full leading-none tabular-nums">
                {liveCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
