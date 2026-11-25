import express from "express";
import { registerPortalRuntimeRoute } from "../dashboard/portal-runtime.js";
import fs from "node:fs";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { getBotInfo } from "../utils/env.js";
import { listenServer } from "./listen-server.js";
import { registerInternalCommandRoutes } from "./internal-command-route.js";
import { getRuntimeInstanceDescriptor } from "../core/runtime-instance.js";
import { terminalLog } from "../utils/terminal-log.js";
import { getListenerRuntimeState } from "../runtime/listener-state.js";
import { writeReloadRequest } from "../commands/mybot/System/reload-request.js";
import { getInternalSecret } from "../commands/mybot/System/mybot-command-relay.js";
import { requestRestartForBot } from "../utils/util.js";
import { ThreadType } from "zca-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, "../..");

let io;
let httpServerInstance;
let connectedClients = new Map();
let activeWebApi = null;
let runtimeReloadHandler = null;

export function updateWebServerApi(nextApi) {
  activeWebApi = nextApi;
}

export function registerRuntimeReloadHandler(handler) {
  runtimeReloadHandler = typeof handler === "function" ? handler : null;
}

/**
 * Listener readiness fields for /internal/runtime/* payloads. Readiness must
 * reflect the ability to RECEIVE messages, not just an open port: a process
 * whose Zalo WebSocket listener is retrying reports listenerConnected=false
 * so dashboards never fake Running/Ready.
 */
function getListenerStateFields() {
  try {
    const snap = getListenerRuntimeState().getSnapshot();
    const mem = process.memoryUsage();
    return {
      listenerConnected: snap.listenerConnected,
      listenerState: snap.listenerState,
      listenerLastError: snap.listenerLastError,
      startupPid: snap.startupPid,
      startupPhase: snap.startupPhase,
      startupStartedAt: snap.startupStartedAt,
      startupLastError: snap.startupLastError,
      startupUpdatedAt: snap.startupUpdatedAt,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
        standby: snap.listenerState === "standby" || snap.listenerState === "hot_standby",
      },
    };
  } catch {
    const mem = process.memoryUsage();
    return {
      listenerConnected: false,
      listenerState: "starting",
      listenerLastError: null,
      startupPid: process.pid,
      startupPhase: "login",
      startupStartedAt: Date.now(),
      startupLastError: null,
      startupUpdatedAt: Date.now(),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
        standby: false,
      },
    };
  }
}

function requestId(req) {
  return req.headers["x-request-id"] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function startWebServer(api, options = {}) {
  activeWebApi = api;
  connectedClients.clear();
  const app = express();
  const httpServer = createServer(app);
  httpServerInstance = httpServer;
  io = new Server(httpServer, {
    cors: {
      origin: "http://127.0.0.1",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    connectedClients.set(socket.id, {
      id: socket.id,
      connectedAt: new Date().toISOString(),
      address: socket.handshake?.address || null,
    });
    socket.on("disconnect", () => {
      connectedClients.delete(socket.id);
    });
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "72mb", verify: (req, _res, buf) => { req.portalRawBody = buf.toString("utf8"); } }));
  app.use((req, res, next) => {
    const id = requestId(req);
    req.requestId = id;
    res.setHeader("X-Request-ID", id);
    next();
  });

  registerPortalRuntimeRoute(app, { root: process.env.PROJECT_ROOT || process.cwd(), getApi: () => activeWebApi, getDescriptor: getRuntimeInstanceDescriptor, getListener: getListenerStateFields, getReloadHandler: () => runtimeReloadHandler, secret: getInternalSecret({ projectRoot: process.env.PROJECT_ROOT || process.cwd() }) });

  // 1. Internal command execution bridge
  registerInternalCommandRoutes(app, { api, getApi: () => activeWebApi, projectRoot: process.cwd() });

  // 2. Internal runtime identity endpoint
  app.get("/internal/runtime/identity", (_req, res) => {
    const desc = getRuntimeInstanceDescriptor();
    res.json({
      success: true,
      kind: desc.kind,
      botKey: desc.botKey,
      configuredUid: desc.configuredUid,
      liveZaloUid: desc.liveZaloUid,
      pid: desc.pid,
      webPort: desc.webPort,
      supervisor: desc.supervisor,
      projectRoot: desc.projectRoot,
      ...getListenerStateFields(),
    });
  });

  // 3. Internal runtime health endpoint
  app.get("/internal/runtime/health", async (_req, res) => {
    const desc = getRuntimeInstanceDescriptor();
    let extensions = {};
    try {
      const { collectHealthExtensions } = await import("../observability/runtime-metrics.js");
      extensions = await collectHealthExtensions().catch(() => ({}));
    } catch {}

    let lifecycleMetrics = {};
    try {
      const { getActiveRuntimeLifecycle } = await import("../core/runtime-lifecycle.js");
      const lc = getActiveRuntimeLifecycle();
      if (lc) {
        const nsfwStats = lc.nsfwWorkerPool?.stats?.() || {};
        const canvasStats = lc.canvasWorkerPool?.stats?.() || {};
        const imageBufStats = lc.stores?.imageBufferCache?.stats?.() || {};
        const msgCacheStore = lc.stores?.messageCacheStore;
        lifecycleMetrics = {
          workers: {
            nsfw: { count: nsfwStats.processes || 0, pids: nsfwStats.pids || [] },
            canvas: { count: canvasStats.processes || 0, pids: canvasStats.pids || [] },
            total: (nsfwStats.processes || 0) + (canvasStats.processes || 0),
          },
          caches: {
            imageBuffer: { entries: imageBufStats.entries || 0, totalBytes: imageBufStats.totalBytes || 0 },
            messageCache: { entries: msgCacheStore?.lru?.size || 0 },
          },
        };
      }
    } catch {}

    let profileInfo = {};
    try {
      const { getResourceProfile } = await import("../utils/resource-profile.js");
      const profile = getResourceProfile(desc.botKey);
      profileInfo = {
        resourceProfile: profile.profile,
        isLean: profile.isLean,
      };
    } catch {}

    res.json({
      status: "healthy",
      kind: desc.kind,
      botKey: desc.botKey,
      ...profileInfo,
      coldStartDurationMs: process.uptime() * 1000,
      configuredUid: desc.configuredUid,
      liveZaloUid: desc.liveZaloUid,
      pid: desc.pid,
      webPort: desc.webPort,
      supervisor: desc.supervisor,
      uptime: process.uptime(),
      ...lifecycleMetrics,
      ...getListenerStateFields(),
      ...extensions,
    });
  });

  // 4. Internal runtime reload endpoint
  app.post("/internal/runtime/reload", async (req, res) => {
    const desc = getRuntimeInstanceDescriptor();
    const botKey = String(desc.botKey || (desc.isMain ? "admin" : "bot")).trim() || "admin";
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const action = body.action === "restart" ? "restart" : "reload";
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "runtime-bridge";
    const requestedAt = new Date().toISOString();
    const activeRoot = path.resolve(
      options?.projectRoot ||
      process.env.DASHBOARD_PROJECT_ROOT ||
      process.env.PROJECT_ROOT ||
      process.env.ProjectRoot ||
      desc.projectRoot ||
      process.cwd()
    );

    let reloadRecord = null;
    try {
      const reloadPayload = {
        action,
        reason,
        reloadType: body.reloadType || (action === "restart" ? "runtime-restart" : "runtime-reload"),
        requestedAt,
      };
      if (activeRoot === defaultRepoRoot) {
        reloadRecord = writeReloadRequest(botKey, reloadPayload);
      } else {
        const customReloadDir = path.join(activeRoot, "mybot", "state", "reload");
        fs.mkdirSync(customReloadDir, { recursive: true });
        reloadRecord = {
          uid: botKey,
          status: "requested",
          ...reloadPayload,
        };
        fs.writeFileSync(path.join(customReloadDir, `${botKey}.json`), `${JSON.stringify(reloadRecord, null, 2)}\n`, "utf8");
      }
    } catch {}

    if (action === "restart") {
      try {
        requestRestartForBot(botKey, { reason }, { root: activeRoot });
      } catch {}
    }

    const handler = typeof options?.onReload === "function" ? options.onReload : runtimeReloadHandler;
    let handlerResult = null;
    if (typeof handler === "function") {
      try {
        handlerResult = await handler({ botKey, action, reason, payload: body, descriptor: desc, reloadRequest: reloadRecord });
      } catch (error) {
        return res.status(500).json({
          success: false,
          acknowledged: false,
          botKey,
          action,
          error: error?.message || "RELOAD_FAILED",
          timestamp: new Date().toISOString(),
        });
      }
    }

    const isTestMode = Boolean(
      options?.disableExit === true ||
      process.env.SKIP_ENV_VALIDATION === "1" ||
      process.env.DASHBOARD_TEST_MODE === "1" ||
      process.env.NODE_ENV === "test" ||
      process.env.NODE_TEST_CONTEXT
    );

    res.json({
      success: true,
      acknowledged: true,
      botKey,
      action,
      reloadRequest: reloadRecord,
      ...(handlerResult && typeof handlerResult === "object" ? { result: handlerResult } : {}),
      timestamp: requestedAt,
    });

    if (action === "restart" && !isTestMode) {
      const timer = setTimeout(() => {
        process.exit(10);
      }, 150);
      timer.unref?.();
    }
  });

  // 4b. Internal loopback remote-control endpoints (groups, friends, chat, leave-group)
  const authorizeInternalBridge = (req, res) => {
    const clientIp = String(req.ip || req.socket?.remoteAddress || "").trim();
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(clientIp)) {
      res.status(403).json({ success: false, code: "FORBIDDEN", error: "Loopback only" });
      return false;
    }
    const activeRoot = path.resolve(
      options?.projectRoot ||
      process.env.DASHBOARD_PROJECT_ROOT ||
      process.env.PROJECT_ROOT ||
      defaultRepoRoot
    );
    const expectedSecret = getInternalSecret({ projectRoot: activeRoot });
    const provided = String(req.headers["x-internal-secret"] || "");
    if (!expectedSecret || provided !== expectedSecret) {
      res.status(403).json({ success: false, code: "INVALID_INTERNAL_SECRET", error: "Forbidden" });
      return false;
    }
    return true;
  };

  // 4c. Internal hot-standby, resume, and ram endpoints
  app.post("/internal/runtime/standby", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    try {
      const { getActiveRuntimeLifecycle } = await import("../core/runtime-lifecycle.js");
      const lc = getActiveRuntimeLifecycle();
      let result = null;
      if (lc && typeof lc.enterStandby === "function") {
        result = await lc.enterStandby();
      } else {
        try { getListenerRuntimeState().markStandby("hot_standby"); } catch {}
        try { activeWebApi?.listener?.stop?.(); } catch {}
        const mem = process.memoryUsage();
        result = {
          status: "standby",
          drained: true,
          memory: {
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
            heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
            standby: true,
          },
        };
      }
      return res.json({
        success: true,
        action: "standby",
        phase: "standby",
        status: "standby",
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        action: "standby",
        phase: "error",
        error: error?.message || "STANDBY_FAILED",
        code: error?.code || "STANDBY_FAILED",
      });
    }
  });

  app.post("/internal/runtime/resume", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    try {
      const { getActiveRuntimeLifecycle } = await import("../core/runtime-lifecycle.js");
      const lc = getActiveRuntimeLifecycle();
      let result = null;
      if (lc && typeof lc.resumeFromStandby === "function") {
        result = await lc.resumeFromStandby();
      } else {
        if (!activeWebApi?.listener) {
          throw new Error("Active listener not available for resume");
        }
        getListenerRuntimeState().markStarting();
        if (typeof activeWebApi.listener.startAsync === "function") {
          await activeWebApi.listener.startAsync({ rotateEndpoint: true });
        } else {
          await activeWebApi.listener.start?.({ rotateEndpoint: true });
        }
        getListenerRuntimeState().markConnected();
        const mem = process.memoryUsage();
        result = {
          status: "ws_ready",
          memory: {
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
            heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
            standby: false,
          },
        };
      }
      return res.json({
        success: true,
        action: "resume",
        phase: "ws_ready",
        status: "ws_ready",
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const isCookieExpired = error?.code === "COOKIE_EXPIRED" || error?.message?.includes("Cookie expired");
      const status = isCookieExpired ? 401 : 500;
      return res.status(status).json({
        success: false,
        action: "resume",
        phase: "error",
        code: error?.code || (isCookieExpired ? "COOKIE_EXPIRED" : "RESUME_FAILED"),
        fallback: error?.fallback || (isCookieExpired ? "QR_LOGIN_REQUIRED" : "COLD_START_REQUIRED"),
        error: error?.message || "RESUME_FAILED",
      });
    }
  });

  app.get("/internal/runtime/ram", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    const mem = process.memoryUsage();
    const snap = getListenerRuntimeState().getSnapshot();
    const isStandby = snap.listenerState === "standby" || snap.listenerState === "hot_standby";
    return res.json({
      success: true,
      pid: process.pid,
      standby: isStandby,
      listenerState: snap.listenerState,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
        standby: isStandby,
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/internal/runtime/groups", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    if (!activeWebApi || typeof activeWebApi.getAllGroups !== "function") {
      return res.json({ success: true, online: false, groups: [] });
    }
    try {
      const rawGroups = await activeWebApi.getAllGroups();
      const ids = Array.isArray(rawGroups)
        ? rawGroups.map((g) => String(g?.groupId || g?.id || g)).filter(Boolean)
        : Object.keys(rawGroups?.gridVerMap || {});
      const groups = [];
      for (let i = 0; i < ids.length; i += 25) {
        const chunk = ids.slice(i, i + 25);
        try {
          const infoRes = typeof activeWebApi.getGroupInfo === "function"
            ? await activeWebApi.getGroupInfo(chunk)
            : null;
          const map = infoRes?.gridInfoMap || infoRes || {};
          for (const gid of chunk) {
            const g = map[gid] || {};
            groups.push({
              threadId: gid,
              name: g.name || g.groupName || `Nhóm ${gid}`,
              memberCount: Number(g.totalMember || g.memberCount || (Array.isArray(g.memVerList) ? g.memVerList.length : 0) || 0),
              avatar: g.avt || g.fullAvt || g.avatar || "",
            });
          }
        } catch {
          for (const gid of chunk) {
            groups.push({ threadId: gid, name: `Nhóm ${gid}`, memberCount: 0, avatar: "" });
          }
        }
      }
      return res.json({ success: true, online: true, groups });
    } catch (error) {
      return res.status(502).json({ success: false, code: "ZALO_GROUPS_FAILED", error: error?.message || "Failed to list groups" });
    }
  });

  app.get("/internal/runtime/friends", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    if (!activeWebApi || typeof activeWebApi.getAllFriends !== "function") {
      return res.json({ success: true, online: false, friends: [] });
    }
    try {
      const rawFriends = await activeWebApi.getAllFriends();
      const list = Array.isArray(rawFriends) ? rawFriends : Array.isArray(rawFriends?.friends) ? rawFriends.friends : [];
      const friends = list.map((f) => ({
        uid: String(f?.userId || f?.uid || f?.id || ""),
        displayName: f?.displayName || f?.dName || f?.zaloName || f?.name || "",
        zaloName: f?.zaloName || "",
        avatar: f?.avatar || f?.avt || "",
      })).filter((f) => f.uid);
      return res.json({ success: true, online: true, friends });
    } catch (error) {
      return res.status(502).json({ success: false, code: "ZALO_FRIENDS_FAILED", error: error?.message || "Failed to list friends" });
    }
  });

  app.post("/internal/runtime/send-message", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    if (!activeWebApi || typeof activeWebApi.sendMessage !== "function") {
      return res.status(503).json({ success: false, code: "BOT_OFFLINE", error: "Bot hiện đang ngoại tuyến, chưa kết nối Zalo API." });
    }
    const threadId = String(req.body?.threadId || "").trim();
    const threadTypeRaw = String(req.body?.threadType || "group").toLowerCase();
    const targetType = threadTypeRaw === "user" || threadTypeRaw === "0" ? ThreadType.User : ThreadType.Group;
    const text = String(req.body?.text || "").trim();
    const mediaUrl = String(req.body?.mediaUrl || "").trim();
    if (!threadId || (!text && !mediaUrl)) {
      return res.status(400).json({ success: false, code: "INVALID_MESSAGE", error: "Thiếu threadId hoặc nội dung tin nhắn." });
    }
    try {
      if (mediaUrl && /\.(mp4|mov|webm)(\?|$)/i.test(mediaUrl) && typeof activeWebApi.sendVideo === "function") {
        await activeWebApi.sendVideo({ videoUrl: mediaUrl, thumbnailUrl: mediaUrl, msg: text, duration: 15000, width: 720, height: 1280 }, threadId, targetType);
      } else {
        const finalText = mediaUrl ? (text ? `${text}\n${mediaUrl}` : mediaUrl) : text;
        await activeWebApi.sendMessage({ msg: finalText }, threadId, targetType);
      }
      return res.json({ success: true, sent: true, threadId, threadType: threadTypeRaw });
    } catch (error) {
      return res.status(502).json({ success: false, code: "SEND_FAILED", error: error?.message || "Không gửi được tin nhắn qua Zalo." });
    }
  });

  app.post("/internal/runtime/leave-group", async (req, res) => {
    if (!authorizeInternalBridge(req, res)) return;
    if (!activeWebApi) {
      return res.status(503).json({ success: false, code: "BOT_OFFLINE", error: "Bot hiện đang ngoại tuyến." });
    }
    const threadId = String(req.body?.threadId || "").trim();
    if (!threadId) {
      return res.status(400).json({ success: false, code: "INVALID_THREAD_ID", error: "Thiếu mã nhóm." });
    }
    try {
      if (typeof activeWebApi.leaveGroup === "function") {
        await activeWebApi.leaveGroup(threadId);
      } else {
        return res.status(501).json({ success: false, code: "LEAVE_UNSUPPORTED", error: "Phiên Zalo hiện tại chưa hỗ trợ API rời nhóm." });
      }
      return res.json({ success: true, left: true, threadId });
    } catch (error) {
      return res.status(502).json({ success: false, code: "LEAVE_FAILED", error: error?.message || "Rời nhóm thất bại." });
    }
  });

  // 5. Strict 404 handler for any non-internal routes (no Dashboard API, no SPA static, no uploads)
  app.all("*", (req, res) => {
    res.status(404).json({
      success: false,
      error: "NOT_FOUND",
      message: "Runtime bridge only exposes /internal/* endpoints on 127.0.0.1",
      path: req.path,
    });
  });

  const desc = getRuntimeInstanceDescriptor();
  const botInfo = await getBotInfo().catch(() => null);
  const PORT = Number(process.env.WEB_PORT || botInfo?.webPort || desc.webPort || (desc.isMain ? 2000 : 3000));
  // Hard-bind runtime bridge to 127.0.0.1 only
  const HOST = "127.0.0.1";

  try {
    await listenServer(httpServer, PORT, HOST);
  } catch (error) {
    if (httpServerInstance === httpServer) httpServerInstance = null;
    try { io?.close(); } catch {}
    io = undefined;
    // Structured bridge bind failure: carries enough detail for the reconcile /
    // monitor layer to distinguish a real `port-closed` from a port that is
    // simply already bound by another process. The bind error is NEVER
    // swallowed here: the bridge is a mandatory runtime surface, not an
    // optional dashboard convenience.
    const bindError = new Error(`Runtime web bridge failed to bind on 127.0.0.1:${PORT} (${error?.code || error?.message})`);
    bindError.code = error?.code || "BRIDGE_PORT_IN_USE";
    bindError.port = PORT;
    bindError.botKey = desc.botKey;
    bindError.pid = desc.pid;
    bindError.cause = error;
    throw bindError;
  }

  console.log(chalk.yellow(`Runtime bridge listening on http://${HOST}:${PORT}`));
  desc.webPort = PORT;

  terminalLog({
    scope: "runtime-bridge",
    level: "success",
    title: "Runtime bridge listening",
    lines: [
      `kind: ${desc.kind}`,
      `botKey: ${desc.botKey}`,
      `liveUid: ${desc.liveZaloUid || "pending"}`,
      `pid: ${process.pid}`,
      `host: ${HOST}`,
      `port: ${PORT}`,
    ],
  });

  httpServer.on("close", () => {
    if (httpServerInstance === httpServer) {
      httpServerInstance = null;
    }
  });
}

export function getIO() {
  return io;
}

export async function closeWebServer() {
  const server = httpServerInstance;
  const socketServer = io;

  httpServerInstance = null;
  io = undefined;
  connectedClients.clear();

  if (socketServer) {
    await new Promise((resolve) => socketServer.close(resolve));
  }

  if (!server || !server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function getConnectedClients() {
  return Array.from(connectedClients.values());
}

export function getConnectedClientsCount() {
  return connectedClients.size;
}
