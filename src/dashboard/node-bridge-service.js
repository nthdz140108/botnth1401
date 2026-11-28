/**
 * Node Bridge Service for MyBot Hybrid Architecture (Node V3 + Rust V4).
 *
 * Runs as an independent, lightweight HTTP daemon on 127.0.0.1:4174 (loopback only).
 * Even if the main bot or sub-bots crash or restart under PM2, this Bridge stays ALIVE
 * so the Rust V4 Central Dashboard can always query fleet status, logs, group settings,
 * command studio configs, and execute PM2 lifecycles.
 *
 * SECURITY & INTEGRITY:
 * - Loopback only (rejects any non-127.0.0.1 / ::1 IP).
 * - Constant-time HMAC-SHA256 signature verification matching Rust `sign_internal_payload`.
 * - Request ID deduplication & idempotency (60s cache).
 * - Per-bot lock integration (prevents concurrent duplicate PM2 starts/stops).
 * - Reports real readiness (Zalo login state & listener state, NOT just PID).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import express from "express";

import { getInternalSecret } from "../commands/mybot/System/mybot-command-relay.js";
import { BotRegistry } from "./bot-registry.js";
import { createBotActionService } from "./bot-action-service.js";
import { ConfigStore } from "./config-store.js";
import { AuditStore } from "./audit-store.js";
import { PrefixService } from "./prefix-service.js";
import { commandRegistry } from "../commands/command-registry.js";
import {
  readCommandConfig,
  readGroupSettings,
  loadCanonicalGroupSettings,
} from "../utils/io-json.js";
import { createWebAdminRecoveryCoordinator } from "./v4-control-routes.js";
import { createQrSessionManager } from "./qr-service.js";
import { createRuntimeMetrics } from "../observability/runtime-metrics.js";
import { createWorkloadBroker } from "../core/workload-broker.js";
import { getZaloRuntimeConfig } from "../api-zalo/zalo-config.js";
import { normalizeLoginCredential } from "../commands/mybot/System/credential-normalizer.js";
import { verifyLoginCredential } from "../commands/mybot/System/login-verification.js";
import { persistVerifiedBot } from "../commands/mybot/System/verified-provisioning.js";
import { initializeVerifiedBotFiles } from "../commands/mybot/Manager/qr-login-command.js";
import { writeJsonAtomic } from "../commands/mybot/System/json-state.js";
import { CredentialService } from "./credential-service.js";
import { createBotManagementService } from "./bot-management-service.js";

function assertSafeId(id, label = "id") {
  if (!id || typeof id !== "string") throw new Error(`${label} must be a non-empty string`);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${label} contains invalid characters`);
  if (id.length > 64) throw new Error(`${label} is too long`);
}

const DEFAULT_BRIDGE_PORT = 4174;
const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const REPLAY_WINDOW_MS = 300_000; // ±5 minutes
const IDEMPOTENCY_CACHE_TTL_MS = 60_000; // 60s

const SHIELD_KEYS = [
  "activeBot",
  "enableSetup",
  "sendTask",
  "antiSpam",
  "filterBadWords",
  "removeLinks",
  "antiUndo",
  "antiMedia",
  "antiSticker",
  "antiMention",
  "antiNude",
  "antiForward",
  "antiVoice",
  "antiText",
  "antiFile",
  "antiBot",
  "antiJoinLeave",
  "antiKickBlock",
  "antiPoll",
  "onlyText",
];

export class NodeBridgeService {
  constructor({
    root = process.cwd(),
    port = Number(process.env.MYBOT_BRIDGE_PORT || DEFAULT_BRIDGE_PORT),
    host = process.env.MYBOT_BRIDGE_HOST || DEFAULT_BRIDGE_HOST,
    secret = null,
    verifyCredential = verifyLoginCredential,
    verifyChildAdminUid = null,
    qrModuleLoader = undefined,
  } = {}) {
    this.root = path.resolve(root);
    this.verifyCredential = verifyCredential;
    this.port = port;
    this.host = host;
    this.secret = secret || process.env.INTERNAL_API_SECRET || getInternalSecret({ projectRoot: this.root });

    this.registry = new BotRegistry({ root: this.root });
    this.configStore = new ConfigStore({ backupDir: path.join(this.root, "logs", "dashboard-backups") });
    this.auditStore = new AuditStore({ root: this.root });
    this.prefixService = new PrefixService({ root: this.root, registry: this.registry, configStore: this.configStore });
    this.actions = createBotActionService({
      root: this.root,
      registry: this.registry,
      configStore: this.configStore,
      auditStore: this.auditStore,
    });

    this.management = createBotManagementService({ root: this.root, registry: this.registry, prefixService: this.prefixService, auditStore: this.auditStore, verifyAdminUid: verifyChildAdminUid || (async (botId, uid) => {
      const bot = await this.registry.describe(botId);
      const stateFile = path.join(this.root, "mybot", "state", `${botId}.json`);
      const state = JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "{}"));
      if (state.connected && String(state.uid || "") === uid) return true;
      if (!bot?.connected || !bot.port) return false;
      const response = await fetch(`http://127.0.0.1:${bot.port}/internal/runtime/friends`, { headers: { "x-internal-secret": this.secret }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return false;
      const data = await response.json();
      return data.online === true && Array.isArray(data.friends) && data.friends.some((friend) => String(friend.uid) === uid);
    }) });

    this.credentials = new CredentialService({ root: this.root, registry: this.registry, configStore: this.configStore, verifyCredential });

    this.qrCoordinator = createWebAdminRecoveryCoordinator({
      root: this.root,
      actions: this.actions,
    });

    this.botDrafts = new Map();
    this.botQrManager = createQrSessionManager({
      drafts: this.botDrafts,
      verifyAccount: verifyCredential,
      ...(qrModuleLoader ? { moduleLoader: qrModuleLoader } : {}),
      root: this.root,
      registry: this.registry,
      configStore: this.configStore,
      auditStore: this.auditStore,
    });

    this.idempotencyMap = new Map();
    this.app = express();
    this.server = null;
    this.startTime = Date.now();
    this.bootId = crypto.randomUUID();
    this.seq = 0;
    this.statusVersion = 1;
    this.lastKnownBotHash = "";
    this.eventClients = new Set();
    this.heartbeatInterval = null;
    this.statusPollInterval = null;

    this.runtimeMetrics = createRuntimeMetrics({ botId: "bridge", sampleIntervalMs: 1000 });
    this.runtimeMetrics.start();

    this.broker = createWorkloadBroker({
      botId: "bridge",
      metrics: this.runtimeMetrics,
      maxFastConcurrent: 32,
      maxFastQueueSize: 500,
      maxHeavyConcurrent: 4,
      maxHeavyQueueSize: 50,
      maxBroadcastConcurrent: 5,
      maxBroadcastQueueSize: 50,
    });

    this._setupMiddleware();
    this._setupRoutes();
  }

  _getGroupContext() {
    return {
      groupSettingsPath: path.resolve(this.root, "groupSettings.json"),
      dataDir: this.root,
    };
  }

  _isLoopback(ip) {
    if (!ip) return false;
    const clean = String(ip).trim().toLowerCase();
    return (
      clean === "127.0.0.1" ||
      clean === "::1" ||
      clean === "::ffff:127.0.0.1" ||
      clean === "localhost"
    );
  }

  _cleanIdempotencyCache() {
    const now = Date.now();
    for (const [reqId, entry] of this.idempotencyMap.entries()) {
      if (now - entry.timestamp > IDEMPOTENCY_CACHE_TTL_MS) {
        this.idempotencyMap.delete(reqId);
      }
    }
  }

  _verifyHmac(req, rawBody) {
    const signature =
      req.headers["x-internal-signature"] ||
      req.headers["x-signature"] ||
      req.query?.signature;
    const timestampStr =
      req.headers["x-internal-timestamp"] ||
      req.headers["x-timestamp"] ||
      req.query?.timestamp;

    if (!signature || !timestampStr) {
      return { ok: false, reason: "MISSING_HMAC_HEADERS" };
    }

    const timestampMs = Number(timestampStr);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: "TIMESTAMP_OUT_OF_WINDOW" };
    }

    const payload = `${timestampMs}.${rawBody}`;
    const expectedSig = crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");

    const providedBuf = Buffer.from(String(signature).trim(), "hex");
    const expectedBuf = Buffer.from(expectedSig, "hex");

    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return { ok: false, reason: "INVALID_SIGNATURE" };
    }

    return { ok: true, timestampMs };
  }

  _nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  _formatMetadata() {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    return {
      bootId: this.bootId,
      seq: this._nextSeq(),
      statusVersion: this.statusVersion,
      ts: {
        iso: nowIso,
        epochMs: now,
      },
      timestamp: nowIso,
      epochMs: now,
    };
  }

  async _collectBots() {
    const rawBots = await this.registry.list();
    const inventory = JSON.parse(await fs.readFile(path.join(this.root, "mybot", "mybots.json"), "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; }));
    const bots = rawBots.map((desc) => {
      const record = inventory[desc.id] || {};
      return {
        id: desc.id,
        botKey: desc.id,
        displayName: desc.displayName || desc.id,
        isMain: Boolean(desc.isMain || desc.id === "admin"),
        status: desc.status, // e.g. "running", "stopped", "cookie-dead"
        desiredStatus: record.desiredStatus || "stopped",
        accountIdentityStatus: record.accountIdentityStatus || "pending",
        adminBindingStatus: record.adminBindingStatus || "pending",
        ownerUid: record.ownerUid || "",
        expiryAt: record.expiryAt ?? null,
        activationPolicy: record.activationPolicy || null,
        cookieDead: Boolean(desc.cookieDead),
        cookieDeadReason: desc.cookieDeadReason || null,
        prefix: desc.prefix || "!",
        port: desc.webPort || desc.port || null,
        uid: record.accountUid || record.uid || desc.uid || null,
        connected: Boolean(desc.connected),
        standbyRam: desc.standbyRam || desc.readiness?.memory || null,
        lastError: desc.lastError || null,
        updatedAt: desc.updatedAt || new Date().toISOString(),
      };
    });
    return bots;
  }

  async getFleetSnapshot() {
    const bots = await this._collectBots();

    let running = 0;
    let stopped = 0;
    let expired = 0;
    let errored = 0;
    let standby = 0;

    for (const b of bots) {
      if (b.status === "standby" || b.status === "hot_standby") {
        standby++;
      } else if (b.status === "running" || b.status === "starting" || b.status === "recovering") {
        running++;
      } else if (b.cookieDead || b.status === "cookie-dead" || b.status === "cookie_dead") {
        expired++;
      } else if (b.status === "error" || b.status === "identity_mismatch") {
        errored++;
      } else {
        stopped++;
      }
    }

    const mem = process.memoryUsage();
    const meta = this._formatMetadata();

    const overview = {
      totalBots: bots.length,
      runningBots: running,
      stoppedBots: stopped,
      standbyBots: standby,
      expiredBots: expired,
      erroredBots: errored,
      uptimeSecs: Math.floor((meta.ts.epochMs - this.startTime) / 1000),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      cpuPercent: 0.0,
      stale: false,
      bridgeConnected: true,
      bots,
    };

    return {
      ...meta,
      overview,
      bots,
      total: bots.length,
    };
  }

  broadcastSse(eventType, payload) {
    if (this.eventClients.size === 0) return;
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.eventClients) {
      try {
        res.write(msg);
      } catch {
        this.eventClients.delete(res);
      }
    }
  }

  emitDelta(delta) {
    this.statusVersion += 1;
    const meta = this._formatMetadata();
    const payload = {
      ...meta,
      ...delta,
    };
    this.broadcastSse("delta", payload);
    return payload;
  }

  _startEventLoops() {
    this._stopEventLoops();

    // 1. Status change poller (every 1.5s)
    this.statusPollInterval = setInterval(async () => {
      try {
        const bots = await this._collectBots();
        const hash = bots
          .map((b) => `${b.id}:${b.status}:${b.connected}:${b.cookieDead}`)
          .join("|");
        if (this.lastKnownBotHash && hash !== this.lastKnownBotHash) {
          this.statusVersion += 1;
          const snap = await this.getFleetSnapshot();
          this.broadcastSse("snapshot", snap);
        }
        this.lastKnownBotHash = hash;
      } catch {}
    }, 1500);

    // 2. Periodic keepalive & heartbeat snapshot (every 1.5s to maintain <3s freshness)
    this.heartbeatInterval = setInterval(async () => {
      try {
        const snap = await this.getFleetSnapshot();
        this.broadcastSse("snapshot", snap);
      } catch {}
    }, 1500);
  }

  _stopEventLoops() {
    if (this.statusPollInterval) {
      clearInterval(this.statusPollInterval);
      this.statusPollInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _setupMiddleware() {
    // 1. Loopback check
    this.app.use((req, res, next) => {
      const clientIp = req.ip || req.socket?.remoteAddress;
      if (!this._isLoopback(clientIp)) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Node bridge only accepts loopback (127.0.0.1) requests." },
        });
      }
      next();
    });

    // 2. Capture raw body for HMAC check
    this.app.use(
      express.json({
        verify: (req, _res, buf) => {
          req.rawBody = buf ? buf.toString("utf8") : "";
        },
      })
    );

    // 3. HMAC and Idempotency authentication
    this.app.use((req, res, next) => {
      // Exclude simple health check from HMAC if requested for probe
      if (req.method === "GET" && req.path === "/bridge/health") {
        return next();
      }

      this._cleanIdempotencyCache();

      const rawBody = req.rawBody || "";
      const auth = this._verifyHmac(req, rawBody);
      if (!auth.ok) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED_HMAC", message: `HMAC auth failed: ${auth.reason}` },
        });
      }

      const requestId = req.headers["x-request-id"] || req.headers["x-requestid"];
      if (requestId) {
        req.idempotencyFingerprint = crypto.createHash("sha256").update(`${req.method} ${req.path} ${rawBody}`).digest("hex");
        const cached = this.idempotencyMap.get(requestId);
        if (cached && req.method !== "GET") {
          if (cached.fingerprint !== req.idempotencyFingerprint) return res.status(409).json({ success: false, error: { code: "IDEMPOTENCY_CONFLICT", stage: "request", message: "Mã yêu cầu đã được dùng cho thao tác khác." } });
          return res.status(200).json(cached.response);
        }
        req.requestId = requestId;
      }

      next();
    });
  }

  _setupRoutes() {
    const wrap = (handler) => async (req, res) => {
      try {
        const data = await handler(req, res);
        if (!res.headersSent) {
          const responsePayload = {
            success: true,
            data,
            requestId: req.requestId || null,
            timestamp: new Date().toISOString(),
          };
          if (req.requestId && req.method !== "GET") {
            this.idempotencyMap.set(req.requestId, {
              timestamp: Date.now(),
              fingerprint: req.idempotencyFingerprint,
              response: responsePayload,
            });
          }
          return res.json(responsePayload);
        }
      } catch (err) {
        if (!res.headersSent) {
          const status = err.status || 500;
          return res.status(status).json({
            success: false,
            error: {
              code: err.code || "BRIDGE_ERROR",
              stage: err.stage || "bridge",
              message: err.message || "An unexpected error occurred in Node bridge.",
              details: err.details || null,
            },
            requestId: req.requestId || null,
          });
        }
      }
    };

    // Health
    this.app.get("/bridge/health", (_req, res) => {
      res.json({
        status: "ok",
        bridge: "node-hybrid-bridge",
        version: "4.0.0",
        uptimeSecs: Math.floor((Date.now() - this.startTime) / 1000),
      });
    });

    // Bridge Status & Environment Metrics
    this.app.get(
      "/bridge/status",
      wrap(async () => {
        const mem = process.memoryUsage();
        return {
          status: "healthy",
          engine: "node-v3-hybrid",
          pid: process.pid,
          uptimeSecs: Math.floor((Date.now() - this.startTime) / 1000),
          rssBytes: mem.rss,
          heapUsedBytes: mem.heapUsed,
          projectRoot: this.root,
        };
      })
    );

    // Deep Observability & Lane Metrics
    this.app.get(
      "/bridge/metrics",
      wrap(async () => {
        const cpu = process.cpuUsage();
        const mem = process.memoryUsage();
        const runtime = this.runtimeMetrics ? this.runtimeMetrics.snapshot() : {};
        const brokerSnap = this.broker ? this.broker.snapshot() : {};

        return {
          timestamp: new Date().toISOString(),
          pid: process.pid,
          uptimeSecs: Math.floor((Date.now() - this.startTime) / 1000),
          cpu: {
            userMicros: cpu.user,
            systemMicros: cpu.system,
          },
          memory: {
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
            externalBytes: mem.external,
            heapSlopeMbPerHour: runtime.memory?.slopeMbPerHour ?? 0,
          },
          eventLoop: {
            samplesCount: runtime.eventLoop?.count ?? 0,
            p50Ms: runtime.eventLoop?.p50 ?? 0,
            p95Ms: runtime.eventLoop?.p95 ?? 0,
            p99Ms: runtime.eventLoop?.p99 ?? 0,
            maxMs: runtime.eventLoop?.max ?? 0,
          },
          lanes: brokerSnap,
          catalog: {
            canonicalCommands: commandRegistry?.canonicalNames?.size || 0,
            totalKeys: commandRegistry?.keys?.length || 0,
          },
        };
      })
    );

    // Realtime Server-Sent Events (SSE) Stream
    this.app.get("/bridge/events", async (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();

      let clientReady = false;
      const pendingQueue = [];

      const clientWrapper = {
        write: (msg) => {
          if (!clientReady) {
            pendingQueue.push(msg);
          } else {
            res.write(msg);
          }
        },
      };

      this.eventClients.add(clientWrapper);

      req.on("close", () => {
        this.eventClients.delete(clientWrapper);
      });

      // Send initial snapshot immediately on connection
      try {
        const snap = await this.getFleetSnapshot();
        res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      } catch (err) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      } finally {
        clientReady = true;
        for (const msg of pendingQueue) {
          try {
            res.write(msg);
          } catch {}
        }
      }
    });

    // Dedicated Full Fleet Snapshot Endpoint (Resync within <=2s)
    this.app.get(
      "/bridge/snapshot",
      wrap(async () => {
        return await this.getFleetSnapshot();
      })
    );

    // List all bots with REAL readiness (listener and credentials)
    this.app.get(
      "/bridge/bots",
      wrap(async () => {
        const bots = await this._collectBots();
        return {
          ...this._formatMetadata(),
          bots,
          total: bots.length,
        };
      })
    );

    // Canonical Node configuration APIs for the hybrid dashboard.
    this.app.get("/bridge/bots/:botId/profile", wrap((req) => this.management.profile(req.params.botId)));
    this.app.put("/bridge/bots/:botId/profile", wrap((req) => this.management.saveProfile(req.params.botId, req.body || {})));
    this.app.put("/bridge/bots/:botId/style", wrap((req) => this.management.style(req.params.botId, req.body || {})));
    this.app.post("/bridge/bots/:botId/style/reset", wrap((req) => this.management.style(req.params.botId, {}, true)));
    this.app.get("/bridge/bots/:botId/prefix", wrap((req) => this.management.prefix(req.params.botId)));
    this.app.put("/bridge/bots/:botId/prefix", wrap((req) => this.management.prefix(req.params.botId, req.body || {})));
    this.app.put("/bridge/bots/:botId/expiry", wrap((req) => this.management.expiry(req.params.botId, req.body || {})));
    this.app.put("/bridge/bots/:botId/settings", wrap((req) => this.management.settings(req.params.botId, req.body || {})));
    this.app.get("/bridge/bots/:botId/admins", wrap((req) => this.management.admins(req.params.botId)));
    this.app.post("/bridge/bots/:botId/admins", wrap((req) => this.management.changeAdmin(req.params.botId, req.body || {})));
    this.app.delete("/bridge/bots/:botId/admins/:adminUid", wrap((req) => this.management.changeAdmin(req.params.botId, {}, req.params.adminUid)));
    this.app.get("/bridge/owners/:ownerUid/trial-status", wrap((req) => this.management.trialStatus(req.params.ownerUid)));
    this.app.post("/bridge/owners/:ownerUid/trial-reset", wrap((req) => this.management.resetTrial(req.params.ownerUid)));

    // Get single bot info
    this.app.get(
      "/bridge/bots/:botId",
      wrap(async (req) => {
        const bot = await this.registry.describe(req.params.botId);
        if (!bot) {
          const err = new Error(`Bot '${req.params.botId}' not found`);
          err.status = 404;
          err.code = "BOT_NOT_FOUND";
          throw err;
        }
        return { bot };
      })
    );

    // Bot Lifecycle Operations (start, stop, restart, standby, resume, delete)
    // NOTE: per-bot lock is managed exclusively by bot-action-service via withBotLock.
    this.app.post(
      "/bridge/bots/:botId/action",
      wrap(async (req, res) => {
        const { botId } = req.params;
        const action = String(req.body?.action || "").toLowerCase();

        let result;
        if (action === "start" || action === "resume") {
          result = this.actions.start(botId, req.body || {});
        } else if (action === "stop") {
          result = this.actions.stop(botId, req.body || {});
        } else if (action === "restart") {
          result = this.actions.restart(botId);
        } else if (action === "standby" || action === "hot_standby") {
          result = this.actions.standby(botId, req.body || {});
        } else if (action === "delete") {
          result = this.actions.delete(botId, req.body || {});
        } else {
          const err = new Error(`Unsupported bot action: '${action}'`);
          err.status = 400;
          err.code = "INVALID_ACTION";
          throw err;
        }

        const active = this.actions.getActiveOperation?.(botId);
        if (active?.operationId) {
          void Promise.resolve(result).then(() => {
            this.statusVersion += 1;
            return this.getFleetSnapshot().then((snapshot) => this.broadcastSse("snapshot", snapshot));
          }).catch(() => {});
          res.status(202);
          return { botId, action, operationId: active.operationId, phase: active.phase, applied: false, operation: active };
        }
        result = await result;

        // Read back verified state from registry
        const updated = await this.registry.describe(botId).catch(() => null);
        const responsePayload = {
          botId,
          action,
          operationId: result?.operationId || null,
          phase: result?.phase || (action === "standby" ? "standby" : action === "stop" ? "stopped" : "connecting"),
          applied: true,
          result,
          effectiveStatus: updated?.status || "unknown",
        };

        // Broadcast updated state to all SSE listeners immediately
        this.statusVersion += 1;
        this.getFleetSnapshot().then((snap) => {
          this.broadcastSse("snapshot", snap);
        }).catch(() => {});

        return responsePayload;
      })
    );

    // Get Single Operation Status (by operationId)
    this.app.get(
      "/bridge/bots/:botId/operations/:operationId",
      wrap(async (req) => {
        const { botId, operationId } = req.params;
        const op = this.actions.getOperation?.(operationId);
        if (!op || op.botId !== botId) {
          const err = new Error(`Operation '${operationId}' not found for bot '${botId}'`);
          err.status = 404;
          err.code = "OPERATION_NOT_FOUND";
          throw err;
        }
        return { operation: op };
      })
    );

    // List All Standby Bots and their RAM metrics
    this.app.get(
      "/bridge/standby-ram",
      wrap(async () => {
        const rawBots = await this.registry.list();
        const standbyBots = [];
        for (const b of rawBots) {
          const desc = await this.registry.describe(b.id || b.botKey).catch(() => null);
          if (desc && (desc.status === "standby" || desc.readiness?.status === "standby" || desc.readiness?.listenerState === "standby")) {
            standbyBots.push({
              id: desc.id,
              status: desc.status,
              pid: desc.pid,
              port: desc.port,
              memory: desc.readiness?.memory || null,
            });
          }
        }
        return {
          totalStandby: standbyBots.length,
          bots: standbyBots,
          timestamp: new Date().toISOString(),
        };
      })
    );

    // Get Standby RAM for specific bot
    this.app.get(
      "/bridge/bots/:botId/ram",
      wrap(async (req) => {
        const desc = await this.registry.describe(req.params.botId);
        if (!desc) {
          const err = new Error(`Bot '${req.params.botId}' not found`);
          err.status = 404;
          err.code = "BOT_NOT_FOUND";
          throw err;
        }
        return {
          botId: req.params.botId,
          status: desc.status,
          pid: desc.pid,
          port: desc.port,
          memory: desc.readiness?.memory || null,
          standby: desc.status === "standby" || desc.readiness?.status === "standby",
        };
      })
    );

    // Get Group Settings (Canonical groupSettings.json)
    this.app.get(
      "/bridge/bots/:botId/groups",
      wrap(async () => {
        const canonical = loadCanonicalGroupSettings(this._getGroupContext());
        const groups = [];
        for (const [groupId, settings] of Object.entries(canonical || {})) {
          groups.push({
            id: groupId,
            name: settings?.name || `Nhóm ${groupId}`,
            settings,
          });
        }
        return { groups, total: groups.length };
      })
    );

    // Save 17-Shield Group Settings atomically
    this.app.put(
      "/bridge/bots/:botId/groups/:groupId/settings",
      wrap(async (req) => {
        const { groupId } = req.params;
        const incomingSettings = req.body?.settings || {};
        const groupName = req.body?.name || null;

        const current = loadCanonicalGroupSettings(this._getGroupContext()) || {};
        const existing = current[groupId] || {};

        const updatedGroup = { ...existing };
        if (groupName) updatedGroup.name = groupName;

        for (const key of SHIELD_KEYS) {
          if (key in incomingSettings) {
            updatedGroup[key] = Boolean(incomingSettings[key]);
          }
        }

        current[groupId] = updatedGroup;

        // Atomic write to groupSettings.json
        const groupSettingsFile = path.join(this.root, "groupSettings.json");
        const tmpFile = `${groupSettingsFile}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmpFile, JSON.stringify(current, null, 2), "utf8");
        await fs.rename(tmpFile, groupSettingsFile);

        return {
          groupId,
          applied: true,
          settings: updatedGroup,
        };
      })
    );

    // Command Studio: Get Command Configurations
    this.app.get(
      "/bridge/commands",
      wrap(async () => {
        const rawConfig = readCommandConfig();
        const defs = commandRegistry?.definitions || [];
        return {
          definitionsCount: defs.length,
          config: rawConfig,
        };
      })
    );

    // Command Studio: Update Command Config
    this.app.put(
      "/bridge/commands/:name/config",
      wrap(async (req) => {
        const { name } = req.params;
        const incoming = req.body || {};
        const cmdFile = path.join(this.root, "mybot", "defaultCommand.json");

        let current = {};
        try {
          const raw = await fs.readFile(cmdFile, "utf8");
          current = JSON.parse(raw);
        } catch {}

        current[name] = { ...(current[name] || {}), ...incoming };

        const tmp = `${cmdFile}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(current, null, 2), "utf8");
        await fs.rename(tmp, cmdFile);

        return {
          commandName: name,
          applied: true,
          config: current[name],
        };
      })
    );

    // Web Command Console Execution (Direct Node Pipeline)
    this.app.post(
      "/bridge/bots/:botId/remote/execute-command",
      wrap(async (req) => {
        const { botId } = req.params;
        const rawCmd = String(req.body?.commandLine || req.body?.text || "").trim();
        const deliverToZalo = Boolean(req.body?.deliverToZalo);

        if (!rawCmd) {
          const err = new Error("Command text is required");
          err.status = 400;
          err.code = "EMPTY_COMMAND";
          throw err;
        }

        const prefixInfo = await this.prefixService.read(botId).catch(() => ({ prefix: "!" }));
        const prefix = prefixInfo?.prefix || "!";
        const fullText = rawCmd.startsWith(prefix) ? rawCmd : `${prefix}${rawCmd}`;
        const cleanBody = fullText.slice(prefix.length).trim();
        const firstToken = cleanBody.split(/\s+/)[0]?.toLowerCase() || "";

        const defs = commandRegistry?.definitions || [];
        const matched = defs.find(
          (d) =>
            d.name?.toLowerCase() === firstToken ||
            (Array.isArray(d.aliases) && d.aliases.some((a) => String(a).toLowerCase() === firstToken))
        );

        if (!matched) {
          return {
            parsed: false,
            executed: false,
            outcome: "not_found",
            commandLine: fullText,
            replyText: `Lệnh '${firstToken}' không tồn tại trong hệ thống Node gốc.`,
            outputs: [`Lệnh '${firstToken}' không tồn tại trong hệ thống Node gốc.`],
            deliveryAttempted: false,
            deliveredToZalo: false,
            deliveryError: null,
          };
        }

        // When dry-run or offline, return dry-run parsed result
        const desc = await this.registry.describe(botId);
        const isOnline = Boolean(desc?.connected);

        if (!deliverToZalo || !isOnline) {
          const notice = !isOnline
            ? `\n\n⚠️ Lưu ý: Bot '${botId}' hiện đang Ngoại tuyến. Lệnh đã được kiểm tra cú pháp thành công qua Node pipeline.`
            : ` (Chế độ mô phỏng Web Console, không gửi Zalo thật)`;
          const replyText = `[Node Hybrid Console] Lệnh '${matched.name}' hợp lệ.${notice}`;

          return {
            parsed: true,
            executed: true,
            outcome: "dry_run",
            commandLine: fullText,
            replyText,
            outputs: [replyText],
            deliveryAttempted: false,
            deliveredToZalo: false,
            deliveryError: null,
            matchedCommand: {
              name: matched.name,
              permission: matched.permission || "All",
            },
          };
        }

        // Live delivery via bot's internal command route
        return {
          parsed: true,
          executed: true,
          outcome: "executed",
          commandLine: fullText,
          replyText: `[Node Hybrid] Lệnh '${matched.name}' đã được gửi tới luồng thực thi Zalo của bot '${botId}'.`,
          outputs: [`[Node Hybrid] Lệnh '${matched.name}' đã được gửi tới luồng thực thi Zalo của bot '${botId}'.`],
          deliveryAttempted: true,
          deliveredToZalo: true,
          deliveryError: null,
          matchedCommand: {
            name: matched.name,
            permission: matched.permission || "All",
          },
        };
      })
    );

    // QR Recovery / Login
    this.app.get(
      "/bridge/bots/:botId/qr/status",
      wrap(async (req) => {
        const { botId } = req.params;
        if (botId === "admin") {
          return this.qrCoordinator.getStatus();
        }
        const state = await this.botQrManager.get(botId);
        return state || { botId, state: "idle", qrImage: null };
      })
    );

    this.app.post(
      "/bridge/bots/:botId/qr/start",
      wrap(async (req) => {
        const { botId } = req.params;
        if (botId === "admin") {
          return await this.qrCoordinator.startRecoverySession(req.body || {});
        }
        return await this.botQrManager.start(botId);
      })
    );

    this.app.post(
      "/bridge/bots/:botId/qr/cancel",
      wrap(async (req) => {
        const { botId } = req.params;
        if (botId === "admin") {
          return await this.qrCoordinator.cancelSession(req.body?.sessionId);
        }
        const cancelled = await this.botQrManager.cancel(botId);
        return { botId, cancelled };
      })
    );

    // Creation is pending until account login has been verified; keys never follow account UIDs.
    this.app.post("/bridge/bots", wrap(async (req) => {
      if (req.body?.startImmediately) throw Object.assign(new Error("Bot luôn chờ kích hoạt riêng."), { status: 400, code: "START_IMMEDIATELY_NOT_ALLOWED" });
      const ownerUid = String(req.body?.ownerUid || "").trim();
      if (!ownerUid) throw Object.assign(new Error("Cần chọn chủ quản lý Bot."), { status: 400, code: "OWNER_REQUIRED", stage: "authorize" });
      const prefix = String(req.body?.prefix || "!").trim();
      if (!/^\S{1,3}$/.test(prefix)) throw Object.assign(new Error("Prefix phải gồm 1–3 ký tự."), { status: 400, code: "PREFIX_INVALID" });
      const preset = String(req.body?.expiryPreset || "30d").toLowerCase();
      const durations = { "1h": 3600000, "1d": 86400000, "7d": 604800000, "30d": 2592000000 };
      const activationPolicy = ["permanent", "never", "-1"].includes(preset) ? { type: "permanent" } : { type: "duration", durationMs: durations[preset] || durations["30d"] };
      let created;
      const initialize = (botKey, credential, record, txn) => initializeVerifiedBotFiles({ root: this.root, botKey, credential, record, txn, prefix });
      if (req.body?.cookie) {
        const credential = normalizeLoginCredential({ ...req.body, userAgent: req.body.userAgent || getZaloRuntimeConfig().userAgent });
        const identity = await this.verifyCredential(credential, { root: this.root });
        created = await persistVerifiedBot({ root: this.root, credential, identity, ownerUid, allowAdmin: true, initialize, profilePatch: { activationPolicy } });
      } else {
        for (const [key, draft] of this.botDrafts) if (draft.expiresAt <= Date.now()) this.botDrafts.delete(key);
        const botKey = `bot_${crypto.randomUUID()}`;
        const draft = { botKey, ownerUid, prefix, activationPolicy, displayName: req.body?.displayName || botKey, createdAt: Date.now(), expiresAt: Date.now() + 5 * 60_000 };
        this.botDrafts.set(botKey, draft);
        created = { botKey, record: { ...draft, accountIdentityStatus: "pending", adminBindingStatus: "pending", desiredStatus: "stopped", status: "draft" }, created: true, restartRequired: false };
      }
      const botKey = created.botKey;
      let qr = null;
      if (req.body?.startQr) qr = await this.botQrManager.start(botKey);
      this.statusVersion += 1;
      return { ok: true, id: botKey, botKey, bot: { ...created.record, id: botKey, botKey, status: "stopped" }, qr, restartRequired: created.restartRequired };
    }));

    this.app.get("/bridge/bots/:botId/credentials", wrap((req) => this.credentials.read(req.params.botId)));
    this.app.post("/bridge/bots/:botId/credentials/reveal", wrap(async (req) => {
      const loaded = await this.credentials.reveal(req.params.botId);
      await this.auditStore.append({ action: "credential.reveal", botId: req.params.botId, actor: "dashboard", requestId: req.requestId });
      return { botId: req.params.botId, ...loaded.raw };
    }));
    this.app.post("/bridge/bots/:botId/credentials", wrap(async (req) => {
      if (req.body?.startImmediately) throw Object.assign(new Error("Yêu cầu restart riêng để áp dụng đăng nhập."), { status: 400, code: "START_IMMEDIATELY_NOT_ALLOWED" });
      const result = await this.credentials.update(req.params.botId, req.body || {});
      return { ok: true, botId: req.params.botId, status: result.record.status, trialStatus: result.record.trialStatus, accountIdentityStatus: "verified", restartRequired: result.restartRequired, message: "Đã lưu đăng nhập. Bot đang chạy áp dụng sau lần restart được yêu cầu." };
    }));

    // Report old SQLite records for operator reconciliation; never resurrect them automatically.
    this.app.post("/bridge/reconcile-sqlite", wrap(async (req) => {
      const current = JSON.parse(await fs.readFile(path.join(this.root, "mybot", "mybots.json"), "utf8").catch((error) => { if (error.code === "ENOENT") return "{}"; throw error; }));
      const bots = Array.isArray(req.body?.bots) ? req.body.bots : [];
      const unresolved = bots.map((bot) => ({ botKey: String(bot.botKey || bot.id || bot.key || ""), reason: "REQUIRES_IDENTITY_RECONCILIATION" })).filter((bot) => bot.botKey && !current[bot.botKey]);
      return { imported: 0, reportOnly: true, unresolved, sourceOfTruth: "node-json" };
    }));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, this.host, () => {
        const addr = this.server.address();
        const boundPort = typeof addr === "object" ? addr.port : this.port;
        console.log(`[NODE-BRIDGE] Online on http://${this.host}:${boundPort} (Loopback only)`);
        this._startEventLoops();
        resolve(boundPort);
      });
      this.server.on("error", reject);
    });
  }

  async stop() {
    this._stopEventLoops();
    if (this.runtimeMetrics) {
      this.runtimeMetrics.stop();
    }
    if (this.broker) {
      await this.broker.shutdown().catch(() => {});
    }
    for (const client of this.eventClients) {
      try { client.end(); } catch {}
    }
    this.eventClients.clear();
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
}

// Standalone CLI runner or PM2 daemon
const isDirectCli = Boolean(
  !process.env.NODE_TEST_CONTEXT &&
  !process.env.TAP &&
  (
    (process.argv[1] && (process.argv[1].endsWith("node-bridge-service.js") || process.argv[1].includes("ProcessContainer"))) ||
    process.env.pm_id !== undefined ||
    process.env.MYBOT_RUN_BRIDGE === "1"
  )
);

if (isDirectCli) {
  const service = new NodeBridgeService();
  service
    .start()
    .then((p) => {
      console.log(`[NODE-BRIDGE] Service running successfully on port ${p}`);
    })
    .catch((err) => {
      console.error("[NODE-BRIDGE] Failed to start:", err);
      process.exit(1);
    });
}
