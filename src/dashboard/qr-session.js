import crypto from "crypto";
import {
  QR_LOGIN_EXPIRY_REASON,
  QR_LOGIN_TIMEOUT_MS,
  isQrLoginExpiredSignal,
} from "../utils/qr-login-expiry.js";

const publicState = (entry) => ({
  id: entry.id,
  botId: entry.botId,
  state: entry.state,
  qrImage: entry.qrImage || null,
  expiresAt: entry.expiresAt,
  error: entry.error || null,
  createdAt: entry.createdAt || null,
  updatedAt: entry.updatedAt || null,
  startedAt: entry.startedAt || null,
  finishedAt: entry.finishedAt || null,
  remainingMs: Math.max(0, (entry.expiresAt || 0) - (typeof entry.now === "function" ? entry.now() : Date.now())),
  active: ["starting", "waiting_scan", "waiting_confirm"].includes(entry.state),
});

export class QrSessionManager {
  constructor({ initSession, verifyClient, generateQr, waitScan, waitConfirm, readQr, writeCredential, now = () => Date.now(), timeoutMs = QR_LOGIN_TIMEOUT_MS, maxConcurrentSessions = 1 } = {}) {
    this.deps = { initSession, verifyClient, generateQr, waitScan, waitConfirm, readQr, writeCredential };
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.maxConcurrentSessions = normalizeConcurrencyLimit(maxConcurrentSessions);
    this.sessions = new Map();
  }

  active() {
    return [...this.sessions.values()].find((entry) => ["starting", "waiting_scan", "waiting_confirm"].includes(entry.state));
  }

  activeCount() {
    return [...this.sessions.values()].filter((entry) => ["starting", "waiting_scan", "waiting_confirm"].includes(entry.state)).length;
  }

  list() {
    return [...this.sessions.values()].map((entry) => publicState(entry));
  }

  async start(botId) {
    if (!botId) throw new Error("botId is required");
    const existing = this.sessions.get(botId);
    if (existing && ["starting", "waiting_scan", "waiting_confirm"].includes(existing.state)) {
      throw makeQrError(409, "QR_CONFLICT", "QR login already active for this bot");
    }
    if (this.activeCount() >= this.maxConcurrentSessions) {
      throw makeQrError(409, "QR_CONFLICT", this.maxConcurrentSessions === 1 ? "Another QR login is already active" : "QR login concurrency limit reached");
    }
    const startedAt = this.now();
    const entry = {
      id: crypto.randomUUID(),
      botId,
      state: "starting",
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
      expiresAt: startedAt + this.timeoutMs,
      now: this.now,
      controller: new AbortController(),
    };
    this.sessions.set(botId, entry);
    try {
      const sessionContext = { botId, sessionId: entry.id };
      let session = await this.deps.initSession(sessionContext);
      session = await this.deps.verifyClient(session);
      const [code, updatedSession, qrMeta] = await this.deps.generateQr(session, sessionContext);
      if (!code || !updatedSession) throw new Error("Unable to generate QR code");
      entry.session = updatedSession;
      entry.code = code;
      const qrImage = await this.deps.readQr(updatedSession, sessionContext);
      entry.qrImage = qrImage || updatedSession.qrImage || qrMeta?.qrImage || null;
      if (!entry.qrImage) throw new Error("QR image is unavailable");
      entry.state = "waiting_scan";
      entry.updatedAt = this.now();
      void this.finish(entry);
      return publicState(entry);
    } catch (error) {
      entry.state = "failed";
      entry.updatedAt = this.now();
      entry.finishedAt = entry.updatedAt;
      entry.error = error.message;
      delete entry.session;
      delete entry.code;
      if (!error.status) error.status = 502;
      if (!error.code) error.code = "QR_INIT_FAILED";
      throw error;
    }
  }

  async finish(entry) {
    try {
      const scanResult = await this.waitForDeadline(
        entry,
        (signal) => this.deps.waitScan(entry.code, entry.session, signal, {
          expiresAt: entry.expiresAt,
          onExpired: () => this.expire(entry, "QR code expired"),
        }),
        "QR scan expired or was not completed",
      );
      if (entry.state === "cancelled" || entry.state === "expired") return;
      if (!scanResult) throw new Error("QR scan was not completed");
      entry.state = "waiting_confirm";
      entry.updatedAt = this.now();
      const [resultData, rawCookies, meta] = await this.waitForDeadline(
        entry,
        (signal) => this.deps.waitConfirm(entry.code, entry.session, {
          signal,
          expiresAt: entry.expiresAt,
          onExpired: () => this.expire(entry, "QR code expired"),
        }),
        "QR confirmation expired or was not completed",
      );
      if (entry.state === "cancelled" || entry.state === "expired" || this.now() >= entry.expiresAt) return;
      if (meta?.expired || !resultData || !rawCookies) throw new Error("QR confirmation was not completed");
      if (entry.state === "cancelled" || entry.state === "expired" || this.now() >= entry.expiresAt) return;
      await this.deps.writeCredential(entry.botId, { prefix: "?", imei: resultData.imei, cookie: resultData.cookie, active: false, rawCookies }, entry.session);
      if (entry.state === "cancelled" || entry.state === "expired" || this.now() >= entry.expiresAt) return;
      entry.state = "configured";
      entry.updatedAt = this.now();
      entry.finishedAt = entry.updatedAt;
      entry.error = null;
    } catch (error) {
      if (entry.state !== "cancelled" && entry.state !== "expired") {
        entry.state = this.now() >= entry.expiresAt || isQrLoginExpiredSignal(entry.controller.signal) ? "expired" : "failed";
        entry.updatedAt = this.now();
        entry.finishedAt = entry.updatedAt;
        entry.error = error.message;
        if (entry.state === "expired") {
          entry.qrImage = null;
          entry.controller.abort(QR_LOGIN_EXPIRY_REASON);
        }
      }
    } finally {
      delete entry.session;
      delete entry.code;
    }
  }

  expire(entry, message = "QR login expired") {
    if (["configured", "failed", "cancelled", "expired"].includes(entry.state)) return;
    entry.state = "expired";
    entry.updatedAt = this.now();
    entry.finishedAt = entry.updatedAt;
    entry.error = message;
    entry.qrImage = null;
    delete entry.session;
    delete entry.code;
    entry.controller.abort(QR_LOGIN_EXPIRY_REASON);
  }

  async waitForDeadline(entry, operation, timeoutMessage) {
    const remaining = entry.expiresAt - this.now();
    if (remaining <= 0) {
      this.expire(entry, timeoutMessage);
      throw new Error(timeoutMessage);
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.expire(entry, timeoutMessage);
        reject(new Error(timeoutMessage));
      }, remaining);
    });
    try {
      return await Promise.race([operation(entry.controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  get(botId) { return this.sessions.has(botId) ? publicState(this.sessions.get(botId)) : null; }
  cancel(botId) {
    const entry = this.sessions.get(botId);
    if (!entry || !["starting", "waiting_scan", "waiting_confirm"].includes(entry.state)) return false;
    entry.state = "cancelled";
    entry.updatedAt = this.now();
    entry.finishedAt = entry.updatedAt;
    entry.qrImage = null;
    entry.controller.abort("cancelled");
    delete entry.session;
    delete entry.code;
    return true;
  }
}

function normalizeConcurrencyLimit(value) {
  if (value === Infinity) return Infinity;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "infinity" || trimmed === "unlimited" || trimmed === "0") return Infinity;
  }
  const numeric = Number(value);
  if (numeric === 0) return Infinity;
  if (!Number.isFinite(numeric) || numeric < 0) return 1;
  return Math.floor(numeric);
}

function makeQrError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
