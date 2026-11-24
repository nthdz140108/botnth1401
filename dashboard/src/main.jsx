import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import ControlCenterApp from "./v4/ControlCenterApp.jsx";
import { createBotActions } from "./app/bot-actions.js";
import { ChatAccessWorkspace } from "./components/chat-access-workspace.jsx";

export function App() {
  return <ControlCenterApp />;
}

export { createBotActions, ChatAccessWorkspace };

if (typeof document !== "undefined") {
  const rootEl = document.getElementById("root");
  if (rootEl) {
    createRoot(rootEl).render(<App />);
  }
}
