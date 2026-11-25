import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import express from "express";
import fetch from "node-fetch";

import { requestIdMiddleware, sendError, sendSuccess } from "../api-response.js";
import { AuditStore } from "../audit-store.js";
import { BotRegistry } from "../bot-registry.js";
import { createBotActionService } from "../bot-action-service.js";
import { CommandStudioService } from "../command-studio-service.js";
import { ConfigStore } from "../config-store.js";
import { readLogs } from "../log-reader.js";
import { PrefixService } from "../prefix-service.js";
import { ProviderConfigService } from "../provider-config-service.js";
import { commandRegistry as defaultCommandRegistry } from "../../commands/command-registry.js";
import { getInternalSecret } from "../../commands/mybot/System/mybot-command-relay.js";
import { writeReloadRequest } from "../../commands/mybot/System/reload-request.js";

import { getSharedControlStore } from "./control-store.js";
import { IamService, ROLE_PERMISSIONS } from "./iam-service.js";
import { SaasCrmService } from "./saas-crm-service.js";
import {
  ShieldIntelligenceService,
  CANONICAL_SHIELDS,
  normalizeUnifiedGroupSettings,
} from "./shield-intelligence-service.js";
import { CampaignMediaService } from "./campaign-media-service.js";
import { SreOpsService, computeBotHealthScore } from "./sre-ops-service.js";

const V5_SESSION_COOKIE = "mybot_v5_session";
const V5_CSRF_COOKIE = "mybot_v5_csrf";
const DEFAULT_V5_COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;

const PWA_ICON_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0ea5e9"/>
        <stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
    </defs>
    <rect width="256" height="256" rx="56" fill="#090d16"/>
    <rect x="18" y="18" width="220" height="220" rx="44" fill="url(#g)" opacity="0.18"/>
    <path d="M128 46l68 28v50c0 46-29 84-68 98-39-14-68-52-68-98V74l68-28z" fill="url(#g)"/>
    <circle cx="104" cy="118" r="10" fill="#fff"/>
    <circle cx="152" cy="118" r="10" fill="#fff"/>
    <path d="M98 150c10 10 50 10 60 0" stroke="#fff" stroke-width="10" stroke-linecap="round" fill="none"/>
  </svg>`
);

const PWA_SERVICE_WORKER_JS = `/* MYBOT Control Plane V5 - Cache-Safe Service Worker */
const CACHE_NAME = "mybot-v5-shell-v1";
const BYPASS_PREFIXES = ["/api/", "/v5-auth/", "/v5-portal/", "/socket.io/"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && (url.pathname.startsWith("/assets/") || url.pathname === "/manifest.webmanifest")) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
`;

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function buildCookieFlags(req, { httpOnly = true, maxAge = DEFAULT_V5_COOKIE_MAX_AGE_SEC } = {}) {
  const isSecure =
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https" ||
    process.env.DASHBOARD_COOKIE_SECURE === "1";
  const parts = ["Path=/", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAge))}`];
  if (httpOnly) parts.push("HttpOnly");
  if (isSecure) parts.push("Secure");
  return parts.join("; ");
}

function setV5SessionCookies(req, res, sessionToken, csrfToken, maxAgeSec = DEFAULT_V5_COOKIE_MAX_AGE_SEC) {
  res.setHeader("Set-Cookie", [
    `${V5_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; ${buildCookieFlags(req, { httpOnly: true, maxAge: maxAgeSec })}`,
    `${V5_CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; ${buildCookieFlags(req, { httpOnly: false, maxAge: maxAgeSec })}`,
  ]);
}

function clearV5SessionCookies(req, res) {
  res.setHeader("Set-Cookie", [
    `${V5_SESSION_COOKIE}=; ${buildCookieFlags(req, { httpOnly: true, maxAge: 0 })}`,
    `${V5_CSRF_COOKIE}=; ${buildCookieFlags(req, { httpOnly: false, maxAge: 0 })}`,
  ]);
}

function timingSafeMatch(a, b) {
  const left = crypto.createHash("sha256").update(String(a || "")).digest();
  const right = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function csvEscape(val) {
  const str = val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function probeLoopbackPort(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const numericPort = Number(port);
    if (!Number.isFinite(numericPort) || numericPort <= 0) {
      resolve(false);
      return;
    }
    const sock = net.createConnection({ host: "127.0.0.1", port: numericPort });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

async function readJsonSafe(filePath, fallback = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

export function createV5DashboardSubsystem(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const getIo = options.getIo || (() => null);

  const store = options.store || getSharedControlStore(root);
  const registry = options.registry || new BotRegistry({ root, pm2: options.pm2, portProbe: options.portProbe });
  const configStore = options.configStore || new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") });
  const auditStore = options.auditStore || new AuditStore({ root });
  const prefixService = options.prefixService || new PrefixService({ root, registry, configStore });
  const providerConfigService = options.providerConfigService || new ProviderConfigService({ root });
  const commandRegistry = options.commandRegistry || defaultCommandRegistry;
  const studioService =
    options.studioService || new CommandStudioService({ root, auditStore, registry: commandRegistry });
  const actions =
    options.actions ||
    options.actionService ||
    createBotActionService({
      root,
      registry,
      configStore,
      auditStore,
      pm2Adapter: options.pm2Adapter || options.pm2,
      processAdapter: options.processAdapter,
    });
  const qrSessionManager = options.qrSessionManager || null;

  const iamService = options.iamService || new IamService({ root, store, auditStore });
  const crmService = options.crmService || new SaasCrmService({ root, store, registry, actions, auditStore });
  const shieldService =
    options.shieldService ||
    new ShieldIntelligenceService({
      root,
      store,
      registry,
      configStore,
      auditStore,
      getIo,
    });
  const campaignService =
    options.campaignService ||
    new CampaignMediaService({
      root,
      store,
      registry,
      auditStore,
      getIo,
    });
  const sreService =
    options.sreService ||
    new SreOpsService({
      root,
      store,
      registry,
      configStore,
      auditStore,
      providerConfigService,
      studioService,
      commandRegistry,
      prefixService,
      actions,
      getIo,
    });

  return {
    root,
    store,
    registry,
    configStore,
    auditStore,
    prefixService,
    providerConfigService,
    commandRegistry,
    studioService,
    actions,
    qrSessionManager,
    iamService,
    crmService,
    shieldService,
    campaignService,
    sreService,
    getIo,
  };
}

export function registerV5DashboardRoutes(app, options = {}) {
  app.locals ||= {};
  const v5 = app.locals.v5 || createV5DashboardSubsystem(options);
  app.locals.v5 = v5;

  const {
    root,
    store,
    registry,
    configStore,
    auditStore,
    commandRegistry,
    studioService,
    actions,
    qrSessionManager,
    iamService,
    crmService,
    shieldService,
    campaignService,
    sreService,
  } = v5;

  const ensureReqContext = (req, res, next) => {
    req.cookies ||= parseCookies(req.headers?.cookie || "");
    if (!req.requestId) {
      return requestIdMiddleware(req, res, next);
    }
    return next();
  };

  const wrap = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch((error) => {
      const status = Number(error?.status || error?.statusCode || 500);
      const code = String(error?.code || "INTERNAL_ERROR");
      return sendError(res, req, status, code, error?.message || "Đã xảy ra lỗi không mong muốn.");
    });

  async function resolveV5Identity(req) {
    req.cookies ||= parseCookies(req.headers?.cookie || "");
    if (req.v5Identity) return req.v5Identity;

    let resolved = null;
    try {
      resolved = await Promise.resolve(iamService?.resolveRequestIdentity?.(req));
    } catch {}

    if (resolved && resolved.authenticated !== false && (resolved.user || resolved.role || resolved.id)) {
      const userObj = resolved.user || resolved;
      const role = userObj.role || resolved.role || "bot_owner";
      const identity = {
        authenticated: true,
        id: userObj.id || resolved.id || userObj.username || "user",
        username: userObj.username || resolved.username || "user",
        displayName: userObj.displayName || userObj.username || "Operator",
        role,
        permissions:
          resolved.permissions ||
          userObj.permissions ||
          ROLE_PERMISSIONS?.[role] ||
          [],
        allowedBotIds: userObj.allowedBotIds || resolved.allowedBotIds || [],
        ownerUid: userObj.ownerUid || resolved.ownerUid || "",
        totpEnabled: Boolean(userObj.totpEnabled ?? resolved.totpEnabled),
        sessionId:
          resolved.sessionId ||
          resolved.session?.sessionId ||
          resolved.session?.id ||
          req.cookies[V5_SESSION_COOKIE] ||
          null,
        csrfToken:
          resolved.csrfToken ||
          resolved.session?.csrfToken ||
          req.cookies[V5_CSRF_COOKIE] ||
          null,
        authSource: resolved.authSource || (req.headers.authorization ? "bearer" : "v5_session"),
        raw: resolved,
      };
      req.v5Identity = identity;
      return identity;
    }

    if (req.dashboardSession) {
      const masterIdentity = {
        authenticated: true,
        id: "primary_admin",
        username: req.dashboardSession.username || "admin",
        displayName: "Super Admin",
        role: "super_admin",
        permissions: ROLE_PERMISSIONS?.super_admin || ["*"],
        allowedBotIds: ["*"],
        ownerUid: "admin",
        totpEnabled: false,
        sessionId: req.dashboardSession.sessionId || null,
        csrfToken: req.dashboardSession.csrfToken || null,
        authSource: "dashboard_session",
      };
      req.v5Identity = masterIdentity;
      return masterIdentity;
    }

    return null;
  }

  async function hasPerm(identity, perm) {
    if (!identity) return false;
    if (identity.role === "super_admin") return true;
    if (Array.isArray(identity.permissions) && (identity.permissions.includes("*") || identity.permissions.includes(perm))) {
      return true;
    }
    try {
      const res = await Promise.resolve(iamService?.hasPermission?.(identity.raw || identity, perm));
      if (typeof res === "boolean") return res;
    } catch {}
    return false;
  }

  async function canAccessBot(identity, botOrId) {
    if (!identity) return false;
    if (identity.role === "super_admin" || identity.role === "operator") return true;
    const botId = typeof botOrId === "string" ? botOrId : String(botOrId?.id || "");
    if (Array.isArray(identity.allowedBotIds) && (identity.allowedBotIds.includes("*") || identity.allowedBotIds.includes(botId))) {
      return true;
    }
    const botObj =
      botOrId && typeof botOrId === "object"
        ? botOrId
        : botId
          ? await registry.describe(botId).catch(() => null)
          : null;
    try {
      const ok = await Promise.resolve(iamService?.canAccessBot?.(identity.raw || identity, botObj || botId));
      if (typeof ok === "boolean" && ok) return true;
    } catch {}
    if (identity.ownerUid && botObj?.config?.ownerUid && String(botObj.config.ownerUid) === String(identity.ownerUid)) {
      return true;
    }
    return false;
  }

  const requirePerm = (perm) =>
    wrap(async (req, res, next) => {
      const identity = await resolveV5Identity(req);
      if (!identity) {
        return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập để sử dụng Control Plane V5.");
      }
      const allowed = await hasPerm(identity, perm);
      if (!allowed) {
        return sendError(
          res,
          req,
          403,
          "FORBIDDEN_PERMISSION",
          `Vai trò '${identity.role}' không có quyền '${perm}'.`
        );
      }
      return next();
    });

  const requireBotScope = (paramName = "id") =>
    wrap(async (req, res, next) => {
      const identity = await resolveV5Identity(req);
      if (!identity) {
        return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
      }
      const botId = String(req.params?.[paramName] || req.body?.botId || req.query?.botId || "").trim();
      if (botId && botId !== "all") {
        const ok = await canAccessBot(identity, botId);
        if (!ok) {
          return sendError(res, req, 403, "FORBIDDEN_BOT_SCOPE", `Bạn không có quyền truy cập Bot '${botId}'.`);
        }
      }
      return next();
    });

  // ---------------------------------------------------------------------------
  // 1. Public PWA Manifest & Cache-Safe Service Worker
  // ---------------------------------------------------------------------------
  app.get("/manifest.webmanifest", (_req, res) => {
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json({
      name: "MYBOT Control Plane V5",
      short_name: "MYBOT V5",
      description: "Hệ thống Quản trị Đội quân Bot Zalo, Khiên AI, Chiến dịch & SRE Telemetry V5",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#090d16",
      theme_color: "#0ea5e9",
      lang: "vi",
      icons: [
        {
          src: `data:image/svg+xml,${PWA_ICON_SVG}`,
          sizes: "192x192",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
        {
          src: `data:image/svg+xml,${PWA_ICON_SVG}`,
          sizes: "512x512",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
      ],
    });
  });

  app.get("/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Service-Worker-Allowed", "/");
    return res.send(PWA_SERVICE_WORKER_JS);
  });

  // ---------------------------------------------------------------------------
  // 2. Multi-Role Auth Endpoints (/v5-auth/*)
  // ---------------------------------------------------------------------------
  const handleGetAuthSession = wrap(async (req, res) => {
    const identity = await resolveV5Identity(req);
    if (!identity) {
      return sendSuccess(
        res,
        req,
        { authenticated: false, user: null, role: null, permissions: [], csrfToken: null },
        { authenticated: false }
      );
    }
    return sendSuccess(
      res,
      req,
      {
        authenticated: true,
        user: {
          id: identity.id,
          username: identity.username,
          displayName: identity.displayName,
          role: identity.role,
          allowedBotIds: identity.allowedBotIds,
          ownerUid: identity.ownerUid,
          totpEnabled: identity.totpEnabled,
        },
        role: identity.role,
        permissions: identity.permissions,
        csrfToken: identity.csrfToken,
      },
      { authenticated: true }
    );
  });

  const handlePostAuthLogin = wrap(async (req, res) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const userAgent = String(req.headers["user-agent"] || "");
    const payload = {
      username: req.body?.username,
      password: req.body?.password,
      totpCode: req.body?.totpCode ?? req.body?.code ?? req.body?.otp,
      ownerAccessCode:
        req.body?.ownerAccessCode ??
        req.body?.accessCode ??
        req.body?.ownerToken ??
        req.body?.accessToken ??
        req.body?.token,
      ipAddress: ip,
      ip,
      userAgent,
    };

    let authResult;
    try {
      authResult = await Promise.resolve(iamService.authenticate(payload));
    } catch (authErr) {
      if (authErr?.code === "TOTP_REQUIRED") {
        return sendError(res, req, 401, "TOTP_REQUIRED", authErr.message, {
          requires2fa: true,
          data: { authenticated: false, requires2fa: true },
        });
      }
      throw authErr;
    }

    if (authResult?.requires2fa || authResult?.totpRequired) {
      return sendSuccess(res, req, {
        authenticated: false,
        requires2fa: true,
        challengeToken: authResult.challengeToken || null,
        message: "Vui lòng nhập mã xác thực 2 lớp (TOTP 6 chữ số).",
      });
    }

    if (!authResult || authResult.authenticated === false || authResult.ok === false) {
      return sendError(
        res,
        req,
        401,
        authResult?.code || "INVALID_CREDENTIALS",
        authResult?.message || "Thông tin đăng nhập hoặc mã truy cập không hợp lệ."
      );
    }

    const sessionToken =
      authResult.session?.sessionId ||
      authResult.sessionToken ||
      authResult.token ||
      authResult.sessionId ||
      authResult.session?.id;
    const csrfToken =
      authResult.session?.csrfToken ||
      authResult.csrfToken ||
      crypto.randomBytes(24).toString("hex");

    if (sessionToken) {
      setV5SessionCookies(req, res, sessionToken, csrfToken);
    }

    await auditStore?.append?.({
      requestId: req.requestId,
      action: "v5.auth.login",
      actor: authResult.user?.username || payload.username || "owner_token",
      role: authResult.user?.role || "bot_owner",
      ip,
    });

    return sendSuccess(
      res,
      req,
      {
        authenticated: true,
        user: authResult.user || null,
        role: authResult.user?.role || authResult.role || "bot_owner",
        permissions:
          authResult.user?.permissions ||
          authResult.permissions ||
          ROLE_PERMISSIONS?.[authResult.user?.role] ||
          [],
        csrfToken,
        expiresAt: authResult.session?.expiresAt || authResult.expiresAt || null,
      },
      { authenticated: true }
    );
  });

  const handlePostAuthLogout = wrap(async (req, res) => {
    req.cookies ||= parseCookies(req.headers?.cookie || "");
    const sessionToken = req.cookies[V5_SESSION_COOKIE];
    if (sessionToken) {
      await Promise.resolve(iamService?.revokeSession?.(sessionToken)).catch(() => {});
    }
    clearV5SessionCookies(req, res);
    return sendSuccess(res, req, { loggedOut: true });
  });

  const handlePostPublicRedeemVoucher = wrap(async (req, res) => {
    const identity = await resolveV5Identity(req);
    const result = await Promise.resolve(
      crmService.redeemVoucher({
        code: req.body?.code,
        botId: req.body?.botId,
        ownerUid: req.body?.ownerUid || identity?.ownerUid || "",
        actor: identity?.username || "self_service",
      })
    );
    await auditStore?.append?.({
      requestId: req.requestId,
      action: "v5.voucher.redeem",
      code: req.body?.code,
      botId: req.body?.botId,
      actor: identity?.username || "self_service",
    });
    return sendSuccess(res, req, result);
  });

  app.get("/v5-auth/session", ensureReqContext, handleGetAuthSession);
  app.post("/v5-auth/login", ensureReqContext, express.json(), handlePostAuthLogin);
  app.post("/v5-auth/logout", ensureReqContext, handlePostAuthLogout);
  app.post("/v5-auth/redeem-voucher", ensureReqContext, express.json(), handlePostPublicRedeemVoucher);

  // ---------------------------------------------------------------------------
  // 3. V4 Parity Fixes (/api/studio/commands & /api/bots/:id/groups/enable-all)
  // ---------------------------------------------------------------------------
  app.get(
    "/api/studio/commands",
    ensureReqContext,
    wrap(async (req, res) => {
      const studioCatalog = studioService.catalog();
      const defs = commandRegistry?.definitions || [];
      const defMap = new Map(defs.map((d) => [String(d.name || "").toLowerCase(), d]));

      const mergedMap = new Map();
      for (const item of studioCatalog.commands || []) {
        const key = String(item.commandName || "").toLowerCase();
        const def = defMap.get(key);
        mergedMap.set(key, {
          name: item.commandName,
          commandName: item.commandName,
          aliases: item.aliases || def?.aliases || [],
          category: def?.category || "general",
          description: def?.description || "",
          permission: item.permission || def?.permission || "all",
          scope: item.scope || def?.scope || "all",
          executionLane: def?.executionLane || "fast",
          status: item.status || "active",
          adapter: item.adapter || "default-config",
          tabs: item.tabs || [],
        });
      }

      for (const def of defs) {
        const key = String(def.name || "").toLowerCase();
        if (!key || mergedMap.has(key)) continue;
        mergedMap.set(key, {
          name: def.name,
          commandName: def.name,
          aliases: def.aliases || [],
          category: def.category || "general",
          description: def.description || "",
          permission: def.permission || "all",
          scope: def.scope || "all",
          executionLane: def.executionLane || "fast",
          status: "active",
          adapter: "default-config",
          tabs: [],
        });
      }

      const commands = [...mergedMap.values()].sort((a, b) => a.name.localeCompare(b.name));
      return sendSuccess(res, req, {
        total: commands.length,
        commands,
      });
    })
  );

  app.post(
    "/api/bots/:id/groups/enable-all",
    ensureReqContext,
    requireBotScope("id"),
    wrap(async (req, res) => {
      const enabled = Boolean(req.body?.enabled !== false);
      const result = await shieldService.enableAllGroups(req.params.id, enabled);
      return sendSuccess(res, req, result);
    })
  );

  // ---------------------------------------------------------------------------
  // 4. Full /api/v5/* Router (Reusable for both /api/v5 and /v5-portal/api/v5)
  // ---------------------------------------------------------------------------
  const v5Router = express.Router();
  v5Router.use(ensureReqContext);

  // --- IAM & RBAC ---
  v5Router.get("/iam/me", handleGetAuthSession);

  v5Router.get(
    "/iam/users",
    requirePerm("iam:manage"),
    wrap(async (req, res) => {
      const users = await Promise.resolve(iamService.listUsers());
      return sendSuccess(res, req, { users, rolePermissions: ROLE_PERMISSIONS });
    })
  );

  v5Router.post(
    "/iam/users",
    requirePerm("iam:manage"),
    wrap(async (req, res) => {
      const created = await Promise.resolve(iamService.createUser(req.body || {}));
      await auditStore?.append?.({
        requestId: req.requestId,
        action: "v5.iam.user.create",
        targetUser: created?.username || req.body?.username,
      });
      res.status(201);
      return sendSuccess(res, req, created);
    })
  );

  const handleUpdateUser = wrap(async (req, res) => {
    const updated = await Promise.resolve(iamService.updateUser(req.params.id, req.body || {}));
    await auditStore?.append?.({
      requestId: req.requestId,
      action: "v5.iam.user.update",
      targetUserId: req.params.id,
    });
    return sendSuccess(res, req, updated);
  });
  v5Router.put("/iam/users/:id", requirePerm("iam:manage"), handleUpdateUser);
  v5Router.patch("/iam/users/:id", requirePerm("iam:manage"), handleUpdateUser);

  v5Router.delete(
    "/iam/users/:id",
    requirePerm("iam:manage"),
    wrap(async (req, res) => {
      const out = await Promise.resolve(iamService.deleteUser(req.params.id));
      await auditStore?.append?.({
        requestId: req.requestId,
        action: "v5.iam.user.delete",
        targetUserId: req.params.id,
      });
      return sendSuccess(res, req, out ?? { id: req.params.id, deleted: true });
    })
  );

  v5Router.get(
    "/iam/sessions",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      if (!identity) return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
      const sessions = await Promise.resolve(iamService.listSessions(identity));
      return sendSuccess(res, req, { sessions });
    })
  );

  v5Router.delete(
    "/iam/sessions/:sessionId",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      if (!identity) return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
      const out = await Promise.resolve(iamService.revokeSession(req.params.sessionId, identity));
      return sendSuccess(res, req, out ?? { sessionId: req.params.sessionId, revoked: true });
    })
  );

  v5Router.post(
    "/iam/2fa/setup",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      if (!identity) return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
      const targetUserId = req.body?.userId || req.body?.username || identity.id;
      const setup = await Promise.resolve(iamService.setup2fa(targetUserId));
      return sendSuccess(res, req, setup);
    })
  );

  v5Router.post(
    "/iam/2fa/enable",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      if (!identity) return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
      const targetUserId = req.body?.userId || req.body?.username || identity.id;
      const code = req.body?.code ?? req.body?.totpCode ?? "";
      const result = await Promise.resolve(iamService.enable2fa(targetUserId, code));
      return sendSuccess(res, req, result);
    })
  );

  v5Router.post(
    "/iam/2fa/disable",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      if (!identity) return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");
      const targetUserId = req.body?.userId || req.body?.username || identity.id;
      const result = await Promise.resolve(iamService.disable2fa(targetUserId, req.body?.code ?? ""));
      return sendSuccess(res, req, result);
    })
  );

  v5Router.post(
    "/iam/owner-token",
    requirePerm("iam:manage"),
    wrap(async (req, res) => {
      const rawBotIds = Array.isArray(req.body?.botIds)
        ? req.body.botIds
        : req.body?.botId
          ? [req.body.botId]
          : [];
      const tokenInfo = await Promise.resolve(
        iamService.createOwnerAccessToken({
          ...(req.body || {}),
          botIds: rawBotIds,
        })
      );
      await auditStore?.append?.({
        requestId: req.requestId,
        action: "v5.iam.owner_token.create",
        botIds: rawBotIds,
        ownerUid: req.body?.ownerUid,
      });
      return sendSuccess(res, req, tokenInfo);
    })
  );

  // --- Enriched Fleet & Bot Meta / Proxy ---
  v5Router.get(
    "/fleet/enriched",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      if (!identity) return sendError(res, req, 401, "AUTH_REQUIRED", "Vui lòng đăng nhập.");

      const allBots = await registry.list();
      const visibleBots = [];
      for (const b of allBots) {
        if (await canAccessBot(identity, b.id)) {
          const health = computeBotHealthScore(b);
          const meta = await sreService.getBotMeta(b.id);
          visibleBots.push({
            ...b,
            healthScore: health.score,
            healthGrade: health.grade,
            healthDeductions: health.deductions,
            restartCount: health.restartCount,
            meta,
          });
        }
      }

      const avgHealthScore =
        visibleBots.length > 0
          ? Math.round(visibleBots.reduce((acc, b) => acc + b.healthScore, 0) / visibleBots.length)
          : 100;

      return sendSuccess(res, req, {
        total: visibleBots.length,
        online: visibleBots.filter((b) => b.connected).length,
        standby: visibleBots.filter((b) => b.status === "hot_standby" || b.status === "standby").length,
        cookieDead: visibleBots.filter((b) => b.cookieDead).length,
        avgHealthScore,
        bots: visibleBots,
      });
    })
  );

  v5Router.get(
    "/bots/:id/meta",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const meta = await sreService.getBotMeta(req.params.id);
      return sendSuccess(res, req, meta);
    })
  );

  const handleUpdateBotMeta = wrap(async (req, res) => {
    const updated = await sreService.updateBotMeta(req.params.id, req.body || {});
    return sendSuccess(res, req, updated);
  });
  v5Router.put("/bots/:id/meta", requireBotScope("id"), handleUpdateBotMeta);
  v5Router.patch("/bots/:id/meta", requireBotScope("id"), handleUpdateBotMeta);

  v5Router.post(
    "/bots/:id/proxy-test",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const result = await sreService.testBotProxy(req.params.id, req.body?.proxyUrl || "");
      return sendSuccess(res, req, result);
    })
  );

  // --- Operations Center ---
  v5Router.get(
    "/operations",
    wrap(async (req, res) => {
      const operations = await Promise.resolve(
        store.listOperations({
          status: req.query.status || undefined,
          botId: req.query.botId || undefined,
          limit: Number(req.query.limit || 100),
        })
      );
      return sendSuccess(res, req, { operations: Array.isArray(operations) ? operations : [] });
    })
  );

  const handleClearCompletedOps = wrap(async (req, res) => {
    const out = await Promise.resolve(store.clearCompletedOperations());
    return sendSuccess(res, req, out ?? { cleared: true });
  });
  v5Router.delete("/operations/completed", handleClearCompletedOps);
  v5Router.post("/operations/completed", handleClearCompletedOps);

  v5Router.get(
    "/operations/:id",
    wrap(async (req, res) => {
      const op = await Promise.resolve(store.getOperation(req.params.id));
      if (!op) return sendError(res, req, 404, "OPERATION_NOT_FOUND", "Không tìm thấy tiến trình tác vụ.");
      return sendSuccess(res, req, op);
    })
  );

  // --- Notifications Center ---
  v5Router.get(
    "/notifications",
    wrap(async (req, res) => {
      const notifications = await Promise.resolve(
        store.listNotifications({
          unreadOnly: req.query.unreadOnly === "true" || req.query.unread === "1",
          limit: Number(req.query.limit || 100),
        })
      );
      const list = Array.isArray(notifications) ? notifications : [];
      const unreadCount = list.filter((n) => !n.read && !n.readAt).length;
      return sendSuccess(res, req, { unreadCount, notifications: list });
    })
  );

  v5Router.post(
    "/notifications/read-all",
    wrap(async (req, res) => {
      const out = await Promise.resolve(store.markAllNotificationsRead());
      return sendSuccess(res, req, out ?? { markedAll: true });
    })
  );

  v5Router.post(
    "/notifications/:id/read",
    wrap(async (req, res) => {
      const out = await Promise.resolve(store.markNotificationRead(req.params.id));
      return sendSuccess(res, req, out ?? { id: req.params.id, read: true });
    })
  );

  // --- SaaS CRM, Vouchers & Lifecycle ---
  v5Router.get(
    "/crm/summary",
    requirePerm("fleet:read"),
    wrap(async (req, res) => {
      const summary = await Promise.resolve(crmService.getSummary());
      return sendSuccess(res, req, summary);
    })
  );

  const handleUpsertCustomer = wrap(async (req, res) => {
    const ownerUid = String(req.params.ownerUid || req.body?.ownerUid || "").trim();
    const saved = await Promise.resolve(
      crmService.upsertCustomer({
        ...(req.body || {}),
        ownerUid,
      })
    );
    return sendSuccess(res, req, saved);
  });
  v5Router.put("/crm/customers/:ownerUid", requirePerm("crm:manage"), handleUpsertCustomer);
  v5Router.post("/crm/customers/:ownerUid", requirePerm("crm:manage"), handleUpsertCustomer);

  v5Router.get(
    "/crm/vouchers",
    requirePerm("fleet:read"),
    wrap(async (req, res) => {
      const vouchers = await Promise.resolve(crmService.listVouchers(req.query || {}));
      return sendSuccess(res, req, { vouchers: Array.isArray(vouchers) ? vouchers : vouchers?.vouchers || [] });
    })
  );

  v5Router.post(
    "/crm/vouchers/batch",
    requirePerm("crm:manage"),
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const batch = await Promise.resolve(
        crmService.generateVoucherBatch({
          ...(req.body || {}),
          actor: identity?.username || "admin",
        })
      );
      res.status(201);
      return sendSuccess(res, req, batch);
    })
  );

  v5Router.post("/crm/vouchers/redeem", handlePostPublicRedeemVoucher);

  v5Router.delete(
    "/crm/vouchers/:code",
    requirePerm("crm:manage"),
    wrap(async (req, res) => {
      const out = await Promise.resolve(crmService.deleteVoucher(req.params.code));
      return sendSuccess(res, req, out ?? { code: req.params.code, deleted: true });
    })
  );

  v5Router.get(
    "/crm/lifecycle-policy",
    requirePerm("fleet:read"),
    wrap(async (req, res) => {
      const policy = await Promise.resolve(crmService.getLifecyclePolicy());
      return sendSuccess(res, req, policy);
    })
  );

  const handleUpdateLifecyclePolicy = wrap(async (req, res) => {
    const policy = await Promise.resolve(crmService.updateLifecyclePolicy(req.body || {}));
    return sendSuccess(res, req, policy);
  });
  v5Router.put("/crm/lifecycle-policy", requirePerm("crm:manage"), handleUpdateLifecyclePolicy);
  v5Router.post("/crm/lifecycle-policy", requirePerm("crm:manage"), handleUpdateLifecyclePolicy);

  v5Router.post(
    "/crm/sweep",
    requirePerm("crm:manage"),
    wrap(async (req, res) => {
      const report = await Promise.resolve(crmService.runExpirySweep({ dryRun: Boolean(req.body?.dryRun) }));
      return sendSuccess(res, req, report);
    })
  );

  // --- Shields, Presets, Deep Group Rules & Moderation ---
  v5Router.get("/shields/catalog", (req, res) => {
    return sendSuccess(res, req, shieldService.getCatalog());
  });

  v5Router.get(
    "/shields/presets",
    wrap(async (req, res) => {
      const presets = await shieldService.listPresets();
      return sendSuccess(res, req, { presets });
    })
  );

  v5Router.post(
    "/shields/presets",
    wrap(async (req, res) => {
      const saved = await shieldService.savePreset(req.body || {});
      res.status(201);
      return sendSuccess(res, req, saved);
    })
  );

  v5Router.put(
    "/shields/presets/:id",
    wrap(async (req, res) => {
      const saved = await shieldService.savePreset({ ...(req.body || {}), id: req.params.id });
      return sendSuccess(res, req, saved);
    })
  );

  v5Router.delete(
    "/shields/presets/:id",
    wrap(async (req, res) => {
      const out = await shieldService.deletePreset(req.params.id);
      return sendSuccess(res, req, out);
    })
  );

  v5Router.post(
    "/bots/:id/groups/apply-preset",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const out = await shieldService.applyPresetToGroups(req.params.id, {
        presetId: req.body?.presetId,
        customSettings: req.body?.customSettings,
        threadIds: req.body?.threadIds || [],
      });
      return sendSuccess(res, req, out);
    })
  );

  v5Router.get(
    "/bots/:id/groups/:threadId/rules",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const rules = await shieldService.getGroupRules(req.params.id, req.params.threadId);
      return sendSuccess(res, req, rules);
    })
  );

  const handleUpdateGroupRules = wrap(async (req, res) => {
    const payload = req.body?.rules && typeof req.body.rules === "object" ? req.body.rules : req.body || {};
    const updated = await shieldService.updateGroupRules(req.params.id, req.params.threadId, payload);
    return sendSuccess(res, req, updated);
  });
  v5Router.put("/bots/:id/groups/:threadId/rules", requireBotScope("id"), handleUpdateGroupRules);
  v5Router.post("/bots/:id/groups/:threadId/rules", requireBotScope("id"), handleUpdateGroupRules);

  v5Router.get(
    "/moderation/violations",
    wrap(async (req, res) => {
      const violations = await shieldService.listViolations({
        botId: req.query.botId || undefined,
        threadId: req.query.threadId || undefined,
        limit: Number(req.query.limit || 100),
      });
      return sendSuccess(res, req, { violations });
    })
  );

  v5Router.post(
    "/moderation/violations",
    wrap(async (req, res) => {
      const saved = await shieldService.recordViolation(req.body || {});
      res.status(201);
      return sendSuccess(res, req, saved);
    })
  );

  v5Router.delete(
    "/moderation/violations",
    wrap(async (req, res) => {
      const out = await shieldService.clearViolations(req.query.botId || req.body?.botId || null);
      return sendSuccess(res, req, out);
    })
  );

  v5Router.get(
    "/moderation/blacklist",
    wrap(async (req, res) => {
      const blacklist = await shieldService.listBlacklist();
      return sendSuccess(res, req, { blacklist });
    })
  );

  v5Router.post(
    "/moderation/blacklist",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const added = await shieldService.addBlacklist({
        ...(req.body || {}),
        addedBy: identity?.username || "admin",
      });
      res.status(201);
      return sendSuccess(res, req, added);
    })
  );

  v5Router.delete(
    "/moderation/blacklist/:uid",
    wrap(async (req, res) => {
      const out = await shieldService.removeBlacklist(req.params.uid);
      return sendSuccess(res, req, out);
    })
  );

  // --- Media Asset Library & Persistent Campaigns ---
  v5Router.get(
    "/media",
    wrap(async (req, res) => {
      const assets = await campaignService.listMedia();
      return sendSuccess(res, req, { assets });
    })
  );

  v5Router.post(
    "/media",
    express.json({ limit: "40mb" }),
    wrap(async (req, res) => {
      const asset = await campaignService.uploadMedia(req.body || {});
      res.status(201);
      return sendSuccess(res, req, asset);
    })
  );

  v5Router.get(
    "/media/:id/raw",
    wrap(async (req, res) => {
      const { meta, filePath } = await campaignService.getMediaFile(req.params.id);
      res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
      res.setHeader("Content-Length", String(meta.sizeBytes));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.sendFile(filePath);
    })
  );

  v5Router.delete(
    "/media/:id",
    wrap(async (req, res) => {
      const out = await campaignService.deleteMedia(req.params.id);
      return sendSuccess(res, req, out);
    })
  );

  v5Router.post(
    "/campaigns/preview-spintax",
    wrap(async (req, res) => {
      const preview = campaignService.previewSpintax(
        req.body?.text ?? req.body?.textSpintax ?? "",
        req.body?.sampleGroup,
        req.body?.vars || {}
      );
      return sendSuccess(res, req, preview);
    })
  );

  v5Router.get(
    "/campaigns/templates",
    wrap(async (req, res) => {
      const templates = await campaignService.listTemplates();
      return sendSuccess(res, req, { templates });
    })
  );

  v5Router.post(
    "/campaigns/templates",
    wrap(async (req, res) => {
      const saved = await campaignService.saveTemplate(req.body || {});
      res.status(201);
      return sendSuccess(res, req, saved);
    })
  );

  v5Router.put(
    "/campaigns/templates/:id",
    wrap(async (req, res) => {
      const saved = await campaignService.saveTemplate({ ...(req.body || {}), id: req.params.id });
      return sendSuccess(res, req, saved);
    })
  );

  v5Router.delete(
    "/campaigns/templates/:id",
    wrap(async (req, res) => {
      const out = await campaignService.deleteTemplate(req.params.id);
      return sendSuccess(res, req, out);
    })
  );

  v5Router.get(
    "/campaigns",
    wrap(async (req, res) => {
      const campaigns = await campaignService.listCampaigns();
      return sendSuccess(res, req, { campaigns });
    })
  );

  v5Router.post(
    "/campaigns",
    requireBotScope("botId"),
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const created = await campaignService.createCampaign({
        ...(req.body || {}),
        actor: identity?.username || "admin",
      });
      res.status(201);
      return sendSuccess(res, req, created);
    })
  );

  v5Router.get(
    "/campaigns/:id",
    wrap(async (req, res) => {
      const campaign = await campaignService.getCampaign(req.params.id);
      return sendSuccess(res, req, campaign);
    })
  );

  v5Router.delete(
    "/campaigns/:id",
    wrap(async (req, res) => {
      const out = await campaignService.deleteCampaign(req.params.id);
      return sendSuccess(res, req, out);
    })
  );

  v5Router.post(
    "/campaigns/:id/:action",
    wrap(async (req, res) => {
      const { id, action } = req.params;
      switch (action) {
        case "start":
          return sendSuccess(res, req, await campaignService.startCampaign(id, { dryRun: req.body?.dryRun }));
        case "pause":
          return sendSuccess(res, req, await campaignService.pauseCampaign(id));
        case "resume":
          return sendSuccess(res, req, await campaignService.resumeCampaign(id));
        case "cancel":
          return sendSuccess(res, req, await campaignService.cancelCampaign(id));
        case "retry":
        case "retry-failed":
          return sendSuccess(res, req, await campaignService.retryFailedTargets(id));
        default:
          return sendError(res, req, 400, "UNKNOWN_CAMPAIGN_ACTION", `Hành động '${action}' không hợp lệ.`);
      }
    })
  );

  // --- Command Studio V2.5 Simulator & SendTask Test ---
  v5Router.post(
    "/studio/simulate",
    wrap(async (req, res) => {
      const report = await sreService.simulateCommand(req.body || {});
      return sendSuccess(res, req, report);
    })
  );

  v5Router.post(
    "/studio/sendtask-test",
    wrap(async (req, res) => {
      const report = await sreService.testSendTask(req.body || {});
      return sendSuccess(res, req, report);
    })
  );

  // --- SRE Telemetry, Key Pool, Alerts, Auto-Heal & Audit ---
  v5Router.get(
    "/telemetry/series",
    wrap(async (req, res) => {
      const data = await sreService.getTelemetrySeries({
        range: req.query.range || "24h",
        botId: req.query.botId || "all",
      });
      return sendSuccess(res, req, data);
    })
  );

  v5Router.get(
    "/providers/pool",
    requirePerm("sre:manage"),
    wrap(async (req, res) => {
      const pool = await sreService.getKeyPool();
      return sendSuccess(res, req, pool);
    })
  );

  const handleUpdateKeyPool = wrap(async (req, res) => {
    const updated = await sreService.updateKeyPool(req.body || {});
    return sendSuccess(res, req, updated);
  });
  v5Router.put("/providers/pool", requirePerm("sre:manage"), handleUpdateKeyPool);
  v5Router.post("/providers/pool", requirePerm("sre:manage"), handleUpdateKeyPool);

  v5Router.get(
    "/alerts/config",
    requirePerm("sre:manage"),
    wrap(async (req, res) => {
      const cfg = await sreService.getAlertConfig();
      return sendSuccess(res, req, cfg);
    })
  );

  const handleUpdateAlertCfg = wrap(async (req, res) => {
    const cfg = await sreService.updateAlertConfig(req.body || {});
    return sendSuccess(res, req, cfg);
  });
  v5Router.put("/alerts/config", requirePerm("sre:manage"), handleUpdateAlertCfg);
  v5Router.post("/alerts/config", requirePerm("sre:manage"), handleUpdateAlertCfg);

  v5Router.post(
    "/alerts/test",
    requirePerm("sre:manage"),
    wrap(async (req, res) => {
      const result = await sreService.sendTestAlert(req.body?.channel || "all");
      return sendSuccess(res, req, result);
    })
  );

  v5Router.get(
    "/auto-heal/config",
    requirePerm("sre:manage"),
    wrap(async (req, res) => {
      const cfg = await sreService.getAutoHealConfig();
      return sendSuccess(res, req, cfg);
    })
  );

  const handleUpdateAutoHealCfg = wrap(async (req, res) => {
    const cfg = await sreService.updateAutoHealConfig(req.body || {});
    return sendSuccess(res, req, cfg);
  });
  v5Router.put("/auto-heal/config", requirePerm("sre:manage"), handleUpdateAutoHealCfg);
  v5Router.post("/auto-heal/config", requirePerm("sre:manage"), handleUpdateAutoHealCfg);

  v5Router.get(
    "/audit/export",
    requirePerm("logs:read"),
    wrap(async (req, res) => {
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));
      const format = String(req.query.format || "csv").toLowerCase();
      const entries = await auditStore.list({ limit });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");

      if (format === "json") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="mybot-audit-${stamp}.json"`);
        return res.send(`${JSON.stringify({ exportedAt: new Date().toISOString(), total: entries.length, entries }, null, 2)}\n`);
      }

      const headers = ["timestamp", "actor", "action", "botId", "requestId", "details"];
      const lines = [headers.join(",")];
      for (const row of entries) {
        const { timestamp, actor, action, botId, requestId, ...rest } = row || {};
        lines.push(
          [
            csvEscape(timestamp),
            csvEscape(actor),
            csvEscape(action),
            csvEscape(botId || ""),
            csvEscape(requestId || ""),
            csvEscape(Object.keys(rest).length ? rest : ""),
          ].join(",")
        );
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="mybot-audit-${stamp}.csv"`);
      return res.send(`\uFEFF${lines.join("\n")}\n`);
    })
  );

  v5Router.get(
    "/audit",
    requirePerm("logs:read"),
    wrap(async (req, res) => {
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
      let entries = await auditStore.list({ limit });
      const q = String(req.query.q || "").trim().toLowerCase();
      const actor = String(req.query.actor || "").trim().toLowerCase();
      const action = String(req.query.action || "").trim().toLowerCase();
      const botId = String(req.query.botId || "").trim();

      if (actor) entries = entries.filter((e) => String(e.actor || "").toLowerCase().includes(actor));
      if (action) entries = entries.filter((e) => String(e.action || "").toLowerCase().includes(action));
      if (botId) entries = entries.filter((e) => String(e.botId || "") === botId);
      if (q) entries = entries.filter((e) => JSON.stringify(e).toLowerCase().includes(q));

      return sendSuccess(res, req, { total: entries.length, entries });
    })
  );

  // --- Multi-Version Snapshot Disaster Recovery Vault ---
  v5Router.get(
    "/snapshots",
    requirePerm("snapshots:manage"),
    wrap(async (req, res) => {
      const snapshots = await sreService.listSnapshots();
      return sendSuccess(res, req, { snapshots });
    })
  );

  v5Router.post(
    "/snapshots",
    requirePerm("snapshots:manage"),
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const created = await sreService.createSnapshot({
        ...(req.body || {}),
        actor: identity?.username || "admin",
      });
      res.status(201);
      return sendSuccess(res, req, created);
    })
  );

  v5Router.post(
    "/snapshots/preview-restore",
    requirePerm("snapshots:manage"),
    express.json({ limit: "40mb" }),
    wrap(async (req, res) => {
      const preview = await sreService.previewRestore({
        snapshotId: req.body?.snapshotId,
        uploadedBundle: req.body?.uploadedBundle || req.body?.bundle || null,
        password: req.body?.password || "",
      });
      return sendSuccess(res, req, preview);
    })
  );

  v5Router.get(
    "/snapshots/:id/download",
    requirePerm("snapshots:manage"),
    wrap(async (req, res) => {
      const password = String(req.query.password || req.headers["x-snapshot-password"] || "");
      const { filename, bundle } = await sreService.getSnapshotDownload(req.params.id, password);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(`${JSON.stringify(bundle, null, 2)}\n`);
    })
  );

  v5Router.post(
    "/snapshots/:id/restore",
    requirePerm("snapshots:manage"),
    express.json({ limit: "40mb" }),
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const result = await sreService.restoreSnapshot(req.params.id, {
        uploadedBundle: req.body?.uploadedBundle || null,
        modules: req.body?.modules,
        password: req.body?.password || "",
        actor: identity?.username || "admin",
      });
      return sendSuccess(res, req, result);
    })
  );

  v5Router.delete(
    "/snapshots/:id",
    requirePerm("snapshots:manage"),
    wrap(async (req, res) => {
      const out = await sreService.deleteSnapshot(req.params.id);
      return sendSuccess(res, req, out);
    })
  );

  app.use("/api/v5", v5Router);

  // ---------------------------------------------------------------------------
  // 5. Scoped Tenant / Operator Gateway (ALL /v5-portal/*)
  // ---------------------------------------------------------------------------
  const portalRouter = express.Router();
  portalRouter.use(ensureReqContext);
  portalRouter.use(express.json({ limit: "10mb" }));

  portalRouter.use(
    wrap(async (req, res, next) => {
      const identity = await resolveV5Identity(req);
      if (!identity) {
        return sendError(res, req, 401, "AUTH_REQUIRED", "Phiên đăng nhập Cổng Thuê Bao / Vận Hành đã hết hạn.");
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && identity.authSource !== "bearer") {
        const headerToken = String(req.headers["x-csrf-token"] || "");
        const expectedToken = String(identity.csrfToken || req.cookies[V5_CSRF_COOKIE] || "");
        if (!headerToken || !expectedToken || !timingSafeMatch(headerToken, expectedToken)) {
          return sendError(res, req, 403, "CSRF_REQUIRED", "Thiếu hoặc sai mã bảo vệ CSRF (x-csrf-token).");
        }
      }
      return next();
    })
  );

  portalRouter.get(
    "/me",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const allBots = await registry.list();
      const accessibleBots = [];
      for (const b of allBots) {
        if (await canAccessBot(identity, b.id)) {
          const health = computeBotHealthScore(b);
          accessibleBots.push({
            id: b.id,
            displayName: b.displayName || b.name || b.id,
            status: b.status,
            connected: b.connected,
            cookieDead: b.cookieDead,
            expiryAt: b.expiryAt,
            healthScore: health.score,
            healthGrade: health.grade,
          });
        }
      }
      return sendSuccess(res, req, {
        user: {
          id: identity.id,
          username: identity.username,
          displayName: identity.displayName,
          role: identity.role,
          ownerUid: identity.ownerUid,
          totpEnabled: identity.totpEnabled,
        },
        permissions: identity.permissions,
        bots: accessibleBots,
      });
    })
  );

  portalRouter.get(
    "/bots",
    wrap(async (req, res) => {
      const identity = await resolveV5Identity(req);
      const allBots = await registry.list();
      const bots = [];
      for (const b of allBots) {
        if (await canAccessBot(identity, b.id)) {
          const health = computeBotHealthScore(b);
          bots.push({
            ...b,
            healthScore: health.score,
            healthGrade: health.grade,
          });
        }
      }
      return sendSuccess(res, req, { bots });
    })
  );

  portalRouter.get(
    "/bots/:id",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const bot = await registry.describe(req.params.id);
      if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Không tìm thấy Bot.");
      const health = computeBotHealthScore(bot);
      return sendSuccess(res, req, { ...bot, healthScore: health.score, healthGrade: health.grade });
    })
  );

  portalRouter.post(
    "/bots/:id/actions/:action",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const { id, action } = req.params;
      if (!["start", "stop", "restart"].includes(action)) {
        return sendError(res, req, 400, "UNSUPPORTED_PORTAL_ACTION", "Hành động không được phép trên Cổng Thuê Bao.");
      }
      if (!actions?.[action]) {
        return sendError(res, req, 501, "ACTION_UNAVAILABLE", "Bộ điều khiển tiến trình chưa sẵn sàng.");
      }
      const result = await actions[action](id, req.body || {});
      return sendSuccess(res, req, result);
    })
  );

  portalRouter.get(
    "/bots/:id/qr",
    requireBotScope("id"),
    wrap(async (req, res) => {
      if (!qrSessionManager) {
        return sendSuccess(res, req, { state: "idle", botId: req.params.id });
      }
      const status =
        typeof qrSessionManager.status === "function"
          ? await qrSessionManager.status(req.params.id)
          : await qrSessionManager.get?.(req.params.id);
      return sendSuccess(res, req, status || { state: "idle", botId: req.params.id });
    })
  );

  portalRouter.post(
    "/bots/:id/qr/start",
    requireBotScope("id"),
    wrap(async (req, res) => {
      if (!qrSessionManager?.start) {
        return sendError(res, req, 501, "QR_UNAVAILABLE", "Trình quét QR trực tuyến chưa được kích hoạt.");
      }
      const session = await qrSessionManager.start(req.params.id, req.body || {});
      return sendSuccess(res, req, session);
    })
  );

  portalRouter.post(
    "/bots/:id/qr/cancel",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const out = await qrSessionManager?.cancel?.(req.params.id);
      return sendSuccess(res, req, out || { cancelled: true });
    })
  );

  portalRouter.get(
    "/bots/:id/groups",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const botId = req.params.id;
      const bot = await registry.describe(botId);
      if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Không tìm thấy Bot.");

      const gsPath =
        bot.paths?.groupSettingsPath ||
        (botId === "admin"
          ? path.join(root, "assets", "data", "group_settings.json")
          : path.join(root, "mybot", "bots", `group_settings_${botId}.json`));
      const savedMap = await readJsonSafe(gsPath, {});
      const liveGroups = new Map();
      const port = Number(bot.port || bot.webPort || (botId === "admin" ? 2000 : 0));
      const reachable = bot.connected ? true : await probeLoopbackPort(port);

      if (reachable && port > 0 && !bot.cookieDead) {
        try {
          const secret = getInternalSecret({ projectRoot: root });
          const resp = await fetch(`http://127.0.0.1:${port}/internal/runtime/groups`, {
            headers: { "x-internal-secret": secret },
            signal: AbortSignal.timeout(3000),
          });
          if (resp.ok) {
            const payload = await resp.json().catch(() => ({}));
            for (const g of payload?.groups || []) {
              if (g?.threadId) liveGroups.set(String(g.threadId), g);
            }
          }
        } catch {}
      }

      const allIds = new Set([...liveGroups.keys(), ...Object.keys(savedMap || {})]);
      const groups = [...allIds].map((tid) => {
        const live = liveGroups.get(tid);
        const saved = savedMap?.[tid] || {};
        const normalized = normalizeUnifiedGroupSettings(saved);
        return {
          threadId: tid,
          name: live?.name || saved?.nameGroup || saved?.name || `Nhóm ${tid}`,
          memberCount: Number(live?.memberCount || saved?.memberCount || 0),
          avatar: live?.avatar || "",
          activeBot: normalized.activeBot,
          enableBot: normalized.enableBot,
          settings: normalized,
        };
      });

      return sendSuccess(res, req, { botId, online: Boolean(reachable && !bot.cookieDead), groups });
    })
  );

  portalRouter.put(
    "/bots/:id/groups/:threadId/settings",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const botId = req.params.id;
      const threadId = String(req.params.threadId || "").trim();
      const bot = await registry.describe(botId);
      if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Không tìm thấy Bot.");

      const gsPath =
        bot.paths?.groupSettingsPath ||
        (botId === "admin"
          ? path.join(root, "assets", "data", "group_settings.json")
          : path.join(root, "mybot", "bots", `group_settings_${botId}.json`));
      const allSettings = await readJsonSafe(gsPath, {});
      const prev = allSettings?.[threadId] && typeof allSettings[threadId] === "object" ? allSettings[threadId] : {};
      const patch = req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : req.body || {};
      const merged = normalizeUnifiedGroupSettings({ ...prev, ...patch });
      allSettings[threadId] = merged;
      await configStore.writeJson(gsPath, allSettings);
      try {
        writeReloadRequest(botId, { reloadType: "command-config" });
      } catch {}
      return sendSuccess(res, req, { botId, threadId, settings: merged });
    })
  );

  portalRouter.post(
    "/bots/:id/groups/enable-all",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const out = await shieldService.enableAllGroups(req.params.id, Boolean(req.body?.enabled !== false));
      return sendSuccess(res, req, out);
    })
  );

  portalRouter.post(
    "/bots/:id/groups/apply-preset",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const out = await shieldService.applyPresetToGroups(req.params.id, req.body || {});
      return sendSuccess(res, req, out);
    })
  );

  portalRouter.get(
    "/bots/:id/groups/:threadId/rules",
    requireBotScope("id"),
    wrap(async (req, res) => {
      return sendSuccess(res, req, await shieldService.getGroupRules(req.params.id, req.params.threadId));
    })
  );

  portalRouter.put(
    "/bots/:id/groups/:threadId/rules",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const rules = req.body?.rules && typeof req.body.rules === "object" ? req.body.rules : req.body || {};
      return sendSuccess(res, req, await shieldService.updateGroupRules(req.params.id, req.params.threadId, rules));
    })
  );

  portalRouter.get(
    "/bots/:id/logs",
    requireBotScope("id"),
    wrap(async (req, res) => {
      const logs = await readLogs({
        root,
        botId: req.params.id,
        lines: Math.min(300, Math.max(20, Number(req.query.lines || 120))),
      });
      return sendSuccess(res, req, logs);
    })
  );

  portalRouter.get("/shields/catalog", (req, res) => {
    return sendSuccess(res, req, {
      shields: CANONICAL_SHIELDS,
      ...shieldService.getCatalog(),
    });
  });

  portalRouter.get(
    "/shields/presets",
    wrap(async (req, res) => {
      return sendSuccess(res, req, { presets: await shieldService.listPresets() });
    })
  );

  portalRouter.post("/vouchers/redeem", handlePostPublicRedeemVoucher);

  // Allow operators/resellers/auditors to access V5 endpoints via /v5-portal/v5/* or /v5-portal/api/v5/*
  portalRouter.use("/v5", v5Router);
  portalRouter.use("/api/v5", v5Router);

  app.use("/v5-portal", portalRouter);

  return v5;
}
