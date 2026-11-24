const ROUTES = {
  overview: "dashboard", dashboard: "dashboard",
  "bots/fleet": "bot-management", "bot-management": "bot-management", account: "bot-info", "bot-info": "bot-info", control: "bot-control", "bot-control": "bot-control", qr: "qr-login", "qr-login": "qr-login",
  "automation/commands": "commands", commands: "commands", replies: "auto-reply", "auto-reply": "auto-reply", chat: "chat-settings", "chat-settings": "chat-settings",
  "messaging/compose": "sender", sender: "sender", recent: "recent-messages", "recent-messages": "recent-messages",
  "groups/settings": "groups", groups: "groups", scan: "scan-groups", "scan-groups": "scan-groups", admins: "admins", whitelist: "whitelist", mute: "mute", block: "block-list", "block-list": "block-list", protection: "anti", anti: "anti",
  "system/credentials": "credentials", credentials: "credentials", "system/logs": "logs", logs: "logs",
};
const CANONICAL = { dashboard: "overview", "bot-management": "bots/fleet", "bot-info": "account", "bot-control": "control", "qr-login": "qr", commands: "automation/commands", "auto-reply": "replies", "chat-settings": "chat", sender: "messaging/compose", "recent-messages": "recent", groups: "groups/settings", "scan-groups": "scan", admins: "admins", whitelist: "whitelist", mute: "mute", "block-list": "block", anti: "groups/protection", credentials: "system/credentials", logs: "system/logs" };

export function resolveRoute(hash) { const page = ROUTES[String(hash || "").replace(/^#/, "")] || "dashboard"; return { route: CANONICAL[page], page }; }
if (typeof window !== "undefined") window.MYBOT_ROUTER = { resolveRoute };
