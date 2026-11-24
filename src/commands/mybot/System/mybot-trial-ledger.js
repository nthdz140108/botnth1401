import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./json-state.js";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DEFAULT_TRIAL_DURATION_MS = 60 * 60 * 1000; // 1 hour trial

/**
 * Calculates the calendar week key in Asia/Bangkok timezone (UTC+7)
 * Week starts at Monday 00:00:00 Bangkok time.
 * Returns ISO week format like "2026-W35"
 */
export function getBangkokCalendarWeek(timestamp = Date.now()) {
  const ts = Number(timestamp) || Date.now();
  // Shift to Bangkok wall clock time in UTC representations
  const bangkokDate = new Date(ts + BANGKOK_OFFSET_MS);

  const year = bangkokDate.getUTCFullYear();
  const month = bangkokDate.getUTCMonth();
  const date = bangkokDate.getUTCDate();
  const day = bangkokDate.getUTCDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday

  // Calculate Monday of the current week (Monday is day 1)
  const dayOfWeek = (day + 6) % 7; // 0 = Mon, 1 = Tue, ..., 6 = Sun
  const targetThursday = new Date(Date.UTC(year, month, date - dayOfWeek + 3));
  const firstThursdayOfYear = new Date(Date.UTC(targetThursday.getUTCFullYear(), 0, 4));
  const firstThursdayDayOfWeek = (firstThursdayOfYear.getUTCDay() + 6) % 7;
  const firstMondayOfYear = new Date(Date.UTC(targetThursday.getUTCFullYear(), 0, 4 - firstThursdayDayOfWeek));

  const weekNumber = Math.floor((targetThursday.getTime() - firstMondayOfYear.getTime()) / (7 * 24 * 3600 * 1000)) + 1;
  const isoYear = targetThursday.getUTCFullYear();

  return `${isoYear}-W${String(weekNumber).padStart(2, "0")}`;
}

export function getTrialLedgerPath(root = process.cwd()) {
  return path.join(root, "mybot", "state", "trial-ledger.json");
}

export function loadTrialLedger({ root = process.cwd(), ledgerPath } = {}) {
  const targetPath = ledgerPath || getTrialLedgerPath(root);
  try {
    if (!fs.existsSync(targetPath)) {
      return { ledger: {}, updatedAt: new Date().toISOString() };
    }
    const raw = fs.readFileSync(targetPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      return { ledger: {}, updatedAt: new Date().toISOString() };
    }
    if (!data.ledger || typeof data.ledger !== "object") {
      data.ledger = {};
    }
    return data;
  } catch {
    return { ledger: {}, updatedAt: new Date().toISOString() };
  }
}

export function saveTrialLedger(data, { root = process.cwd(), ledgerPath } = {}) {
  const targetPath = ledgerPath || getTrialLedgerPath(root);
  const safeData = {
    ledger: data?.ledger && typeof data.ledger === "object" ? data.ledger : {},
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(targetPath, safeData);
  return safeData;
}

export function getOwnerTrialStatus(ownerUid, { root = process.cwd(), ledgerPath, now = Date.now() } = {}) {
  if (!ownerUid) {
    return { eligible: false, currentWeek: getBangkokCalendarWeek(now), lastGrantedWeek: null, record: null };
  }
  const uid = String(ownerUid).trim();
  const currentWeek = getBangkokCalendarWeek(now);
  const data = loadTrialLedger({ root, ledgerPath });
  const ownerRecords = data.ledger[uid] || {};
  const currentRecord = ownerRecords[currentWeek] || null;

  const weekKeys = Object.keys(ownerRecords).sort();
  const lastGrantedWeek = weekKeys.length > 0 ? weekKeys[weekKeys.length - 1] : null;

  return {
    eligible: !currentRecord,
    currentWeek,
    lastGrantedWeek,
    record: currentRecord,
  };
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function withTrialLedgerLock(targetPath, fn) {
  const lockDir = path.dirname(targetPath);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }
  const lockFile = `${targetPath}.lock`;
  const maxRetries = 200;
  const retryDelayMs = 25;
  const leaseTimeoutMs = 15000;
  let acquired = false;
  let heartbeatTimer = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const lockData = JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
      });
      fs.writeFileSync(lockFile, lockData, { flag: "wx" });
      acquired = true;
      break;
    } catch (err) {
      if (err.code === "EEXIST") {
        try {
          const raw = fs.readFileSync(lockFile, "utf8");
          const parsed = JSON.parse(raw);
          const isAlive = isPidAlive(parsed?.pid);
          const isStale = (Date.now() - (parsed?.heartbeatAt || 0)) > leaseTimeoutMs;

          if (!isAlive || isStale) {
            try {
              fs.unlinkSync(lockFile);
              continue;
            } catch {}
          }
        } catch {
          // If corrupted lock file older than 5s
          try {
            const stat = fs.statSync(lockFile);
            if (Date.now() - stat.mtimeMs > 5000) {
              fs.unlinkSync(lockFile);
              continue;
            }
          } catch {}
        }
        const start = Date.now();
        while (Date.now() - start < retryDelayMs) {}
      } else {
        throw err;
      }
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire lock for trial ledger: ${lockFile}`);
  }

  // Start heartbeat renewal while lock is held
  heartbeatTimer = setInterval(() => {
    try {
      const updated = JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
      });
      fs.writeFileSync(lockFile, updated, "utf8");
    } catch {}
  }, 1000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  try {
    return fn();
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

export function claimOwnerTrial(ownerUid, botId, {
  durationMs = DEFAULT_TRIAL_DURATION_MS,
  root = process.cwd(),
  ledgerPath,
  now = Date.now(),
} = {}) {
  if (!ownerUid) {
    return { success: false, code: "INVALID_OWNER", error: "ownerUid is required" };
  }
  const targetPath = ledgerPath || getTrialLedgerPath(root);
  return withTrialLedgerLock(targetPath, () => {
    const uid = String(ownerUid).trim();
    const bId = String(botId || uid).trim();
    const currentTime = Number(now) || Date.now();
    const currentWeek = getBangkokCalendarWeek(currentTime);
    const duration = Number(durationMs) > 0 ? Number(durationMs) : DEFAULT_TRIAL_DURATION_MS;

    const data = loadTrialLedger({ root, ledgerPath: targetPath });
    if (!data.ledger[uid]) {
      data.ledger[uid] = {};
    }

    const existing = data.ledger[uid][currentWeek];
    if (existing) {
      return {
        success: false,
        code: "TRIAL_QUOTA_EXHAUSTED",
        error: "Owner đã sử dụng hạn mức trial cho tuần này (1 lần / tuần lịch Bangkok).",
        weekKey: currentWeek,
        record: existing,
      };
    }

    const grantedAt = new Date(currentTime).toISOString();
    const expiryAt = new Date(currentTime + duration).toISOString();
    const newRecord = {
      ownerUid: uid,
      botId: bId,
      weekKey: currentWeek,
      grantedAt,
      expiryAt,
      durationMs: duration,
    };

    data.ledger[uid][currentWeek] = newRecord;
    saveTrialLedger(data, { root, ledgerPath: targetPath });

    return {
      success: true,
      weekKey: currentWeek,
      record: newRecord,
      grantedAt,
      expiryAt,
      durationMs: duration,
    };
  });
}

export function releaseOwnerTrial(ownerUid, weekKey, { root = process.cwd(), ledgerPath } = {}) {
  return resetOwnerTrialForWeek(ownerUid, weekKey, { root, ledgerPath });
}

export function resetOwnerTrialForWeek(ownerUid, weekKey, { root = process.cwd(), ledgerPath } = {}) {
  if (!ownerUid) return false;
  const uid = String(ownerUid).trim();
  const targetPath = ledgerPath || getTrialLedgerPath(root);
  return withTrialLedgerLock(targetPath, () => {
    const data = loadTrialLedger({ root, ledgerPath: targetPath });
    if (data.ledger[uid] && (weekKey ? data.ledger[uid][weekKey] : true)) {
      if (weekKey) {
        delete data.ledger[uid][weekKey];
        if (Object.keys(data.ledger[uid]).length === 0) {
          delete data.ledger[uid];
        }
      } else {
        delete data.ledger[uid];
      }
      saveTrialLedger(data, { root, ledgerPath: targetPath });
      return true;
    }
    return false;
  });
}

const inFlightTrialReservations = new Map();

export function reserveTrialActivation(ownerUid, botId, {
  durationMs = DEFAULT_TRIAL_DURATION_MS,
  root = process.cwd(),
  ledgerPath,
  now = Date.now(),
  ttlMs = 60000,
} = {}) {
  if (!ownerUid) {
    return { success: false, code: "INVALID_OWNER", error: "ownerUid is required" };
  }
  const uid = String(ownerUid).trim();
  const bId = String(botId || uid).trim();
  const currentTime = Number(now) || Date.now();
  const currentWeek = getBangkokCalendarWeek(currentTime);

  // Check trial ledger first
  const trialStatus = getOwnerTrialStatus(uid, { root, ledgerPath, now: currentTime });
  if (!trialStatus.eligible) {
    return {
      success: false,
      code: "TRIAL_QUOTA_EXHAUSTED",
      error: "Owner đã sử dụng hạn mức trial cho tuần này (1 lần / tuần lịch Bangkok).",
      weekKey: currentWeek,
      record: trialStatus.record,
    };
  }

  // Check in-flight reservation
  const existingRes = inFlightTrialReservations.get(uid);
  if (existingRes && existingRes.expiresAt > currentTime) {
    return {
      success: false,
      code: "TRIAL_ALREADY_RESERVED",
      error: "Đang có một tiến trình kích hoạt dùng thử khác đang xử lý cho tài khoản này.",
      weekKey: currentWeek,
    };
  }

  const reservation = {
    ownerUid: uid,
    botId: bId,
    weekKey: currentWeek,
    reservedAt: currentTime,
    expiresAt: currentTime + ttlMs,
  };
  inFlightTrialReservations.set(uid, reservation);

  let status = "reserved";

  const txn = {
    ownerUid: uid,
    botId: bId,
    weekKey: currentWeek,
    get status() {
      return status;
    },
    commit({ commitNow = Date.now(), commitDurationMs = durationMs } = {}) {
      if (status === "committed") return { success: true, alreadyCommitted: true };
      if (status !== "reserved") return { success: false, error: `Cannot commit trial in status ${status}` };

      try {
        const claimRes = claimOwnerTrial(uid, bId, {
          durationMs: commitDurationMs,
          root,
          ledgerPath,
          now: commitNow,
        });
        if (claimRes.success) {
          status = "committed";
        }
        return claimRes;
      } finally {
        if (inFlightTrialReservations.get(uid) === reservation) {
          inFlightTrialReservations.delete(uid);
        }
      }
    },
    release() {
      if (status === "released" || status === "committed") return { success: true, status };
      status = "released";
      if (inFlightTrialReservations.get(uid) === reservation) {
        inFlightTrialReservations.delete(uid);
      }
      return { success: true, status: "released" };
    },
  };

  return {
    success: true,
    weekKey: currentWeek,
    reservation,
    txn,
  };
}

export const trialActivationTransaction = {
  reserve: (ownerUid, botUid, options) => reserveTrialActivation(ownerUid, botUid, options),
};

