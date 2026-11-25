import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import ControlCenterV5App from "./v5/ControlCenterV5App.jsx";
import { createBotActions } from "./app/bot-actions.js";
import { ChatAccessWorkspace } from "./components/chat-access-workspace.jsx";

export function App() {
  return <ControlCenterV5App />;
}

export { ControlCenterV5App, createBotActions, ChatAccessWorkspace };

if (typeof document !== "undefined") {
  const rootEl = document.getElementById("root");
  if (rootEl) {
    createRoot(rootEl).render(<App />);
  }
}
