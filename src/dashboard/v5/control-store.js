import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const requireBuiltin = createRequire(import.meta.url);
const sharedStores = new Map();

const ACTIVE_OPERATION_STATUSES = new Set([
  "running",
  "pending",
  "queued",
  "in_progress",
  "starting",
]);

function nowIso() {
  return new Date().toISOString();
}

function toIsoTimestamp(value, fallbackIso = nowIso()) {
  if (value === null || value === undefined || value === "") return fallbackIso;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  const str = String(value).trim();
  if (!str) return fallbackIso;
  const numeric = Number(str);
  if (Number.isFinite(numeric) && /^\d{10,15}$/.test(str)) {
    return new Date(numeric).toISOString();
  }
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? fallbackIso : new Date(parsed).toISOString();
}

function toEpochMs(value, fallbackMs = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === "") return fallbackMs;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? fallbackMs : parsed;
}

function safeJsonParse(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function writeJsonFileAtomicSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, serialized, "utf8");
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, serialized, "utf8");
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function loadDatabaseSyncClass() {
  try {
    const sqliteMod = requireBuiltin("node:sqlite");
    return sqliteMod?.DatabaseSync || null;
  } catch {
    return null;
  }
}

function createEmptyFallbackState() {
  return {
    kv_docs: {},
    iam_users: {},
    iam_sessions: {},
    server_operations: {},
    notifications: [],
    crm_customers: {},
    crm_vouchers: {},
    crm_ledger: [],
    moderation_violations: [],
    uid_blacklist: {},
    campaigns: {},
    metric_buckets: [],
  };
}

export class ControlPlaneStore {
  constructor(options = {}) {
    const rootInput = typeof options === "string" ? options : options?.root || process.cwd();
    this.root = path.resolve(rootInput);
    this.runtimeDir = path.join(this.root, ".runtime", "control-plane");
    this.dbPath = options?.dbPath
      ? path.resolve(options.dbPath)
      : path.join(this.runtimeDir, "v5-control.sqlite");
    this.fallbackPath = path.join(this.runtimeDir, "v5-control-fallback.json");
    this.closed = false;
    this.db = null;
    this.backend = "sqlite";
    this.fallbackState = null;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    const isEphemeralTestRoot =
      Boolean(process.env.NODE_TEST_CONTEXT || process.env.DASHBOARD_TEST_MODE === "1") &&
      !options?.forceSqlite;
    const DatabaseSync = options?.forceFallback || isEphemeralTestRoot ? null : loadDatabaseSyncClass();
    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(this.dbPath);
        this.#initSqlite();
        return;
      } catch {
        try {
          this.db?.close?.();
        } catch {}
        this.db = null;
      }
    }

    this.backend = "json-fallback";
    this.#initFallback();
  }

  #initSqlite() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS kv_docs (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE IF NOT EXISTS iam_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS iam_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_iam_sessions_user ON iam_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_iam_sessions_exp ON iam_sessions(expires_at_ms);

      CREATE TABLE IF NOT EXISTS server_operations (
        id TEXT PRIMARY KEY,
        bot_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ops_bot_status ON server_operations(bot_id, status);
      CREATE INDEX IF NOT EXISTS idx_ops_started ON server_operations(started_at DESC);

      CREATE TABLE IF NOT EXISTS notifications (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        bot_id TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, seq DESC);

      CREATE TABLE IF NOT EXISTS crm_customers (
        owner_uid TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crm_vouchers (
        code TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crm_ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        owner_uid TEXT,
        bot_id TEXT,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_crm_ledger_owner ON crm_ledger(owner_uid, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_crm_ledger_bot ON crm_ledger(bot_id, seq DESC);

      CREATE TABLE IF NOT EXISTS moderation_violations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        bot_id TEXT,
        thread_id TEXT,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_violations_bot_thread ON moderation_violations(bot_id, thread_id, seq DESC);

      CREATE TABLE IF NOT EXISTS uid_blacklist (
        uid TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        bot_id TEXT,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metric_buckets (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        bot_id TEXT NOT NULL,
        bucket_ts TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_ts_bot ON metric_buckets(bucket_ts ASC, bot_id);
    `);
  }

  #initFallback() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    if (fs.existsSync(this.fallbackPath)) {
      const loaded = safeJsonParse(fs.readFileSync(this.fallbackPath, "utf8"), null);
      this.fallbackState = { ...createEmptyFallbackState(), ...(loaded || {}) };
    } else {
      this.fallbackState = createEmptyFallbackState();
      this.#flushFallback();
    }
  }

  #flushFallback() {
    if (this.backend !== "json-fallback" || !this.fallbackState) return;
    writeJsonFileAtomicSync(this.fallbackPath, this.fallbackState);
  }

  #assertOpen() {
    if (this.closed) {
      throw new Error("ControlPlaneStore đã đóng kết nối");
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Key-Value Config Documents
  // ---------------------------------------------------------------------------
  getDoc(namespace, key, fallback = null) {
    this.#assertOpen();
    const ns = String(namespace || "").trim();
    const docKey = String(key || "").trim();
    if (!ns || !docKey) return fallback;

    if (this.db) {
      const row = this.db
        .prepare("SELECT value_json FROM kv_docs WHERE namespace = ? AND key = ?")
        .get(ns, docKey);
      if (!row) return fallback;
      return safeJsonParse(row.value_json, fallback);
    }

    const bucket = this.fallbackState.kv_docs[ns];
    if (!bucket || !(docKey in bucket)) return fallback;
    return cloneJson(bucket[docKey].value);
  }

  setDoc(namespace, key, value) {
    this.#assertOpen();
    const ns = String(namespace || "").trim();
    const docKey = String(key || "").trim();
    if (!ns || !docKey) {
      throw new Error("namespace và key không được để trống");
    }
    const updatedAt = nowIso();
    const serialized = JSON.stringify(value ?? null);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO kv_docs (namespace, key, value_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(namespace, key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `)
        .run(ns, docKey, serialized, updatedAt);
    } else {
      if (!this.fallbackState.kv_docs[ns]) this.fallbackState.kv_docs[ns] = {};
      this.fallbackState.kv_docs[ns][docKey] = {
        value: safeJsonParse(serialized, null),
        updatedAt,
      };
      this.#flushFallback();
    }

    return { namespace: ns, key: docKey, value: safeJsonParse(serialized, null), updatedAt };
  }

  listDocs(namespace) {
    this.#assertOpen();
    const ns = String(namespace || "").trim();
    if (!ns) return [];

    if (this.db) {
      const rows = this.db
        .prepare("SELECT key, value_json, updated_at FROM kv_docs WHERE namespace = ? ORDER BY key ASC")
        .all(ns);
      return rows.map((row) => ({
        key: row.key,
        value: safeJsonParse(row.value_json, null),
        updatedAt: row.updated_at,
      }));
    }

    const bucket = this.fallbackState.kv_docs[ns] || {};
    return Object.keys(bucket)
      .sort((a, b) => a.localeCompare(b))
      .map((docKey) => ({
        key: docKey,
        value: cloneJson(bucket[docKey].value),
        updatedAt: bucket[docKey].updatedAt,
      }));
  }

  deleteDoc(namespace, key) {
    this.#assertOpen();
    const ns = String(namespace || "").trim();
    const docKey = String(key || "").trim();
    if (!ns || !docKey) return false;

    if (this.db) {
      const res = this.db
        .prepare("DELETE FROM kv_docs WHERE namespace = ? AND key = ?")
        .run(ns, docKey);
      return Number(res.changes) > 0;
    }

    const bucket = this.fallbackState.kv_docs[ns];
    if (!bucket || !(docKey in bucket)) return false;
    delete bucket[docKey];
    this.#flushFallback();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 2. IAM Users
  // ---------------------------------------------------------------------------
  listUsers() {
    this.#assertOpen();
    if (this.db) {
      const rows = this.db
        .prepare("SELECT data_json FROM iam_users ORDER BY created_at ASC")
        .all();
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }
    return Object.values(this.fallbackState.iam_users)
      .map((u) => cloneJson(u))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  getUserById(id) {
    this.#assertOpen();
    const userId = String(id || "").trim();
    if (!userId) return null;

    if (this.db) {
      const row = this.db.prepare("SELECT data_json FROM iam_users WHERE id = ?").get(userId);
      return row ? safeJsonParse(row.data_json, null) : null;
    }
    const found = this.fallbackState.iam_users[userId];
    return found ? cloneJson(found) : null;
  }

  getUserByUsername(username) {
    this.#assertOpen();
    const uname = String(username || "").trim();
    if (!uname) return null;

    if (this.db) {
      const row = this.db
        .prepare("SELECT data_json FROM iam_users WHERE LOWER(username) = LOWER(?)")
        .get(uname);
      return row ? safeJsonParse(row.data_json, null) : null;
    }
    const lower = uname.toLowerCase();
    const found = Object.values(this.fallbackState.iam_users).find(
      (u) => String(u.username || "").toLowerCase() === lower
    );
    return found ? cloneJson(found) : null;
  }

  upsertUser(user) {
    this.#assertOpen();
    if (!user || typeof user !== "object") {
      throw new Error("Thông tin người dùng không hợp lệ");
    }
    const existing =
      (user.id ? this.getUserById(user.id) : null) ||
      (user.username ? this.getUserByUsername(user.username) : null);
    const now = nowIso();
    const id = String(user.id || existing?.id || `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).trim();
    const username = String(user.username || existing?.username || "").trim();
    if (!username) {
      throw new Error("Tên đăng nhập không được để trống");
    }

    const record = {
      ...(existing || {}),
      ...user,
      id,
      username,
      createdAt: existing?.createdAt || user.createdAt || now,
      updatedAt: now,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO iam_users (id, username, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            username = excluded.username,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
        `)
        .run(id, username, serialized, record.createdAt, record.updatedAt);
    } else {
      this.fallbackState.iam_users[id] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  deleteUser(id) {
    this.#assertOpen();
    const userId = String(id || "").trim();
    if (!userId) return false;

    if (this.db) {
      this.db.prepare("DELETE FROM iam_sessions WHERE user_id = ?").run(userId);
      const res = this.db.prepare("DELETE FROM iam_users WHERE id = ?").run(userId);
      return Number(res.changes) > 0;
    }

    if (!(userId in this.fallbackState.iam_users)) return false;
    delete this.fallbackState.iam_users[userId];
    for (const [sid, sess] of Object.entries(this.fallbackState.iam_sessions)) {
      if (sess.userId === userId) delete this.fallbackState.iam_sessions[sid];
    }
    this.#flushFallback();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 3. IAM Sessions
  // ---------------------------------------------------------------------------
  createSession(session) {
    this.#assertOpen();
    if (!session || typeof session !== "object") {
      throw new Error("Dữ liệu phiên đăng nhập không hợp lệ");
    }
    const now = nowIso();
    const sessionId = String(session.sessionId || session.id || crypto.randomBytes(24).toString("hex")).trim();
    const userId = String(session.userId || "").trim();
    if (!userId) {
      throw new Error("Phiên đăng nhập thiếu userId");
    }
    const defaultExpiryMs = Date.now() + 24 * 60 * 60 * 1000;
    const expiresAtMs = toEpochMs(session.expiresAt ?? session.expiresAtMs, defaultExpiryMs);
    const expiresAt = new Date(expiresAtMs).toISOString();
    const createdAt = toIsoTimestamp(session.createdAt, now);
    const lastSeenAt = toIsoTimestamp(session.lastSeenAt, now);

    const record = {
      ...session,
      id: sessionId,
      sessionId,
      userId,
      csrfToken: session.csrfToken || crypto.randomBytes(24).toString("hex"),
      createdAt,
      lastSeenAt,
      expiresAt,
      expiresAtMs,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO iam_sessions (session_id, user_id, expires_at, expires_at_ms, last_seen_at, created_at, data_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            user_id = excluded.user_id,
            expires_at = excluded.expires_at,
            expires_at_ms = excluded.expires_at_ms,
            last_seen_at = excluded.last_seen_at,
            data_json = excluded.data_json
        `)
        .run(sessionId, userId, expiresAt, expiresAtMs, lastSeenAt, createdAt, serialized);
    } else {
      this.fallbackState.iam_sessions[sessionId] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  getSession(sessionId) {
    this.#assertOpen();
    const sid = String(sessionId || "").trim();
    if (!sid) return null;

    if (this.db) {
      const row = this.db
        .prepare("SELECT expires_at_ms, data_json FROM iam_sessions WHERE session_id = ?")
        .get(sid);
      if (!row) return null;
      if (Number(row.expires_at_ms) <= Date.now()) {
        this.db.prepare("DELETE FROM iam_sessions WHERE session_id = ?").run(sid);
        return null;
      }
      return safeJsonParse(row.data_json, null);
    }

    const entry = this.fallbackState.iam_sessions[sid];
    if (!entry) return null;
    if (toEpochMs(entry.expiresAtMs ?? entry.expiresAt, 0) <= Date.now()) {
      delete this.fallbackState.iam_sessions[sid];
      this.#flushFallback();
      return null;
    }
    return cloneJson(entry);
  }

  touchSession(sessionId) {
    this.#assertOpen();
    const current = this.getSession(sessionId);
    if (!current) return null;
    const lastSeenAt = nowIso();
    const updated = { ...current, lastSeenAt };
    const serialized = JSON.stringify(updated);

    if (this.db) {
      this.db
        .prepare("UPDATE iam_sessions SET last_seen_at = ?, data_json = ? WHERE session_id = ?")
        .run(lastSeenAt, serialized, current.sessionId);
    } else {
      this.fallbackState.iam_sessions[current.sessionId] = updated;
      this.#flushFallback();
    }
    return updated;
  }

  listSessions(userId) {
    this.#assertOpen();
    this.pruneExpiredSessions();
    const filterUserId = userId ? String(userId).trim() : "";

    if (this.db) {
      const rows = filterUserId
        ? this.db
            .prepare("SELECT data_json FROM iam_sessions WHERE user_id = ? ORDER BY last_seen_at DESC")
            .all(filterUserId)
        : this.db.prepare("SELECT data_json FROM iam_sessions ORDER BY last_seen_at DESC").all();
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }

    return Object.values(this.fallbackState.iam_sessions)
      .filter((s) => (!filterUserId ? true : s.userId === filterUserId))
      .map((s) => cloneJson(s))
      .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  }

  deleteSession(sessionId) {
    this.#assertOpen();
    const sid = String(sessionId || "").trim();
    if (!sid) return false;

    if (this.db) {
      const res = this.db.prepare("DELETE FROM iam_sessions WHERE session_id = ?").run(sid);
      return Number(res.changes) > 0;
    }

    if (!(sid in this.fallbackState.iam_sessions)) return false;
    delete this.fallbackState.iam_sessions[sid];
    this.#flushFallback();
    return true;
  }

  deleteOtherSessions(userId, keepSessionId) {
    this.#assertOpen();
    const uid = String(userId || "").trim();
    const keepSid = String(keepSessionId || "").trim();
    if (!uid) return 0;

    if (this.db) {
      const res = keepSid
        ? this.db
            .prepare("DELETE FROM iam_sessions WHERE user_id = ? AND session_id != ?")
            .run(uid, keepSid)
        : this.db.prepare("DELETE FROM iam_sessions WHERE user_id = ?").run(uid);
      return Number(res.changes) || 0;
    }

    let removed = 0;
    for (const [sid, sess] of Object.entries(this.fallbackState.iam_sessions)) {
      if (sess.userId === uid && sid !== keepSid) {
        delete this.fallbackState.iam_sessions[sid];
        removed += 1;
      }
    }
    if (removed > 0) this.#flushFallback();
    return removed;
  }

  pruneExpiredSessions() {
    this.#assertOpen();
    const nowMs = Date.now();

    if (this.db) {
      const res = this.db
        .prepare("DELETE FROM iam_sessions WHERE expires_at_ms <= ?")
        .run(nowMs);
      return Number(res.changes) || 0;
    }

    let removed = 0;
    for (const [sid, sess] of Object.entries(this.fallbackState.iam_sessions)) {
      if (toEpochMs(sess.expiresAtMs ?? sess.expiresAt, 0) <= nowMs) {
        delete this.fallbackState.iam_sessions[sid];
        removed += 1;
      }
    }
    if (removed > 0) this.#flushFallback();
    return removed;
  }

  // ---------------------------------------------------------------------------
  // 4. Server Operations
  // ---------------------------------------------------------------------------
  getOperation(id) {
    this.#assertOpen();
    const opId = String(id || "").trim();
    if (!opId) return null;

    if (this.db) {
      const row = this.db.prepare("SELECT data_json FROM server_operations WHERE id = ?").get(opId);
      return row ? safeJsonParse(row.data_json, null) : null;
    }
    const entry = this.fallbackState.server_operations[opId];
    return entry ? cloneJson(entry) : null;
  }

  upsertOperation(op) {
    this.#assertOpen();
    if (!op || typeof op !== "object") {
      throw new Error("Thông tin tác vụ không hợp lệ");
    }
    const now = nowIso();
    const id = String(op.id || `op_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).trim();
    const existing = this.getOperation(id);

    const startedAt = op.startedAt ?? existing?.startedAt ?? now;
    const finishedAt = op.finishedAt !== undefined ? op.finishedAt : existing?.finishedAt ?? null;
    const computedDuration =
      op.durationMs !== undefined
        ? op.durationMs
        : finishedAt && startedAt
          ? Math.max(0, toEpochMs(finishedAt) - toEpochMs(startedAt))
          : existing?.durationMs ?? null;

    const record = {
      ...(existing || {}),
      ...op,
      id,
      botId: op.botId !== undefined ? op.botId : existing?.botId ?? null,
      botName: op.botName !== undefined ? op.botName : existing?.botName ?? "",
      action: op.action !== undefined ? op.action : existing?.action ?? "unknown",
      actionType: op.actionType !== undefined ? op.actionType : existing?.actionType ?? op.action ?? "lifecycle",
      status: op.status !== undefined ? op.status : existing?.status ?? "running",
      phase: op.phase !== undefined ? op.phase : existing?.phase ?? "init",
      timeline: Array.isArray(op.timeline)
        ? op.timeline
        : Array.isArray(existing?.timeline)
          ? existing.timeline
          : [],
      actor: op.actor !== undefined ? op.actor : existing?.actor ?? "system",
      durationMs: computedDuration,
      error: op.error !== undefined ? op.error : existing?.error ?? null,
      recommendation: op.recommendation !== undefined ? op.recommendation : existing?.recommendation ?? null,
      startedAt: toIsoTimestamp(startedAt, now),
      finishedAt: finishedAt ? toIsoTimestamp(finishedAt, now) : null,
      updatedAt: now,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO server_operations (id, bot_id, status, started_at, updated_at, data_json)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            bot_id = excluded.bot_id,
            status = excluded.status,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            data_json = excluded.data_json
        `)
        .run(id, record.botId, record.status, record.startedAt, record.updatedAt, serialized);
    } else {
      this.fallbackState.server_operations[id] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  listOperations({ limit = 60, botId, status } = {}) {
    this.#assertOpen();
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 60));
    const filterBotId = botId ? String(botId).trim() : "";
    const filterStatus = status ? String(status).trim() : "";

    if (this.db) {
      const clauses = [];
      const params = [];
      if (filterBotId) {
        clauses.push("bot_id = ?");
        params.push(filterBotId);
      }
      if (filterStatus) {
        clauses.push("status = ?");
        params.push(filterStatus);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(safeLimit);
      const rows = this.db
        .prepare(
          `SELECT data_json FROM server_operations ${whereSql} ORDER BY started_at DESC, updated_at DESC LIMIT ?`
        )
        .all(...params);
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }

    return Object.values(this.fallbackState.server_operations)
      .filter((op) => {
        if (filterBotId && op.botId !== filterBotId) return false;
        if (filterStatus && op.status !== filterStatus) return false;
        return true;
      })
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, safeLimit)
      .map((op) => cloneJson(op));
  }

  clearCompletedOperations() {
    this.#assertOpen();
    if (this.db) {
      const activeList = Array.from(ACTIVE_OPERATION_STATUSES);
      const placeholders = activeList.map(() => "?").join(", ");
      const res = this.db
        .prepare(`DELETE FROM server_operations WHERE status NOT IN (${placeholders})`)
        .run(...activeList);
      return Number(res.changes) || 0;
    }

    let cleared = 0;
    for (const [id, op] of Object.entries(this.fallbackState.server_operations)) {
      if (!ACTIVE_OPERATION_STATUSES.has(String(op.status || "").toLowerCase())) {
        delete this.fallbackState.server_operations[id];
        cleared += 1;
      }
    }
    if (cleared > 0) this.#flushFallback();
    return cleared;
  }

  // ---------------------------------------------------------------------------
  // 5. Notifications
  // ---------------------------------------------------------------------------
  addNotification({
    level = "info",
    category = "system",
    title = "",
    message = "",
    botId = null,
    metadata = {},
  } = {}) {
    this.#assertOpen();
    const id = `ntf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const createdAt = nowIso();
    const record = {
      id,
      level: String(level || "info"),
      category: String(category || "system"),
      title: String(title || ""),
      message: String(message || ""),
      botId: botId ? String(botId) : null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      read: false,
      readAt: null,
      createdAt,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO notifications (id, level, category, bot_id, is_read, created_at, data_json)
          VALUES (?, ?, ?, ?, 0, ?, ?)
        `)
        .run(id, record.level, record.category, record.botId, createdAt, serialized);
      this.db
        .prepare(`
          DELETE FROM notifications
          WHERE seq NOT IN (SELECT seq FROM notifications ORDER BY seq DESC LIMIT 2000)
        `)
        .run();
    } else {
      this.fallbackState.notifications.unshift(safeJsonParse(serialized, record));
      if (this.fallbackState.notifications.length > 2000) {
        this.fallbackState.notifications.length = 2000;
      }
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  listNotifications({ limit = 80, unreadOnly = false } = {}) {
    this.#assertOpen();
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 80));

    if (this.db) {
      const rows = unreadOnly
        ? this.db
            .prepare("SELECT data_json FROM notifications WHERE is_read = 0 ORDER BY seq DESC LIMIT ?")
            .all(safeLimit)
        : this.db.prepare("SELECT data_json FROM notifications ORDER BY seq DESC LIMIT ?").all(safeLimit);
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }

    return this.fallbackState.notifications
      .filter((item) => (unreadOnly ? !item.read : true))
      .slice(0, safeLimit)
      .map((item) => cloneJson(item));
  }

  markNotificationRead(id) {
    this.#assertOpen();
    const ntfId = String(id || "").trim();
    if (!ntfId) return false;
    const readAt = nowIso();

    if (this.db) {
      const row = this.db.prepare("SELECT data_json FROM notifications WHERE id = ?").get(ntfId);
      if (!row) return false;
      const parsed = safeJsonParse(row.data_json, {});
      const updated = { ...parsed, read: true, readAt: parsed.readAt || readAt };
      const res = this.db
        .prepare("UPDATE notifications SET is_read = 1, data_json = ? WHERE id = ?")
        .run(JSON.stringify(updated), ntfId);
      return Number(res.changes) > 0;
    }

    const found = this.fallbackState.notifications.find((n) => n.id === ntfId);
    if (!found) return false;
    found.read = true;
    found.readAt = found.readAt || readAt;
    this.#flushFallback();
    return true;
  }

  markAllNotificationsRead() {
    this.#assertOpen();
    const readAt = nowIso();

    if (this.db) {
      const rows = this.db
        .prepare("SELECT id, data_json FROM notifications WHERE is_read = 0")
        .all();
      if (rows.length === 0) return 0;
      const updateStmt = this.db.prepare(
        "UPDATE notifications SET is_read = 1, data_json = ? WHERE id = ?"
      );
      for (const row of rows) {
        const parsed = safeJsonParse(row.data_json, {});
        updateStmt.run(JSON.stringify({ ...parsed, read: true, readAt }), row.id);
      }
      return rows.length;
    }

    let count = 0;
    for (const item of this.fallbackState.notifications) {
      if (!item.read) {
        item.read = true;
        item.readAt = readAt;
        count += 1;
      }
    }
    if (count > 0) this.#flushFallback();
    return count;
  }

  // ---------------------------------------------------------------------------
  // 6. CRM Customers, Vouchers & Ledger
  // ---------------------------------------------------------------------------
  listCustomers() {
    this.#assertOpen();
    if (this.db) {
      const rows = this.db
        .prepare("SELECT data_json FROM crm_customers ORDER BY updated_at DESC")
        .all();
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }
    return Object.values(this.fallbackState.crm_customers)
      .map((c) => cloneJson(c))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  getCustomer(ownerUid) {
    this.#assertOpen();
    const uid = String(ownerUid || "").trim();
    if (!uid) return null;

    if (this.db) {
      const row = this.db
        .prepare("SELECT data_json FROM crm_customers WHERE owner_uid = ?")
        .get(uid);
      return row ? safeJsonParse(row.data_json, null) : null;
    }
    const found = this.fallbackState.crm_customers[uid];
    return found ? cloneJson(found) : null;
  }

  upsertCustomer(customerOrUid, maybePatch) {
    this.#assertOpen();
    const payload =
      typeof customerOrUid === "string"
        ? { ...(maybePatch || {}), ownerUid: customerOrUid }
        : { ...(customerOrUid || {}) };
    const ownerUid = String(payload.ownerUid || "").trim();
    if (!ownerUid) {
      throw new Error("ownerUid khách hàng không được để trống");
    }

    const existing = this.getCustomer(ownerUid);
    const now = nowIso();
    const record = {
      ownerUid,
      displayName: payload.displayName ?? existing?.displayName ?? ownerUid,
      contactInfo: payload.contactInfo ?? existing?.contactInfo ?? "",
      tier: payload.tier ?? existing?.tier ?? "standard",
      notes: payload.notes ?? existing?.notes ?? "",
      maxBots: Number.isFinite(Number(payload.maxBots))
        ? Number(payload.maxBots)
        : existing?.maxBots ?? 5,
      totalSpentVnd: Number.isFinite(Number(payload.totalSpentVnd))
        ? Number(payload.totalSpentVnd)
        : existing?.totalSpentVnd ?? 0,
      ...(existing || {}),
      ...payload,
      ownerUid,
      createdAt: existing?.createdAt || payload.createdAt || now,
      updatedAt: now,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO crm_customers (owner_uid, updated_at, data_json)
          VALUES (?, ?, ?)
          ON CONFLICT(owner_uid) DO UPDATE SET
            updated_at = excluded.updated_at,
            data_json = excluded.data_json
        `)
        .run(ownerUid, now, serialized);
    } else {
      this.fallbackState.crm_customers[ownerUid] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  deleteCustomer(ownerUid) {
    this.#assertOpen();
    const uid = String(ownerUid || "").trim();
    if (!uid) return false;

    if (this.db) {
      const res = this.db.prepare("DELETE FROM crm_customers WHERE owner_uid = ?").run(uid);
      return Number(res.changes) > 0;
    }

    if (!(uid in this.fallbackState.crm_customers)) return false;
    delete this.fallbackState.crm_customers[uid];
    this.#flushFallback();
    return true;
  }

  listVouchers() {
    this.#assertOpen();
    if (this.db) {
      const rows = this.db
        .prepare("SELECT data_json FROM crm_vouchers ORDER BY created_at DESC")
        .all();
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }
    return Object.values(this.fallbackState.crm_vouchers)
      .map((v) => cloneJson(v))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  getVoucher(code) {
    this.#assertOpen();
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) return null;

    if (this.db) {
      const row = this.db
        .prepare("SELECT data_json FROM crm_vouchers WHERE code = ?")
        .get(normalized);
      return row ? safeJsonParse(row.data_json, null) : null;
    }
    const found = this.fallbackState.crm_vouchers[normalized];
    return found ? cloneJson(found) : null;
  }

  upsertVoucher(voucher) {
    this.#assertOpen();
    if (!voucher || typeof voucher !== "object") {
      throw new Error("Thông tin voucher không hợp lệ");
    }
    const code = String(voucher.code || "").trim().toUpperCase();
    if (!code) {
      throw new Error("Mã voucher không được để trống");
    }
    const existing = this.getVoucher(code);
    const now = nowIso();
    const record = {
      ...(existing || {}),
      ...voucher,
      code,
      durationPreset: voucher.durationPreset ?? existing?.durationPreset ?? "+30d",
      priceVnd: Number(voucher.priceVnd ?? existing?.priceVnd ?? 0) || 0,
      maxUses: Math.max(1, Number(voucher.maxUses ?? existing?.maxUses ?? 1) || 1),
      usedCount: Math.max(0, Number(voucher.usedCount ?? existing?.usedCount ?? 0) || 0),
      tier: voucher.tier ?? existing?.tier ?? "vip",
      note: voucher.note ?? existing?.note ?? "",
      createdAt: existing?.createdAt || voucher.createdAt || now,
      updatedAt: now,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO crm_vouchers (code, created_at, updated_at, data_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET
            updated_at = excluded.updated_at,
            data_json = excluded.data_json
        `)
        .run(code, record.createdAt, record.updatedAt, serialized);
    } else {
      this.fallbackState.crm_vouchers[code] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  deleteVoucher(code) {
    this.#assertOpen();
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) return false;

    if (this.db) {
      const res = this.db.prepare("DELETE FROM crm_vouchers WHERE code = ?").run(normalized);
      return Number(res.changes) > 0;
    }

    if (!(normalized in this.fallbackState.crm_vouchers)) return false;
    delete this.fallbackState.crm_vouchers[normalized];
    this.#flushFallback();
    return true;
  }

  appendLedger(entry = {}) {
    this.#assertOpen();
    const createdAt = toIsoTimestamp(entry.createdAt, nowIso());
    const id = String(entry.id || `ldg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).trim();
    const record = {
      ...entry,
      id,
      type: entry.type || "voucher_redeem",
      ownerUid: entry.ownerUid ? String(entry.ownerUid) : "",
      botId: entry.botId ? String(entry.botId) : null,
      code: entry.code ? String(entry.code).toUpperCase() : null,
      amountVnd: Number(entry.amountVnd ?? entry.priceVnd ?? 0) || 0,
      actor: entry.actor || "system",
      createdAt,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO crm_ledger (id, owner_uid, bot_id, created_at, data_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(id, record.ownerUid || null, record.botId, createdAt, serialized);
    } else {
      this.fallbackState.crm_ledger.unshift(safeJsonParse(serialized, record));
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  listLedger({ limit = 100, ownerUid, botId } = {}) {
    this.#assertOpen();
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const filterOwner = ownerUid ? String(ownerUid).trim() : "";
    const filterBot = botId ? String(botId).trim() : "";

    if (this.db) {
      const clauses = [];
      const params = [];
      if (filterOwner) {
        clauses.push("owner_uid = ?");
        params.push(filterOwner);
      }
      if (filterBot) {
        clauses.push("bot_id = ?");
        params.push(filterBot);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(safeLimit);
      const rows = this.db
        .prepare(`SELECT data_json FROM crm_ledger ${whereSql} ORDER BY seq DESC LIMIT ?`)
        .all(...params);
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }

    return this.fallbackState.crm_ledger
      .filter((item) => {
        if (filterOwner && item.ownerUid !== filterOwner) return false;
        if (filterBot && item.botId !== filterBot) return false;
        return true;
      })
      .slice(0, safeLimit)
      .map((item) => cloneJson(item));
  }

  // ---------------------------------------------------------------------------
  // 7. Moderation Violations & Blacklist
  // ---------------------------------------------------------------------------
  addViolation(entry = {}) {
    this.#assertOpen();
    const createdAt = toIsoTimestamp(entry.createdAt, nowIso());
    const id = String(entry.id || `vio_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).trim();
    const record = {
      ...entry,
      id,
      botId: entry.botId ? String(entry.botId) : "admin",
      threadId: entry.threadId ? String(entry.threadId) : "",
      senderUid: entry.senderUid || entry.uid || "",
      senderName: entry.senderName || "",
      rule: entry.rule || entry.type || "policy",
      actionTaken: entry.actionTaken || entry.action || "warn",
      createdAt,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO moderation_violations (id, bot_id, thread_id, created_at, data_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(id, record.botId, record.threadId, createdAt, serialized);
      this.db
        .prepare(`
          DELETE FROM moderation_violations
          WHERE seq NOT IN (SELECT seq FROM moderation_violations ORDER BY seq DESC LIMIT 5000)
        `)
        .run();
    } else {
      this.fallbackState.moderation_violations.unshift(safeJsonParse(serialized, record));
      if (this.fallbackState.moderation_violations.length > 5000) {
        this.fallbackState.moderation_violations.length = 5000;
      }
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  listViolations({ limit = 100, botId, threadId } = {}) {
    this.#assertOpen();
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const filterBot = botId ? String(botId).trim() : "";
    const filterThread = threadId ? String(threadId).trim() : "";

    if (this.db) {
      const clauses = [];
      const params = [];
      if (filterBot) {
        clauses.push("bot_id = ?");
        params.push(filterBot);
      }
      if (filterThread) {
        clauses.push("thread_id = ?");
        params.push(filterThread);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(safeLimit);
      const rows = this.db
        .prepare(`SELECT data_json FROM moderation_violations ${whereSql} ORDER BY seq DESC LIMIT ?`)
        .all(...params);
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }

    return this.fallbackState.moderation_violations
      .filter((item) => {
        if (filterBot && item.botId !== filterBot) return false;
        if (filterThread && item.threadId !== filterThread) return false;
        return true;
      })
      .slice(0, safeLimit)
      .map((item) => cloneJson(item));
  }

  clearViolations(botId) {
    this.#assertOpen();
    const filterBot = botId ? String(botId).trim() : "";

    if (this.db) {
      const res = filterBot
        ? this.db.prepare("DELETE FROM moderation_violations WHERE bot_id = ?").run(filterBot)
        : this.db.prepare("DELETE FROM moderation_violations").run();
      return Number(res.changes) || 0;
    }

    const before = this.fallbackState.moderation_violations.length;
    this.fallbackState.moderation_violations = filterBot
      ? this.fallbackState.moderation_violations.filter((v) => v.botId !== filterBot)
      : [];
    const removed = before - this.fallbackState.moderation_violations.length;
    if (removed > 0) this.#flushFallback();
    return removed;
  }

  listBlacklist() {
    this.#assertOpen();
    if (this.db) {
      const rows = this.db
        .prepare("SELECT data_json FROM uid_blacklist ORDER BY updated_at DESC")
        .all();
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }
    return Object.values(this.fallbackState.uid_blacklist)
      .map((item) => cloneJson(item))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  upsertBlacklist({ uid, reason = "", scope = "global", botId = null, actor = "admin" } = {}) {
    this.#assertOpen();
    const cleanUid = String(uid || "").trim();
    if (!cleanUid) {
      throw new Error("UID đưa vào danh sách đen không được để trống");
    }
    const now = nowIso();
    let existing = null;
    if (this.db) {
      const row = this.db.prepare("SELECT data_json FROM uid_blacklist WHERE uid = ?").get(cleanUid);
      existing = row ? safeJsonParse(row.data_json, null) : null;
    } else {
      existing = this.fallbackState.uid_blacklist[cleanUid] || null;
    }

    const record = {
      uid: cleanUid,
      reason: String(reason ?? existing?.reason ?? ""),
      scope: String(scope || existing?.scope || "global"),
      botId: botId !== undefined ? botId : existing?.botId ?? null,
      actor: String(actor || existing?.actor || "admin"),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO uid_blacklist (uid, scope, bot_id, updated_at, data_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(uid) DO UPDATE SET
            scope = excluded.scope,
            bot_id = excluded.bot_id,
            updated_at = excluded.updated_at,
            data_json = excluded.data_json
        `)
        .run(cleanUid, record.scope, record.botId, now, serialized);
    } else {
      this.fallbackState.uid_blacklist[cleanUid] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  removeBlacklist(uid) {
    this.#assertOpen();
    const cleanUid = String(uid || "").trim();
    if (!cleanUid) return false;

    if (this.db) {
      const res = this.db.prepare("DELETE FROM uid_blacklist WHERE uid = ?").run(cleanUid);
      return Number(res.changes) > 0;
    }

    if (!(cleanUid in this.fallbackState.uid_blacklist)) return false;
    delete this.fallbackState.uid_blacklist[cleanUid];
    this.#flushFallback();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 8. Campaigns & Metric Buckets
  // ---------------------------------------------------------------------------
  listCampaigns() {
    this.#assertOpen();
    if (this.db) {
      const rows = this.db
        .prepare("SELECT data_json FROM campaigns ORDER BY updated_at DESC, created_at DESC")
        .all();
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }
    return Object.values(this.fallbackState.campaigns)
      .map((c) => cloneJson(c))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  getCampaign(id) {
    this.#assertOpen();
    const cmpId = String(id || "").trim();
    if (!cmpId) return null;

    if (this.db) {
      const row = this.db.prepare("SELECT data_json FROM campaigns WHERE id = ?").get(cmpId);
      return row ? safeJsonParse(row.data_json, null) : null;
    }
    const found = this.fallbackState.campaigns[cmpId];
    return found ? cloneJson(found) : null;
  }

  upsertCampaign(campaign) {
    this.#assertOpen();
    if (!campaign || typeof campaign !== "object") {
      throw new Error("Thông tin chiến dịch không hợp lệ");
    }
    const now = nowIso();
    const id = String(campaign.id || `cmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).trim();
    const existing = this.getCampaign(id);

    const record = {
      ...(existing || {}),
      ...campaign,
      id,
      status: String(campaign.status || existing?.status || "draft"),
      createdAt: existing?.createdAt || campaign.createdAt || now,
      updatedAt: now,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT INTO campaigns (id, status, created_at, updated_at, data_json)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at,
            data_json = excluded.data_json
        `)
        .run(id, record.status, record.createdAt, record.updatedAt, serialized);
    } else {
      this.fallbackState.campaigns[id] = safeJsonParse(serialized, record);
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  deleteCampaign(id) {
    this.#assertOpen();
    const cmpId = String(id || "").trim();
    if (!cmpId) return false;

    if (this.db) {
      const res = this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(cmpId);
      return Number(res.changes) > 0;
    }

    if (!(cmpId in this.fallbackState.campaigns)) return false;
    delete this.fallbackState.campaigns[cmpId];
    this.#flushFallback();
    return true;
  }

  insertMetricBucket(point = {}) {
    this.#assertOpen();
    const bucketTs = toIsoTimestamp(point.timestamp || point.bucketTs || point.createdAt, nowIso());
    const id = String(point.id || `met_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).trim();
    const botId = String(point.botId || "all").trim() || "all";
    const record = {
      ...point,
      id,
      botId,
      timestamp: bucketTs,
      bucketTs,
    };
    const serialized = JSON.stringify(record);

    if (this.db) {
      this.db
        .prepare(`
          INSERT OR REPLACE INTO metric_buckets (id, bot_id, bucket_ts, data_json)
          VALUES (?, ?, ?, ?)
        `)
        .run(id, botId, bucketTs, serialized);
    } else {
      this.fallbackState.metric_buckets.push(safeJsonParse(serialized, record));
      this.#flushFallback();
    }

    return safeJsonParse(serialized, record);
  }

  queryMetricBuckets({ sinceIso, botId } = {}) {
    this.#assertOpen();
    const filterSince = sinceIso ? toIsoTimestamp(sinceIso, "") : "";
    const filterBot = botId ? String(botId).trim() : "";

    if (this.db) {
      const clauses = [];
      const params = [];
      if (filterSince) {
        clauses.push("bucket_ts >= ?");
        params.push(filterSince);
      }
      if (filterBot) {
        clauses.push("bot_id = ?");
        params.push(filterBot);
      }
      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db
        .prepare(`SELECT data_json FROM metric_buckets ${whereSql} ORDER BY bucket_ts ASC`)
        .all(...params);
      return rows.map((row) => safeJsonParse(row.data_json, null)).filter(Boolean);
    }

    return this.fallbackState.metric_buckets
      .filter((item) => {
        if (filterSince && String(item.bucketTs || item.timestamp || "") < filterSince) return false;
        if (filterBot && item.botId !== filterBot) return false;
        return true;
      })
      .sort((a, b) =>
        String(a.bucketTs || a.timestamp || "").localeCompare(
          String(b.bucketTs || b.timestamp || "")
        )
      )
      .map((item) => cloneJson(item));
  }

  pruneOldMetrics(olderThanIso) {
    this.#assertOpen();
    if (!olderThanIso) return 0;
    const cutoff = toIsoTimestamp(olderThanIso, "");
    if (!cutoff) return 0;

    if (this.db) {
      const res = this.db
        .prepare("DELETE FROM metric_buckets WHERE bucket_ts < ?")
        .run(cutoff);
      return Number(res.changes) || 0;
    }

    const before = this.fallbackState.metric_buckets.length;
    this.fallbackState.metric_buckets = this.fallbackState.metric_buckets.filter(
      (item) => String(item.bucketTs || item.timestamp || "") >= cutoff
    );
    const removed = before - this.fallbackState.metric_buckets.length;
    if (removed > 0) this.#flushFallback();
    return removed;
  }

  // ---------------------------------------------------------------------------
  // 9. Lifecycle Cleanup
  // ---------------------------------------------------------------------------
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.db) {
      try {
        this.db.close();
      } catch {}
      this.db = null;
    }
    for (const [key, cached] of sharedStores.entries()) {
      if (cached === this) sharedStores.delete(key);
    }
  }
}

export function getSharedControlStore(root = process.cwd()) {
  const resolvedRoot = path.resolve(root);
  const existing = sharedStores.get(resolvedRoot);
  if (existing && !existing.closed) {
    return existing;
  }
  const store = new ControlPlaneStore({ root: resolvedRoot });
  sharedStores.set(resolvedRoot, store);
  return store;
}
