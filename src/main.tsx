import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// NOTE: React.StrictMode intentionally removed. dockview (the Workspace docking
// layout) renders panel content through React portals, and StrictMode's dev-only
// double-mount tears down dockview's portal lifecycle, leaving the dock visible
// but empty (panels never render, nothing to drag/snap). Dev-only impact; the
// production build was unaffected, which is why build gates passed while the UI
// was blank. See ant-farm/decisions.md 2026-06-11.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
