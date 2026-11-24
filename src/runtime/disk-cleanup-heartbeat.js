/**
 * Disk Cleanup Guardian Heartbeat & Observable Health Evaluator.
 *
 * Responsibilities:
 * - Atomic write/read of guardian heartbeat (.runtime/disk-cleanup/heartbeat.json).
 * - Decouples guardian liveness from cleanup run results so a living guardian
 *   with failing cleanup is clearly distinguished from a dead guardian.
 * - Health evaluator classifies status into:
 *     - 'never_started': No guardian heartbeat or run attempt recorded yet.
 *     - 'stale': Heartbeat is older than 10 minutes (HEARTBEAT_STALE_MS) or missing.
 *     - 'partial': Last cleanup ended in partial state, locked files, or incomplete inventory.
 *     - 'healthy': Heartbeat is fresh and system is operational without errors.
 */

import fs from 'node:fs';
import path from 'node:path';

export const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes

export function getHeartbeatPath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), '.runtime', 'disk-cleanup', 'heartbeat.json');
}

export function getStatusPath(projectRoot = process.cwd()) {
  return path.join(path.resolve(projectRoot), '.runtime', 'disk-cleanup', 'status.json');
}

/**
 * Record heartbeat atomically.
 */
export function recordGuardianHeartbeat({
  projectRoot = process.cwd(),
  pid = process.pid,
  status = 'online',
  error = null,
  nowMs = Date.now(),
} = {}) {
  const filePath = getHeartbeatPath(projectRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const payload = {
    pid,
    guardianHeartbeatAt: new Date(nowMs).toISOString(),
    timestamp: nowMs,
    status,
    error: error ? String(error) : null,
  };

  const tmpPath = `${filePath}.tmp-${process.pid}-${nowMs}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return payload;
}

/**
 * Read guardian heartbeat from disk safely.
 */
export function readGuardianHeartbeat({ projectRoot = process.cwd() } = {}) {
  const filePath = getHeartbeatPath(projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {}
  return null;
}

/**
 * Evaluate health state of disk cleanup system.
 *
 * Classifies health into:
 * - 'never_started': Neither heartbeat nor attempt has been recorded.
 * - 'stale': Heartbeat missing or older than staleMs.
 * - 'partial': Last cleanup completed with partial state, errors, or incomplete inventory.
 * - 'healthy': Heartbeat is fresh and latest cleanup succeeded or is ready.
 * - 'timed_out': Last cleanup exceeded hard deadline.
 * - 'error': Fatal error occurred.
 */
export function evaluateCleanupHealth({
  status = null,
  heartbeat = null,
  nowMs = Date.now(),
  staleMs = HEARTBEAT_STALE_MS,
} = {}) {
  const hbTime = heartbeat?.timestamp || (heartbeat?.guardianHeartbeatAt ? new Date(heartbeat.guardianHeartbeatAt).getTime() : null);
  const hasAttempt = Boolean(status?.lastAttemptAt || status?.lastRun);

  // 1. Never started
  if (!hbTime && !hasAttempt && (!status || status.status === 'idle' || status.status === 'never_started')) {
    return 'never_started';
  }

  // 2. Stale heartbeat check
  if (!hbTime) {
    return 'stale';
  }
  const age = nowMs - hbTime;
  if (age > staleMs) {
    return 'stale';
  }

  // 3. Status checks
  if (status) {
    if (status.status === 'timed_out') {
      return 'timed_out';
    }
    if (status.status === 'error') {
      return 'error';
    }
    if (status.status === 'partial' || status.inventoryComplete === false) {
      return 'partial';
    }
    if (Array.isArray(status.errors) && status.errors.length > 0) {
      return 'partial';
    }
  }

  return 'healthy';
}
