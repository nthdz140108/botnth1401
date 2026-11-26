/*@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
                   _ooOoo_
                  o8888888o
                  88" . "88
                  (| -_- |)
                  O\  =  /O
               ____/`---'\____
             .'  \\|     |//  `.
            /  \\|||  :  |||//  \
           /  _||||| -:- |||||-  \
           |   | \\\  -  /// |   |
           | \_|  ''\---/''  |   |
           \  .-\__  `-`  ___/-. /
         ___`. .'  /--.--\  `. . __
      ."" '<  `.___\_<|>_/___.'  >'"".
     | | :  `- \`.;`\ _ /`;.`/ - ` : | |
     \  \ `-.   \_ __\ /__ _/   .-` /  /
======`-.____`-.___\_____/___.-`____.-'======
                   `=---='
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  PHẬT ĐỘ, CODE Không LỖI, TỐI ƯU Không BUG
            DEVELOPER: SBT
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@*/

import { Zalo } from "./api-zalo/index.js";
import { appContext } from "./api-zalo/context.js";
import { getZaloRuntimeConfig } from "./api-zalo/zalo-config.js";
import { getBotName } from "./utils/env.js";
import { restoreAutoSendText } from "./commands/lenh-debug/send-all/autosendtext.js";
import { groupEvents } from "./automations/events-group.js";
import { messagesUser } from "./automations/event-send-msg.js";
import { undoMessageEvents } from "./automations/event-undo-msg.js";

import {
  readAdmins,
  readMainBotAdmins,
  readHighCommandAdmins,
  isMainBotAdmin,
  readConfig,
  readGroupSettings,
  loadCanonicalGroupSettings,
  getActiveRuntimeContext,
  readCommandConfig,
  writeProphylacticConfig,
  readProphylacticConfig
} from "./utils/io-json.js";
export { readMainBotAdmins, isMainBotAdmin };

import { resetRankInfo, scheduleMidnightRankReset } from "./service-debug/info-service/rank-chat.js";
import { logManagerBot } from "./utils/io-json.js";
import { initService, rebindServiceApi, setGlobalPrefix } from "./service-debug/service.js";
import { reactionEvents } from "./automations/events-reaction.js";
import { typingEvents } from "./automations/event-typing.msg.js";
import { onListenerReady, markLocmemDowntime, shutdownLocmem } from "./service-debug/locmem/index.js";
import { getRuntimeContext } from "./utils/bot-runtime-context.js";
import { closeWebServer, getIO, registerRuntimeReloadHandler, startWebServer, updateWebServerApi } from "./web-service/web-server.js";
import { terminalLog, terminalLogger } from "./utils/terminal-log.js";
import { bindZaloListeners, ListenerLeakDetector } from "./runtime/listener-binder.js";
import { createRuntimeLogger } from "./runtime/logger.js";
import { getListenerRuntimeState, withDeadline, LOGIN_DEADLINE_MS } from "./runtime/listener-state.js";
import { startMemoryPressureWatcher } from "./runtime/memory-pressure-listener.js";
import fs from "fs";
import { resolveUserRole, ROLE_LEVELS } from "./utils/role-policy.js";
import schedule from "node-schedule";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import {
  getSwitchFlag,
  resumePendingTasks,
  loadPendingTasks,
  checkLimitAndSwitchSession
} from "./skills/auto-session-switch.js";
import { resumeSpamSessions } from "./commands/bot-manager/spamgroup.js";
import { resumeBulkMessages } from "./web-service/bulk-message.js";
import { dedupeMyBotsRegistry, loadMyBotsRegistry, saveMyBotsRegistry } from "./commands/mybot/System/mybots-registry.js";
import { resolveAdminIdentity, syncMainBotRegistry, hydrateCurrentBotIdentity, resolveCurrentInstanceIdentity, persistVerifiedInstanceIdentity, extractUsernameFromUserInfo, normalizeUsername } from "./commands/mybot/System/mybot-identity.js";
import { writeIdentityHandshake } from "./commands/mybot/System/identity-handshake.js";
import { readReloadRequest, writeReloadRequest } from "./commands/mybot/System/reload-request.js";
import { performRuntimeReload } from "./commands/mybot/System/runtime-reload.js";
import { invalidateRuntimePolicyCache } from "./commands/command.js";
import { createStudioRuntimeApplier } from "./commands/studio/runtime-apply.js";
import { initializeScheduler } from "./service-debug/scheduler/scheduler.js";
import { resolveAdminBotIdSync } from "./utils/util.js";
import {
  createAdminStartupCoordinator,
  isRecoveryLockActive,
} from "./utils/admin-startup-recovery.js";
import { createRuntimeLifecycle, getActiveRuntimeLifecycle } from "./core/runtime-lifecycle.js";
import { getRuntimeInstanceDescriptor, setLiveZaloUid, verifyRuntimeIdentity } from "./core/runtime-instance.js";
import { shouldUpdateMainStatusOnExit, resolveExitStatusOwner } from "./core/runtime-exit-guard.js";
import {
  getGlobalRuntimeMetrics,
  registerHealthProvider,
} from "./observability/runtime-metrics.js";
import { getTransportLimiterStats } from "./api-zalo/transport-limiter.js";

let _unhandledRejectionCount = 0;
process.on('unhandledRejection', (err) => {
  // Handlers must catch their own errors; a stray rejection is audited and
  // counted but never kills the bot process.
  _unhandledRejectionCount += 1;
  try { getGlobalRuntimeMetrics().recordOutbound({ operation: "unhandledRejection", status: "error", durationMs: 0 }); } catch {}
  logManagerBot(`[WARN] Unhandled rejection (#${_unhandledRejectionCount}): ${err?.message || err}`);
  terminalLog({ scope: "listener", level: "warn", title: "Unhandled rejection", lines: [err?.stack || err?.message || String(err)] });
});

process.on('uncaughtException', (err) => {
  logManagerBot(`[FATAL] Uncaught exception: ${err?.message || err}`);
  terminalLog({ scope: "listener", level: "error", title: "Uncaught exception", lines: [err?.stack || err?.message || String(err)] });
  controlledShutdown(`uncaughtException: ${err?.message || err}`);
});

process.on('exit', (code) => {
  if (code === 3221225786) {
    logManagerBot('[FATAL] Windows access violation detected (0xC0000006). Native module crash.');
    terminalLog({ scope: "listener", level: "error", title: "Windows access violation", lines: ["0xC0000006 native module crash"] });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const botName = getBotName();
const stateDir = path.join(projectRoot, 'mybot', 'state');
const adminStatePath = path.join(stateDir, "admin.json");
const adminRecoveryLockPath = path.join(stateDir, "admin-recovery.lock");
terminalLogger.writeBanner({ name: "BOT LISTENER", botName, status: "STARTING" });

let _shutdownInProgress = false;
function controlledShutdown(reason) {
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;
  logManagerBot(`[FATAL] Controlled shutdown: ${reason}`);
  terminalLog({ scope: "listener", level: "error", title: "Controlled shutdown", lines: [reason] });
  const finish = () => process.exit(1);
  const timeoutGuard = setTimeout(finish, 5000);
  timeoutGuard.unref?.();
  (async () => {
    try {
      try { api?.listener?.ws?.close?.(); } catch {}
      // Abort the listener retry loop (process shutdown only) and report stopped.
      try { listenerAbortController.abort(); } catch {}
      try { getListenerRuntimeState().markStopped(`shutdown: ${reason}`); } catch {}
      // Dispose listener binder (removes exactly our callbacks)
      if (_currentListenerBinder) { try { _currentListenerBinder.dispose(); } catch {} _currentListenerBinder = null; }
      // Stop memory pressure listener
      if (_memoryPressureListener) { try { _memoryPressureListener.stop(); } catch {} _memoryPressureListener = null; }
      await closeWebServer().catch(() => {});
      if (_runtimeLifecycle) { try { await _runtimeLifecycle.shutdown(); } catch {} }
      try { shutdownLocmem(getRuntimeContext()); } catch {}
      // Flush and close the runtime logger LAST so error logs during shutdown
      // are still captured.
      if (_runtimeLogger) { try { await _runtimeLogger.close(); } catch {} _runtimeLogger = null; }
    } catch {}
    clearTimeout(timeoutGuard);
    finish();
  })();
}

function writeBotPid() {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, `${botName}.json`);
    let state = {};
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    state.pid = String(process.pid);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("Không thể ghi bot PID:", e.message);
  }
}

function removeBotPid() {
  try {
    const statePath = path.join(stateDir, `${botName}.json`);
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      delete state.pid;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } catch (e) {
    console.warn("Không thể xóa bot PID:", e.message);
  }
}

let idBot = -1;
const prophylacticConfig = readProphylacticConfig();
export let admins = readAdmins();
let config = readConfig();
let commandConfig = readCommandConfig();
const COOKIE_DEAD_EXIT_CODE = 12;
const QR_CANCELLED_EXIT_CODE = 12;
const QR_UID_MISMATCH_EXIT_CODE = 13;

export async function shutdownBot(apiInstance) {
  try {
    console.log('Đang tắt bot an toàn...');
    logManagerBot('Đang tắt bot an toàn...');

    if (_runtimeLifecycle) {
      try {
        await _runtimeLifecycle.shutdown();
      } catch (e) {
        console.warn('Lỗi khi shutdown lifecycle:', e.message);
      }
    }

    try {
      if (typeof schedule !== 'undefined' && schedule.gracefulShutdown) {
        schedule.gracefulShutdown();
      }
    } catch (e) {
      console.warn('Lỗi khi tắt schedule:', e.message);
    }

    if (apiInstance && apiInstance.listener && apiInstance.listener.ws) {
      try {
        apiInstance.listener.ws.close();
      } catch (e) {
        console.warn('Lỗi khi đóng websocket:', e.message);
      }
    }

    await closeWebServer().catch((e) => console.warn('Lỗi khi đóng web server:', e.message));
    console.log('Web server đã đóng');
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  } catch (error) {
    console.error('Lỗi khi tắt bot:', error);
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
}


export function getApi() {
  return api;
}

export function getBotId() {
  return idBot;
}

export function setBotId(id) {
  idBot = id;
  setLiveZaloUid(id);
}

export function getCommandConfig() {
  return commandConfig;
}

export function reloadCommandConfig() {
  commandConfig = readCommandConfig();
  invalidateRuntimePolicyCache();
  return commandConfig;
}

export function getProphylacticConfig() {
  return prophylacticConfig;
}

export function getProphylacticUploadAttachment() {
  return prophylacticConfig.prophylacticUploadAttachment.enable;
}

export function setProphylacticUploadAttachment(enable, resetNum = false) {
  prophylacticConfig.prophylacticUploadAttachment.enable = enable;
  prophylacticConfig.prophylacticUploadAttachment.lastBlocked = Date.now();
  if (resetNum) prophylacticConfig.prophylacticUploadAttachment.numRequestZalo = 0;
  writeProphylacticConfig(prophylacticConfig);
}

const timeResetNumberRequestUpload = 120 * 60 * 1000;
const timeDisableProphylacticConfig = 120 * 60 * 1000;
const maxRequestUploadIntoNotProphylactic = 300;

export function checkDisableProphylacticConfig() {
  if (prophylacticConfig.prophylacticUploadAttachment.enable) {
    const currentTime = Date.now();
    const lastBlockedTime = prophylacticConfig.prophylacticUploadAttachment.lastBlocked;
    const timeDifference = currentTime - lastBlockedTime;

    if (timeDifference > timeDisableProphylacticConfig) {
      setProphylacticUploadAttachment(false, true);
    }
  }
}

export function checkConfigUploadAttachment(extFile, isUseProphylactic = false) {
  if (["jpg", "jpeg", "png", "webp"].includes(extFile)) {
    const currentTime = Date.now();
    if ((!prophylacticConfig.prophylacticUploadAttachment?.lastRequestTime) 
      || (currentTime - prophylacticConfig.prophylacticUploadAttachment.lastRequestTime > timeResetNumberRequestUpload)) {
      prophylacticConfig.prophylacticUploadAttachment.numRequestZalo = 0;
      prophylacticConfig.prophylacticUploadAttachment.lastRequestTime = currentTime;
      setProphylacticUploadAttachment(false);
    }

    if (!isUseProphylactic) {
      prophylacticConfig.prophylacticUploadAttachment.numRequestZalo++;
    }

    if (prophylacticConfig.prophylacticUploadAttachment.numRequestZalo > maxRequestUploadIntoNotProphylactic) {
      setProphylacticUploadAttachment(true);
      prophylacticConfig.prophylacticUploadAttachment.lastBlocked = currentTime;
      const pendingTasks = loadPendingTasks();
      if (pendingTasks.length > 0) {
        setProphylacticUploadAttachment(false, true);
        logManagerBot(`[AutoSessionSwitch] Upload limit reached (${prophylacticConfig.prophylacticUploadAttachment.numRequestZalo}/${maxRequestUploadIntoNotProphylactic}). Chuyen session...`);
        console.log(`[AutoSessionSwitch] Upload limit reached. Chuyen session...`);
        setTimeout(() => {
          checkLimitAndSwitchSession("upload_limit", {
            taskId: pendingTasks[0].id
          }).catch(err => console.error("[AutoSessionSwitch] Loi:", err));
        }, 1000);
      }
    }
  }
}

export function isAdmin(userId, threadId, groupAdmins) {
  if (!userId) return false;
  const idStr = String(userId).trim();
  if (!idStr) return false;

  const groupSettings = readGroupSettings();
  const role = resolveUserRole(idStr, {
    threadId,
    mainAdmins: readMainBotAdmins(),
    highCommandAdmins: readHighCommandAdmins(),
    botAdmins: readAdmins(),
    groupSettings,
  });
  return ROLE_LEVELS[role] >= ROLE_LEVELS.adminBox;
}

let api;
const MAX_STARTUP_RETRIES = 5;
const STARTUP_RETRY_DELAY = 5000;
const QR_BOOTSTRAP_TIMEOUT_MS = 30000;
const CREDENTIAL_RELOAD_TIMEOUT_MS = 5000;
const QR_BOOTSTRAP_SESSION = process.env.QR_BOOTSTRAP_SESSION || "";
const QR_BOOTSTRAP_ONLY = process.env.QR_BOOTSTRAP_ONLY === "true";

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

export function hasRequiredCredentials(credentials) {
  if (!credentials || typeof credentials !== "object") return false;
  const cookie = String(credentials.cookie || "").trim();
  const imei = String(credentials.imei || "").trim();
  return cookie.length > 0 && imei.length > 0;
}

export function decideStartupFailureAction({
  error,
  botName = "admin",
  retryCount = 0,
  maxRetries = MAX_STARTUP_RETRIES,
  hasRecoveredWithQr = false,
  credentials = null,
} = {}) {
  const hasMissingCreds = credentials !== null && !hasRequiredCredentials(credentials);
  const authFailure = error ? classifyAuthError(error) : { isAuthError: false, reason: "none" };
  const isAuthOrMissing = hasMissingCreds || authFailure.isAuthError;
  const reason = hasMissingCreds ? "missing-credentials" : authFailure.reason;

  const isMainInstance = botName === "admin";

  if (isAuthOrMissing) {
    if (isMainInstance) {
      if (hasRecoveredWithQr) {
        return {
          action: "stop",
          reason: "qr-recovery-exhausted",
          isAuthError: true,
          error: "Admin credentials still invalid after QR recovery",
        };
      }
      return {
        action: "admin-recovery",
        reason,
        isAuthError: true,
      };
    }

    return {
      action: "stop",
      reason,
      isAuthError: true,
      error: `Sub-bot '${botName}' credentials invalid or expired`,
    };
  }

  if (retryCount + 1 < maxRetries) {
    const delay = STARTUP_RETRY_DELAY * (retryCount + 1);
    return {
      action: "retry",
      retryCount: retryCount + 1,
      delay,
      reason: "transient-network",
      isAuthError: false,
    };
  }

  return {
    action: "stop",
    reason: "max-retries-exceeded",
    isAuthError: false,
    error: `Bot stopped after ${maxRetries} failed startup attempts`,
  };
}

export function classifyAuthError(error) {
  const code = String(error?.code || error?.error_code || error?.errorCode || "").toLowerCase();
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const message = String(error?.message || error?.body || error || "").toLowerCase();
  const authCodes = new Set(["401", "403", "-1003", "cookie_invalid", "cookie_expired", "unauthorized", "forbidden", "missing_params", "invalid_cookie"]);
  const authMessage = (
    message.includes("missing required params") ||
    message.includes("missing params") ||
    message.includes("invalid cookie") ||
    message.includes("cookie is not available") ||
    message.includes("user agent is not available") ||
    message.includes("cookie may have expired") ||
    message.includes("cookie is expired") ||
    message.includes("cookie đã hết hạn") ||
    message.includes("không hợp lệ") ||
    message.includes("khong hop le") ||
    message.includes("hết hạn") ||
    message.includes("het han") ||
    message.includes("login failed") ||
    message.includes("login data is null") ||
    message.includes("failed to fetch login info") ||
    message.includes("failed to fetch server info") ||
    message.includes("failed to decrypt login data") ||
    message.includes("zpw_ws") ||
    message.includes("zpw_enk") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    (message.includes("cookie") && (
      message.includes("expired") ||
      message.includes("invalid") ||
      message.includes("missing") ||
      message.includes("format")
    ))
  );
  if (authCodes.has(code) || status === 401 || status === 403 || authMessage) {
    return { isAuthError: true, reason: code || (status ? String(status) : "cookie-invalid"), status: status || null, code: code || null };
  }
  return { isAuthError: false, reason: "not-auth" };
}

function markAdminCookieDead(reason) {
  if (botName !== resolveAdminBotIdSync({ root: projectRoot })) return;
  const state = readJsonSafe(adminStatePath, {});
  writeJsonAtomic(adminStatePath, {
    ...state,
    uid: state.uid || String(idBot > 0 ? idBot : ""),
    cookieDead: true,
    cookieDeadAt: new Date().toISOString(),
    cookieDeadReason: reason || "cookie-invalid",
  });
  updateAdminBotStatus("recovering", { cookieDead: true });
}

function markAdminCookieAlive() {
  if (botName !== resolveAdminBotIdSync({ root: projectRoot })) return;
  const state = readJsonSafe(adminStatePath, {});
  writeJsonAtomic(adminStatePath, {
    ...state,
    uid: String(idBot || state.uid || ""),
    cookieDead: false,
    cookieDeadAt: null,
    cookieDeadReason: null,
    lastReadyAt: new Date().toISOString(),
  });
  updateAdminBotStatus("running", { cookieDead: false });
}

function isExpiredCookieError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('cookie') && (
    message.includes('expired') ||
    message.includes('invalid') ||
    message.includes('hết hạn') ||
    message.includes('không hợp lệ')
  );
}

function buildZaloClient(credentials = config) {
  const runtimeConfig = getZaloRuntimeConfig();
  return new Zalo(
    {
      cookie: credentials?.cookie,
      imei: credentials?.imei,
      userAgent: credentials?.userAgent || runtimeConfig.userAgent,
    },
    {
      selfListen: true,
      checkUpdate: false,
      uploadAttachmentHooks: {
        checkConfigUploadAttachment,
        getProphylacticUploadAttachment,
        setProphylacticUploadAttachment,
      },
    }
  );
}

function extractProfileField(userInfo, fieldNames) {
  const candidates = [
    userInfo,
    userInfo?.data,
    userInfo?.changed_profiles,
    userInfo?.profiles,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    for (const field of fieldNames) {
      if (candidate[field]) return candidate[field];
    }
    for (const value of Object.values(candidate)) {
      if (value && typeof value === "object") {
        for (const field of fieldNames) {
          if (value[field]) return value[field];
        }
      }
    }
  }
  return "";
}

async function resolveBotIdentity(apiInstance, uid, credentials = config) {
  let userInfo = null;
  try {
    if (uid && typeof apiInstance?.getUserInfo === "function") {
      userInfo = await apiInstance.getUserInfo(uid);
    }
  } catch (error) {
    console.warn(`[QR-BOOTSTRAP] Cannot fetch user info for ${uid}: ${error.message}`);
  }

  const usernameVal = extractUsernameFromUserInfo(userInfo, uid) ||
    normalizeUsername(credentials.canonicalUsername || credentials.zaloUsername || credentials.username || "");

  return {
    uid: String(uid || ""),
    displayName: extractProfileField(userInfo, ["displayName", "dName", "name", "zaloName"]) || credentials.displayName || credentials.name || "",
    avatar: extractProfileField(userInfo, ["avatar", "avatarUrl", "avatar_url", "photo"]) || credentials.avatar || "",
    canonicalUsername: usernameVal || "",
  };
}

async function runBootstrapOnly() {
  if (!QR_BOOTSTRAP_ONLY) return false;
  if (!QR_BOOTSTRAP_SESSION) {
    console.error("[QR-BOOTSTRAP] Missing QR_BOOTSTRAP_SESSION");
    process.exit(1);
  }
  const timeout = setTimeout(() => {
    writeIdentityHandshake(QR_BOOTSTRAP_SESSION, {
      status: "timeout",
      pid: process.pid,
      configPath: process.env.CONFIG_PATH || "",
      error: `Bootstrap exceeded ${QR_BOOTSTRAP_TIMEOUT_MS}ms`,
    });
    process.exit(1);
  }, QR_BOOTSTRAP_TIMEOUT_MS);
  try {
    writeIdentityHandshake(QR_BOOTSTRAP_SESSION, {
      status: "starting",
      pid: process.pid,
      configPath: process.env.CONFIG_PATH || "",
    });
    const zalo = buildZaloClient(config);
    const bootstrapApi = await zalo.login();
    bootstrapApi.assertReady();
    const identity = await resolveBotIdentity(bootstrapApi, zalo.userId, config);
    writeIdentityHandshake(QR_BOOTSTRAP_SESSION, {
      status: identity.uid ? "ready" : "auth_failed",
      ...identity,
      pid: process.pid,
      configPath: process.env.CONFIG_PATH || "",
      error: identity.uid ? undefined : "Zalo login returned an empty uid",
    });
    try {
      bootstrapApi.listener?.ws?.close?.();
    } catch {}
    clearTimeout(timeout);
    process.exit(identity.uid ? 0 : 1);
  } catch (error) {
    writeIdentityHandshake(QR_BOOTSTRAP_SESSION, {
      status: "auth_failed",
      pid: process.pid,
      configPath: process.env.CONFIG_PATH || "",
      error: error.message,
    });
    clearTimeout(timeout);
    process.exit(1);
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function recoverAdminWithQr() {
  if (botName !== 'admin') return { success: false, spawnFailed: true, reason: "not-admin" };
  if (process.env.MYBOT_DASHBOARD_MANAGED === "1" && process.env.MYBOT_ALLOW_TERMINAL_QR !== "1") {
    markAdminCookieDead("waiting-web-dashboard-recovery");
    updateAdminBotStatus("stopped", { cookieDead: true });
    const dashPort = Number(process.env.DASHBOARD_PORT || 4173);
    console.warn(`\n[LIFERAFT] Cookie Bot Admin chưa có hoặc đã hết hạn.`);
    console.warn(`[LIFERAFT] Mở ngay Web Dashboard: http://localhost:${dashPort} -> Bấm "Quét QR Khôi Phục Admin" (Không cần thao tác trên Terminal!).\n`);
    return { success: false, cancelled: true, reason: "webDashboardStandby" };
  }
  if (fs.existsSync(adminRecoveryLockPath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(adminRecoveryLockPath, "utf8"));
      const ownerPid = Number(lockData?.ownerPid || 0);
      const childPid = Number(lockData?.pid || 0);
      if (ownerPid > 0 && ownerPid !== process.pid && !isProcessAlive(ownerPid)) {
        console.warn(`[QR] Phát hiện tiến trình QR mồ côi (PID: ${childPid}) từ admin cũ (${ownerPid}), tự động thu hồi.`);
        if (childPid > 0 && isProcessAlive(childPid)) {
          try { process.kill(childPid); } catch {}
        }
        fs.unlinkSync(adminRecoveryLockPath);
      } else if (isRecoveryLockActive(lockData, { currentPid: process.pid, isProcessAlive })) {
        console.error(`[QR] Admin recovery is already running (PID: ${lockData.pid}).`);
        return { success: false, cancelled: true, reason: "already-running" };
      } else {
        console.warn("[QR] Phát hiện lock recovery cũ không còn hoạt động, tự động dọn dẹp.");
        fs.unlinkSync(adminRecoveryLockPath);
      }
    } catch {
      try { fs.unlinkSync(adminRecoveryLockPath); } catch {}
    }
  }

  const qrScript = path.join(projectRoot, 'qr-login-admin.js');
  if (!fs.existsSync(qrScript)) {
    console.error(`[QR] Không tìm thấy script recovery: ${qrScript}`);
    return { success: false, spawnFailed: true, reason: "spawnFailed" };
  }

  console.log('[QR] Cookie admin hết hạn hoặc thiếu credentials. Đang mở QR login để đăng nhập lại...');
  logManagerBot('[QR] Cookie admin hết hạn hoặc thiếu credentials. Đang chuyển sang QR login...');
  if (process.env.BOT_MANAGED === 'true') {
    console.log('[QR] Bot đang chạy dưới PM2: mã QR sẽ được publish vào dashboard (GET /api/system/admin-recovery) và hiển thị bằng: npm run admin:recovery:show');
  }

  markAdminCookieDead("cookie-invalid");
  writeJsonAtomic(adminRecoveryLockPath, {
    pid: process.pid,
    ownerPid: process.pid,
    phase: "starting",
    startedAt: new Date().toISOString(),
  });

  getListenerRuntimeState().setStartupPhase("qr-recovery");
  const { runQrRecoveryWithLimit } = await import("./runtime/qr-recovery-limiter.js");
  let activeQrChild = null;
  const cleanupQrChildOnExit = () => {
    try { activeQrChild?.kill?.(); } catch {}
  };
  process.once("exit", cleanupQrChildOnExit);
  let recovery;
  try {
    recovery = await runQrRecoveryWithLimit({
      lockPath: adminRecoveryLockPath,
      limitMs: 120_000,
      spawnChild: () => {
        const qrEnv = { ...process.env, BOT_NAME: 'admin' };
        delete qrEnv.pm_exec_path;
        delete qrEnv.pm_id;
        delete qrEnv.NODE_APP_INSTANCE;
        const child = spawn(process.execPath, [qrScript], {
          cwd: projectRoot,
          stdio: 'inherit',
          windowsHide: process.env.BOT_MANAGED === 'true',
          env: qrEnv,
        });
        activeQrChild = child;
        writeJsonAtomic(adminRecoveryLockPath, {
          pid: child.pid || 0,
          ownerPid: process.pid,
          phase: "qr-child",
          startedAt: new Date().toISOString(),
        });
        child.once('error', (error) => {
          console.error(`[QR] Không thể khởi động QR login: ${error.message}`);
        });
        return child;
      },
    });
  } finally {
    activeQrChild = null;
    process.removeListener("exit", cleanupQrChildOnExit);
  }

  const exitCode = recovery.timedOut ? 1 : (recovery.exitCode ?? 1);
  if (recovery.timedOut) {
    console.error("[QR] QR recovery vượt quá giới hạn 120s. Kết thúc QR child và dọn lock.");
    logManagerBot("[QR] QR recovery timeout (120s).");
    getListenerRuntimeState().setStartupError("qr-recovery-timeout");
  } else {
    try {
      if (fs.existsSync(adminRecoveryLockPath)) fs.unlinkSync(adminRecoveryLockPath);
    } catch {}
  }

  if (exitCode !== 0) {
    if (exitCode === QR_UID_MISMATCH_EXIT_CODE) {
      console.error("[QR] Phát hiện QR login trùng tài khoản admin, dừng để tránh chạy ẩn.");
    }
    markAdminCookieDead(exitCode === QR_UID_MISMATCH_EXIT_CODE ? "uid-mismatch" : "qr-cancelled-or-failed");
    updateAdminBotStatus("stopped", { cookieDead: true });
    console.error(`[QR] QR login thất bại hoặc bị hủy (mã ${exitCode}).`);
    const reason = exitCode === QR_UID_MISMATCH_EXIT_CODE
      ? "uidMismatch"
      : exitCode === QR_CANCELLED_EXIT_CODE
        ? "cancelled"
        : "spawnFailed";
    return { success: false, uidMismatch: reason === "uidMismatch", cancelled: reason === "cancelled", spawnFailed: reason === "spawnFailed", reason };
  }

  // qr-login-admin.js writes assets/config.json; reload it before retrying.
  config = readConfig();
  if (!hasRequiredCredentials(config)) {
    console.error("[QR] Thông tin credentials trong config.json vẫn thiếu sau khi quét QR.");
    markAdminCookieDead("credentials-still-missing");
    updateAdminBotStatus("stopped", { cookieDead: true });
    return { success: false, credentialsInvalid: true, reason: "credentialsInvalid" };
  }

  console.log('[QR] Đăng nhập QR thành công. Đang thử khởi động bot lại...');
  logManagerBot('[QR] Đăng nhập QR thành công. Đang thử khởi động bot lại...');
  return { success: true };
}

let adminStartupCoordinator = null;

function getAdminStartupCoordinator() {
  if (!adminStartupCoordinator) {
    adminStartupCoordinator = createAdminStartupCoordinator({
      credentials: config,
      login: async (credentials) => {
        const zalo = buildZaloClient(credentials);
        // 30s login deadline: admin must never hang PM2-online forever.
        api = await withDeadline(zalo.login(), LOGIN_DEADLINE_MS, "Admin login deadline");
        api.assertReady();
        setBotId(zalo.userId);
        markAdminCookieAlive();
        api.getBotId = () => getBotId();
        return api;
      },
      recoverWithQr: recoverAdminWithQr,
      reloadCredentials: async () => {
        config = readConfig();
        return config;
      },
      logger: (message) => {
        if (message.startsWith("Startup retry scheduled")) {
          const delay = Number(message.match(/(\d+)ms$/)?.[1] || 0);
          terminalLog({
            scope: "listener",
            level: "warn",
            title: "Startup retry scheduled",
            lines: [`delay: ${delay / 1000}s`],
            countAsRetry: true,
          });
        } else {
          console.error(message);
          logManagerBot(message);
        }
      },
    });
  }
  return adminStartupCoordinator;
}

async function attemptStart(retryCount = 0, hasRecoveredWithQr = false) {
  const _listenerState = getListenerRuntimeState();
  if (botName === "admin") {
    _listenerState.setStartupPhase("login");
    const result = await getAdminStartupCoordinator().start();
    if (result.status === "ONLINE") return true;
    _listenerState.setStartupError(result.reason || result.error?.message || "startup failed");
    logManagerBot(`[FATAL] Admin bot stopped: ${result.reason || result.error?.message || "startup failed"}`);
    terminalLog({
      scope: "listener",
      level: "error",
      title: "Startup stopped",
      lines: [result.reason || result.error?.message || "startup failed"],
    });
    return false;
  }

  try {
    _listenerState.setStartupPhase(retryCount > 0 ? "login-retry" : "login");
    if (!hasRequiredCredentials(config)) {
      throw new Error("Missing required params");
    }
    const zalo = buildZaloClient(config);
    // 30s login deadline: a hung zalo.login() must not leave PM2 reporting
    // online while the bot can never become ready.
    api = await withDeadline(zalo.login(), LOGIN_DEADLINE_MS, "Child bot login deadline");
    api.assertReady();
    setBotId(zalo.userId);
    markAdminCookieAlive();
    api.getBotId = () => getBotId();
    return true;
  } catch (error) {
    logManagerBot(`[FATAL] Lần khởi động ${retryCount + 1} thất bại: ${error.message}`);
    terminalLog({
      scope: "listener",
      level: "error",
      title: "Startup failed",
      lines: [`attempt: ${retryCount + 1}`, error.message],
    });

    const decision = decideStartupFailureAction({
      error,
      botName,
      retryCount,
      maxRetries: MAX_STARTUP_RETRIES,
      hasRecoveredWithQr,
      credentials: config,
    });

    if (decision.action === "admin-recovery") {
      markAdminCookieDead(decision.reason);
      const recovered = await recoverAdminWithQr();
      if (recovered) {
        config = readConfig();
        return attemptStart(0, true);
      }
      return false;
    }

    if (decision.action === "retry") {
      terminalLog({
        scope: "listener",
        level: "warn",
        title: "Startup retry scheduled",
        lines: [`delay: ${decision.delay / 1000}s`],
        countAsRetry: true,
      });
      await new Promise(r => setTimeout(r, decision.delay));
      return attemptStart(decision.retryCount, hasRecoveredWithQr);
    }

    logManagerBot(`[FATAL] Bot đã dừng: ${decision.error || decision.reason}`);
    terminalLog({
      scope: "listener",
      level: "error",
      title: "Startup stopped",
      lines: [decision.error || `reason: ${decision.reason}`],
    });
    return false;
  }
}

  let adminStandbyLiferaft = false;
  let _servicesBootstrapped = false;

  if (process.env.SKIP_ENV_VALIDATION || process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test") {
    console.log("[BOOT] Startup skipped in validation/test mode.");
  } else {
    await runBootstrapOnly();

    const started = await attemptStart();
    if (!started) {
      const botName = getBotName();
      try {
        writeBotPid();
        const stateDir = path.join(projectRoot, 'mybot', 'state');
        if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
        const statePath = path.join(stateDir, `${botName}.json`);
        let state = {};
        if (fs.existsSync(statePath)) {
          state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        }
        state.cookieDead = true;
        state.cookieDeadAt = new Date().toISOString();
        state.cookieDeadReason = "login-failed-or-cookie-expired";
        state.pid = process.pid;
        state.webPort = Number(process.env.WEB_PORT || config?.webPort || (botName === "admin" ? 2000 : 3000));
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        console.error(`[COOKIE-DEAD] Đánh dấu cookie chết cho bot ${botName}`);
      } catch (e) {
        console.error(`Lỗi ghi cookie dead flag: ${e.message}`);
      }
      if (botName === "admin" && process.env.MYBOT_DASHBOARD_MANAGED === "1") {
        adminStandbyLiferaft = true;
        console.warn(`[LIFERAFT] Bot Admin chuyển sang chế độ Trực Chiến Cứu Hộ (Standby) — Web Dashboard vẫn luôn hoạt động trên cổng ${process.env.DASHBOARD_PORT || 4173}.`);
      } else {
        setTimeout(() => process.exit(COOKIE_DEAD_EXIT_CODE), 1000);
        await new Promise(() => {});
      }
    }
    writeBotPid();
  }

if (api) {
  const liveUid = getBotId();
  const descriptor = getRuntimeInstanceDescriptor();
  const verification = verifyRuntimeIdentity(descriptor, liveUid);
  if (!verification.verified && verification.action === "exit") {
    console.error(`[BOOT:IDENTITY:FATAL] ${verification.reason}`);
    try { api?.listener?.ws?.close?.(); } catch {}
    process.exit(verification.exitCode || 13);
  }

  try {
    const verifiedId = resolveCurrentInstanceIdentity({
      api,
      botName,
      configPath: process.env.CONFIG_PATH,
      projectRoot,
    });
    if (verifiedId.verified) {
      persistVerifiedInstanceIdentity({
        instanceKind: verifiedId.instanceKind,
        liveUid: verifiedId.processBotUid,
        botName,
        configPath: process.env.CONFIG_PATH,
        projectRoot,
      });
    }
  } catch (idErr) {
    console.error("[BOOT] Lỗi xác thực và lưu định danh bot:", idErr.message);
  }

  try {
    const hydrated = await hydrateCurrentBotIdentity({
      api,
      botId: idBot > 0 ? String(idBot) : (descriptor.isMain ? undefined : botName),
      projectRoot,
    });
    if (hydrated?.hydrated) {
      console.log(`[BOOT] Đã đồng bộ định danh bot (${hydrated.botId}): globalUid=${hydrated.globalUid || "N/A"}, username=${hydrated.canonicalUsername || "N/A"}`);
    }
  } catch (hydErr) {
    console.error("[BOOT] Lỗi hydrate định danh bot:", hydErr.message);
  }
}

const isTestMode = Boolean(
  process.env.SKIP_ENV_VALIDATION ||
  process.env.NODE_TEST_CONTEXT ||
  process.env.NODE_ENV === "test" ||
  process.execArgv.some(a => a.includes("test")) ||
  process.argv.some(a => a.includes("test"))
);

if (!isTestMode && getRuntimeInstanceDescriptor().isMain) {
  try {
    const adminWebPort = (process.env.WEB_PORT || config.webPort || "2000").toString();
    const resolvedIdentity = resolveAdminIdentity({ projectRoot, api, config, stateDir });
    dedupeMyBotsRegistry({ adminUid: String(resolvedIdentity.adminUid), adminPid: process.pid, adminWebPort, removeAliasFiles: true });
    syncMainBotRegistry({
      projectRoot,
      adminUid: resolvedIdentity.adminUid,
      webPort: adminWebPort,
      pid: process.pid,
      forceSave: true,
      identityInfo: resolvedIdentity,
    });
    console.log("Đã chuẩn hóa và đăng ký bot admin vào mybots.json");
  } catch (e) {
    console.error("Lỗi đăng ký bot admin:", e.message);
  }
}

// (MANDATORY runtime bridge is bound later in the !isTestMode block, after
// `isTestMode` and `api` are both known. That keeps the bridge as a hard
// requirement without forcing a TDZ-aware reorder of the top-level flow.)

// Resolve runtime test mode here so the bridge block below can use it.

process.on("exit", () => {
  removeBotPid();
  if (isTestMode) return;
  const descriptor = getRuntimeInstanceDescriptor();
  const isMainExit = shouldUpdateMainStatusOnExit(descriptor);
  if (isMainExit) {
    updateAdminBotStatus("stopped");
  } else {
    // Child bot or unknown: update only our own record if we can identify it
    const exitOwner = resolveExitStatusOwner({ descriptor });
    if (exitOwner && exitOwner.toLowerCase() !== "admin") {
      try {
        const myBotsPath = path.join(projectRoot, "mybot", "mybots.json");
        if (fs.existsSync(myBotsPath)) {
          const myBots = loadMyBotsRegistry();
          if (myBots[exitOwner]) {
            myBots[exitOwner].status = "stopped";
            myBots[exitOwner].lastUpdated = new Date().toISOString();
            saveMyBotsRegistry(myBots);
            console.log(`Đã cập nhật trạng thái bot ${exitOwner} thành stopped`);
          }
        }
      } catch (e) {
        console.error("Lỗi cập nhật trạng thái bot con:", e.message);
      }
    }
  }
});

function updateAdminBotStatus(status, extra = {}) {
  try {
    const myBotsPath = path.join(projectRoot, "mybot", "mybots.json");
    if (!fs.existsSync(myBotsPath)) return;
    const myBots = loadMyBotsRegistry();
    if (myBots["admin"]) {
      myBots["admin"].status = status;
      Object.assign(myBots["admin"], extra);
      myBots["admin"].lastUpdated = new Date().toISOString();
    }
    saveMyBotsRegistry(myBots);
    console.log(`Đã cập nhật trạng thái bot admin thành ${status}`);
  } catch (e) {
    console.error("Lỗi cập nhật trạng thái bot admin:", e.message);
  }
}

process.on("SIGINT", () => {
  try { shutdownLocmem(getRuntimeContext()); } catch {}
  if (shouldUpdateMainStatusOnExit(getRuntimeInstanceDescriptor())) {
    updateAdminBotStatus("stopped");
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  try { shutdownLocmem(getRuntimeContext()); } catch {}
  if (shouldUpdateMainStatusOnExit(getRuntimeInstanceDescriptor())) {
    updateAdminBotStatus("stopped");
  }
  process.exit(0);
});

const switchFlag = getSwitchFlag();
if (switchFlag) {
  logManagerBot(`[AutoSessionSwitch] Phat hien switch flag: ${switchFlag.reason}`);
  console.log(`[AutoSessionSwitch] Phat hien switch flag: ${switchFlag.reason}`);
}

const pendingTasks = api ? resumePendingTasks(api) : [];
if (pendingTasks.length > 0) {
  logManagerBot(`[AutoSessionSwitch] Da tai lai ${pendingTasks.length} task dang cho`);
  console.log(`[AutoSessionSwitch] Da tai lai ${pendingTasks.length} task dang cho`);
}

const spamTasks = pendingTasks.filter(t => t.type === "spamgroup");

if (!isTestMode) {
  // MANDATORY runtime bridge: bound right after login/identity, NOT as an
  // optional dashboard convenience. A bind failure throws a structured error
  // (code, port, botKey, pid — e.g. BRIDGE_PORT_IN_USE) that exits the process
  // with the real cause, so PM2 never keeps a bot "online" with a closed port
  // and reconcile can auto-fix the port.
  registerRuntimeReloadHandler(async (payload) => performCredentialReload(payload));
  try {
    await startWebServer(api);
  } catch (error) {
    const descriptor = getRuntimeInstanceDescriptor();
    const portLabel = error.port || descriptor.webPort || "?";
    console.error(`[BRIDGE:FATAL] ${error.code || "BRIDGE_BIND_FAILED"} on 127.0.0.1:${portLabel} bot=${error.botKey || descriptor.botKey} pid=${error.pid || process.pid}: ${error.message}`);
    if (error.code === "EADDRINUSE" || error.code === "BRIDGE_PORT_IN_USE") {
      if (descriptor.isMain) {
        // Main bot KEEPS its fixed port 2000 — never auto-changes. Report the
        // occupant and stop so an operator can resolve the conflict.
        console.error(`[BRIDGE:MAIN] Admin bot keeps fixed port ${portLabel}; resolve the port conflict manually (check which process holds it) and restart.`);
      } else {
        console.error(`[BRIDGE:CHILD] Child bot port ${portLabel} is occupied; reconcile will re-provision a free port and reload this child once.`);
      }
    }
    try { api?.listener?.ws?.close?.(); } catch {}
    try { getListenerRuntimeState().setStartupError(error.message); } catch {}
    setTimeout(() => process.exit(1), 1000);
    await new Promise(() => {});
  }

  // 1. Resolve bot runtime context
  const botRuntimeCtx = getActiveRuntimeContext();
  // 2. Load group settings canonical
  loadCanonicalGroupSettings(botRuntimeCtx);
  // 3. Reset topchat của bot hiện tại
  resetRankInfo(botRuntimeCtx);
  // 4. Đăng ký job reset 0h
  scheduleMidnightRankReset(botRuntimeCtx);

  if (api) {
    if (spamTasks.length > 0) {
      resumeSpamSessions(api).catch(err => console.error("[AutoSessionSwitch] Loi resume spam:", err));
    }
    // 2.1 Restore sendtext timers for groups with sendtext enabled
    restoreAutoSendText(api);

    try {
      await initService(api);
      _servicesBootstrapped = true;
    } catch (error) {
      logManagerBot(`[WARN] initService lỗi: ${error.message}. Bot vẫn tiếp tục chạy nhưng dashboard sẽ không kết nối được.`);
      terminalLog({
        scope: "listener",
        level: "warn",
        title: "initService warning",
        lines: [error.message, "Bot continues, dashboard may not connect"],
      });
    }
    const io = getIO();
    const bulkTasks = loadPendingTasks().filter(t => t.type === "bulk_message" && t.status === "pending");
    if (bulkTasks.length > 0) {
      resumeBulkMessages(api, io).catch(err => console.error("[AutoSessionSwitch] Loi resume bulk:", err));
    }
  }
}

// Xử Lý Tin Nhắn Riêng Và Tin Nhắn Nhóm
let _runtimeLifecycle = null;
let _currentListenerBinder = null; // active bindZaloListeners binder
let _leakDetector = null;          // listener leak detector
let _runtimeLogger = null;        // RuntimeLogger instance
let _memoryPressureListener = null; // memory pressure IPC listener
let _startupConnectInProgress = false;

async function refreshZaloSessionForReconnect(currApi, meta = {}) {
  const targetApi = currApi || api;
  const credentialPath = resolveRuntimePath(config?._meta?.configPath || process.env.CONFIG_PATH);
  const diskCredentials = credentialPath ? readJsonSafe(credentialPath, null) : null;
  const diskCookieChanged = Boolean(
    diskCredentials &&
    hasRequiredCredentials(diskCredentials) &&
    String(diskCredentials.cookie).trim() !== String(config?.cookie || "").trim()
  );

  const runtimeCredentials = {
    ...(config || {}),
    cookie: appContext.cookie || config?.cookie,
    imei: appContext.imei || config?.imei,
    userAgent: appContext.userAgent || config?.userAgent,
  };

  const candidates = [];
  if (diskCookieChanged) {
    candidates.push({ label: "disk-updated", creds: diskCredentials });
  }
  if (hasRequiredCredentials(runtimeCredentials)) {
    candidates.push({ label: "runtime", creds: runtimeCredentials });
  }
  if (diskCredentials && hasRequiredCredentials(diskCredentials) && !diskCookieChanged) {
    if (String(diskCredentials.cookie).trim() !== String(runtimeCredentials.cookie || "").trim()) {
      candidates.push({ label: "disk-fallback", creds: diskCredentials });
    }
  }

  if (candidates.length === 0) {
    throw new Error("Missing required credentials for Zalo session refresh");
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const zalo = buildZaloClient(candidate.creds);
      if (typeof zalo.fetchSession === "function" && typeof targetApi?.applyRefreshedSession === "function") {
        const session = await withDeadline(
          zalo.fetchSession(),
          LOGIN_DEADLINE_MS,
          "Reconnect session refresh deadline"
        );
        targetApi.applyRefreshedSession(session);
        if (candidate.label === "disk-updated") {
          config = {
            ...candidate.creds,
            _meta: { ...(config?._meta || {}), configPath: credentialPath, reloadedAt: new Date().toISOString() },
          };
        }
        setBotId(zalo.userId);
        updateWebServerApi(targetApi);
        logManagerBot(`[INFO] Đã làm mới phiên Zalo thành công (${candidate.label}, attempt=${meta?.attempt || 1}).`);
        return targetApi;
      }

      const nextApi = await withDeadline(
        zalo.login(),
        LOGIN_DEADLINE_MS,
        "Reconnect session login deadline"
      );
      nextApi.assertReady();
      nextApi.getBotId = () => getBotId();
      try { targetApi?.listener?.stop?.(); } catch {}
      api = nextApi;
      setBotId(zalo.userId);
      updateWebServerApi(nextApi);
      await bindBotEventHandlers(nextApi);
      return nextApi;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Zalo session refresh failed");
}

export async function getOrCreateRuntimeLifecycle(apiInstance) {
  if (_runtimeLifecycle) {
    if (apiInstance) {
      _runtimeLifecycle.updateApi(apiInstance);
    }
    _runtimeLifecycle.setReconnectHooks?.({
      refreshSession: refreshZaloSessionForReconnect,
      onListenerReconnected: async (reconnectedApi) => {
        try {
          await onListenerReady(reconnectedApi, getRuntimeContext());
        } catch (err) {
          logManagerBot(`[WARN] onListenerReady after reconnect error: ${err.message}`);
        }
      },
    });
    return _runtimeLifecycle;
  }
  const descriptor = getRuntimeInstanceDescriptor();
  _runtimeLifecycle = await createRuntimeLifecycle({
    projectRoot,
    botName: descriptor.botKey || botName || "admin",
    api: apiInstance,
    handlers: {
      message: messagesUser,
      group_event: groupEvents,
      undo: undoMessageEvents,
      reaction: reactionEvents,
    },
    logger: {
      info: (msg) => logManagerBot(msg),
      warn: (msg) => logManagerBot(msg),
      error: (msg) => logManagerBot(msg),
    },
    refreshSession: refreshZaloSessionForReconnect,
    onListenerReconnected: async (reconnectedApi) => {
      try {
        await onListenerReady(reconnectedApi, getRuntimeContext());
      } catch (err) {
        logManagerBot(`[WARN] onListenerReady after reconnect error: ${err.message}`);
      }
    },
  });
  return _runtimeLifecycle;
}

/**
 * Initialize the RuntimeLogger once (lazy, guarded by botName).
 * Creates logs under logs/<botName>/ with 4 log kinds.
 */
function getRuntimeLogger() {
  if (_runtimeLogger) return _runtimeLogger;
  const logsDir = path.join(projectRoot, 'logs', botName);
  _runtimeLogger = createRuntimeLogger({ logsDir, botKey: botName });
  return _runtimeLogger;
}

/**
 * Start memory-pressure IPC listener if running under PM2.
 * Reads .runtime/pressure/<pm2Name>.flag files, runs GC, writes ACK.
 */
function startMemoryPressureIfManaged(hooks = []) {
  if (process.env.BOT_MANAGED !== 'true') return;
  const pm2Name = process.env.BOT_NAME || botName;
  _memoryPressureListener = startMemoryPressureWatcher({
    pm2Name,
    projectRoot,
    pruneHooks: hooks,
    logger: _runtimeLogger || null,
  });
  terminalLog({ scope: "listener", level: "info", title: "Memory pressure watcher started", lines: [`pm2Name: ${pm2Name}`] });
}

async function bindBotEventHandlers(apiInstance) {
  const lifecycle = await getOrCreateRuntimeLifecycle(apiInstance);
  const fastPathDispatcher = lifecycle.fastPathDispatcher;
  const inboundCoordinator = lifecycle.inboundCoordinator;
  const inboundDispatcher = lifecycle.dispatcher;
  const logger = getRuntimeLogger();

  // Start memory pressure listener once and hook into runtime lifecycle maintenance
  if (!_memoryPressureListener) {
    startMemoryPressureIfManaged([async () => lifecycle?.maintenance?.runContinuousPrune?.()]);
  } else if (lifecycle?.maintenance?.runContinuousPrune && !_memoryPressureListener.pruneHooks.length) {
    _memoryPressureListener.pruneHooks.push(async () => lifecycle.maintenance.runContinuousPrune());
  }

  // Replay unacked events from spool if any existed from previous crash
  try {
    const replayResult = await inboundCoordinator.replay((envelope) => inboundDispatcher.dispatch(envelope));
    if (replayResult.replayed > 0) {
      logManagerBot(`[INFO] Replayed ${replayResult.replayed} persisted events from spool.`);
    }
  } catch (replayErr) {
    logManagerBot(`[WARN] Spool replay warning: ${replayErr.message}`);
  }

  // Dispose the OLD binder before creating a new one. This is the key fix:
  // without this, every reconnect adds duplicate listeners (N×messages bug).
  if (_currentListenerBinder) {
    const removed = _currentListenerBinder.dispose();
    _currentListenerBinder = null;
    terminalLog({ scope: "listener", level: "info", title: "Listener binder disposed", lines: [`removed: ${removed}`] });
  }

  // Build handlers that also log through RuntimeLogger
  function markListenerAlive() {
    try {
      getListenerRuntimeState().markEventEvidence();
    } catch {}
  }

  function messageHandler(message) {
    // Any real Zalo message is proof the listener socket is alive: heal a
    // stale `retrying` state back to `connected` so readiness stops reporting
    // `listener-disconnected` on a working bot.
    markListenerAlive();
    if (process.env.ZALO_DEBUG_SEND_RECEIPT === "1" && message.isSelf) {
      console.log(`[SELF ECHO] threadId="${message.threadId || ""}" type=${message.type} msgId="${message.data?.msgId || ""}" cliMsgId="${message.data?.cliMsgId || ""}"`);
    }
    fastPathDispatcher.dispatchMessage(message).catch((error) => {
      const detailError = `Mã Lỗi: ${error.code} - > Chú Thích Lỗi Tin Nhắn: ${error.message}\nNội Dung Lỗi: ${error.stack}`;
      logManagerBot(detailError);
      terminalLog({ scope: "listener", level: "error", title: "Message handler error", lines: [detailError] });
      logger.error({ scope: "listener", err: error, message: detailError });
    });
    // Only log chat messages to .ndjson when explicitly enabled
    if (process.env.LOG_CHAT_MESSAGES === "true") {
      logger.message({
        threadId: message.threadId || '',
        userId: message.data?.uidFrom || '',
        content: message.data?.msgContent || '',
        extra: { type: message.type, isSelf: message.isSelf },
      });
    }
  }

  function groupEventHandler(event) {
    markListenerAlive();
    fastPathDispatcher.dispatchGroupEvent(event).catch((error) => {
      const detailError = `Mã Lỗi: ${error.code} - > Chú Thích Lỗi Sự Kiện Nhóm: ${error.message}\nNội Dung Lỗi: ${error.stack}`;
      logManagerBot(detailError);
      terminalLog({ scope: "listener", level: "error", title: "Group event handler error", lines: [detailError] });
      logger.error({ scope: "group-event", err: error, message: detailError });
    });
  }

  function undoHandler(undo) {
    markListenerAlive();
    fastPathDispatcher.dispatchUndo(undo).catch((error) => {
      const detailError = `Mã Lỗi: ${error.code} - > Chú Thích Lỗi Sự Kiện Undo: ${error.message}\nNội Dung Lỗi: ${error.stack}`;
      logManagerBot(detailError);
      terminalLog({ scope: "listener", level: "error", title: "Undo handler error", lines: [detailError] });
      logger.error({ scope: "undo", err: error, message: detailError });
    });
  }

  function reactionHandler(reaction) {
    markListenerAlive();
    fastPathDispatcher.dispatchReaction(reaction).catch((error) => {
      const detailError = `Mã Lỗi: ${error.code} - > Chú Thích Lỗi Sự Kiện Reaction: ${error.message}\nNội Dung Lỗi: ${error.stack}`;
      logManagerBot(detailError);
      terminalLog({ scope: "listener", level: "error", title: "Reaction handler error", lines: [detailError] });
      logger.error({ scope: "reaction", err: error, message: detailError });
    });
  }

  function cipherKeyHandler(generation) {
    try {
      const updated = getListenerRuntimeState().markConnectedForGeneration(generation);
      if (updated) {
        onListenerReady(apiInstance, getRuntimeContext()).catch(() => {});
      }
    } catch {}
  }

  function errorHandler(error, generation) {
    const errMsg = error?.message || String(error || "WebSocket error");
    logManagerBot(`[WARN] WebSocket listener transport error: ${errMsg}`);
    terminalLog({ scope: "listener", level: "warn", title: "WebSocket listener error", lines: [errMsg] });
    logger.warn ? logger.warn({ scope: "ws", message: errMsg }) : null;
    const accepted = markListenerTransportDown(errMsg, generation);
    if (accepted !== false && !_startupConnectInProgress) {
      lifecycle.reconnectCoordinator.schedule("error");
    }
  }

  function closedHandler(generation, closeInfo) {
    const reasonMsg = closeInfo?.reason || "WebSocket closed";
    const scheduleReason = closeInfo?.kickedByDuplicate ? "duplicate_connection" : "closed";
    logManagerBot(`[INFO] ${reasonMsg}. Lên lịch reconnect (${scheduleReason})...`);
    terminalLog({ scope: "listener", level: "warn", title: "WebSocket closed", lines: [reasonMsg, `scheduling reconnect (${scheduleReason})`] });
    logger.system({ scope: "ws", level: "warn", message: reasonMsg });
    const accepted = markListenerTransportDown(reasonMsg, generation);
    if (accepted !== false && !_startupConnectInProgress) {
      lifecycle.reconnectCoordinator.schedule(scheduleReason);
    }
  }

  // Bind all listeners through the binder (prevents duplicate listeners on reconnect)
  _currentListenerBinder = bindZaloListeners(apiInstance.listener, {
    message: messageHandler,
    group_event: groupEventHandler,
    undo: undoHandler,
    reaction: reactionHandler,
    error: errorHandler,
    closed: closedHandler,
    cipher_key: cipherKeyHandler,
  });

  // Initialize leak detector after first bind
  if (!_leakDetector) {
    _leakDetector = new ListenerLeakDetector({
      threshold: 3,
      onLeak: (leaked, reports) => {
        logManagerBot(`[WARN] Listener leak detected: ${leaked.join(', ')}`);
        terminalLog({ scope: "listener", level: "warn", title: "Listener leak detected", lines: [JSON.stringify(reports)] });
        logger.error({ scope: "listener", message: `Listener leak: ${leaked.join(', ')}` });
      },
    });
    _leakDetector.setBaseline(_currentListenerBinder.getListenerCounts());
  }

  terminalLog({ scope: "listener", level: "success", title: "Listeners bound", lines: [`size: ${_currentListenerBinder.size}`] });
}

/**
 * Listener shutdown signal — aborted ONLY on process shutdown or an
 * unrecoverable bootstrap failure. Transient listener errors must never
 * close the web bridge (the PM2 port-closed bug): the bridge stays bound
 * and readiness reports `retrying` until the listener reconnects.
 */
const listenerAbortController = new AbortController();

async function startListenerWithRetry(apiInstance) {
  const listenerState = getListenerRuntimeState();
  let startupAttempts = 0;
  _startupConnectInProgress = true;
  let result;
  try {
    result = await listenerState.connectListenerWithRetry({
      start: async () => {
        startupAttempts += 1;
        if (startupAttempts >= 3 && startupAttempts % 2 === 1) {
          try {
            await refreshZaloSessionForReconnect(apiInstance, { attempt: startupAttempts, reason: "startup-retry" });
          } catch (refreshErr) {
            logManagerBot(`[WARN] Làm mới phiên khi khởi động listener thất bại: ${refreshErr.message}`);
          }
        }
        const rotateEndpoint = startupAttempts > 1;
        if (typeof apiInstance.listener?.startAsync === "function") {
          await apiInstance.listener.startAsync({ rotateEndpoint });
        } else {
          await apiInstance.listener.start();
        }
        logManagerBot("[INFO] WebSocket listener đã khởi động.");
        terminalLog({ scope: "listener", level: "success", title: "WebSocket listener started", lines: [`bot: ${botName}`] });
      },
      signal: listenerAbortController.signal,
      retryDelayMs: 15000,
      onEvent: (event) => {
        if (event.type === "retry") {
          logManagerBot(`[WARN] WebSocket listener lỗi (lần thử ${event.attempts}): ${event.error}. Đang thử lại sau 15s...`);
          terminalLog({ scope: "listener", level: "warn", title: "Listener start failed", lines: [`attempt: ${event.attempts}`, event.error], countAsRetry: true });
        }
      },
    });
  } finally {
    _startupConnectInProgress = false;
  }
  if (result.connected) {
    logManagerBot("[INFO] listener-connected");
    terminalLog({ scope: "listener", level: "success", title: "Listener connected", lines: [`attempts: ${result.attempts}`] });
    try {
      onListenerReady(apiInstance, getRuntimeContext()).catch((err) => {
        logManagerBot(`[WARN] onListenerReady error: ${err.message}`);
      });
    } catch {}
  } else if (result.aborted) {
    logManagerBot("[INFO] Listener retry loop aborted (shutdown).");
  }
  // Deliberately NOT calling closeWebServer() here: the runtime bridge must
  // stay open while the listener retries so PM2/health endpoints keep
  // reporting an accurate picture.
}

/** Mark the listener as transport-disconnected (ws closed/error handlers). */
function markListenerTransportDown(reason, generation = undefined) {
  let accepted = true;
  try {
    // A `closed`/`error` event may arrive late from a PREVIOUS socket. Use the
    // generation-aware variant so a stale event for a replaced socket is
    // dropped and cannot overwrite the healthy `connected` state of the
    // current socket right after a successful reconnect.
    accepted = getListenerRuntimeState().markRetryingForGeneration(reason, generation);
  } catch {}
  if (accepted !== false) {
    try {
      markLocmemDowntime(reason, getRuntimeContext());
    } catch {}
  }
  return accepted;
}

function resolveRuntimePath(filePath) {
  if (!filePath) return "";
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

async function performCredentialReload(request) {
  const startedAt = Date.now();
  writeReloadRequest(botName, {
    ...request,
    status: "reloading",
    error: null,
  });
  try {
    if (request.reloadType === "command-config") {
      const result = await performRuntimeReload(request, {
        reloadCommandConfig,
        setGlobalPrefix,
        writeReloadState: (uid, state) => writeReloadRequest(uid, state),
      });
      writeReloadRequest(botName, {
        ...result,
        status: "ready",
        uid: String(request.uid || botName),
        error: null,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, uid: String(request.uid || botName), reloadType: request.reloadType };
    }
    if (request.reloadType === "command-studio") {
      invalidateRuntimePolicyCache();
      const result = await performRuntimeReload(request, {
        applyStudioCommand: createStudioRuntimeApplier({
          root: projectRoot,
          getBotId,
          initializeSchedulerFn: async ({ schedules, retry }) => initializeScheduler(api, { schedules, retry }),
        }),
        writeReloadState: (uid, state) => writeReloadRequest(uid, state),
      });
      writeReloadRequest(botName, {
        ...result,
        status: result.status || "ready",
        uid: String(request.uid || botName),
        error: null,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, uid: String(request.uid || botName), reloadType: request.reloadType };
    }
    const credentialPath = resolveRuntimePath(request.credentialPath || config._meta?.configPath || process.env.CONFIG_PATH);
    const nextCredentials = readJsonSafe(credentialPath, null);
    if (!nextCredentials) throw new Error(`Cannot read credential file: ${credentialPath}`);
    const zalo = buildZaloClient(nextCredentials);
    const nextApi = await withDeadline(zalo.login(), LOGIN_DEADLINE_MS, "Credential reload login deadline");
    nextApi.assertReady();
    nextApi.getBotId = () => getBotId();
    const previousApi = api;
    try {
      previousApi?.listener?.stop?.();
    } catch {}
    api = nextApi;
    updateWebServerApi(api);
    const lifecycle = await getOrCreateRuntimeLifecycle(api);
    lifecycle.updateApi(api);
    lifecycle.reconnectCoordinator?.reset?.();
    config = { ...nextCredentials, _meta: { ...(config._meta || {}), configPath: credentialPath, reloadedAt: new Date().toISOString() } };
    setBotId(zalo.userId);
    markAdminCookieAlive();
    adminStandbyLiferaft = false;
    await bindBotEventHandlers(api);
    try { restoreAutoSendText(api); } catch {}
    if (!_servicesBootstrapped) {
      await initService(api);
      _servicesBootstrapped = true;
    } else {
      await rebindServiceApi(api);
    }
    await startListenerWithRetry(api);
    getListenerRuntimeState().setStartupPhase("ready");
    writeReloadRequest(botName, {
      ...request,
      status: "ready",
      uid: String(zalo.userId || request.uid || botName),
      error: null,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, uid: String(zalo.userId || "") };
  } catch (error) {
    writeReloadRequest(botName, {
      ...request,
      status: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, error };
  }
}

function startCredentialReloadWatcher() {
  let lastRequestId = "";
  let lastMtimeMs = 0;
  let reloading = false;
  const reloadFilePath = path.join(projectRoot, "mybot", "state", "reload", `${botName}.json`);
  setInterval(async () => {
    if (reloading) return;
    try {
      const stat = fs.statSync(reloadFilePath);
      if (stat.mtimeMs === lastMtimeMs) return;
      lastMtimeMs = stat.mtimeMs;
    } catch {
      return;
    }
    const request = readReloadRequest(botName);
    if (request.status !== "requested" || !request.requestId || request.requestId === lastRequestId) return;
    lastRequestId = request.requestId;
    reloading = true;
    await Promise.race([
      performCredentialReload(request),
      new Promise((resolve) => setTimeout(() => {
        writeReloadRequest(botName, {
          ...request,
          status: "failed",
          error: `Credential reload exceeded ${CREDENTIAL_RELOAD_TIMEOUT_MS}ms`,
          completedAt: new Date().toISOString(),
        });
        resolve(false);
      }, CREDENTIAL_RELOAD_TIMEOUT_MS)),
    ]);
    reloading = false;
  }, 2000).unref?.();
}

if (isTestMode) {
    terminalLog({ scope: "listener", level: "info", title: "Bootstrap skipped", lines: ["validation/test mode enabled"] });
} else if (adminStandbyLiferaft && !api) {
    getListenerRuntimeState().setStartupError("cookie-dead-standby-recovery");
    startCredentialReloadWatcher();
    terminalLogger.writeBanner({ name: "ADMIN LIFERAFT", botName, status: "STANDBY_WEB_QR" });
    terminalLog({
      scope: "listener",
      level: "warn",
      title: "Admin waiting for Web QR recovery",
      lines: [`Mở http://localhost:${process.env.DASHBOARD_PORT || 4173} để quét QR khôi phục Admin`],
    });
} else {
    const _listenerState = getListenerRuntimeState();
    try {
        api.assertReady();
        _listenerState.setStartupPhase("api-ready");
        await bindBotEventHandlers(api);
        logManagerBot("[INFO] api-ready");
        terminalLog({ scope: "listener", level: "success", title: "API ready", lines: [`bot: ${botName}`] });
        await startListenerWithRetry(api);
        _listenerState.setStartupPhase("ready");
        logManagerBot("[INFO] listener-connected");
        startCredentialReloadWatcher();
        terminalLogger.writeBanner({ name: "BOT LISTENER", botName, status: "ONLINE" });
        terminalLog({ scope: "listener", level: "success", title: "Listener connected", lines: [] });
    } catch (error) {
        // Only an unrecoverable bootstrap failure closes the web bridge and
        // exits. Transient listener failures stay inside the retry loop above
        // and never reach this branch.
        _listenerState.setStartupError(error.message);
        logManagerBot(`[FATAL] WebSocket listener lỗi: ${error.message}`);
        terminalLog({ scope: "listener", level: "error", title: "Listener fatal error", lines: [error.message] });
        listenerAbortController.abort();
        await closeWebServer();
        logManagerBot("[FATAL] Bot không thể nhận tin nhắn. Đang tắt...");
        terminalLog({ scope: "listener", level: "error", title: "Listener shutting down", lines: ["Bot cannot receive messages"] });
        setTimeout(() => process.exit(1), 1000);
        await new Promise(() => {});
    }
}
