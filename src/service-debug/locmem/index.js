import { clearRolloverJob } from "./locmem-tracker.js";
import { clearCleanupJob } from "./locmem-cleanup.js";
import { defaultPendingManager } from "./locmem-pending.js";
import { closeAllLocmemStores } from "./locmem-store.js";

export {
  TIMEZONE,
  VIETNAM_TIMEZONE,
  getVietnamDateKey,
  getVietnamMonthKey,
  getVietnamParts,
  getConsecutiveCalendarDays,
} from "./time-util.js";

export {
  LocmemStore,
  createLocmemStore,
  getLocmemStore,
  resolveLocmemDbPath,
  closeAllLocmemStores,
  COVERAGE_STATUS,
  normalizeCoverageStatusCode,
} from "./locmem-store.js";

export {
  PendingConfirmationManager,
  defaultPendingManager,
} from "./locmem-pending.js";

export {
  extractGroupMemberUids,
  trackLocmemMessage,
  trackLocmemReaction,
  trackLocmemGroupAction,
  takeGroupSnapshots,
  handleDayRollover,
  onListenerReady,
  markLocmemDowntime,
  clearRolloverJob,
} from "./locmem-tracker.js";

export {
  runMonthlyCleanup,
  runDailyLocmemRetentionPrune,
  checkAndRunStartupCatchUp,
  initializeMonthlyCleanupScheduler,
  clearCleanupJob,
} from "./locmem-cleanup.js";

export {
  handleLocmemCommand,
  handleLocmemReaction,
  fetchCandidateNames,
  getRegisteredBotUids,
} from "./locmem-service.js";

/**
 * Gracefully shuts down all locmem resources:
 * - Cancels rollover jobs
 * - Cancels monthly cleanup scheduler jobs
 * - Clears in-memory pending manager
 * - Checkpoints and closes SQLite database stores
 *
 * @param {string|object} [botUid=null]
 */
export function shutdownLocmem(botUid = null) {
  try {
    clearRolloverJob(botUid);
  } catch {}
  try {
    clearCleanupJob(botUid);
  } catch {}
  try {
    defaultPendingManager.clear();
  } catch {}
  try {
    closeAllLocmemStores();
  } catch {}
}
