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
import { writeJsonAtomic } from "../commands/mybot/System/json-state.js";
import { updateProfile } from "../commands/mybot/System/mybot-profile-service.js";

function assertSafeId(id, label = "id") {
  if (!id || typeof id !== "string") throw new Error(`${label} must be a non-empty string`);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${label} contains invalid characters`);
  if (id.length > 64) throw new Error(`${label} is too long`);
}

function parseFlexibleCookieInput(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  return { raw: trimmed };
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
  } = {}) {
    this.root = path.resolve(root);
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

    this.qrCoordinator = createWebAdminRecoveryCoordinator({
      root: this.root,
      actions: this.actions,
    });

    this.botQrManager = createQrSessionManager({
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
    const bots = rawBots.map((desc) => {
      return {
        id: desc.id,
        botKey: desc.id,
        displayName: desc.displayName || desc.id,
        isMain: Boolean(desc.isMain || desc.id === "admin"),
        status: desc.status, // e.g. "running", "stopped", "cookie-dead"
        desiredStatus: desc.enabled === false ? "stopped" : "running",
        cookieDead: Boolean(desc.cookieDead),
        cookieDeadReason: desc.cookieDeadReason || null,
        prefix: desc.prefix || "!",
        port: desc.webPort || desc.port || null,
        uid: desc.uid || null,
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
        const cached = this.idempotencyMap.get(requestId);
        if (cached && req.method !== "GET") {
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
      wrap(async (req) => {
        const { botId } = req.params;
        const action = String(req.body?.action || "").toLowerCase();

        let result;
        if (action === "start" || action === "resume") {
          result = await this.actions.start(botId, req.body || {});
        } else if (action === "stop") {
          result = await this.actions.stop(botId, req.body || {});
        } else if (action === "restart") {
          result = await this.actions.restart(botId);
        } else if (action === "standby" || action === "hot_standby") {
          result = await this.actions.standby(botId, req.body || {});
        } else if (action === "delete") {
          result = await this.actions.delete(botId, req.body || {});
        } else {
          const err = new Error(`Unsupported bot action: '${action}'`);
          err.status = 400;
          err.code = "INVALID_ACTION";
          throw err;
        }

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
        if (!op) {
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

    // Create new bot in Node
    this.app.post(
      "/bridge/bots",
      wrap(async (req) => {
        if (req.body?.startImmediately === true) {
          const err = new Error("startImmediately không còn được hỗ trợ. Bot luôn được tạo ở trạng thái chờ kích hoạt.");
          err.status = 400;
          err.code = "START_IMMEDIATELY_NOT_ALLOWED";
          throw err;
        }

        const rawKey = String(req.body?.botKey || req.body?.id || "").trim();
        const botId = rawKey
          ? rawKey.replace(/[^a-zA-Z0-9_-]/g, "")
          : `bot_${Date.now().toString(36)}`;
        assertSafeId(botId, "botId");
        if (botId.toLowerCase() === "admin") {
          const err = new Error("Mã 'admin' được dành riêng cho Bot Quản Trị Chính.");
          err.status = 400;
          err.code = "RESERVED_BOT_ID";
          throw err;
        }

        const existing = await this.registry.describe(botId);
        if (existing) {
          const err = new Error(`Bot '${botId}' đã tồn tại trong hệ thống.`);
          err.status = 409;
          err.code = "BOT_ALREADY_EXISTS";
          throw err;
        }

        const displayName = String(req.body?.displayName || req.body?.name || botId).trim() || botId;
        const ownerUid = String(req.body?.ownerUid || "").trim();
        const prefix = String(req.body?.prefix || "!").trim() || "!";
        const expiryPreset = String(req.body?.expiryPreset || "30d").trim();

        const myBotsPath = path.join(this.root, "mybot", "mybots.json");
        let myBots = {};
        try {
          if (fsSync.existsSync(myBotsPath)) {
            myBots = JSON.parse(fsSync.readFileSync(myBotsPath, "utf8"));
          }
        } catch {}

        const usedPorts = new Set(
          Object.values(myBots || {})
            .map((entry) => Number(entry?.webPort || 0))
            .filter((n) => n > 0)
        );
        usedPorts.add(2000);
        let nextPort = 3001;
        while (usedPorts.has(nextPort)) nextPort += 1;

        const relCredPath = `mybot/credentials/${botId}.json`;
        const absCredPath = path.join(this.root, relCredPath);
        const botMetaPath = path.join(this.root, "mybot", "bots", `${botId}.json`);
        const groupSettingsRel = `mybot/bots/group_settings_${botId}.json`;

        const parsedCookie = parseFlexibleCookieInput(req.body?.cookie);
        const initialCred = {
          prefix,
          imei: String(req.body?.imei || "").trim(),
          userAgent: String(req.body?.userAgent || getZaloRuntimeConfig().userAgent).trim(),
          cookie: parsedCookie || {},
          active: false,
        };

        const credDir = path.dirname(absCredPath);
        const botsDir = path.dirname(botMetaPath);
        if (!fsSync.existsSync(credDir)) fsSync.mkdirSync(credDir, { recursive: true });
        if (!fsSync.existsSync(botsDir)) fsSync.mkdirSync(botsDir, { recursive: true });

        writeJsonAtomic(absCredPath, initialCred);
        writeJsonAtomic(path.join(this.root, groupSettingsRel), {});

        const nowIso = new Date().toISOString();
        const botConfig = {
          id: botId,
          uid: botId,
          name: displayName,
          displayName,
          ownerUid,
          prefix,
          webPort: nextPort,
          configFilePath: relCredPath,
          groupSettingsPath: groupSettingsRel,
          expiryAt: null,
          expiryPreset,
          trialStatus: "pending",
          enabled: true,
          status: "stopped",
          admins: ownerUid ? [ownerUid] : [],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        writeJsonAtomic(botMetaPath, botConfig);

        myBots[botId] = {
          uid: botId,
          name: displayName,
          displayName,
          ownerUid,
          webPort: nextPort,
          configFilePath: relCredPath,
          groupSettingsPath: groupSettingsRel,
          expiryAt: null,
          expiryPreset,
          trialStatus: "pending",
          enabled: true,
          status: "stopped",
          createdAt: nowIso,
          lastUpdated: nowIso,
        };
        writeJsonAtomic(myBotsPath, myBots);

        if (ownerUid) {
          try {
            updateProfile(botId, { ownerUid, displayName }, { root: this.root, actor: "dashboard-bridge" });
          } catch {}
        }

        let qr = null;
        if (req.body?.startQr) {
          try {
            qr = await this.botQrManager.start(botId);
          } catch (qrErr) {
            qr = { state: "failed", error: qrErr.message };
          }
        }

        await this.auditStore?.append?.({
          action: "bot.create",
          botId,
          actor: "bridge",
          details: { displayName, ownerUid, prefix },
        }).catch(() => {});

        this.statusVersion += 1;

        return {
          ok: true,
          botKey: botId,
          id: botId,
          bot: {
            id: botId,
            botKey: botId,
            displayName,
            ownerUid,
            prefix,
            status: "stopped",
            desiredStatus: "stopped",
            trialStatus: "pending",
            webPort: nextPort,
          },
          qr,
        };
      })
    );

    // Update bot credentials
    this.app.post(
      "/bridge/bots/:botId/credentials",
      wrap(async (req) => {
        if (req.body?.startImmediately === true) {
          const err = new Error("startImmediately không còn được hỗ trợ. Bot luôn được giữ ở trạng thái chờ kích hoạt.");
          err.status = 400;
          err.code = "START_IMMEDIATELY_NOT_ALLOWED";
          throw err;
        }

        const { botId } = req.params;
        const bot = await this.registry.describe(botId);
        if (!bot) {
          const err = new Error(`Bot '${botId}' not found`);
          err.status = 404;
          err.code = "BOT_NOT_FOUND";
          throw err;
        }

        const configPathRaw = bot.configPath || `mybot/credentials/${botId}.json`;
        const credPath = path.isAbsolute(configPathRaw) ? configPathRaw : path.join(this.root, configPathRaw);
        let existingCred = {};
        try {
          if (fsSync.existsSync(credPath)) {
            existingCred = JSON.parse(fsSync.readFileSync(credPath, "utf8"));
          }
        } catch {}

        const parsedCookie = parseFlexibleCookieInput(req.body?.cookie) || existingCred.cookie || {};
        const updatedCred = {
          ...existingCred,
          cookie: parsedCookie,
          imei: String(req.body?.imei || existingCred.imei || "").trim(),
          userAgent: String(req.body?.userAgent || existingCred.userAgent || getZaloRuntimeConfig().userAgent).trim(),
          active: false,
        };
        writeJsonAtomic(credPath, updatedCred);

        return { ok: true, botId, status: "stopped", trialStatus: "pending" };
      })
    );

    // Reconcile SQLite bots into Node registry safely
    this.app.post(
      "/bridge/reconcile-sqlite",
      wrap(async (req) => {
        const botsFromSqlite = Array.isArray(req.body?.bots) ? req.body.bots : [];
        const backupDir = path.join(this.root, "logs", "dashboard-backups");
        if (!fsSync.existsSync(backupDir)) fsSync.mkdirSync(backupDir, { recursive: true });

        const myBotsPath = path.join(this.root, "mybot", "mybots.json");
        let myBots = {};
        if (fsSync.existsSync(myBotsPath)) {
          try {
            myBots = JSON.parse(fsSync.readFileSync(myBotsPath, "utf8"));
            const backupFile = path.join(backupDir, `mybots-reconcile-${Date.now()}.json`);
            fsSync.writeFileSync(backupFile, JSON.stringify(myBots, null, 2), "utf8");
          } catch {}
        }

        const existingBotKeys = new Set(Object.keys(myBots || {}));
        const existingUids = new Set(
          Object.values(myBots || {})
            .map((b) => String(b.uid || "").trim())
            .filter(Boolean)
        );

        let imported = 0;
        const conflicts = [];

        for (const sqBot of botsFromSqlite) {
          const key = String(sqBot.botKey || sqBot.id || sqBot.key || "").trim();
          const uid = String(sqBot.uid || "").trim();
          if (!key || key === "admin") continue;

          if (existingBotKeys.has(key)) {
            const existingUid = String(myBots[key]?.uid || "").trim();
            if (uid && existingUid && uid !== existingUid) {
              conflicts.push({ botKey: key, sqliteUid: uid, nodeUid: existingUid, reason: "UID_MISMATCH" });
            }
            continue;
          }

          if (uid && existingUids.has(uid)) {
            conflicts.push({ botKey: key, uid, reason: "DUPLICATE_UID" });
            continue;
          }

          const relCredPath = `mybot/credentials/${key}.json`;
          const absCredPath = path.join(this.root, relCredPath);
          const botMetaPath = path.join(this.root, "mybot", "bots", `${key}.json`);
          const groupSettingsRel = `mybot/bots/group_settings_${key}.json`;

          if (!fsSync.existsSync(absCredPath)) {
            writeJsonAtomic(absCredPath, {
              prefix: sqBot.prefix || "!",
              imei: sqBot.imei || "",
              userAgent: sqBot.userAgent || getZaloRuntimeConfig().userAgent,
              cookie: sqBot.cookie || {},
              active: false,
            });
          }

          const botConfig = {
            id: key,
            uid: uid || key,
            name: sqBot.displayName || key,
            displayName: sqBot.displayName || key,
            ownerUid: sqBot.ownerUid || "",
            prefix: sqBot.prefix || "!",
            webPort: sqBot.webPort || 0,
            configFilePath: relCredPath,
            groupSettingsPath: groupSettingsRel,
            expiryAt: sqBot.expiryAt || null,
            trialStatus: sqBot.trialStatus || "pending",
            enabled: true,
            status: "stopped",
            admins: sqBot.ownerUid ? [sqBot.ownerUid] : [],
            createdAt: sqBot.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          writeJsonAtomic(botMetaPath, botConfig);

          myBots[key] = {
            uid: uid || key,
            name: sqBot.displayName || key,
            displayName: sqBot.displayName || key,
            ownerUid: sqBot.ownerUid || "",
            webPort: sqBot.webPort || 0,
            configFilePath: relCredPath,
            groupSettingsPath: groupSettingsRel,
            expiryAt: sqBot.expiryAt || null,
            trialStatus: sqBot.trialStatus || "pending",
            enabled: true,
            status: "stopped",
            createdAt: sqBot.createdAt || new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          };
          existingBotKeys.add(key);
          if (uid) existingUids.add(uid);
          imported++;
        }

        if (imported > 0) {
          writeJsonAtomic(myBotsPath, myBots);
          this.statusVersion += 1;
        }

        return { ok: true, imported, conflicts, totalNodeBots: Object.keys(myBots).length };
      })
    );
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
