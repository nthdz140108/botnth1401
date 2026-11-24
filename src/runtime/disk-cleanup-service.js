/**
 * DiskCleanupService — unified SSD disk cleanup engine for VPS.
 *
 * Coordinates safe automated disk cleanup:
 * - temp directories (assets/temp, temp, mybot/instances/{id}/temp, .tmp-qr-concurrency-*)
 * - OS temp matching MyBot-specific prefixes only
 * - Gemini Chrome caches (Cache, Code Cache, GPUCache, ShaderCache, .downloads)
 * - Normal logs (bot-stdout, message.txt, dashboard logs, root test logs)
 * - PM2 stdout/stderr logs of MyBot fleet (truncated safely on Windows)
 * - Error/system/audit logs and backups (retained for 7 days)
 *
 * Safety boundaries:
 * - Credentials, databases, registry, game state, UNDO, spool, and login cookies are NEVER touched.
 * - Symlinks pointing outside allowlists are rejected.
 * - Open/locked/active files are recorded and deferred to next cycle.
 * - Truncates PM2 logs in-place without invalidating handles or unlinking.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMyBotProcess } from './pm2-adapter.js';
import { isTempFileLeased } from '../utils/temp-lease-manager.js';

export const MYBOT_TEMP_PREFIXES = [
  'gemini-out-',
  'mybot-updater-bundle-',
  'admin-recovery-qr-',
  'giftext_',
  'download_',
  'mybot-dl-',
  'sticker-job-',
];

export const RETENTION_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const STALE_TEMP_MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const WARN_LOG_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB
export const MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024; // 10MB hard cap
export const DEFAULT_DEADLINE_MS = 290_000; // 290s

/**
 * Vietnam time is UTC+7 with no daylight saving time (always 7 hours offset).
 * 23:55:00 in Vietnam (UTC+7) corresponds exactly to 16:55:00 UTC.
 */
export function getNext2355Timestamp(fromMs = Date.now()) {
  const date = new Date(fromMs);
  const todayTarget = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    16, 55, 0, 0
  );

  if (fromMs < todayTarget) {
    return todayTarget;
  }
  return todayTarget + 24 * 60 * 60 * 1000;
}

/**
 * Safely test if childPath is strictly contained inside parentDir.
 * Resolves symlinks/junctions via realpath to prevent path escape.
 */
export function isPathContained(childPath, parentDir) {
  if (!childPath || !parentDir) return false;
  try {
    const parentResolved = path.resolve(parentDir);
    let parentReal = parentResolved;
    try {
      parentReal = fs.realpathSync(parentResolved);
    } catch {}

    const childResolved = path.resolve(childPath);
    let childReal = childResolved;
    try {
      childReal = fs.realpathSync(childResolved);
    } catch {
      // If child does not exist yet, resolve ancestor realpath + relative remainder
      let cur = path.dirname(childResolved);
      while (cur && cur !== path.dirname(cur)) {
        try {
          const ancReal = fs.realpathSync(cur);
          const remainder = path.relative(cur, childResolved);
          childReal = path.resolve(ancReal, remainder);
          break;
        } catch {
          cur = path.dirname(cur);
        }
      }
    }

    const isWindows = process.platform === 'win32';
    const normParent = isWindows ? parentReal.toLowerCase() : parentReal;
    const normChild = isWindows ? childReal.toLowerCase() : childReal;

    const rel = path.relative(normParent, normChild);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function getDiskUsage(targetPath = process.cwd()) {
  try {
    const stats = await fs.promises.statfs(targetPath);
    const total = stats.bsize * stats.blocks;
    const free = stats.bsize * stats.bavail;
    const used = total - free;
    const usedPercent = total > 0 ? Number(((used / total) * 100).toFixed(2)) : 0;
    return { total, free, used, usedPercent };
  } catch (err) {
    return { total: 0, free: 0, used: 0, usedPercent: 0, error: err.message };
  }
}

/**
 * Shared classification policy for log files across all directory depths.
 *
 * Rules:
 * - Routine logs: message/command, message.txt, bot-manager.log, stdout/stderr, test logs.
 * - Aged logs (7-day retention): error-*, system-*, audit, authorization, admin-role, backup.
 * - Actively appended audit logs: rotate if oversized, archive kept for 7 days.
 * - PM2 logs starting with 'pm2-': skipped from filesystem walk and resolved via adapter.
 */
export function classifyLogFile(fileName, fullPath, stat, nowMs) {
  const base = fileName.toLowerCase();

  // 1. Aged retention group: 7-day retention
  const isErrorLog = (
    /^error[-._]/i.test(base) ||
    /[-._]error\.(log|ndjson|jsonl|txt)$/i.test(base) ||
    base === 'error.log' ||
    base === 'error.ndjson' ||
    base === 'error.jsonl' ||
    base.startsWith('error')
  );

  const isSystemLog = (
    /^system[-._]/i.test(base) ||
    /[-._]system\.(log|ndjson|jsonl|txt)$/i.test(base) ||
    base === 'system.log' ||
    base === 'system.ndjson' ||
    base === 'system.jsonl' ||
    base.startsWith('system')
  );

  const isAuditLog = /audit/i.test(base);
  const isAuthLog = /authorization/i.test(base);
  const isAdminRoleLog = /admin-role/i.test(base);
  const isBackup = (
    /\.(bak|backup)$/i.test(base) ||
    fullPath.includes(`${path.sep}backups${path.sep}`) ||
    fullPath.endsWith(`${path.sep}backups`) ||
    fullPath.includes('qr-bootstrap-')
  );

  if (isErrorLog || isSystemLog || isAuditLog || isAuthLog || isAdminRoleLog || isBackup) {
    const isActivelyAppendedAudit = (
      base === 'authorization-decisions.jsonl' ||
      base === 'admin-role-audit.jsonl' ||
      base === 'dashboard-audit.jsonl' ||
      base === 'audit.jsonl'
    );

    const isOldEnough = (nowMs - stat.mtimeMs) >= RETENTION_7_DAYS_MS;

    return {
      type: 'aged',
      group: 'agedLogs',
      isActivelyAppendedAudit,
      isOldEnough,
      truncate: false,
    };
  }

  // 2. PM2 logs are handled exclusively via PM2 fleet discovery
  if (base.startsWith('pm2-')) {
    return { type: 'pm2_skip' };
  }

  // 3. Routine logs: truncated in place
  return {
    type: 'routine',
    group: 'normalLogs',
    truncate: true,
  };
}

export class DiskCleanupService {
  constructor({
    projectRoot = process.cwd(),
    tempDir = null,
    geminiProfileDir = null,
    adapter = null,
    statusPath = null,
    observationsPath = null,
    now = () => Date.now(),
    logger = console,
    warnPercent = 80,
    criticalPercent = 90,
    warnLogSizeLimit = WARN_LOG_SIZE_LIMIT,
  } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.tempDir = tempDir ? path.resolve(tempDir) : os.tmpdir();
    this.geminiProfileDir = geminiProfileDir
      ? path.resolve(geminiProfileDir)
      : path.resolve(process.env.GEMINI_WEB_PROFILE_DIR || path.join(this.projectRoot, '.runtime', 'gemini-web', 'user-data'));
    this.adapter = adapter;
    this.statusPath = statusPath || path.join(this.projectRoot, '.runtime', 'disk-cleanup', 'status.json');
    this.observationsPath = observationsPath || path.join(this.projectRoot, '.runtime', 'disk-cleanup', 'observations.json');
    this.now = now;
    this.logger = logger;
    this.warnPercent = warnPercent;
    this.criticalPercent = criticalPercent;
    this.warnLogSizeLimit = warnLogSizeLimit;

    this._lastStatus = null;
    this._tempObservations = this._loadObservations();
  }

  _loadObservations() {
    const map = new Map();
    try {
      if (fs.existsSync(this.observationsPath)) {
        const raw = fs.readFileSync(this.observationsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [k, v] of Object.entries(parsed)) {
            map.set(k, v);
          }
        }
      }
    } catch {}
    return map;
  }

  _saveObservations() {
    try {
      const dir = path.dirname(this.observationsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Prune dead files from observation cache
      const payload = {};
      for (const [filePath, obs] of this._tempObservations.entries()) {
        try {
          if (fs.existsSync(filePath)) {
            payload[filePath] = obs;
          }
        } catch {}
      }

      const tmpPath = `${this.observationsPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.observationsPath);
    } catch (err) {
      this.logger.error('[DISK-CLEANUP] Failed to save observations:', err.message);
    }
  }

  /**
   * Check if a path is strictly contained within any allowed temp root.
   */
  isAllowedTempPath(targetPath) {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);

    // 1. Assets temp: <projectRoot>/assets/temp
    const assetsTemp = path.join(this.projectRoot, 'assets', 'temp');
    if (isPathContained(resolved, assetsTemp)) return true;

    // 2. Project root temp: <projectRoot>/temp
    const rootTemp = path.join(this.projectRoot, 'temp');
    if (isPathContained(resolved, rootTemp)) return true;

    // 3. Instances temp: <projectRoot>/mybot/instances/<id>/temp
    const instancesDir = path.join(this.projectRoot, 'mybot', 'instances');
    const relInst = path.relative(instancesDir, resolved);
    if (!relInst.startsWith('..') && !path.isAbsolute(relInst)) {
      const parts = relInst.split(path.sep);
      if (parts.length >= 2 && parts[1] === 'temp') {
        const instTempRoot = path.join(instancesDir, parts[0], 'temp');
        if (isPathContained(resolved, instTempRoot)) return true;
      }
    }

    // 4. Temporary concurrency dirs: <projectRoot>/.tmp-qr-concurrency-*
    const relRoot = path.relative(this.projectRoot, resolved);
    if (!relRoot.startsWith('..') && !path.isAbsolute(relRoot)) {
      const parts = relRoot.split(path.sep);
      if (parts.length >= 2 && parts[0].startsWith('.tmp-qr-concurrency-')) {
        const concRoot = path.join(this.projectRoot, parts[0]);
        if (isPathContained(resolved, concRoot)) return true;
      }
    }

    // 4b. Transient QR cache, sandboxed .runtime/temp, temp scopes, and bootstrap/reload state files
    const runtimeTempDir = path.join(this.projectRoot, '.runtime', 'temp');
    const runtimeLeaseDir = path.join(runtimeTempDir, '.leases');
    if (isPathContained(resolved, runtimeTempDir) && !isPathContained(resolved, runtimeLeaseDir) && resolved.toLowerCase() !== runtimeLeaseDir.toLowerCase()) {
      return true;
    }
    const cacheDir = path.join(this.projectRoot, '.cache');
    if (isPathContained(resolved, cacheDir)) return true;
    const tempScopesDir = path.join(this.projectRoot, '.runtime', 'temp-scopes');
    if (isPathContained(resolved, tempScopesDir)) return true;
    const qrBootstrapStateDir = path.join(this.projectRoot, 'mybot', 'state', 'qr-bootstrap');
    if (isPathContained(resolved, qrBootstrapStateDir)) return true;
    const reloadStateDir = path.join(this.projectRoot, 'mybot', 'state', 'reload');
    if (isPathContained(resolved, reloadStateDir)) return true;

    // 5. System temp with MyBot prefixes ONLY
    const relTemp = path.relative(this.tempDir, resolved);
    if (!relTemp.startsWith('..') && !path.isAbsolute(relTemp)) {
      const parts = relTemp.split(path.sep);
      if (parts.length >= 1 && MYBOT_TEMP_PREFIXES.some((prefix) => parts[0].startsWith(prefix))) {
        const pRoot = path.join(this.tempDir, parts[0]);
        if (isPathContained(resolved, pRoot) || resolved.toLowerCase() === pRoot.toLowerCase()) return true;
      }
    }

    return false;
  }

  /**
   * Determine if a given path is forbidden to clean under any circumstance.
   */
  isForbidden(targetPath) {
    if (!targetPath) return true;
    const resolved = path.resolve(targetPath);
    const base = path.basename(resolved).toLowerCase();

    // 1. Credentials and secrets
    if (/^\.env($|\.)/i.test(base)) return true;
    if (/(token|secret|credential|password)/i.test(base) && !base.endsWith('.log') && !base.endsWith('.jsonl')) return true;

    // 2. Registry and configuration files
    if (base === 'mybots.json' || base === 'groupsettings.json' || base === 'group_settings.json') return true;
    if (base === 'config.json' && !this.isAllowedTempPath(resolved)) return true;
    if (resolved.includes(path.join('mybot', 'bots')) && base.endsWith('.json')) return true;

    // 3. Databases
    if (/\.(db|sqlite|sqlite3|db-wal|db-shm|sql)$/i.test(base)) return true;

    // 4. Game state and user profile/balance data
    if (resolved.includes(path.join('mybot', 'instances')) && resolved.includes(path.join('data'))) return true;
    if (/(taixiu|fishing|ranking|nong-trai)/i.test(base) && base.endsWith('.json')) return true;

    // 5. UNDO and message cache retention
    if (/undo.*\.json$/i.test(base) || base === 'message.json') return true;

    // 6. Runtime spool
    if (resolved.includes(path.join('.runtime', 'spool')) || /\.(spool|unack)$/i.test(base)) return true;

    // 7. Hard protection for media, video, assets/data, assets/resources
    const norm = resolved.replace(/\\/g, '/').toLowerCase();
    if (/(^|\/)media(\/|$)/i.test(norm)) return true;
    if (/(^|\/)video(\/|$)/i.test(norm)) return true;
    if (/(^|\/)assets\/data(\/|$)/i.test(norm)) return true;
    if (/(^|\/)assets\/resources(\/|$)/i.test(norm)) return true;

    // 8. Specific protected media files like linhcute.mp3 or any audio/video outside allowed temp roots
    if (base === 'linhcute.mp3') return true;
    if (/\.(mp3|mp4|png|jpg|jpeg|gif|webp|wav|ogg|m4a|aac|flac|mkv|webm)$/i.test(base)) {
      if (!this.isAllowedTempPath(resolved)) {
        return true;
      }
    }

    // 9. Gemini Chrome login credentials, cookies, preferences, storage
    if (resolved.startsWith(this.geminiProfileDir)) {
      if (/(cookies|login data|web data|local storage|session storage|indexeddb|preferences|secure preferences|singletonlock)/i.test(resolved)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Safely check symlinks and reparse points / directory junctions.
   * Rejects symlinks pointing outside allowed base directories.
   */
  isSafeSymlink(filePath, allowedBaseDir) {
    try {
      const lstat = fs.lstatSync(filePath);
      if (lstat.isSymbolicLink() || lstat.isDirectory()) {
        const real = fs.realpathSync(filePath);
        return isPathContained(real, allowedBaseDir) || real.toLowerCase() === path.resolve(allowedBaseDir).toLowerCase();
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Async directory traversal with yield to avoid blocking Node.js event loop
   * and respect deadline / abort signals.
   */
  async _walkDirAsync(dirPath, onFile, { group = 'temp', minAgeMs = 0, deadline = Infinity, signal = null } = {}) {
    if (!fs.existsSync(dirPath)) return;
    if (signal?.aborted || this.now() >= deadline) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    // Yield to the event loop on every directory visit
    await new Promise((resolve) => setImmediate(resolve));

    const nowMs = this.now();
    for (const entry of entries) {
      if (signal?.aborted || this.now() >= deadline) break;

      const fullPath = path.join(dirPath, entry.name);
      if (!this.isSafeSymlink(fullPath, dirPath)) continue;
      if (this.isForbidden(fullPath)) continue;

      if (entry.isDirectory()) {
        await this._walkDirAsync(fullPath, onFile, { group, minAgeMs, deadline, signal });
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (minAgeMs > 0 && (nowMs - stat.mtimeMs) < minAgeMs) {
            continue;
          }
          await onFile({
            name: entry.name,
            path: fullPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            group,
          });
        } catch {}
      }
    }
  }

  /**
   * Evaluate temp candidate file under safe stale policy:
   * - Must be unchanged across at least two observations.
   * - Must be at least 2 hours old.
   * - Otherwise deferred.
   */
  _evaluateTempCandidate(item, nowMs) {
    if (isTempFileLeased(item.path, { projectRoot: this.projectRoot, now: nowMs })) {
      return { eligible: false, reason: 'active_temp_lease' };
    }
    const prev = this._tempObservations.get(item.path);

    if (!prev) {
      // First observation: defer
      this._tempObservations.set(item.path, {
        size: item.size,
        mtimeMs: item.mtimeMs,
        firstObservedAt: nowMs,
        lastObservedAt: nowMs,
        count: 1,
      });
      return { eligible: false, reason: 'unobserved_first_pass' };
    }

    // Check if modified between observations (active write)
    if (prev.size !== item.size || prev.mtimeMs !== item.mtimeMs) {
      this._tempObservations.set(item.path, {
        size: item.size,
        mtimeMs: item.mtimeMs,
        firstObservedAt: nowMs,
        lastObservedAt: nowMs,
        count: 1,
      });
      return { eligible: false, reason: 'active_modified' };
    }

    // Unchanged
    const count = (prev.count || 1) + 1;
    this._tempObservations.set(item.path, {
      ...prev,
      lastObservedAt: nowMs,
      count,
    });

    if (count < 2) {
      return { eligible: false, reason: 'insufficient_observations' };
    }

    const ageMs = nowMs - item.mtimeMs;
    if (ageMs < STALE_TEMP_MIN_AGE_MS) {
      return { eligible: false, reason: 'age_under_2h' };
    }

    return { eligible: true };
  }

  /**
   * Collect temp files across project and OS temp.
   */
  async _collectTempFiles({ deadline = Infinity, signal = null } = {}) {
    const files = [];

    const handleFile = async (f) => {
      files.push({ ...f, group: 'temp' });
    };

    // 1. Assets temp
    await this._walkDirAsync(path.join(this.projectRoot, 'assets', 'temp'), handleFile, { group: 'temp', deadline, signal });

    // 2. Project root temp, sandboxed .runtime/temp & transient state dirs
    await this._walkDirAsync(path.join(this.projectRoot, '.runtime', 'temp'), (f) => {
      if (f.path.includes(`${path.sep}.leases${path.sep}`)) return;
      return handleFile(f);
    }, { group: 'temp', deadline, signal });
    await this._walkDirAsync(path.join(this.projectRoot, 'temp'), handleFile, { group: 'temp', deadline, signal });
    await this._walkDirAsync(path.join(this.projectRoot, '.cache'), handleFile, { group: 'temp', deadline, signal });
    await this._walkDirAsync(path.join(this.projectRoot, '.runtime', 'temp-scopes'), handleFile, { group: 'temp', deadline, signal });
    await this._walkDirAsync(path.join(this.projectRoot, 'mybot', 'state', 'qr-bootstrap'), handleFile, { group: 'temp', deadline, signal });
    await this._walkDirAsync(path.join(this.projectRoot, 'mybot', 'state', 'reload'), handleFile, { group: 'temp', deadline, signal });

    // 3. Instances temp: mybot/instances/*/temp
    const instancesDir = path.join(this.projectRoot, 'mybot', 'instances');
    if (fs.existsSync(instancesDir)) {
      try {
        const entries = await fs.promises.readdir(instancesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (signal?.aborted || this.now() >= deadline) break;
          if (entry.isDirectory()) {
            const instTemp = path.join(instancesDir, entry.name, 'temp');
            await this._walkDirAsync(instTemp, handleFile, { group: 'temp', deadline, signal });
          }
        }
      } catch {}
    }

    // 4. Temporary concurrency dirs: .tmp-qr-concurrency-* in project root
    try {
      const rootEntries = await fs.promises.readdir(this.projectRoot, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (signal?.aborted || this.now() >= deadline) break;
        if (entry.isDirectory() && entry.name.startsWith('.tmp-qr-concurrency-')) {
          await this._walkDirAsync(path.join(this.projectRoot, entry.name), handleFile, { group: 'temp', deadline, signal });
        }
      }
    } catch {}

    // 5. System temp with MyBot prefixes ONLY
    if (fs.existsSync(this.tempDir)) {
      try {
        const tempEntries = await fs.promises.readdir(this.tempDir, { withFileTypes: true });
        for (const entry of tempEntries) {
          if (signal?.aborted || this.now() >= deadline) break;
          const isPrefixMatch = MYBOT_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
          if (!isPrefixMatch) continue;

          const fullPath = path.join(this.tempDir, entry.name);
          if (entry.isDirectory()) {
            await this._walkDirAsync(fullPath, handleFile, { group: 'temp', deadline, signal });
          } else if (entry.isFile()) {
            try {
              const stat = await fs.promises.stat(fullPath);
              files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs, group: 'temp' });
            } catch {}
          }
        }
      } catch {}
    }

    return files;
  }

  /**
   * Collect Gemini Chrome caches (Cache, Code Cache, GPUCache, ShaderCache, .downloads).
   */
  async _collectGeminiCacheFiles({ deadline = Infinity, signal = null } = {}) {
    const files = [];
    if (!fs.existsSync(this.geminiProfileDir)) return files;

    const cacheNames = [
      'Cache',
      'Code Cache',
      'GPUCache',
      'ShaderCache',
      'GrShaderCache',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'GraphiteDawnCache',
      'GPUPersistentCache',
      path.join('Service Worker', 'CacheStorage'),
      path.join('Service Worker', 'ScriptCache'),
      'segmentation_platform',
      'BrowserMetrics',
      'Crashpad',
      'blob_storage',
      '.downloads',
    ];

    const searchDirs = [
      this.geminiProfileDir,
      path.join(this.geminiProfileDir, 'Default'),
    ];

    const handleFile = async (f) => {
      files.push({ ...f, group: 'geminiCache' });
    };

    for (const searchDir of searchDirs) {
      if (signal?.aborted || this.now() >= deadline) break;
      if (!fs.existsSync(searchDir)) continue;
      for (const name of cacheNames) {
        if (signal?.aborted || this.now() >= deadline) break;
        const targetDir = path.join(searchDir, name);
        if (fs.existsSync(targetDir)) {
          await this._walkDirAsync(targetDir, handleFile, { group: 'geminiCache', deadline, signal });
        }
      }
    }

    return files;
  }

  /**
   * Collect regular log files, root logs, full instance logs, and MyBot PM2 logs.
   */
  async _collectLogFiles({ deadline = Infinity, signal = null } = {}) {
    const files = [];
    const logsDir = path.join(this.projectRoot, 'logs');
    const nowMs = this.now();

    // 1. Root-level transient log files
    try {
      const rootEntries = await fs.promises.readdir(this.projectRoot, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (signal?.aborted || this.now() >= deadline) break;
        if (entry.isFile() && (
          /^dashboard-.*\.log$/i.test(entry.name) ||
          /^test-.*\.log$/i.test(entry.name) ||
          entry.name === 'test.log' ||
          entry.name === 'test-run.log' ||
          entry.name === 'npm-test-final.log'
        )) {
          const fullPath = path.join(this.projectRoot, entry.name);
          try {
            const stat = await fs.promises.stat(fullPath);
            files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs, group: 'normalLogs', truncate: true });
          } catch {}
        }
      }
    } catch {}

    // Helper to evaluate and classify a log file at any depth
    const processLogFile = (f) => {
      const classification = classifyLogFile(path.basename(f.path), f.path, f, nowMs);
      if (classification.type === 'pm2_skip') {
        return; // Handled exclusively via adapter discovery below
      }

      if (classification.type === 'aged') {
        if (classification.isActivelyAppendedAudit) {
          // If active audit file is oversized, mark for rotation
          if (f.size >= MAX_AUDIT_FILE_BYTES) {
            files.push({
              path: f.path,
              size: f.size,
              mtimeMs: f.mtimeMs,
              group: 'agedLogs',
              rotateAudit: true,
            });
          }
          // Otherwise, active appending audit file is kept intact
          return;
        }

        if (classification.isOldEnough) {
          files.push({
            path: f.path,
            size: f.size,
            mtimeMs: f.mtimeMs,
            group: 'agedLogs',
            truncate: false,
          });
        }
      } else if (classification.type === 'routine') {
        files.push({
          path: f.path,
          size: f.size,
          mtimeMs: f.mtimeMs,
          group: 'normalLogs',
          truncate: true,
        });
      }
    };

    // 2. logs/ directory: files and all valid bot subdirectories (UUIDs, names with spaces, etc.)
    if (fs.existsSync(logsDir)) {
      try {
        const logEntries = await fs.promises.readdir(logsDir, { withFileTypes: true });

        for (const entry of logEntries) {
          if (signal?.aborted || this.now() >= deadline) break;
          const fullPath = path.join(logsDir, entry.name);

          if (entry.isFile()) {
            try {
              const stat = await fs.promises.stat(fullPath);
              processLogFile({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
            } catch {}
          } else if (entry.isDirectory()) {
            const isBackupDir = entry.name.endsWith('-backups') || entry.name === 'backups' || entry.name.startsWith('qr-bootstrap-');
            if (isBackupDir) {
              await this._walkDirAsync(fullPath, (f) => {
                files.push({ path: f.path, size: f.size, mtimeMs: f.mtimeMs, group: 'agedLogs', truncate: false });
              }, { group: 'agedLogs', minAgeMs: RETENTION_7_DAYS_MS, deadline, signal });
            } else {
              // Valid bot log directory under logs/ (supports any name: UUID, spaces, etc.)
              await this._walkDirAsync(fullPath, (f) => {
                processLogFile(f);
              }, { deadline, signal });
            }
          }
        }
      } catch {}
    }

    // 3. Instance log directories: mybot/instances/*/logs
    const instancesDir = path.join(this.projectRoot, 'mybot', 'instances');
    if (fs.existsSync(instancesDir)) {
      try {
        const instanceEntries = await fs.promises.readdir(instancesDir, { withFileTypes: true });
        for (const entry of instanceEntries) {
          if (signal?.aborted || this.now() >= deadline) break;
          if (entry.isDirectory()) {
            const instanceLogDir = path.join(instancesDir, entry.name, 'logs');
            if (fs.existsSync(instanceLogDir)) {
              await this._walkDirAsync(instanceLogDir, (f) => {
                processLogFile(f);
              }, { deadline, signal });
            }
          }
        }
      } catch {}
    }

    let pm2InventoryComplete = true;
    let pm2DiscoveryError = null;

    // 4. PM2 stdout/stderr logs of MyBot fleet processes using normalized contract ONLY
    if (this.adapter && typeof this.adapter.listProcesses === 'function') {
      try {
        const procs = await this.adapter.listProcesses();
        const mybotProcs = procs.filter(isMyBotProcess);

        for (const proc of mybotProcs) {
          if (signal?.aborted || this.now() >= deadline) break;
          const logPaths = [
            proc.outLogPath,
            proc.errorLogPath,
          ].filter(Boolean);

          for (const lp of new Set(logPaths)) {
            if (fs.existsSync(lp)) {
              try {
                const stat = await fs.promises.stat(lp);
                if (stat.isFile() && stat.size > 0) {
                  files.push({
                    path: lp,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    group: 'pm2Logs',
                    truncate: true,
                    procName: proc.name,
                  });
                }
              } catch {}
            }
          }
        }
      } catch (err) {
        pm2InventoryComplete = false;
        pm2DiscoveryError = err.message;
        this.logger.error('[DISK-CLEANUP] PM2 process list discovery failed:', err.message);
      }
    }

    return { files, pm2InventoryComplete, pm2DiscoveryError };
  }

  /**
   * Scan items eligible for cleanup without deleting.
   */
  async scan({
    trigger = 'scan',
    dryRun = true,
    deadlineMs = DEFAULT_DEADLINE_MS,
    signal = null,
  } = {}) {
    const startTime = this.now();
    const deadline = startTime + deadlineMs;
    const disk = await getDiskUsage(this.projectRoot);

    const [tempFiles, geminiFiles, logFilesResult] = await Promise.all([
      this._collectTempFiles({ deadline, signal }),
      this._collectGeminiCacheFiles({ deadline, signal }),
      this._collectLogFiles({ deadline, signal }),
    ]);

    const logFiles = Array.isArray(logFilesResult) ? logFilesResult : (logFilesResult.files || []);
    const pm2InventoryComplete = Array.isArray(logFilesResult) ? true : Boolean(logFilesResult.pm2InventoryComplete);
    const pm2Error = Array.isArray(logFilesResult) ? null : logFilesResult.pm2DiscoveryError;
    const inventoryComplete = pm2InventoryComplete;

    const allCandidates = [...tempFiles, ...geminiFiles, ...logFiles];
    const candidateMap = new Map();
    for (const item of allCandidates) {
      if (this.isForbidden(item.path)) continue;
      candidateMap.set(item.path, item);
    }

    const uniqueCandidates = Array.from(candidateMap.values());
    const candidateBytesByGroup = {
      temp: 0,
      geminiCache: 0,
      normalLogs: 0,
      pm2Logs: 0,
      agedLogs: 0,
    };
    const candidateFilesByGroup = {
      temp: 0,
      geminiCache: 0,
      normalLogs: 0,
      pm2Logs: 0,
      agedLogs: 0,
    };

    let totalCandidateBytes = 0;
    for (const item of uniqueCandidates) {
      totalCandidateBytes += item.size;
      const g = item.group || 'temp';
      candidateBytesByGroup[g] = (candidateBytesByGroup[g] || 0) + item.size;
      candidateFilesByGroup[g] = (candidateFilesByGroup[g] || 0) + 1;
    }

    return {
      trigger,
      dryRun,
      candidateBytes: totalCandidateBytes,
      candidateFiles: uniqueCandidates.length,
      candidateBytesByGroup,
      candidateFilesByGroup,
      candidates: uniqueCandidates,
      inventoryComplete,
      pm2Error,
      disk,
    };
  }

  /**
   * Run cleanup according to allowlist, deadline, stale policy, and trigger rules.
   */
  async run({
    trigger = 'manual_run',
    deadlineMs = DEFAULT_DEADLINE_MS,
    scope = 'all',
    signal = null,
  } = {}) {
    const startTime = this.now();
    const deadline = startTime + deadlineMs;
    const diskBefore = await getDiskUsage(this.projectRoot);

    let scanResult;
    try {
      scanResult = await this.scan({ trigger, dryRun: false, deadlineMs, signal });
    } catch (err) {
      return this._buildErrorResult({
        startTime,
        trigger,
        diskBefore,
        error: `Scan failed: ${err.message}`,
      });
    }

    const inventoryComplete = Boolean(scanResult.inventoryComplete);
    const candidates = scanResult.candidates;
    let bytesFreedTotal = 0;
    let filesFreedTotal = 0;
    const bytesFreedByGroup = {
      temp: 0,
      geminiCache: 0,
      normalLogs: 0,
      pm2Logs: 0,
      agedLogs: 0,
    };
    const filesFreedByGroup = {
      temp: 0,
      geminiCache: 0,
      normalLogs: 0,
      pm2Logs: 0,
      agedLogs: 0,
    };

    const lockedFiles = [];
    const deferredFiles = [];
    const errors = [];
    if (!inventoryComplete && scanResult.pm2Error) {
      errors.push({ group: 'pm2Logs', error: `PM2 discovery failed: ${scanResult.pm2Error}` });
    }
    let skipped = 0;
    let timedOut = (this.now() >= deadline);

    for (const item of candidates) {
      if (signal?.aborted || this.now() >= deadline) {
        timedOut = true;
        break;
      }

      // Check trigger scope policies
      if (scope === 'temp_only' || trigger === 'hourly_temp') {
        if (item.group !== 'temp') continue;
      }

      // SSD 80% Warn trigger: only PM2/routine logs that exceed warnLogSizeLimit are truncated
      if (trigger === 'disk_threshold_warn_80') {
        if ((item.group === 'normalLogs' || item.group === 'pm2Logs') && item.size < this.warnLogSizeLimit) {
          continue;
        }
      }

      // Safety guard check
      if (this.isForbidden(item.path)) {
        skipped++;
        continue;
      }

      // Safe stale temp evaluation
      if (item.group === 'temp') {
        const evalResult = this._evaluateTempCandidate(item, this.now());
        if (!evalResult.eligible) {
          deferredFiles.push({ path: item.path, reason: evalResult.reason });
          skipped++;
          continue;
        }
      }

      // Check if file actively modified between scan and execution
      let currentStat;
      try {
        currentStat = fs.statSync(item.path);
        if (currentStat.size !== item.size || currentStat.mtimeMs !== item.mtimeMs) {
          deferredFiles.push({ path: item.path, reason: 'active_write_resized' });
          skipped++;
          continue;
        }
      } catch {
        // File already vanished
        continue;
      }

      // Action: Rotate active audit log or Truncate or Delete
      try {
        if (item.rotateAudit) {
          // Rotate active audit log capped at 10MB keeping max 1 backup (.1)
          const rotatedPath = `${item.path}.1`;
          try {
            if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
          } catch {}
          fs.renameSync(item.path, rotatedPath);
          fs.writeFileSync(item.path, '', 'utf8');
        } else if (item.truncate) {
          fs.truncateSync(item.path, 0);
          const freed = item.size;
          bytesFreedTotal += freed;
          filesFreedTotal++;
          const g = item.group || 'normalLogs';
          bytesFreedByGroup[g] = (bytesFreedByGroup[g] || 0) + freed;
          filesFreedByGroup[g] = (filesFreedByGroup[g] || 0) + 1;
        } else {
          fs.unlinkSync(item.path);
          if (item.group === 'temp') {
            this._tempObservations.delete(item.path);
          }
          const freed = item.size;
          bytesFreedTotal += freed;
          filesFreedTotal++;
          const g = item.group || 'temp';
          bytesFreedByGroup[g] = (bytesFreedByGroup[g] || 0) + freed;
          filesFreedByGroup[g] = (filesFreedByGroup[g] || 0) + 1;
        }
      } catch (err) {
        if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
          lockedFiles.push({ path: item.path, reason: err.code });
        } else {
          errors.push({ path: item.path, error: err.message, code: err.code });
        }
      }
    }

    this._saveObservations();

    const durationMs = this.now() - startTime;
    const diskAfter = await getDiskUsage(this.projectRoot);

    let warning = null;
    if (diskAfter.usedPercent >= this.criticalPercent) {
      warning = `CRITICAL_DISK_PRESSURE: Disk usage is ${diskAfter.usedPercent}% (>= ${this.criticalPercent}%). Manual intervention required; safety bounds preserved.`;
      this.logger.warn(`[DISK-CLEANUP] ${warning}`);
    }

    // Determine canonical result status:
    // - timed_out: deadline reached
    // - error: fatal scan / status / PM2 failure
    // - partial: has locked/deferred files or non-fatal errors or incomplete inventory
    // - success: completed with no issues
    let resultStatus = 'success';
    if (timedOut) {
      resultStatus = 'timed_out';
    } else if (errors.length > 0 && filesFreedTotal === 0 && candidates.length > 0) {
      resultStatus = 'error';
    } else if (lockedFiles.length > 0 || deferredFiles.length > 0 || errors.length > 0 || !inventoryComplete) {
      resultStatus = 'partial';
    }

    const isSuccess = (resultStatus === 'success' || resultStatus === 'partial');
    const isFullDailySuccess = (trigger === 'schedule_daily_2355' || trigger === 'startup_catchup') && resultStatus === 'success' && inventoryComplete;
    const isHourlySuccess = (trigger === 'hourly_temp') && isSuccess && inventoryComplete;
    const isSuccessfulRun = (resultStatus === 'success') && inventoryComplete;
    const nowIso = new Date(startTime).toISOString();

    const existingStatus = this._lastStatus || this._readStatusFromDisk() || {};

    const statusObj = {
      schemaVersion: 1,
      status: resultStatus,
      success: isSuccess,
      inventoryComplete,
      guardianHeartbeatAt: existingStatus.guardianHeartbeatAt || null,
      lastRun: nowIso,
      lastAttemptAt: nowIso,
      lastSuccessfulRunAt: isSuccessfulRun
        ? nowIso
        : existingStatus.lastSuccessfulRunAt || null,
      lastDailySuccessAt: isFullDailySuccess
        ? nowIso
        : existingStatus.lastDailySuccessAt || null,
      lastHourlySuccessAt: isHourlySuccess
        ? nowIso
        : existingStatus.lastHourlySuccessAt || null,
      lastThresholdRunAt: (trigger.startsWith('disk_threshold_')) && isSuccess
        ? nowIso
        : existingStatus.lastThresholdRunAt || null,
      trigger,
      durationMs,
      nextDailyRunAt: this._computeNextDailyRun(startTime),
      nextScheduledRun: this._computeNextDailyRun(startTime),
      diskBefore,
      diskAfter,
      bytesFreedTotal,
      filesFreedTotal,
      bytesFreedByGroup,
      filesFreedByGroup,
      lockedFiles,
      deferredFiles,
      errors,
      skipped,
      timedOut,
      thresholds: {
        warnPercent: this.warnPercent,
        criticalPercent: this.criticalPercent,
      },
      warning,
    };

    this._lastStatus = statusObj;
    this._writeStatusAtomically(statusObj);

    return {
      ...statusObj,
      bytesFreed: bytesFreedTotal,
      filesFreed: filesFreedTotal,
    };
  }

  _buildErrorResult({ startTime, trigger, diskBefore, error }) {
    const durationMs = this.now() - startTime;
    const nowIso = new Date(startTime).toISOString();
    const existing = this._lastStatus || this._readStatusFromDisk() || {};

    const statusObj = {
      schemaVersion: 1,
      status: 'error',
      success: false,
      inventoryComplete: false,
      guardianHeartbeatAt: existing.guardianHeartbeatAt || null,
      lastRun: nowIso,
      lastAttemptAt: nowIso,
      lastSuccessfulRunAt: existing.lastSuccessfulRunAt || null,
      lastDailySuccessAt: existing.lastDailySuccessAt || null,
      lastHourlySuccessAt: existing.lastHourlySuccessAt || null,
      lastThresholdRunAt: existing.lastThresholdRunAt || null,
      trigger,
      durationMs,
      nextDailyRunAt: this._computeNextDailyRun(startTime),
      nextScheduledRun: this._computeNextDailyRun(startTime),
      diskBefore,
      diskAfter: diskBefore,
      bytesFreedTotal: 0,
      filesFreedTotal: 0,
      bytesFreedByGroup: {},
      filesFreedByGroup: {},
      lockedFiles: [],
      deferredFiles: [],
      errors: [{ error }],
      skipped: 0,
      timedOut: false,
      warning: error,
    };

    this._lastStatus = statusObj;
    this._writeStatusAtomically(statusObj);
    return statusObj;
  }

  _computeNextDailyRun(nowMs) {
    return new Date(getNext2355Timestamp(nowMs)).toISOString();
  }

  _computeNextScheduledRun(nowMs) {
    return new Date(getNext2355Timestamp(nowMs)).toISOString();
  }

  _writeStatusAtomically(statusObj) {
    try {
      const dir = path.dirname(this.statusPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.statusPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(tmpPath, JSON.stringify(statusObj, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.statusPath);
    } catch (err) {
      this.logger.error('[DISK-CLEANUP] Failed to write status file:', err.message);
    }
  }

  _readStatusFromDisk() {
    if (fs.existsSync(this.statusPath)) {
      try {
        const raw = fs.readFileSync(this.statusPath, 'utf8');
        return JSON.parse(raw);
      } catch {}
    }
    return null;
  }

  status() {
    if (this._lastStatus) return this._lastStatus;
    const diskStatus = this._readStatusFromDisk();
    if (diskStatus) {
      this._lastStatus = diskStatus;
      return this._lastStatus;
    }
    return {
      schemaVersion: 1,
      status: 'idle',
      inventoryComplete: true,
      guardianHeartbeatAt: null,
      lastRun: null,
      lastAttemptAt: null,
      lastSuccessfulRunAt: null,
      lastDailySuccessAt: null,
      lastHourlySuccessAt: null,
      lastThresholdRunAt: null,
      trigger: null,
      nextDailyRunAt: this._computeNextDailyRun(this.now()),
      nextScheduledRun: this._computeNextDailyRun(this.now()),
      diskBefore: null,
      diskAfter: null,
      bytesFreedTotal: 0,
      filesFreedTotal: 0,
    };
  }

  /**
   * Safe automated cleanup specifically for temporary MP3 and MP4 media files.
   *
   * Invariants:
   * - Only evaluates files ending with .mp3 or .mp4 inside allowed temp roots.
   * - Enforces 2-hour minimum age (STALE_TEMP_MIN_AGE_MS).
   * - Enforces unchanged size & mtime across at least 2 observations.
   * - Files younger than 2h, active/modifying, or locked are deferred with reason.
   * - Never touches non-temp media, linhcute.mp3, assets/data, media, or video dirs.
   */
  async cleanMediaTemp({
    dryRun = false,
    deadlineMs = DEFAULT_DEADLINE_MS,
    signal = null,
  } = {}) {
    const startTime = this.now();
    const deadline = startTime + deadlineMs;

    let tempFiles = [];
    let inventoryComplete = true;
    let scanError = null;

    try {
      tempFiles = await this._collectTempFiles({ deadline, signal });
    } catch (err) {
      inventoryComplete = false;
      scanError = err.message;
    }

    const candidateFiles = [];
    let protectedSkipped = 0;

    for (const item of tempFiles) {
      const ext = path.extname(item.path).toLowerCase();
      if (ext !== '.mp3' && ext !== '.mp4') continue;

      if (!this.isAllowedTempPath(item.path)) {
        protectedSkipped++;
        continue;
      }

      if (this.isForbidden(item.path)) {
        protectedSkipped++;
        continue;
      }

      candidateFiles.push(item);
    }

    let candidateBytes = 0;
    const deferred = [];
    const eligible = [];

    for (const item of candidateFiles) {
      candidateBytes += item.size;
      const evalResult = this._evaluateTempCandidate(item, this.now());
      if (!evalResult.eligible) {
        deferred.push({ path: item.path, reason: evalResult.reason });
      } else {
        eligible.push(item);
      }
    }

    let deletedFiles = 0;
    let deletedBytes = 0;
    const errors = [];
    if (scanError) {
      errors.push({ error: scanError });
    }
    let timedOut = (this.now() >= deadline);

    if (!dryRun) {
      for (const item of eligible) {
        if (signal?.aborted || this.now() >= deadline) {
          timedOut = true;
          deferred.push({ path: item.path, reason: 'deadline_exceeded' });
          continue;
        }

        // Check if file was actively modified between scan and deletion
        try {
          const curStat = fs.statSync(item.path);
          if (curStat.size !== item.size || curStat.mtimeMs !== item.mtimeMs) {
            deferred.push({ path: item.path, reason: 'active_write_resized' });
            continue;
          }
        } catch {
          continue; // file already removed
        }

        try {
          fs.unlinkSync(item.path);
          this._tempObservations.delete(item.path);
          deletedFiles++;
          deletedBytes += item.size;
        } catch (err) {
          if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
            deferred.push({ path: item.path, reason: 'file_locked', code: err.code });
          } else {
            errors.push({ path: item.path, error: err.message, code: err.code });
          }
        }
      }

      this._saveObservations();
    }

    let status = 'success';
    if (timedOut) {
      status = 'timed_out';
    } else if (errors.length > 0 && deletedFiles === 0 && candidateFiles.length > 0) {
      status = 'error';
    } else if (deferred.length > 0 || errors.length > 0 || !inventoryComplete) {
      status = 'partial';
    }

    return {
      status,
      inventoryComplete,
      candidateFiles: candidateFiles.length,
      candidateBytes,
      deletedFiles,
      deletedBytes,
      deferred,
      protectedSkipped,
      errors,
      startedAt: new Date(startTime).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
    };
  }
}
