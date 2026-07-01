import { BrowserRouter, Routes, Route } from "react-router-dom";
import { usePodStreamSync } from "./lib/usePodStreamSync";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Morning } from "./pages/Morning";
import { Tonight } from "./pages/Tonight";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Sessions } from "./pages/Sessions";
import { Usage } from "./pages/Usage";
import { Settings } from "./pages/Settings";
import { VoiceMode } from "./pages/VoiceMode";
import { Wrapped } from "./pages/Wrapped";
import { Memory } from "./pages/Memory";
import { Chat } from "./pages/Chat";
import { Forge } from "./pages/Forge";

export default function App() {
  usePodStreamSync();
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="morning" element={<Morning />} />
          <Route path="tonight" element={<Tonight />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:slug" element={<ProjectDetail />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="memory" element={<Memory />} />
          <Route path="chat" element={<Chat />} />
          <Route path="forge" element={<Forge />} />
          <Route path="usage" element={<Usage />} />
          <Route path="wrapped" element={<Wrapped />} />
          <Route path="workspace" element={null} />
          <Route path="settings" element={<Settings />} />
          <Route path="voice" element={<VoiceMode />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
