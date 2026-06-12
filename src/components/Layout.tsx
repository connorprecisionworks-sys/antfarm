import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { WorkspacePage } from "../pages/Workspace";

export function Layout() {
  const { pathname } = useLocation();
  const isWorkspace = pathname === "/workspace";

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      {/*
        WorkspacePage is ALWAYS mounted so TerminalPane never unmounts on navigation.
        CSS visibility toggle: display:flex when on /workspace, display:none otherwise.
        When display:none → flex, ResizeObserver fires inside TerminalPane → fit + resize_pty.
      */}
      <div
        className="flex-1 overflow-hidden"
        style={{ display: isWorkspace ? "flex" : "none", flexDirection: "column" }}
      >
        <WorkspacePage />
      </div>
      {/* Outlet for all other routes — hidden (not unmounted) on /workspace */}
      <main
        className="flex-1 overflow-y-auto bg-surface-0"
        style={{ display: isWorkspace ? "none" : undefined }}
      >
        <Outlet />
      </main>
    </div>
  );
}
