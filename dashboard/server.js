import express from "express";
import fs from "node:fs";
import { createServer } from "node:http";
import { Server } from "socket.io";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminalLog, terminalLogger } from "../src/utils/terminal-log.js";
import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { createDashboardGateway } from "../src/dashboard/dashboard-gateway.js";
import { BotRegistry } from "../src/dashboard/bot-registry.js";
import { createRuntimeStatusResolver } from "../src/dashboard/runtime-status-resolver.js";
import { ConfigStore } from "../src/dashboard/config-store.js";
import { createQrSessionManager } from "../src/dashboard/qr-service.js";
import { createAdminRecoveryService } from "../src/dashboard/admin-recovery-service.js";
import { commandRegistry } from "../src/commands/command-registry.js";
import { upsertEnvLocalEntries } from "../src/bootstrap.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { LRUCache } from "lru-cache";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(__dirname, "..");

function resolveProjectRoot() {
  const explicit = process.env.DASHBOARD_PROJECT_ROOT || process.env.PROJECT_ROOT || process.env.ProjectRoot;
  if (explicit && String(explicit).trim()) {
    return path.resolve(String(explicit).trim());
  }
  if (process.env.DASHBOARD_TEST_MODE === "1") {
    const cwd = path.resolve(process.cwd());
    if (cwd !== __dirname && cwd !== defaultProjectRoot && fs.existsSync(path.join(cwd, "mybot"))) {
      return cwd;
    }
  }
  return defaultProjectRoot;
}

const projectRoot = resolveProjectRoot();
dotenv.config({ path: path.join(projectRoot, ".env.local"), override: false, quiet: true });
dotenv.config({ path: path.join(projectRoot, ".env"), override: false, quiet: true });
const dist = path.join(__dirname, "dist");
const publicRoot = path.join(__dirname, "public");
const hasDist = fs.existsSync(path.join(dist, "index.html"));
const hasPublic = fs.existsSync(path.join(publicRoot, "index.html"));
const assetRoot = process.env.DASHBOARD_TEST_MODE === "1" && hasPublic ? publicRoot : hasDist ? dist : publicRoot;
const app = express();
const httpServer = createServer(app);
const port = Number(process.env.DASHBOARD_PORT || 4173);
if (process.env.MYBOT_NODE_HYBRID === "true" || process.env.DISABLE_NODE_DASHBOARD === "true") {
  console.log("[NODE DASHBOARD] Node dashboard is disabled in Hybrid mode. Port 4173 is exclusively held by Rust V4. Exiting cleanly.");
  process.exit(0);
}
if (process.env.DASHBOARD_TEST_MODE !== "1") {
  if (!process.env.DASHBOARD_ADMIN_USERNAME || !process.env.DASHBOARD_ADMIN_PASSWORD) {
    throw new Error("DASHBOARD_ADMIN_USERNAME và DASHBOARD_ADMIN_PASSWORD là bắt buộc (không còn giá trị mặc định)");
  }
}
const authUsername = String(process.env.DASHBOARD_ADMIN_USERNAME || "test-admin").trim() || "test-admin";
let authSecret = String(process.env.DASHBOARD_ADMIN_PASSWORD || process.env.DASHBOARD_AUTH_SECRET || "test-secret").trim() || "test-secret";
const sessionTtlMs = Number(process.env.DASHBOARD_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const loginRateLimitWindowMs = Number(process.env.DASHBOARD_LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginRateLimitMax = Number(process.env.DASHBOARD_LOGIN_RATE_LIMIT_MAX || 5);
const authSessions = new LRUCache({ max: 500, ttl: Math.max(1000, sessionTtlMs) });
const loginAttempts = new LRUCache({ max: 2000, ttl: Math.max(1000, loginRateLimitWindowMs) });
const cookieSameSite = process.env.DASHBOARD_COOKIE_SAMESITE || "Strict";

function isSecureRequest(req) {
  const mode = String(process.env.DASHBOARD_COOKIE_SECURE ?? "").trim();
  if (mode === "1") return true;
  if (mode === "0") return false;
  if (req?.secure) return true;
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  return forwardedProto === "https";
}

function sessionCookieFlags(req, { httpOnly = true, maxAge } = {}) {
  const secure = isSecureRequest(req) ? "Secure; " : "";
  const httpOnlyPart = httpOnly ? "HttpOnly; " : "";
  const maxAgePart = maxAge !== undefined ? `; Max-Age=${maxAge}` : "; Max-Age=0";
  return `Path=/; ${httpOnlyPart}${secure}SameSite=${cookieSameSite}${maxAgePart}`;
}
const dashboardRegistry = new BotRegistry({ root: projectRoot });
// Shared status resolver: overview + /api/bots + terminal use the same engine.
const runtimeResolver = createRuntimeStatusResolver({ root: projectRoot });
const dashboardConfigStore = new ConfigStore({ backupDir: path.join(projectRoot, "logs", "dashboard-backups") });
const qrSessionManager = createQrSessionManager({
  root: projectRoot,
  registry: dashboardRegistry,
  configStore: dashboardConfigStore,
  auditStore: { append: async () => null },
  maxConcurrentSessions: process.env.QR_LOGIN_MAX_CONCURRENT !== undefined && process.env.QR_LOGIN_MAX_CONCURRENT !== ""
    ? process.env.QR_LOGIN_MAX_CONCURRENT
    : Infinity,
  persistQrFile: false,
});
// Read-only view over the admin recovery artifact channel (Task 1). The
// dashboard never starts or cancels recovery; it only polls the artifact.
const adminRecoveryService = createAdminRecoveryService({ projectRoot });

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) continue;
    cookies[key] = decodeURIComponent(rest.join("=") || "");
  }
  return cookies;
}

function getClientIp(req) {
  if (process.env.DASHBOARD_TRUST_PROXY === "1") {
    const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req?.socket?.remoteAddress || req?.ip || "unknown";
}

function getLoginAttempts(ip) {
  const now = Date.now();
  const bucket = loginAttempts.get(ip);
  if (!bucket || now - bucket.startedAt >= loginRateLimitWindowMs) {
    const next = { startedAt: now, count: 0 };
    loginAttempts.set(ip, next);
    return next;
  }
  return bucket;
}

function isLoginRateLimited(ip) {
  return getLoginAttempts(ip).count >= loginRateLimitMax;
}

function registerLoginFailure(ip) {
  const bucket = getLoginAttempts(ip);
  bucket.count += 1;
  loginAttempts.set(ip, bucket);
  return bucket;
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function issueSession() {
  const sessionId = randomBytes(24).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  authSessions.set(sessionId, {
    sessionId,
    username: authUsername,
    csrfToken,
    createdAt: Date.now(),
    expiresAt: Date.now() + sessionTtlMs,
  });
  return { sessionId, csrfToken };
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const entry = cookies.mybot_session ? authSessions.get(cookies.mybot_session) : null;
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    authSessions.delete(entry.sessionId);
    return null;
  }
  return entry;
}

function clearSession(req, res, sessionId) {
  if (sessionId) authSessions.delete(sessionId);
  res.setHeader("Set-Cookie", [
    `mybot_session=; ${sessionCookieFlags(req, { maxAge: 0 })}`,
    `mybot_csrf=; ${sessionCookieFlags(req, { httpOnly: false, maxAge: 0 })}`,
  ]);
}

function authorizeSocket(socket, next) {
  const cookies = parseCookies(socket.request.headers.cookie || "");
  const session = cookies.mybot_session ? authSessions.get(cookies.mybot_session) : null;
  if (!session || session.expiresAt <= Date.now()) return next(new Error("AUTH_REQUIRED"));
  const token = socket.handshake.auth?.csrfToken || socket.request.headers["x-csrf-token"] || cookies.mybot_csrf;
  if (!token || String(token) !== session.csrfToken) return next(new Error("CSRF_REQUIRED"));
  socket.data.dashboardSession = session;
  return next();
}

function setSessionCookies(req, res, sessionId, csrfToken) {
  const maxAge = Math.floor(sessionTtlMs / 1000);
  res.setHeader("Set-Cookie", [
    `mybot_session=${sessionId}; ${sessionCookieFlags(req, { maxAge })}`,
    `mybot_csrf=${csrfToken}; ${sessionCookieFlags(req, { httpOnly: false, maxAge })}`,
  ]);
}

const PUBLIC_DASHBOARD_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/system/health",
]);

function resolveSafeRequestPathname(req) {
  const rawUrl = String(req?.originalUrl || req?.url || "");
  const qIndex = rawUrl.indexOf("?");
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  if (!rawPath.startsWith("/")) return null;
  if (rawPath.includes("..") || /%2e/i.test(rawPath) || rawPath.includes("\\") || /%5c/i.test(rawPath) || rawPath.includes("\0") || /%00/i.test(rawPath)) {
    return null;
  }
  try {
    const parsed = new URL(rawPath, "http://127.0.0.1");
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    if (pathname.includes("..") || /%2e/i.test(pathname)) return null;
    return pathname;
  } catch {
    return null;
  }
}

function requireDashboardAuth(req, res, next) {
  const pathname = resolveSafeRequestPathname(req);
  if (pathname && PUBLIC_DASHBOARD_PATHS.has(pathname)) return next();
  const session = getSession(req);
  if (!session) return res.status(401).json({ success: false, error: "AUTH_REQUIRED" });
  req.dashboardSession = session;
  return next();
}

function requireCsrf(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const session = req.dashboardSession || getSession(req);
  const headerToken = req.headers["x-csrf-token"];
  if (!session?.csrfToken || !headerToken || !timingSafeEqualSafe(String(headerToken), session.csrfToken)) {
    return res.status(403).json({ success: false, error: "CSRF_REQUIRED" });
  }
  req.dashboardSession = session;
  return next();
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isPortOpen(portNumber, host = "127.0.0.1", timeout = 400) {
  const numericPort = Number(portNumber);
  if (!Number.isFinite(numericPort) || numericPort <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("error", () => done(false));
    socket.connect(numericPort, host, () => done(true));
  });
}

function getBotPaths(root, uid) {
  return {
    configPath: path.join(root, "mybot", "bots", `${uid}.json`),
    statePath: path.join(root, "mybot", "state", `${uid}.json`),
  };
}

async function getDashboardBots(root = projectRoot) {
  const registry = readJson(path.join(root, "mybot", "mybots.json"), {});
  const ids = new Set(["admin", ...Object.keys(registry || {})]);
  const bots = [];

  for (const uid of ids) {
    const paths = getBotPaths(root, uid);
    const config = readJson(paths.configPath, {});
    const state = readJson(paths.statePath, {});
    const registryInfo = uid === "admin" ? {} : registry[uid] || {};
    const portNumber = Number(registryInfo.webPort || config.webPort || state.webPort || 0);
    const host = config.webHost || "127.0.0.1";

    // Two-layer status from the shared resolver. In DASHBOARD_TEST_MODE the
    // identity probe is skipped (no real bot runtime in tests); a bot whose
    // port answers is treated as identity-verified so test fixtures work.
    const testMode = process.env.DASHBOARD_TEST_MODE === "1";
    let resolved;
    if (testMode) {
      const portOpen = await isPortOpen(portNumber, host);
      const online = portOpen;
      resolved = {
        status: online ? "running" : (registryInfo.enabled === false ? "disabled" : "stopped"),
        configuredStatus: registryInfo.status || config.status || "unknown",
        connected: online,
        enabled: registryInfo.enabled !== false,
        expired: false,
        supervisor: { available: true, status: online ? "online" : "stopped", pid: null, pm2Id: null, uptime: 0, restartCount: 0 },
        readiness: { status: online ? "ready" : "not-ready", portOpen, identityVerified: online, reason: online ? "test-mode" : "port-closed", checkedAt: new Date().toISOString() },
        reason: online ? "ready" : "stopped",
      };
    } else {
      resolved = await runtimeResolver.resolveBot({
        id: uid,
        enabled: registryInfo.enabled !== false,
        expiryAt: registryInfo.expiryAt || config.expiryAt || null,
        port: portNumber,
        webHost: host,
        configuredStatus: registryInfo.status || config.status || "unknown",
      });
    }

    const processAlive = isProcessAlive(state.pid || registryInfo.pid);
    const calculatedStatus = resolved.status;
    const configuredStatus = resolved.configuredStatus;
    const connected = resolved.connected;
    bots.push({
      id: uid,
      uid,
      name: registryInfo.name || config.name || uid,
      displayName: registryInfo.displayName || config.displayName || registryInfo.name || config.name || uid,
      status: calculatedStatus,
      // Status schema v2 (see src/dashboard/bot-registry.js): schema version,
      // provenance layers and machine-readable reason on every bot record.
      statusSchemaVersion: 2,
      statusReason: resolved.reason || resolved.readiness?.reason || null,
      configuredStatus,
      connected,
      supervisor: resolved.supervisor,
      readiness: resolved.readiness,
      pm2Status: resolved.supervisor?.status || null,
      processAlive,
      portOpen: resolved.readiness?.portOpen || false,
      identityVerified: resolved.readiness?.identityVerified || false,
      port: portNumber || null,
      webPort: portNumber || null,
      pid: resolved.supervisor?.pid || state.pid || registryInfo.pid || null,
      startedAt: state.startedAt || registryInfo.startedAt || null,
      expiryAt: registryInfo.expiryAt || config.expiryAt || null,
      configPath: fs.existsSync(paths.configPath) ? paths.configPath : null,
      lastSeenAt: state.timestamp || state.updatedAt || null,
      cookieDead: state.cookieDead === true,
    });
  }

  return bots.sort((a, b) => (a.id === "admin" ? -1 : b.id === "admin" ? 1 : a.id.localeCompare(b.id)));
}

async function getDashboardOverview(range) {
  const bots = await getDashboardBots();
  const counts = bots.reduce((acc, bot) => {
    const key = bot.connected ? "running" : (bot.configuredStatus === "running" ? "unknown" : bot.configuredStatus || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const adminBot = bots.find((b) => b.id === "admin");
  const adminCfg = readJson(path.join(projectRoot, "assets", "config.json"), {});
  const adminCookieConfigured = Boolean(adminCfg?.cookie && typeof adminCfg.cookie === "object" && Object.keys(adminCfg.cookie).length > 0);
  const adminNeedsRecovery = Boolean(adminBot && !adminBot.connected && (adminBot.cookieDead || !adminCookieConfigured));

  return {
    total: bots.length,
    counts,
    bots,
    adminNeedsRecovery,
    process: {
      pid: process.pid,
      uptime: process.uptime(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function registerOverviewRoute(serverApp, observabilityService) {
  serverApp.get("/api/dashboard/overview", async (req, res) => {
    const range = req.query.range || "24h";
    if (range !== "24h" && range !== "7d") return res.status(400).json({ success: false, code: "INVALID_RANGE" });
    try {
      if (observabilityService) return res.json(await observabilityService.getOverview(range));
      const overview = await getDashboardOverview(range);
      return res.json({ success: true, data: overview, ...overview });
    } catch {
      return res.status(500).json({ success: false, code: "OVERVIEW_UNAVAILABLE" });
    }
  });
}

function registerAuthRoutes(serverApp) {
  serverApp.get("/api/auth/session", (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ success: false, authenticated: false, username: null, csrfToken: null, expiresAt: null });
    return res.json({
      success: true,
      authenticated: true,
      username: session.username || authUsername,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });
  serverApp.post("/api/auth/login", (req, res) => {
    const ip = getClientIp(req);
    if (isLoginRateLimited(ip)) {
      return res.status(429).json({ success: false, error: "LOGIN_RATE_LIMITED" });
    }
    const username = String(req.body?.username || "");
    const password = String(req.body?.password || "");
    const usernameMatch = timingSafeEqualSafe(username, authUsername);
    const passwordMatch = timingSafeEqualSafe(password, authSecret);
    if (!usernameMatch || !passwordMatch) {
      const bucket = registerLoginFailure(ip);
      if (bucket.count >= loginRateLimitMax) {
        return res.status(429).json({ success: false, error: "LOGIN_RATE_LIMITED" });
      }
      return res.status(401).json({ success: false, error: "INVALID_CREDENTIALS" });
    }
    clearLoginFailures(ip);
    const { sessionId, csrfToken } = issueSession();
    setSessionCookies(req, res, sessionId, csrfToken);
    return res.json({ success: true, authenticated: true, username: authUsername, csrfToken, expiresAt: new Date(Date.now() + sessionTtlMs).toISOString() });
  });
  serverApp.post("/api/auth/logout", (req, res) => {
    const session = getSession(req);
    clearSession(req, res, session?.sessionId);
    return res.json({ success: true });
  });
}

function timingSafeEqualSafe(left, right) {
  const leftDigest = createHash("sha256").update(String(left)).digest();
  const rightDigest = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function configureDashboardApp(app, { observabilityService, gateway, getIo = () => null } = {}) {
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
  registerAuthRoutes(app);
  app.use("/api", requireDashboardAuth);
  app.use("/api", requireCsrf);
  app.post("/api/auth/change-password", (req, res) => {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "").trim();
    if (!timingSafeEqualSafe(currentPassword, authSecret)) {
      return res.status(401).json({
        success: false,
        error: { code: "INVALID_CURRENT_PASSWORD", message: "Mật khẩu hiện tại không chính xác." },
      });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: { code: "WEAK_PASSWORD", message: "Mật khẩu mới phải có ít nhất 6 ký tự." },
      });
    }
    authSecret = newPassword;
    process.env.DASHBOARD_ADMIN_PASSWORD = newPassword;
    if (process.env.DASHBOARD_TEST_MODE !== "1") {
      try {
        upsertEnvLocalEntries(path.join(projectRoot, ".env.local"), {
          DASHBOARD_ADMIN_PASSWORD: newPassword,
        });
      } catch {}
    }
    return res.json({ success: true, data: { changed: true } });
  });
  registerOverviewRoute(app, observabilityService);
  registerDashboardApi(app, { root: projectRoot, qrSessionManager, adminRecoveryService, commandRegistry, vipRegistry: commandRegistry, getIo });
  app.use(gateway.middleware);
  app.use(express.static(assetRoot));
  app.get("*", (req, res) => {
    const acceptsHtml = req.headers.accept?.includes("text/html");
    if (!acceptsHtml) return res.status(404).json({ success: false, error: "Not found" });
    return res.sendFile(path.join(assetRoot, "index.html"));
  });
  return app;
}

function createDashboardServer({ observabilityService } = {}) {
  const testApp = express();
  const testServer = createServer(testApp);
  const testGateway = createDashboardGateway({ root: projectRoot });
  let testIoRef = null;
  configureDashboardApp(testApp, { observabilityService, gateway: testGateway, getIo: () => testIoRef });
  const testIo = new Server(testServer, {
    cors: {
      origin: process.env.DASHBOARD_ORIGIN ? [process.env.DASHBOARD_ORIGIN] : false,
      credentials: true,
    },
  });
  testIoRef = testIo;
  testIo.use(authorizeSocket);
  testGateway.attachSocketRelay(testIo);
  const rawClose = testServer.close.bind(testServer);
  let isClosing = false;
  testServer.close = (callback) => {
    try {
      testServer.closeAllConnections?.();
    } catch {}
    if (!isClosing) {
      isClosing = true;
      try {
        testIo.close(callback);
        return testServer;
      } catch {}
    }
    return rawClose(callback);
  };
  return testServer;
}

const gateway = createDashboardGateway({ root: projectRoot });
let liveIoRef = null;
configureDashboardApp(app, { gateway, getIo: () => liveIoRef });
const io = new Server(httpServer, {
  cors: {
    origin: process.env.DASHBOARD_ORIGIN ? [process.env.DASHBOARD_ORIGIN] : false,
    credentials: true,
  },
});
liveIoRef = io;
io.use(authorizeSocket);
gateway.attachSocketRelay(io);

if (process.env.DASHBOARD_TEST_MODE !== "1" && process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  const host = process.env.DASHBOARD_HOST || "0.0.0.0";
  terminalLogger.writeBanner({ name: "WEB DASHBOARD", botName: "dashboard", status: "STARTING" });
  httpServer.listen(port, host, () => {
    console.log(`MYBOT dashboard listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    terminalLogger.writeBanner({ name: "WEB DASHBOARD", botName: "dashboard", status: "ONLINE" });
    terminalLog({ scope: "dashboard", level: "success", title: "Dashboard server listening", lines: [`http://${host === "0.0.0.0" ? "localhost" : host}:${port}`] });
  });
}

export { app, createDashboardServer, getClientIp, httpServer, projectRoot, requireDashboardAuth, timingSafeEqualSafe };
