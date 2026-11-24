import { isDashboardView } from "./navigation.js";

const ALIASES = new Map([
  ["overview", { workspace: "overview" }],
  ["bots/fleet", { workspace: "bots", tab: "fleet" }],
  ["groups/settings", { workspace: "chat-access", tab: "settings" }],
  ["system/logs", { workspace: "system", tab: "logs" }],
  ["qr-login", { workspace: "bots", tab: "qr-login" }],
  ["automation/commands", { workspace: "commands", tab: "commands" }],
  ["security/policies", { workspace: "system", tab: "flags" }],
]);

function cleanHash(hash) {
  return String(hash ?? "")
    .replace(/^#/, "")
    .replace(/^\//, "")
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .map((part) => decodeURIComponent(part))
    .filter(Boolean);
}

/** Resolve canonical routes and the historical dashboard hash aliases. */
export function parseHashRoute(hash) {
  const parts = cleanHash(hash);
  const key = parts.join("/");
  if (ALIASES.has(key)) return { ...ALIASES.get(key) };
  if (!parts.length) return { workspace: "overview" };

  const [requestedWorkspace, entityId, tab] = parts;
  const workspace = isDashboardView(requestedWorkspace) ? requestedWorkspace : "overview";
  const route = { workspace };
  if (workspace !== requestedWorkspace) route.requestedWorkspace = requestedWorkspace;
  if (entityId) route.entityId = entityId;
  if (tab) route.tab = tab;
  return route;
}

export function subscribeToHashRoute(callback, target = globalThis) {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const onHashChange = () => callback(parseHashRoute(target.location?.hash || ""));
  target.addEventListener("hashchange", onHashChange);
  return () => target.removeEventListener?.("hashchange", onHashChange);
}

/** Convert a route object to a stable hash path and update the browser when available. */
export function routeToHash(route) {
  if (typeof route === "string") return `#${route.replace(/^#/, "")}`;
  if (!route || typeof route !== "object" || !route.workspace) throw new TypeError("A workspace is required");
  const parts = [route.workspace, route.entityId, route.tab].filter((part) => part !== undefined && part !== null && part !== "");
  return `#${parts.map((part) => encodeURIComponent(String(part))).join("/")}`;
}

export function navigate(route, target = globalThis.location) {
  const hash = routeToHash(route);
  if (target && typeof target === "object") target.hash = hash;
  return parseHashRoute(hash);
}

export default { parseHashRoute, routeToHash, navigate };
