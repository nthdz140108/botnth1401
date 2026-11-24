import { createOverviewWorkspace } from "../workspaces/overview.js";
import { createCommandPalette } from "../components/command-palette.js";

document.addEventListener("DOMContentLoaded", () => {
  const workspace = createOverviewWorkspace({ document });
  workspace.load().catch(() => {});
  const socket = window.socket;
  socket?.on?.("dashboard:metrics", (metrics) => workspace.applyMetrics(metrics));
  socket?.on?.("dashboard:activity", (activity) => workspace.applyActivity(activity));
  window.setInterval(() => workspace.checkStale(), 5000);
  createCommandPalette({ document, router: { navigate: (route) => { window.location.hash = route; } }, getBots: () => window.bots || [], getGroups: () => window.groups || [] });
});
