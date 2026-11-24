export const DASHBOARD_VIEWS = [
  { id: "overview", label: "Overview", description: "Live fleet telemetry and status." },
  { id: "bots", label: "Bot fleet", description: "Search, filter, and control the bot fleet." },
  { id: "workspace", label: "Bot workspace", description: "Bot config, credential, and QR login." },
  { id: "commands", label: "Commands", description: "Command studio, scan, and override management." },
  { id: "chat-access", label: "Chat access", description: "Per-bot group and private chat controls." },
  { id: "logs", label: "Logs & events", description: "Runtime logs and live events." },
  { id: "system", label: "System health", description: "Health, SSD cleanup, provider keys, and state snapshots." },
];

export function getDashboardView(viewId) {
  return DASHBOARD_VIEWS.find((view) => view.id === viewId) || DASHBOARD_VIEWS[0];
}

export function isDashboardView(viewId) {
  return DASHBOARD_VIEWS.some((view) => view.id === viewId);
}
