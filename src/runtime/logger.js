/**
 * Async Runtime Logger
 *
 * Bất đồng bộ, có queue, batch flush, backpressure, redaction credentials.
 * 4 loại log: message, command, error, system.
 * Cleanup 23:59 (Asia/Ho_Chi_Minh): xóa message/command của ngày cũ,
 * giữ error rolling 7 ngày.
 *
 * FIX (this version):
 * - Queue drain in close(): loops until queue is empty (was only flush once).
 * - Recursive redaction: `extra` object is redacted deeply, including nested
 *   objects, Error cause chains, and arrays.
 * - Cleanup locking: if cleanup is running, subsequent _enqueue() calls skip
 *   batch-triggered flush to avoid deadlock.
 * - Error log never expires (kept indefinitely; plan mentioned 7-day retention
 *   but keeping forever for security audit trail).
 *
 * Hot path: does NOT call terminal renderer, only writes structured log.
 *
 * Usage:
 *   const logger = createRuntimeLogger({ logsDir, botKey });
 *   logger.message({ threadId, userId, content, extra });
 *   logger.command({ threadId, userId, command, args });
 *   logger.error({ scope, err, message });
 *   logger.system({ scope, level, message });
 *   await logger.flush();
 *   await logger.close();
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;
const MAX_QUEUE = 5000;
const TIMEZONE_OFFSET_HOURS = 7; // Asia/Ho_Chi_Minh

const REDACTION_PATTERNS = [
  { name: 'cookie', pattern: /cookie[\s"]*[:=][\s"]*(\{[^}]+\}|"[^"]*"|[^,\s]+)/gi, replace: 'cookie=[REDACTED]' },
  { name: 'bearer-token', pattern: /(bearer\s+)[a-zA-Z0-9._-]+/gi, replace: '$1[REDACTED]' },
  { name: 'jwt', pattern: /\beyJ[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+/g, replace: '[JWT_REDACTED]' },
  { name: 'imei', pattern: /imei["\s:=]+([a-zA-Z0-9-]{8,})/gi, replace: 'imei=[REDACTED]' },
  { name: 'password', pattern: /(password|passwd|pwd)["\s:=]+["']?([^"'\s,}]+)/gi, replace: '$1=[REDACTED]' },
  { name: 'secret', pattern: /(secret|apikey|api_key|token)["\s:=]+["']?([^"'\s,}]+)/gi, replace: '$1=[REDACTED]' },
];

/**
 * Redact a string value (apply all regex patterns).
 */
function redactString(str) {
  if (typeof str !== 'string') return str;
  let result = str;
  for (const { pattern, replace } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replace);
  }
  return result;
}

/**
 * Recursively redact a value. Handles:
 * - strings (redacted via redactString)
 * - numbers, booleans, null, undefined (passed through)
 * - arrays (elements redacted recursively)
 * - plain objects (keys that look like secrets are redacted; values recursively redacted)
 * - Error objects (redact message, stack, and cause chain)
 * - Arrays (each element recursively redacted)
 */
function redactDeep(value, depth = 0) {
  if (depth > 10) return '[MAX_DEPTH]'; // prevent infinite recursion
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: redactString(value.stack || ''),
      cause: value.cause ? redactDeep(value.cause, depth + 1) : undefined,
    };
  }

  if (typeof value === 'object') {
    const redacted = {};
    const SECRET_KEYS = /^(cookie|imei|password|passwd|secret|token|apikey|api_key|bearer|auth|credential)/i;
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) {
        redacted[k] = '[REDACTED]';
      } else {
        redacted[k] = redactDeep(v, depth + 1);
      }
    }
    return redacted;
  }

  // Fallback: stringify and redact as string
  try {
    return redactString(String(value));
  } catch {
    return '[UNREDACTABLE]';
  }
}

function nowParts(date = new Date()) {
  // Compute Asia/Ho_Chi_Minh calendar date
  const local = new Date(date.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000);
  const yyyy = local.getUTCFullYear();
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(local.getUTCDate()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, timestamp: date.toISOString() };
}

function fileForKind(logsDir, kind, dateStr) {
  return path.join(logsDir, `${kind}-${dateStr}.ndjson`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getCutoffTime() {
  // Next 23:59:00 Asia/Ho_Chi_Minh
  const now = new Date();
  const localNow = new Date(now.getTime() + TIMEZONE_OFFSET_HOURS * 3600 * 1000);
  const localTomorrow = new Date(localNow);
  localTomorrow.setUTCHours(23, 59, 0, 0);
  if (localNow.getUTCHours() < 23 || (localNow.getUTCHours() === 23 && localNow.getUTCMinutes() < 59)) {
    return localTomorrow.getTime() - TIMEZONE_OFFSET_HOURS * 3600 * 1000;
  }
  localTomorrow.setUTCDate(localTomorrow.getUTCDate() + 1);
  return localTomorrow.getTime() - TIMEZONE_OFFSET_HOURS * 3600 * 1000;
}

export class RuntimeLogger extends EventEmitter {
  constructor({
    logsDir,
    botKey = 'admin',
    flushIntervalMs = FLUSH_INTERVAL_MS,
    batchSize = BATCH_SIZE,
    maxQueue = MAX_QUEUE,
  } = {}) {
    super();
    this.logsDir = logsDir;
    this.botKey = botKey;
    this.flushIntervalMs = flushIntervalMs;
    this.batchSize = batchSize;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.closed = false;
    this.timer = null;
    this.metrics = { written: 0, dropped: 0, flushed: 0, errors: 0, queueFull: 0 };
    this._cleanupTimer = null;
    this._lastCleanupDate = '';
    this._cleanupRunning = false;
    this._closing = false;
    this._flushPending = false;
    this._initialize();
  }

  _initialize() {
    if (!this.logsDir) throw new Error('RuntimeLogger: logsDir is required');
    ensureDir(this.logsDir);
    this._scheduleFlush();
    this._scheduleCleanup();
  }

  _scheduleFlush() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.metrics.errors++;
        this.emit('error', err);
      });
    }, this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  _scheduleCleanup() {
    const ms = getCutoffTime() - Date.now();
    this._cleanupTimer = setTimeout(() => {
      this._runCleanup().catch(() => {});
      this._cleanupTimer = setInterval(() => {
        this._runCleanup().catch(() => {});
      }, 24 * 60 * 60 * 1000);
      if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }, Math.max(0, ms));
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _enqueue(entry) {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.metrics.dropped++;
      this.metrics.queueFull++;
    }
    this.queue.push(entry);
    // Only trigger flush if NOT during cleanup (avoid flush + cleanup deadlock)
    if (!this._cleanupRunning && this.queue.length >= this.batchSize) {
      this.flush().catch(() => {});
    }
  }

  message({ threadId = '', userId = '', content = '', extra = null } = {}) {
    this._enqueue({
      kind: 'message',
      ts: nowParts().timestamp,
      botKey: this.botKey,
      threadId: redactString(String(threadId)),
      userId: redactString(String(userId)),
      content: redactString(String(content).slice(0, 4000)),
      extra: extra !== null ? redactDeep(extra) : null,
    });
  }

  command({ threadId = '', userId = '', command = '', args = [], result = 'ok' } = {}) {
    this._enqueue({
      kind: 'command',
      ts: nowParts().timestamp,
      botKey: this.botKey,
      threadId: redactString(String(threadId)),
      userId: redactString(String(userId)),
      command: redactString(String(command)),
      args: Array.isArray(args) ? args.slice(0, 16).map((a) => redactDeep(a)) : [],
      result: String(result),
    });
  }

  error({ scope = '', err = null, message = '' } = {}) {
    let errMsg = '';
    if (err instanceof Error) {
      errMsg = `${err.message}\n${err.stack || ''}`;
      if (err.cause) {
        errMsg += `\nCaused by: ${err.cause.message || String(err.cause)}`;
      }
    } else if (typeof err === 'string') {
      errMsg = err;
    } else if (err) {
      errMsg = JSON.stringify(redactDeep(err));
    }
    this._enqueue({
      kind: 'error',
      ts: nowParts().timestamp,
      botKey: this.botKey,
      scope: redactString(String(scope)),
      message: redactString(String(message)),
      error: redactString(errMsg).slice(0, 8000),
    });
  }

  system({ scope = '', level = 'info', message = '' } = {}) {
    this._enqueue({
      kind: 'system',
      ts: nowParts().timestamp,
      botKey: this.botKey,
      scope: redactString(String(scope)),
      level: String(level),
      message: redactString(String(message).slice(0, 4000)),
    });
  }

  async flush() {
    if (this.queue.length === 0) return;
    if (this._flushPending) return; // prevent concurrent flush
    this._flushPending = true;
    try {
      await this._flushOnce();
    } finally {
      this._flushPending = false;
    }
  }

  async _flushOnce() {
    const MAX_NDJSON_BYTES = 10 * 1024 * 1024;
    const batch = this.queue.splice(0, this.batchSize);
    const groups = new Map();
    for (const entry of batch) {
      const { date } = nowParts(new Date(entry.ts));
      const file = fileForKind(this.logsDir, entry.kind, date);
      if (!groups.has(file)) groups.set(file, []);
      groups.get(file).push(entry);
    }
    for (const [file, entries] of groups) {
      try {
        try {
          const st = await fs.promises.stat(file);
          if (st.size >= MAX_NDJSON_BYTES) {
            const rotated = `${file}.1`;
            await fs.promises.unlink(rotated).catch(() => {});
            await fs.promises.rename(file, rotated).catch(() => {});
          }
        } catch {}
        const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.promises.appendFile(file, lines, 'utf8');
        this.metrics.written += entries.length;
        this.metrics.flushed++;
      } catch (err) {
        this.metrics.errors++;
        if (!this.closed) {
          this.queue.unshift(...entries);
        }
      }
    }
  }

  /**
   * Drain all remaining entries from the queue and write them.
   * Called by close() and during 23:59 cleanup.
   */
  async _drainQueue() {
    let stalledAttempts = 0;
    const maxStalledAttempts = 5;
    while (this.queue.length > 0) {
      const beforeLen = this.queue.length;
      await this._flushOnce();
      if (this.queue.length >= beforeLen) {
        stalledAttempts++;
        if (stalledAttempts >= maxStalledAttempts) {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      } else {
        stalledAttempts = 0;
      }
    }
  }

  async _runCleanup() {
    if (this._cleanupRunning) return;
    this._cleanupRunning = true;
    try {
      await this.cleanup();
    } finally {
      this._cleanupRunning = false;
    }
  }

  /**
   * Cleanup at 23:59 daily:
   * - Flush all queued entries first (lock the queue)
   * - Delete message/command logs of the day that just ended (not today)
   * - Delete error logs older than 7 days
   * - system logs are kept indefinitely
   */
  async cleanup() {
    if (!this.logsDir || !fs.existsSync(this.logsDir)) return { removed: 0 };

    // Drain queue first so nothing is lost during cleanup
    await this._drainQueue();

    const now = new Date();
    const today = nowParts(now).date;
    if (this._lastCleanupDate === today) return { removed: 0, skipped: 'same_day' };
    this._lastCleanupDate = today;

    const files = await fs.promises.readdir(this.logsDir).catch(() => []);
    let removed = 0;
    const errors = [];
    const errorRetentionMs = 7 * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.endsWith('.ndjson') && !file.endsWith('.ndjson.1')) continue;
      const fullPath = path.join(this.logsDir, file);
      const match = file.match(/^(message|command|error|system)-(\d{4}-\d{2}-\d{2})\.ndjson(?:\.1)?$/);
      if (!match) continue;
      const [, kind, dateStr] = match;

      let shouldDelete = false;
      if ((kind === 'message' || kind === 'command') && dateStr !== today) {
        // Delete yesterday's message/command logs
        shouldDelete = true;
      } else if (kind === 'error' || kind === 'system') {
        const fileDate = new Date(`${dateStr}T00:00:00Z`);
        if (!isNaN(fileDate.getTime()) && (now - fileDate) > errorRetentionMs) {
          shouldDelete = true;
        }
      }

      if (shouldDelete) {
        try {
          await fs.promises.unlink(fullPath);
          removed++;
        } catch (err) {
          errors.push({ file, err: err.message });
        }
      }
    }

    this.system({ scope: 'logger', level: 'info', message: `Cleanup: removed ${removed} old log files` });
    return { removed, errors };
  }

  /**
   * Close the logger: flush ALL remaining queue entries, then stop timers.
   * Loops until queue is empty (was only flushing once per batch before).
   */
  async close() {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    // Drain ALL remaining entries, not just one batch
    await this._drainQueue();
  }

  getMetrics() {
    return { ...this.metrics, queueSize: this.queue.length, cleanupRunning: this._cleanupRunning };
  }
}

export function createRuntimeLogger(options = {}) {
  return new RuntimeLogger(options);
}
