import schedule from "node-schedule";
import { getLocmemStore } from "./locmem-store.js";
import { getVietnamDateKey, getVietnamMonthKey, getVietnamParts, getConsecutiveCalendarDays, VIETNAM_TIMEZONE } from "./time-util.js";

const cleanupJobs = new Map();

/**
 * Runs the monthly cleanup for locmem:
 * - Keeps only today and the exact 35 calendar days immediately preceding today (at most 36 dates).
 * - Deletes all older activity, snapshots, and coverage.
 * - Runs WAL checkpoint & VACUUM.
 * - Saves last_monthly_cleanup = monthKey.
 *
 * @param {string|object} [botUid="admin"]
 * @param {object} [options]
 * @param {string} [options.todayKey]
 * @param {string} [options.monthKey]
 * @returns {{ monthKey: string, keepDateKeys: string[] }}
 */
export function runMonthlyCleanup(botUid = "admin", options = {}) {
  const store = options.storeOverride || getLocmemStore(botUid);
  const todayKey = options.todayKey || getVietnamDateKey();
  const monthKey = options.monthKey || getVietnamMonthKey();

  if (!options.force) {
    const lastCleanupMonth = store.getMeta("last_monthly_cleanup");
    if (lastCleanupMonth === monthKey) {
      return { cleaned: false, reason: "already_cleaned_for_month", monthKey };
    }
  }

  // Keep today plus exact 35 consecutive calendar days immediately preceding today (up to 36 dates)
  const preceding7Days = getConsecutiveCalendarDays(todayKey, 35);
  const keepDateKeys = Array.from(new Set([todayKey, ...preceding7Days]));

  store.cleanupMonthly({ keepDateKeys, monthKey });

  return {
    cleaned: true,
    monthKey,
    keepDateKeys,
    keptDatesCount: keepDateKeys.length,
  };
}

/**
 * Daily rolling 35-day retention prune (keeps 35 days + today so 7d/14d/30d windows stay intact).
 */
export function runDailyLocmemRetentionPrune(botUid = "admin", { retentionDays = 35, todayKey = getVietnamDateKey(), storeOverride = null } = {}) {
  const store = storeOverride || getLocmemStore(botUid);
  const removed = store.pruneOlderThanDays(retentionDays, todayKey);
  return { removed, retentionDays, todayKey };
}

/**
 * Checks if the monthly cleanup should run as a catch-up on bot startup.
 * Runs once if the current month has not yet been cleaned up.
 *
 * @param {string} [botUid="admin"]
 * @returns {boolean} Whether catch-up cleanup ran
 */
export function checkAndRunStartupCatchUp(botUid = "admin") {
  try {
    const store = getLocmemStore(botUid);
    const parts = getVietnamParts();
    const currentMonthKey = parts.monthKey;
    const lastCleanupMonth = store.getMeta("last_monthly_cleanup");

    if (lastCleanupMonth !== currentMonthKey) {
      runMonthlyCleanup(botUid, { monthKey: currentMonthKey, todayKey: parts.dateKey });
      return true;
    }
  } catch (err) {
    console.warn(`[locmem-cleanup] startup catch-up error: ${err.message}`);
  }
  return false;
}

/**
 * Schedules monthly cleanup at 03:10 on day 1 of every month in Asia/Ho_Chi_Minh.
 * Also runs startup catch-up if needed.
 *
 * @param {string} [botUid="admin"]
 */
export function initializeMonthlyCleanupScheduler(botUid = "admin") {
  // 1. Startup catch-up
  checkAndRunStartupCatchUp(botUid);

  // 2. Schedule recurring cron: 03:10 on the 1st of every month
  if (cleanupJobs.has(botUid)) {
    try {
      cleanupJobs.get(botUid).cancel();
    } catch {}
  }

  const job = schedule.scheduleJob({ rule: "10 3 1 * *", tz: VIETNAM_TIMEZONE }, () => {
    try {
      runMonthlyCleanup(botUid);
    } catch (err) {
      console.error(`[locmem-cleanup] scheduled monthly cleanup error: ${err.message}`);
    }
  });

  if (job) {
    cleanupJobs.set(botUid, job);
  }
}

/**
 * Cancels monthly cleanup job (for testing/shutdown).
 * @param {string} [botUid=null]
 */
export function clearCleanupJob(botUid = null) {
  if (botUid) {
    if (cleanupJobs.has(botUid)) {
      try {
        cleanupJobs.get(botUid).cancel();
      } catch {}
      cleanupJobs.delete(botUid);
    }
  } else {
    for (const [key, job] of cleanupJobs.entries()) {
      try {
        job.cancel();
      } catch {}
    }
    cleanupJobs.clear();
  }
}
