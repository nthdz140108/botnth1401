import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as createSocketClient } from "socket.io-client";

const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_UPSTREAM = "http://127.0.0.1:2000";
const PROXY_PREFIXES = [
  "/api/dashboard/overview",
  "/api/admin/control",
  "/api/automation/",
  "/api/groups",
  "/api/friends",
  "/api/messages/",
  "/api/security",
  "/api/system/",
  "/api/jobs",
  "/api/logs",
];

function hasUnsafePathSequence(rawPath = "") {
  const value = String(rawPath || "");
  return value.includes("..") || /%2e/i.test(value) || value.includes("\\") || /%5c/i.test(value) || value.includes("\0") || /%00/i.test(value);
}

export function createDashboardGateway({
  upstreamUrl,
  upstreamDisabled = process.env.DASHBOARD_UPSTREAM_DISABLED === "1",
  fetchImpl = globalThis.fetch,
  ioClientFactory = createSocketClient,
  retryAttempts = 5,
  root = process.env.DASHBOARD_PROJECT_ROOT || process.env.PROJECT_ROOT || process.env.ProjectRoot || DEFAULT_PROJECT_ROOT,
} = {}) {
  const resolvedUpstreamUrl = resolveUpstreamUrl({ upstreamUrl, root });
  const upstreamOrigin = new URL(resolvedUpstreamUrl).origin;
  let offline = Boolean(upstreamDisabled);

  const middleware = async (req, res, next) => {
    const rawUrl = String(req.originalUrl || req.url || "");
    const qIndex = rawUrl.indexOf("?");
    const rawPathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const requestId = req.headers["x-request-id"] || `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    if (rawPathname.startsWith("//") || (rawPathname.startsWith("/api") && hasUnsafePathSequence(rawPathname))) {
      res.setHeader("X-Request-ID", requestId);
      return res.status(400).json({ success: false, data: null, requestId, error: { code: "INVALID_PROXY_PATH", message: "Unsafe proxy path rejected" } });
    }
    if (!isProxyPath(req.path)) return next();
    let target;
    try {
      target = new URL(req.originalUrl || req.url, resolvedUpstreamUrl);
    } catch {
      res.setHeader("X-Request-ID", requestId);
      return res.status(400).json({ success: false, data: null, requestId, error: { code: "INVALID_PROXY_PATH", message: "Invalid proxy URL" } });
    }
    if (target.origin !== upstreamOrigin || !isProxyPath(target.pathname)) {
      res.setHeader("X-Request-ID", requestId);
      return res.status(400).json({ success: false, data: null, requestId, error: { code: "INVALID_PROXY_PATH", message: "Unsafe proxy target rejected" } });
    }
    if (upstreamDisabled) {
      if (req.path === "/api/dashboard/overview" && isRead(req.method)) return next();
      return sendUnavailable(res, requestId);
    }
    try {
      const body = await readRequestBody(req);
      const headers = new Headers(req.headers);
      headers.set("X-Request-ID", requestId);
      headers.delete("host");
      const response = await fetchImpl(target, {
        method: req.method,
        headers,
        body: body === null || ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      offline = false;
      res.status(response.status);
      response.headers.forEach((value, key) => { if (key.toLowerCase() !== "content-length") res.setHeader(key, value); });
      res.setHeader("X-Request-ID", response.headers.get("X-Request-ID") || requestId);
      return res.send(Buffer.from(await response.arrayBuffer()));
    } catch {
      offline = true;
      if (req.path === "/api/dashboard/overview" && isRead(req.method)) return next();
      return sendUnavailable(res, requestId);
    }
  };

  function attachSocketRelay(ioServer) {
    ioServer.on("connection", (browserSocket) => {
      let upstreamSocket;
      const publishState = (state, reason = "") => {
        offline = state === "offline";
        browserSocket.emit("dashboard:upstream", { state, reason });
      };
      try {
        upstreamSocket = ioClientFactory(resolvedUpstreamUrl, {
          reconnection: true,
          reconnectionAttempts: retryAttempts,
          reconnectionDelay: 500,
          reconnectionDelayMax: 5000,
          timeout: 3000,
        });
        upstreamSocket.on("connect", () => publishState("online"));
        upstreamSocket.on("disconnect", (reason) => publishState("offline", reason));
        upstreamSocket.on("connect_error", (error) => publishState("offline", error?.message || "connect_error"));
        upstreamSocket.onAny((event, ...args) => {
          if (event !== "connect" && event !== "disconnect") browserSocket.emit(event, ...args);
        });
      } catch (error) {
        publishState("offline", error.message);
      }
      browserSocket.on("disconnect", () => upstreamSocket?.disconnect());
    });
    return ioServer;
  }

  return {
    middleware,
    attachSocketRelay,
    getOfflineState: () => ({ offline, upstreamUrl: resolvedUpstreamUrl }),
  };
}

function resolveUpstreamUrl({ upstreamUrl, root }) {
  const explicit = upstreamUrl || process.env.DASHBOARD_UPSTREAM_URL || process.env.BOT_WEB_URL;
  if (explicit) return explicit;
  const resolved = resolveRegistryUpstreamUrl(root);
  return resolved || DEFAULT_UPSTREAM;
}

function resolveRegistryUpstreamUrl(root) {
  const registryPath = path.join(root, "mybot", "role-registry.json");
  const inventoryPath = path.join(root, "mybot", "mybots.json");
  const roleRegistry = readJsonSync(registryPath);
  const inventory = readJsonSync(inventoryPath);
  const candidateIds = [
    roleRegistry?.primaryBotId,
    roleRegistry?.adminBotId,
    "admin",
  ].filter((value, index, values) => typeof value === "string" && value.trim() && values.indexOf(value) === index);

  for (const botId of candidateIds) {
    const bot = inventory?.[botId] || readJsonSync(path.join(root, "mybot", "bots", `${botId}.json`));
    const host = bot?.webHost || "127.0.0.1";
    const port = Number(bot?.webPort || bot?.port || bot?.runtime?.port);
    if (Number.isFinite(port) && port > 0) {
      return `http://${host}:${port}`;
    }
  }

  return null;
}

function readJsonSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isProxyPath(requestPath) {
  if (typeof requestPath !== "string" || !requestPath.startsWith("/") || requestPath.startsWith("//")) return false;
  const qIndex = requestPath.indexOf("?");
  const pathname = qIndex === -1 ? requestPath : requestPath.slice(0, qIndex);
  if (hasUnsafePathSequence(pathname)) return false;
  if (pathname === "/api/bots" || /^\/api\/bots\/[^/]+$/.test(pathname)) return false;
  return PROXY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))
    || /^\/api\/bots\/[^/]+(?:\/actions\/qr-login|\/qr-login)(?:\/|$)/.test(pathname);
}

function isRead(method) { return method === "GET" || method === "HEAD"; }

async function readRequestBody(req) {
  if (["GET", "HEAD"].includes(req.method)) return null;
  if (req.body !== undefined) return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : null;
}

function sendUnavailable(res, requestId) {
  res.setHeader("X-Request-ID", requestId);
  return res.status(503).json({ success: false, data: null, requestId, error: { code: "BACKEND_UNAVAILABLE", message: "Dashboard backend is unavailable" } });
}

export { DEFAULT_UPSTREAM, PROXY_PREFIXES, isProxyPath };
