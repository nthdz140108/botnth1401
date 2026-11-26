import fs from "fs/promises";
import path from "path";
import { createBot } from "./Manager/createBot.js";
import { detailBot } from "./Manager/infoBot.js";
import { readCommandConfig } from "../../utils/io-json.js";

function getGlobalPrefix() {
  try {
    return readCommandConfig()?.prefix || "!";
  } catch {
    return "!";
  }
}
import { getZaloCookiePayload, getZaloRuntimeConfig } from "../../api-zalo/zalo-config.js";
import {
  checkBotExists,
  stopPM2Process,
  startBotWithLauncher,
  checkPM2Status,
  restartBotRuntime,
  updateBotStatus,
  deletePM2Process,
  createBotConfig,
  validateCredentials,
  killSpawnedProcess,
  checkSpawnedProcessStatus,
  resolveBotRuntimeState,
} from "./System/pm2-manager.js";
import { sendMessageComplete, sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { initSession, verifyClient, generateQRCode, waitingScan, waitingConfirm, getUserInfo } from "./Credentials/qr-login.js";
import { handleQrLogin } from "./Manager/qr-login-command.js";
import { createBotListImage } from "./list-canvas.js";
import { parseMyBotCommand, parseDuration } from "./System/mybot-parser.js";
import { relayCommandToChild } from "./System/mybot-command-relay.js";
import {
  resolveAdminIdentity,
  resolveMyBotCallerRole,
  isMainBot,
  assertCanDeleteBot,
  resolveManagedBotList,
  resolveManagedBotTarget,
  resolveVisibleBots,
} from "./System/mybot-identity.js";
import {
  getSortedBotList,
  resolveTargetBots,
  calculateExtendExpiry,
  calculateMinusExpiry,
  extendBotExpiryLogic,
  reduceBotExpiryLogic,
  deleteChildBotLogic,
  cleanExpiredBotsLogic,
  executeNotifyBroadcast,
  sendNotifyToOwners,
} from "./System/mybot-lifecycle.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./System/mybots-registry.js";
import { releaseCreationQuota, checkOwnerCreationQuota } from "./System/mybot-creation-quota.js";
import { qrSessionBlockingResult } from "./Manager/qr-login-session-coordinator.js";
import { activatePendingTrial, revertFailedTrialReactivation } from "./System/mybot-trial.js";
import { claimOwnerTrial, getOwnerTrialStatus, getBangkokCalendarWeek } from "./System/mybot-trial-ledger.js";
import {
  getProfile,
  saveProfile,
  updateProfile,
  updateStyle,
  resetStyle,
  redactProfile,
} from "./System/mybot-profile-service.js";
import { validateStyle, DEFAULT_STYLE } from "./System/mybot-style.js";
import {
  activateBot,
  resolveOwnedActivationCandidates,
  resolveOwnerActiveSlot,
} from "./System/mybot-activation-service.js";
import { openMyBotActiveSelection } from "./System/mybot-active-selection.js";
import { appContext } from "../../api-zalo/context.js";
import { resolveMainBotUid, resolveCurrentInstanceIdentity } from "../../utils/instance-authorization.js";
import { getProjectRoot } from "../../utils/env.js";

let projectRoot = getProjectRoot();
let myBotDir = path.join(projectRoot, "mybot");
let myBotsPath = path.join(myBotDir, "mybots.json");
let launcherPath = path.join(projectRoot, "index.js");

function refreshMyBotPaths() {
  projectRoot = getProjectRoot();
  myBotDir = path.join(projectRoot, "mybot");
  myBotsPath = path.join(myBotDir, "mybots.json");
  launcherPath = path.join(projectRoot, "index.js");
  return { projectRoot, myBotDir, myBotsPath, launcherPath };
}

const ZALO_RUNTIME = getZaloRuntimeConfig();

// Single-flight lock for in-progress restarts
const inProgressRestarts = new Map();

export async function mybotHandleCommand(api, message, isAdminLevelHighest = false, aliasCommand = "mybot", options = {}) {
  refreshMyBotPaths();
  const { threadId, data: { uidFrom, dName, content, mentions }, type } = message;
  const prefix = getGlobalPrefix();

  const helpargs = `《 HỆ THỐNG QUẢN LÝ BOT 》

✪ Tạo / Kích Hoạt Bot:
➤ ${prefix}${aliasCommand} qrlogin: Đăng nhập bot qua mã QR
➤ ${prefix}${aliasCommand} create <imei> <cookie>: Tạo bot bằng data
➤ ${prefix}${aliasCommand} active: Kích hoạt dùng thử 1 giờ (1 lần / tuần lịch Bangkok)

✪ Quản Lý Thông Tin & Giao Diện:
➤ ${prefix}${aliasCommand} list: Xem danh sách bot
➤ ${prefix}${aliasCommand} showinfo: Xem danh sách bot của bạn
➤ ${prefix}${aliasCommand} detail [index|uid]: Xem chi tiết bot
➤ ${prefix}${aliasCommand} set <field> <value>: Cài đặt tên, mô tả bot
• Các trường: name, desc, info, platform
➤ ${prefix}${aliasCommand} style <size|color|type|icon|reset>: Cài đặt phong cách hiển thị

✪ Vận Hành Bot:
➤ ${prefix}${aliasCommand} restart [index|uid|all]: Khởi động lại bot
➤ ${prefix}${aliasCommand} start [index|uid|all]: Khởi động bot
➤ ${prefix}${aliasCommand} shutdown [index|uid|all]: Tắt bot
➤ ${prefix}${aliasCommand} help: Xem hướng dẫn lệnh
➤ ${prefix}${aliasCommand} qtv: Hướng dẫn quản trị viên
➤ ${prefix}${aliasCommand} manager: Lệnh quản trị hệ thống (Admin)`;

  try {
    // Canonical Instance Guard: Block child bots with INSTANCE_DENIED
    const passedAuth = options?.instanceAuthorization;
    let isMainInstance = false;
    if (passedAuth && typeof passedAuth === "object" && passedAuth.instanceKind) {
      isMainInstance = passedAuth.instanceKind === "main";
      console.log(`[mybot-guard] fromDispatcher=true instanceKind=${passedAuth.instanceKind} source=${passedAuth.source}`);
    } else {
      const identity = resolveCurrentInstanceIdentity({
        api,
        appContext,
        projectRoot,
      });
      isMainInstance = identity.instanceKind === "main" && identity.verified;
      console.log(`[mybot-guard] fromDispatcher=false instanceKind=${identity.instanceKind} verified=${identity.verified} processBotUid=${identity.processBotUid} mainBotUid=${identity.mainBotUid} source=${identity.identitySource}`);
    }

    if (!isMainInstance) {
      return await sendMessageWarning(
        api,
        message,
        "Lệnh này chỉ khả dụng trên bot admin/Main Bot. (INSTANCE_DENIED)",
        true,
        false
      );
    }

    const rawMentions = Array.isArray(message?.data?.mentions) ? message.data.mentions : [];
    const parsed = parseMyBotCommand({ content, aliasCommand, prefix });

    if (!parsed.valid && parsed.action === "unknown") {
      return await sendMessageWarning(
        api,
        message,
        `Lệnh không hợp lệ: "${parsed.rawAction}"!\nSử dụng ${prefix}${aliasCommand} help để xem danh sách lệnh được hỗ trợ.`,
        true,
        false
      );
    }

    if (parsed.action === "help") {
      return await sendMessageComplete(api, message, helpargs, true, false);
    }

    const { adminUid } = resolveAdminIdentity({ projectRoot, api });
    const callerRole = resolveMyBotCallerRole({
      uidFrom,
      adminBotUid: adminUid,
      isAdminLevelHighest,
      api,
      projectRoot,
    });

    const isSystemAdmin = callerRole.isSystemAdmin;
    const myBots = loadMyBotsRegistry(myBotsPath);

    // Subcommands handling
    switch (parsed.action) {
      case "qtv": {
        const qtvMessage = `📋 HƯỚNG DẪN QUẢN TRỊ VIÊN BOT 📋

1️⃣ Quản lý profile & style:
➤ ${prefix}${aliasCommand} set name <tên mới>: Đổi tên server bot
➤ ${prefix}${aliasCommand} set desc <mô tả>: Đổi mô tả bot
➤ ${prefix}${aliasCommand} style color <mã màu>: Đổi màu tin nhắn (ví dụ: db342e, 15a85f, 0084ff)
➤ ${prefix}${aliasCommand} style icon <icon>: Đổi icon bot
➤ ${prefix}${aliasCommand} style size <cỡ tên> [cỡ text]: Đổi kích thước chữ (10-24)
➤ ${prefix}${aliasCommand} style reset: Đặt lại style mặc định

2️⃣ Vận hành bot:
➤ ${prefix}${aliasCommand} active: Kích hoạt dùng thử 1 giờ
➤ ${prefix}${aliasCommand} restart: Khởi động lại bot
➤ ${prefix}${aliasCommand} shutdown: Dừng bot
➤ ${prefix}${aliasCommand} showinfo: Xem tất cả bot của bạn
➤ ${prefix}${aliasCommand} delete: Xóa bot khỏi hệ thống`;
        return await sendMessageComplete(api, message, qtvMessage, true, false);
      }

      case "manager": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(
            api,
            message,
            "Chỉ Quản Trị Cấp Cao của Main Bot mới có thể xem danh sách lệnh quản trị hệ thống.",
            true,
            false
          );
        }
        const managerMessage = `👮 LỆNH QUẢN TRỊ HỆ THỐNG BOT 👮

✪ Quản lý danh sách:
  ➤ ${prefix}${aliasCommand} list: Xem danh sách tất cả bot
  ➤ ${prefix}${aliasCommand} showinfo all: Xem chi tiết toàn bộ bot hệ thống
  ➤ ${prefix}${aliasCommand} notify [nội dung]: Thông báo cho tất cả bot con

✪ Quản lý bot cụ thể:
  ➤ ${prefix}${aliasCommand} detail [index|uid]: Xem chi tiết bot
  ➤ ${prefix}${aliasCommand} cmd [index|uid] <lệnh>: Thực thi lệnh từ xa trên bot con
  ➤ ${prefix}${aliasCommand} restart [index|uid|all]: Khởi động lại bot
  ➤ ${prefix}${aliasCommand} start [index|uid|all]: Khởi động bot
  ➤ ${prefix}${aliasCommand} stop [index|uid|all]: Tắt bot

✪ Phê duyệt / Gia hạn:
  ➤ ${prefix}${aliasCommand} approve [index|uid]: Cho phép bot hoạt động lại
  ➤ ${prefix}${aliasCommand} reject [index|uid] [-1]: Vô hiệu hóa bot
  ➤ ${prefix}${aliasCommand} extend [index|uid] [thời gian|-1]: Gia hạn bot
  ➤ ${prefix}${aliasCommand} minus [index|uid] [thời gian|-1]: Rút ngắn hạn bot

✪ Quản lý hệ thống:
  ➤ ${prefix}${aliasCommand} delete [index|uid|all]: Xóa bot khỏi hệ thống
  ➤ ${prefix}${aliasCommand} clean: Xóa các bot đã hết hạn`;
        return await sendMessageWarning(api, message, managerMessage, true, false);
      }

      case "list": {
        return await handleListBots(api, threadId, type, message, { isSystemAdmin, callerUid: uidFrom });
      }

      case "showinfo": {
        return await handleShowInfoCommand(api, message, parsed.selector, myBots, uidFrom, isSystemAdmin);
      }

      case "active": {
        return await handleActiveCommand(api, message, parsed.selector, myBots, uidFrom, isSystemAdmin);
      }

      case "set": {
        return await handleSetCommand(api, message, parsed, myBots, uidFrom, isSystemAdmin, callerRole);
      }

      case "style": {
        return await handleStyleCommand(api, message, parsed, myBots, uidFrom, isSystemAdmin, callerRole);
      }

      case "notify": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(
            api,
            message,
            "Chỉ Main Bot và Quản Trị Cấp Cao mới có quyền gửi thông báo hệ thống.",
            true,
            false
          );
        }
        if (!parsed.notifyMessage || !parsed.notifyMessage.trim()) {
          return await sendMessageWarning(
            api,
            message,
            `Sai cú pháp!\nCách dùng: ${prefix}${aliasCommand} notify [nội dung thông báo]`,
            true,
            false
          );
        }
        return await handleNotifyCommand(api, message, parsed.notifyMessage.trim(), myBots);
      }

      case "clean": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(
            api,
            message,
            "Chỉ Main Bot và Quản Trị Cấp Cao mới có quyền dọn dẹp bot hết hạn.",
            true,
            false
          );
        }
        return await cleanExpiredBots(api, message, isAdminLevelHighest);
      }

      case "qrlogin": {
        return await handleQrLogin(api, message, threadId, type, isAdminLevelHighest);
      }

      case "getupdate": {
        return await handleQrUpdate(api, message, threadId, type);
      }

      case "create": {
        return await createBot(api, message, isAdminLevelHighest, parsed.args, aliasCommand);
      }

      case "nameserver": {
        if (!parsed.serverName || !parsed.serverName.trim()) {
          return await sendMessageWarning(
            api,
            message,
            `Sai cú pháp!\nCách dùng: ${prefix}${aliasCommand} nameserver [tên server mới]`,
            true,
            false
          );
        }
        return await handleChangeNameServer(api, uidFrom, dName, parsed.serverName.trim(), threadId, type, message);
      }

      case "update": {
        if (parsed.updateType === "name") {
          if (!parsed.updateValue || !parsed.updateValue.trim()) {
            return await sendMessageWarning(
              api,
              message,
              `Sai cú pháp!\nCách dùng: ${prefix}${aliasCommand} update name [tên hiển thị mới]`,
              true,
              false
            );
          }
          return await handleUpdateName(api, uidFrom, dName, parsed.updateValue.trim(), threadId, type, message);
        } else if (parsed.updateType === "description") {
          if (!parsed.updateValue || !parsed.updateValue.trim()) {
            return await sendMessageWarning(
              api,
              message,
              `Sai cú pháp!\nCách dùng: ${prefix}${aliasCommand} update description [mô tả mới]`,
              true,
              false
            );
          }
          return await handleUpdateDescription(api, uidFrom, dName, parsed.updateValue.trim(), threadId, type, message);
        } else if (parsed.updateType === "credentials") {
          if (!parsed.imei || !parsed.rawCookie) {
            return await sendMessageWarning(
              api,
              message,
              `Sai cú pháp!\n\nCách dùng:\n• ${prefix}${aliasCommand} update name [tên mới]\n• ${prefix}${aliasCommand} update description [mô tả mới]\n• ${prefix}${aliasCommand} update [Imei] [Cookie]`,
              true,
              false
            );
          }
          return await updateBotCredentials(api, message, [parsed.imei, parsed.rawCookie, parsed.userAgent], aliasCommand);
        } else {
          return await sendMessageWarning(
            api,
            message,
            `Sai cú pháp!\n\nCách dùng:\n• ${prefix}${aliasCommand} update name [tên mới]\n• ${prefix}${aliasCommand} update description [mô tả mới]\n• ${prefix}${aliasCommand} update [Imei] [Cookie]`,
            true,
            false
          );
        }
      }

      case "detail": {
        if (parsed.selector.type === "all" || parsed.selector.type === "multiple") {
          return await sendMessageWarning(
            api,
            message,
            `Lệnh ${prefix}${aliasCommand} detail chỉ hỗ trợ xem thông tin một bot cụ thể!`,
            true,
            false
          );
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "detail" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu để xem chi tiết!", true, false);
        }
        const targetBot = targets[0];
        if (!isSystemAdmin && !callerRole.canManageBot(targetBot)) {
          return await sendMessageWarning(api, message, "Bạn chỉ có thể xem thông tin bot của chính mình!", true, false);
        }
        return await detailBot(api, message, isAdminLevelHighest, targetBot.key);
      }

      case "cmd": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(
            api,
            message,
            "Chỉ Quản Trị Cấp Cao của Main Bot mới có quyền thực thi lệnh từ xa trên bot con.",
            true,
            false
          );
        }
        if (!parsed.valid || !parsed.commandText) {
          return await sendMessageWarning(
            api,
            message,
            `Sai cú pháp!\n\nCách dùng: ${prefix}${aliasCommand} cmd <số thứ tự|uid> (lệnh hoàn chỉnh)\nVí dụ: ${prefix}${aliasCommand} cmd 2 (admin add qtv @user)`,
            true,
            false
          );
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "cmd" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu để thực thi lệnh!", true, false);
        }
        const targetBot = targets[0];
        if (isMainBot(targetBot, targetBot.key)) {
          return await sendMessageWarning(api, message, "Lệnh cmd từ xa chỉ áp dụng cho bot con!", true, false);
        }

        const effectiveMentions = rawMentions.length > 0 ? rawMentions : [];

        const resolvedCurrentIdentity = resolveCurrentInstanceIdentity({ api, appContext, projectRoot });
        const effectiveSourceBotUid = (resolvedCurrentIdentity?.mainBotUid && resolvedCurrentIdentity.mainBotUid.toLowerCase() !== "admin")
          ? resolvedCurrentIdentity.mainBotUid
          : (adminUid && adminUid.toLowerCase() !== "admin" ? adminUid : "admin");

        const relayResult = await relayCommandToChild({
          targetBot,
          actorUid: uidFrom,
          sourceBotUid: effectiveSourceBotUid,
          targetGlobalUid: targetBot.globalUid || null,
          threadId,
          threadType: type,
          commandText: parsed.commandText,
          mentions: effectiveMentions,
          projectRoot,
          api,
        });

        if (!relayResult.success) {
          return await sendMessageWarning(
            api,
            message,
            `Không thể thực thi lệnh trên bot con: ${relayResult.message || relayResult.code}`,
            true,
            false
          );
        }

        const botName = targetBot.displayName || targetBot.nameServer || targetBot.name || targetBot.key;
        if (relayResult.data?.error) {
          return await sendMessageWarning(
            api,
            message,
            `[Bot con ${botName}] Lỗi thực thi lệnh: ${relayResult.data.error}`,
            true,
            false
          );
        }

        if (relayResult.data?.delivered === false) {
          if (Array.isArray(relayResult.data?.outputs) && relayResult.data.outputs.length > 0) {
            const combinedOutput = relayResult.data.outputs.join("\n\n");
            const notInGroupPrefix = relayResult.data?.inGroup === false
              ? `(Bot con chưa có trong nhóm, kết quả phản hồi):\n\n`
              : "";
            return await sendMessageComplete(
              api,
              message,
              `🤖 [Bot con: ${botName}]\n${notInGroupPrefix}${combinedOutput}`,
              true,
              false
            );
          } else if (relayResult.data?.inGroup === false) {
            return await sendMessageWarning(
              api,
              message,
              `🤖 [Bot con: ${botName}] Bot con chưa tham gia nhóm này. Vui lòng thêm bot vào nhóm trước.`,
              true,
              false
            );
          } else {
            return await sendMessageComplete(
              api,
              message,
              `🤖 [Bot con: ${botName}] Đã thực thi lệnh hoàn tất.`,
              true,
              false
            );
          }
        }

        return true;
      }

      case "start": {
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "start" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hoặc không có quyền!", true, false);
        }
        if (targets.length > 1) {
          return await handleBatchAction(api, message, isAdminLevelHighest, "start", targets);
        }
        const targetBot = targets[0];
        if (!isSystemAdmin && !callerRole.canManageBot(targetBot)) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hoặc không có quyền!", true, false);
        }
        return await startBot(api, message, isAdminLevelHighest, parsed.args, false, targetBot.key);
      }

      case "restart": {
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "restart" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hoặc không có quyền!", true, false);
        }
        if (targets.length > 1) {
          return await handleBatchAction(api, message, isAdminLevelHighest, "restart", targets);
        }
        const targetBot = targets[0];
        if (!isSystemAdmin && !callerRole.canManageBot(targetBot)) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hoặc không có quyền!", true, false);
        }
        return await restartManagedBot(api, message, isAdminLevelHighest, parsed.args, false, targetBot.key);
      }

      case "stop": {
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "stop" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hoặc không có quyền!", true, false);
        }
        if (targets.length > 1) {
          return await handleBatchAction(api, message, isAdminLevelHighest, "stop", targets);
        }
        const targetBot = targets[0];
        if (!isSystemAdmin && !callerRole.canManageBot(targetBot)) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hoặc không có quyền!", true, false);
        }
        return await stopBot(api, message, isAdminLevelHighest, parsed.args, false, targetBot.key);
      }

      case "delete": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(api, message, "Chỉ Quản Trị Cấp Cao / Bot Admin mới có quyền xóa bot khỏi hệ thống!", true, false);
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "delete" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu hợp lệ để xóa!", true, false);
        }
        if (targets.length > 1) {
          return await handleBatchAction(api, message, isAdminLevelHighest, "delete", targets);
        }
        const targetBot = targets[0];
        if (isMainBot(targetBot, targetBot.key)) {
          return await sendMessageWarning(api, message, "Không thể xóa hoặc vô hiệu hóa Main Bot!", true, false);
        }
        return await deleteBot(api, message, isAdminLevelHighest, parsed.args, false, targetBot.key);
      }

      case "extend": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(api, message, "Chỉ Main Bot và Quản Trị Cấp Cao mới có quyền gia hạn bot!", true, false);
        }
        if (parsed.selector.type === "self" || !parsed.rawDuration) {
          return await sendMessageWarning(
            api,
            message,
            `Sai cú pháp!\n\nCách dùng: ${prefix}${aliasCommand} extend [số thứ tự|uid] [thời gian|-1]\nVí dụ: ${prefix}${aliasCommand} extend 1 30d hoặc ${prefix}${aliasCommand} extend 1 -1`,
            true,
            false
          );
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "extend" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu để gia hạn!", true, false);
        }
        const targetBot = targets[0];
        return await extendBotExpiry(api, message, isAdminLevelHighest, parsed.rawDuration, parsed.selector.value || 1, targetBot.key);
      }

      case "minus": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(api, message, "Chỉ Main Bot và Quản Trị Cấp Cao mới có quyền rút ngắn thời hạn bot!", true, false);
        }
        if (parsed.selector.type === "self" || !parsed.rawDuration) {
          return await sendMessageWarning(
            api,
            message,
            `Sai cú pháp!\n\nCách dùng: ${prefix}${aliasCommand} minus [số thứ tự|uid] [thời gian|-1]\nVí dụ: ${prefix}${aliasCommand} minus 1 7d hoặc ${prefix}${aliasCommand} minus 1 -1`,
            true,
            false
          );
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "minus" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu để rút ngắn thời hạn!", true, false);
        }
        const targetBot = targets[0];
        return await reduceBotExpiry(api, message, isAdminLevelHighest, parsed.rawDuration, parsed.selector.value || 1, targetBot.key);
      }

      case "reject": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(api, message, "Chỉ Main Bot và Quản Trị Cấp Cao mới có quyền vô hiệu hóa bot!", true, false);
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "reject" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu để vô hiệu hóa!", true, false);
        }
        const targetBot = targets[0];
        if (isMainBot(targetBot, targetBot.key)) {
          return await sendMessageWarning(api, message, "Không thể vô hiệu hóa Main Bot!", true, false);
        }
        return await rejectBot(api, message, isAdminLevelHighest, parsed.isPermanent, dName, targetBot.key);
      }

      case "approve": {
        if (!isSystemAdmin) {
          return await sendMessageWarning(api, message, "Chỉ Main Bot và Quản Trị Cấp Cao mới có quyền cho phép bot hoạt động lại!", true, false);
        }
        const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "approve" });
        if (targets.length === 0) {
          return await sendMessageWarning(api, message, "Không tìm thấy bot mục tiêu để phê duyệt!", true, false);
        }
        const targetBot = targets[0];
        return await approveBot(api, message, isAdminLevelHighest, targetBot.key);
      }

      default:
        return await sendMessageWarning(
          api,
          message,
          `Lệnh không hợp lệ!\nSử dụng ${prefix}${aliasCommand} help để xem danh sách lệnh.`,
          true,
          false
        );
    }
  } catch (error) {
    await handleError(error, api, threadId, "xử lý lệnh mybot", type, message);
  }
}

// ---------------------------------------------------------------------------
// Active Command (Bangkok Calendar Week Trial / Unlimited Multi-bot Active)
// ---------------------------------------------------------------------------
async function handleActiveCommand(api, message, selector, myBots, uidFrom, isSystemAdmin) {
  if (selector && (selector.type === "all" || selector.type === "list" || selector.type === "csv" || selector.type === "multiple")) {
    const batchTargets = isSystemAdmin
      ? resolveManagedBotTarget({
          selector,
          registry: myBots,
          callerUid: uidFrom,
          isSystemAdmin: true,
          action: "active",
          projectRoot,
        }).filter((b) => !isMainBot(b, b.key))
      : resolveOwnedActivationCandidates({
          ownerUid: uidFrom,
          registry: myBots,
          projectRoot,
        });

    if (batchTargets.length === 0) {
      return await sendMessageWarning(
        api,
        message,
        "Không tìm thấy bot con nào để kích hoạt!",
        true,
        false
      );
    }

    const activatedNames = [];
    const alreadyRunningNames = [];
    const failedItems = [];
    for (const bot of batchTargets) {
      const targetUid = bot.uid || bot.key;
      const bName = bot.displayName || bot.nameServer || bot.name || targetUid;
      const res = await activateBot({
        botId: targetUid,
        actorUid: uidFrom,
        isSystemAdmin,
        root: projectRoot,
      });
      if (res.success) {
        if (res.alreadyRunning) alreadyRunningNames.push(bName);
        else activatedNames.push(bName);
      } else {
        failedItems.push(`${bName} (${res.code || res.error || "lỗi"})`);
      }
    }

    const summaryLines = [
      `📊 KẾT QUẢ KÍCH HOẠT BOT (${batchTargets.length} bot):`,
      `• Đã kích hoạt mới: ${activatedNames.length}${activatedNames.length ? ` (${activatedNames.join(", ")})` : ""}`,
      `• Đang chạy sẵn: ${alreadyRunningNames.length}${alreadyRunningNames.length ? ` (${alreadyRunningNames.join(", ")})` : ""}`,
    ];
    if (failedItems.length > 0) {
      summaryLines.push(`• Bỏ qua/Thất bại: ${failedItems.length} (${failedItems.join(", ")})`);
    }
    return await sendMessageComplete(api, message, summaryLines.join("\n"), true, false);
  }

  const executeActivation = async (targetBot, replyMsg = message) => {
    const targetUid = targetBot.uid || targetBot.key;
    const botName = targetBot.displayName || targetBot.nameServer || targetBot.name || targetUid;

    const res = await activateBot({
      botId: targetUid,
      actorUid: uidFrom,
      isSystemAdmin,
      root: projectRoot,
    });

    if (!res.success) {
      if (res.code === "OWNER_ACTIVE_BOT_EXISTS") {
        return await sendMessageWarning(
          api,
          replyMsg,
          res.error || "Bạn đang có bot khác đang hoạt động hoặc còn hạn dùng. Mỗi tài khoản chỉ được kích hoạt 1 bot cùng lúc.",
          true,
          false
        );
      }
      if (res.code === "ACTIVATION_IN_PROGRESS") {
        return await sendMessageWarning(
          api,
          replyMsg,
          "Đang có tiến trình kích hoạt bot khác đang diễn ra cho tài khoản của bạn.",
          true,
          false
        );
      }
      if (res.code === "FORBIDDEN") {
        return await sendMessageWarning(api, replyMsg, "Bạn chỉ có thể kích hoạt dùng thử bot của chính mình!", true, false);
      }
      if (res.code === "BOT_REJECTED") {
        return await sendMessageWarning(api, replyMsg, `Không thể kích hoạt bot ${botName} vì đã bị Admin vô hiệu hóa!`, true, false);
      }
      if (res.code === "BOT_DISABLED") {
        return await sendMessageWarning(api, replyMsg, `Bot ${botName} đang bị tắt. Vui lòng bật bot trước khi kích hoạt!`, true, false);
      }
      if (res.code === "TRIAL_QUOTA_EXHAUSTED") {
        return await sendMessageWarning(
          api,
          replyMsg,
          `⚠️ Bạn đã sử dụng hết lượt dùng thử cho tuần này (${res.weekKey || getBangkokCalendarWeek()}, tối đa 1 lần / tuần lịch Bangkok).\nBot của bạn đã hết hạn. Vui lòng liên hệ Admin để gia hạn!`,
          true,
          false
        );
      }
      return await sendMessageWarning(
        api,
        replyMsg,
        `⚠️ Kích hoạt bot ${botName} thất bại: ${res.error || "Lỗi không xác định"}`,
        true,
        false
      );
    }

    if (res.alreadyRunning) {
      return await sendMessageComplete(
        api,
        replyMsg,
        `🤖 Bot ${botName} đã đang hoạt động!`,
        true,
        false
      );
    }

    if (res.trialGranted) {
      return await sendMessageComplete(
        api,
        replyMsg,
        `🎉 Bot ${botName} đã được kích hoạt dùng thử 1 giờ thành công!\n⏳ Hạn dùng: ${formatDateTime(new Date(res.expiryAt))}\n(Tuần lịch Bangkok ${res.weekKey}: 1 lần dùng thử / tuần)`,
        true,
        false
      );
    }

    const expStr = res.expiryAt === "-1" ? "Vĩnh viễn" : formatDateTime(new Date(res.expiryAt));
    return await sendMessageComplete(
      api,
      replyMsg,
      `✅ Bot ${botName} đang còn hạn dùng đến ${expStr}.\nĐã khởi động bot thành công!`,
      true,
      false
    );
  };

  // If selector is specified (index or uid)
  if (selector && selector.type !== "self") {
    let targetCandidate = null;
    if (isSystemAdmin) {
      const targets = resolveManagedBotTarget({
        selector,
        registry: myBots,
        callerUid: uidFrom,
        isSystemAdmin: true,
        action: "active",
        projectRoot,
      });
      targetCandidate = targets.length > 0 ? targets[0] : null;
      if (targetCandidate && isMainBot(targetCandidate, targetCandidate.key)) {
        return await sendMessageWarning(api, message, "Không thể kích hoạt dùng thử cho Main Bot!", true, false);
      }
    } else {
      const candidates = resolveOwnedActivationCandidates({
        ownerUid: uidFrom,
        registry: myBots,
        projectRoot,
      });
      if (selector.type === "index") {
        const idx = Number(selector.value) - 1;
        if (idx >= 0 && idx < candidates.length) {
          targetCandidate = candidates[idx];
        }
      } else if (selector.type === "uid" || selector.type === "name") {
        const val = String(selector.value).toLowerCase().trim();
        targetCandidate = candidates.find(
          (b) => String(b.key).toLowerCase() === val ||
                 String(b.uid).toLowerCase() === val ||
                 String(b.name).toLowerCase() === val ||
                 String(b.displayName).toLowerCase() === val
        );
      }
    }

    if (!targetCandidate) {
      return await sendMessageWarning(
        api,
        message,
        "Không tìm thấy bot phù hợp hoặc không có quyền để kích hoạt!",
        true,
        false
      );
    }

    return await executeActivation(targetCandidate);
  }

  // Bare `mybot active` with no selector
  const candidates = resolveOwnedActivationCandidates({
    ownerUid: uidFrom,
    registry: myBots,
    projectRoot,
  });

  if (candidates.length === 0) {
    return await sendMessageWarning(
      api,
      message,
      "Bạn chưa có bot nào đang trong trạng thái chờ kích hoạt trong hệ thống!",
      true,
      false
    );
  }

  // Bare `mybot active` with 1 bot
  if (candidates.length === 1) {
    return await executeActivation(candidates[0]);
  }

  // 2 or more candidates: open interactive selection session with canvas table
  return await openMyBotActiveSelection({
    api,
    message,
    candidates,
    projectRoot,
    onSelect: async (selectedBot, idx, replyMsg) => {
      await executeActivation(selectedBot, replyMsg);
    },
  });
}

// ---------------------------------------------------------------------------
// Set Command
// ---------------------------------------------------------------------------
async function handleSetCommand(api, message, parsed, myBots, uidFrom, isSystemAdmin, callerRole) {
  if (!parsed.setField || !parsed.setValue) {
    return await sendMessageWarning(
      api,
      message,
      `Sai cú pháp!\n\nCách dùng:\n• !mybot set name <tên mới>\n• !mybot set desc <mô tả mới>\n• !mybot set info <thông tin>\n• !mybot set platform <zalo|other>`,
      true,
      false
    );
  }

  const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "set" });
  if (targets.length === 0) {
    return await sendMessageWarning(api, message, "Không tìm thấy bot để cài đặt cấu hình!", true, false);
  }
  const targetBot = targets[0];
  if (!isSystemAdmin && !callerRole.canManageBot(targetBot)) {
    return await sendMessageWarning(api, message, "Bạn chỉ có thể cài đặt bot của chính mình!", true, false);
  }

  try {
    const updated = updateProfile(targetBot.key, { [parsed.setField]: parsed.setValue.trim() }, {
      root: projectRoot,
      actor: uidFrom,
    });
    return await sendMessageComplete(
      api,
      message,
      `✅ Đã cập nhật ${parsed.setField} cho bot ${targetBot.key} thành công!\nGiá trị mới: ${parsed.setValue.trim()}`,
      true,
      false
    );
  } catch (error) {
    return await sendMessageWarning(
      api,
      message,
      `Lỗi cập nhật cấu hình: ${error.message}`,
      true,
      false
    );
  }
}

// ---------------------------------------------------------------------------
// Style Command
// ---------------------------------------------------------------------------
async function handleStyleCommand(api, message, parsed, myBots, uidFrom, isSystemAdmin, callerRole) {
  const targets = resolveTargetBots({ selector: parsed.selector, myBots, callerUid: uidFrom, isSystemAdmin, action: "style" });
  if (targets.length === 0) {
    return await sendMessageWarning(api, message, "Không tìm thấy bot để cài đặt style!", true, false);
  }
  const targetBot = targets[0];
  if (!isSystemAdmin && !callerRole.canManageBot(targetBot)) {
    return await sendMessageWarning(api, message, "Bạn chỉ có thể cài đặt style cho bot của chính mình!", true, false);
  }

  const sub = parsed.styleSubAction || "show";

  if (sub === "reset") {
    resetStyle(targetBot.key, { root: projectRoot, actor: uidFrom });
    return await sendMessageComplete(
      api,
      message,
      `✅ Đã đặt lại phong cách hiển thị (Style) của bot ${targetBot.key} về mặc định!`,
      true,
      false
    );
  }

  if (sub === "color") {
    if (!parsed.styleColor) {
      return await sendMessageWarning(api, message, "Cách dùng: !mybot style color <mã hex> (ví dụ: db342e, 15a85f, 0084ff)", true, false);
    }
    const val = validateStyle({ color: parsed.styleColor });
    if (!val.ok) {
      return await sendMessageWarning(api, message, `Mã màu không hợp lệ: ${val.errors.join(", ")}`, true, false);
    }
    updateStyle(targetBot.key, { color: parsed.styleColor }, { root: projectRoot, actor: uidFrom });
    return await sendMessageComplete(api, message, `✅ Đã cập nhật màu tin nhắn cho bot thành #${parsed.styleColor.replace("#", "")}!`, true, false);
  }

  if (sub === "icon") {
    if (!parsed.styleIcon) {
      return await sendMessageWarning(api, message, "Cách dùng: !mybot style icon <emoji/icon> (ví dụ: 🤖, 👑, ⚡)", true, false);
    }
    updateStyle(targetBot.key, { icon: parsed.styleIcon.trim() }, { root: projectRoot, actor: uidFrom });
    return await sendMessageComplete(api, message, `✅ Đã cập nhật icon bot thành ${parsed.styleIcon.trim()}!`, true, false);
  }

  if (sub === "size") {
    const sName = parseInt(parsed.styleSizeNameServer, 10);
    const sText = parsed.styleSizeText ? parseInt(parsed.styleSizeText, 10) : sName;
    const patch = {};
    if (Number.isInteger(sName)) patch.nameServer = sName;
    if (Number.isInteger(sText)) patch.text = sText;
    if (Object.keys(patch).length === 0) {
      return await sendMessageWarning(api, message, "Cách dùng: !mybot style size <cỡ tên 10-24> [cỡ text 10-24]", true, false);
    }
    updateStyle(targetBot.key, { size: patch }, { root: projectRoot, actor: uidFrom });
    return await sendMessageComplete(api, message, `✅ Đã cập nhật kích thước chữ: Header=${patch.nameServer || 18}, Text=${patch.text || 14}!`, true, false);
  }

  if (sub === "type") {
    if (!parsed.styleType) {
      return await sendMessageWarning(api, message, "Cách dùng: !mybot style type <bold|italic|underline|strike|none> [nameserver|text|all]", true, false);
    }
    const target = parsed.styleTarget || "all";
    const typeArr = parsed.styleType.split(/[\s,]+/).filter(Boolean);
    const patch = {};
    if (target === "all" || target === "nameserver") patch.nameServer = typeArr;
    if (target === "all" || target === "text") patch.text = typeArr;
    updateStyle(targetBot.key, { type: patch }, { root: projectRoot, actor: uidFrom });
    return await sendMessageComplete(api, message, `✅ Đã cập nhật kiểu chữ: [${typeArr.join(", ")}] cho ${target}!`, true, false);
  }

  // Show current style
  const profile = getProfile(targetBot.key, { root: projectRoot });
  const st = profile.style || DEFAULT_STYLE;
  const styleSummary = `🎨 PHONG CÁCH HIỂN THỊ (STYLE) 🎨\n\n` +
    `• Bot: ${profile.nameServer || targetBot.key}\n` +
    `• Icon: ${st.icon || "🤖"}\n` +
    `• Màu sắc: #${st.color}\n` +
    `• Cỡ chữ: Header=${st.size?.nameServer || 18}, Text=${st.size?.text || 14}\n` +
    `• Kiểu chữ: Header=[${(st.type?.nameServer || ["bold"]).join(", ")}], Text=[${(st.type?.text || ["none"]).join(", ")}]\n\n` +
    `💡 Dùng: !mybot style <size|color|type|icon|reset> để điều chỉnh.`;
  return await sendMessageComplete(api, message, styleSummary, true, false);
}

// ---------------------------------------------------------------------------
// Show Info Command
// ---------------------------------------------------------------------------
async function handleShowInfoCommand(api, message, selector, myBots, uidFrom, isSystemAdmin) {
  const currentWeek = getBangkokCalendarWeek();
  const trialStatus = getOwnerTrialStatus(uidFrom, { root: projectRoot });

  // QR-running state comes from the in-memory coordinator, not the stale
  // 5-minute quota-reservations file. A requester with a live coordinator
  // session is reported as busy; a requester whose session ended (acquired,
  // expired, failed) is immediately reported as ready even if an old quota
  // reservation record is still on disk.
  const qrSessionState = qrSessionBlockingResult(uidFrom);
  const quotaCheck = checkOwnerCreationQuota(uidFrom, { projectRoot, registry: myBots, includeReservations: true });
  const hasInFlight = qrSessionState.hasInFlightReservation || quotaCheck.hasInFlightReservation;
  const creationQuotaLabel = hasInFlight ? "Đang có phiên QR xử lý" : "Sẵn sàng tạo QR";

  const trialLabel = trialStatus.eligible ? "Còn 1 lượt" : "Đã dùng";

  if (selector.type === "all") {
    if (!isSystemAdmin) {
      return await sendMessageWarning(
        api,
        message,
        "Chỉ Quản Trị Cấp Cao / Main Bot mới có quyền xem toàn bộ bot hệ thống!",
        true,
        false
      );
    }
    const allBots = resolveManagedBotList({
      projectRoot,
      registry: myBots,
      includeMain: true,
    });
    if (allBots.length === 0) {
      return await sendMessageWarning(api, message, "Hệ thống chưa có bot nào!", true, false);
    }
    let infoText = `📊 DANH SÁCH TOÀN BỘ BOT HỆ THỐNG (${allBots.length} bot) 📊\nTuần Bangkok: ${currentWeek}\n\n`;
    allBots.forEach((bot, idx) => {
      const p = bot.profile || getProfile(bot.key, { root: projectRoot });
      const exp = bot.expiryAt === "-1" ? "Vĩnh viễn" : bot.expiryAt ? formatDateTime(new Date(bot.expiryAt)) : "Chưa có";
      const botType = bot.isMain ? " [MAIN BOT]" : "";
      infoText += `${idx + 1}. [${bot.status || "unknown"}] ${bot.displayName || p.nameServer || bot.key}${botType}\n`;
      infoText += `   • ID: ${bot.key} | Owner: ${bot.ownerName || p.ownerName || bot.ownerUid || "-"}\n`;
      infoText += `   • Hạn dùng: ${exp} | Trial: ${p.trialStatus || bot.trialStatus || "-"}\n\n`;
    });
    return await sendMessageComplete(api, message, infoText.trim(), true, false);
  }

  // Filter bots owned by uidFrom
  const userBots = resolveManagedBotList({
    projectRoot,
    registry: myBots,
    ownerUid: uidFrom,
    includeMain: isSystemAdmin,
  });

  if (userBots.length === 0) {
    return await sendMessageWarning(
      api,
      message,
      `Bạn chưa sở hữu bot nào trong hệ thống!\n• Tuần lịch Bangkok: ${currentWeek}\n• Lượt trial tuần này: ${trialLabel}\n• Quyền tạo bot: ${creationQuotaLabel}\n\nDùng !mybot qrlogin hoặc !mybot create để tạo bot mới!`,
      true,
      false
    );
  }

  let infoText = `👤 DANH SÁCH BOT CỦA BẠN (${userBots.length} bot) 👤\n`;
  infoText += `📅 Tuần Bangkok: ${currentWeek}\n`;
  infoText += `• Lượt trial tuần này: ${trialLabel}\n`;
  infoText += `• Quyền tạo bot: ${creationQuotaLabel}\n\n`;

  userBots.forEach((bot, idx) => {
    const profile = bot.profile || getProfile(bot.key, { root: projectRoot });
    const now = Date.now();
    const isExp = bot.expiryAt && bot.expiryAt !== "-1" && new Date(bot.expiryAt).getTime() <= now;
    const expStr = bot.expiryAt === "-1" ? "Vĩnh viễn" : bot.expiryAt ? formatDateTime(new Date(bot.expiryAt)) : "Chưa kích hoạt";
    const statusStr = isExp ? "Hết hạn" : (bot.status === "running" ? "Đang chạy" : "Đã dừng");

    infoText += `${idx + 1}. ${profile.style?.icon || "🤖"} ${bot.displayName || profile.nameServer || bot.key}\n`;
    infoText += `   • Bot ID: ${bot.key}\n`;
    infoText += `   • Trạng thái: ${statusStr}\n`;
    infoText += `   • Hạn dùng: ${expStr}\n`;
    infoText += `   • Trial: ${profile.trialStatus || bot.trialStatus || "pending"}\n\n`;
  });

  infoText += `💡 Dùng: !mybot active để kích hoạt hoặc !mybot restart để khởi động lại.`;
  return await sendMessageComplete(api, message, infoText, true, false);
}

// ---------------------------------------------------------------------------
// Bot Lifecycle Implementations
// ---------------------------------------------------------------------------
export async function startBot(api, message, isAdminLevelHighest, args, suppressMessages = false, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      if (!suppressMessages) {
        await sendMessageWarning(api, message, "Bạn chưa có BOT được tạo", true, false);
      }
      return false;
    }
    const botInfo = checkResult.botInfo;
    if (botInfo.status === "rejected") {
      if (!suppressMessages) {
        await sendMessageWarning(api, message, `Không thể khởi động bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} vì đã bị Bot Admin vô hiệu hóa!`, true, false);
      }
      return false;
    }
    // NOTE: `identityPending` no longer blocks startup. A pending child must be
    // allowed to run so it can resolve its own admin identities in its own
    // session. While pending it runs in restricted mode (self UID is the only
    // Supreme Admin, fail-closed). Other invalid states below still block.
    if (["trialExpired", "expired", "stopping"].includes(botInfo.status)) {
      const statusMessages = {
        trialExpired: "Bạn đã hết thời gian dùng thử! Hãy liên hệ admin để gia hạn bot.",
        expired: "Bot của bạn đã hết hạn! Hãy liên hệ admin để gia hạn.",
        stopping: "Bot của bạn đang trong trạng thái bảo trì! Hãy liên hệ admin.",
      };
      if (!suppressMessages) {
        await sendMessageWarning(api, message, statusMessages[botInfo.status], true, false);
      }
      return false;
    }

    const pm2Status = await checkPM2Status(uidFrom);
    const spawnedStatus = await checkSpawnedProcessStatus(uidFrom);
    if (pm2Status.running || spawnedStatus.running) {
      if (!suppressMessages) {
        await sendMessageWarning(api, message, `Bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} đang hoạt động rồi!`, true, false);
      }
      return false;
    }

    const effectiveOwner = botInfo.ownerUid || botInfo.createdByUid || requesterUid || uidFrom;
    const hasExplicitExpiry = Boolean(
      botInfo.expiryAt !== null &&
      botInfo.expiryAt !== undefined &&
      botInfo.expiryAt !== "" &&
      (String(botInfo.expiryAt).trim() === "-1" || !Number.isNaN(Date.parse(String(botInfo.expiryAt))))
    );
    const isPendingTrial = !hasExplicitExpiry && (botInfo.trialStatus === "pending" || botInfo.trialStatus !== "active");

    if (isPendingTrial && !isAdminLevelHighest) {
      const trialCheck = getOwnerTrialStatus(effectiveOwner, { root: projectRoot });
      if (!trialCheck.eligible) {
        if (!suppressMessages) {
          await sendMessageWarning(
            api,
            message,
            `⚠️ Bạn đã sử dụng hết 1 lượt dùng thử miễn phí trong tuần lịch Bangkok (${trialCheck.currentWeek}). Hãy liên hệ Admin để gia hạn bot!`,
            true,
            false
          );
        }
        return false;
      }
    }

    const startResult = await startBotWithLauncher(uidFrom);
    const isSuccess = Boolean(startResult === true || startResult?.success === true);
    if (isSuccess) {
      if (isPendingTrial) {
        try {
          await activatePendingTrial(uidFrom, {
            root: projectRoot,
            ownerUid: effectiveOwner,
            enforceQuota: !isAdminLevelHighest,
          });
        } catch (quotaErr) {
          await stopPM2Process(uidFrom).catch(() => {});
          await killSpawnedProcess(uidFrom).catch(() => {});
          await revertFailedTrialReactivation(uidFrom, { root: projectRoot }).catch(() => {});
          if (!suppressMessages) {
            await sendMessageWarning(
              api,
              message,
              quotaErr?.code === "TRIAL_QUOTA_EXHAUSTED"
                ? "⚠️ Bạn đã hết lượt dùng thử miễn phí trong tuần này! Hãy liên hệ Admin để gia hạn bot."
                : `Không thể kích hoạt dùng thử cho bot: ${quotaErr?.message || quotaErr}`,
              true,
              false
            );
          }
          return false;
        }
        if (!suppressMessages) {
          await sendMessageComplete(
            api,
            message,
            `✅ Khởi động bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} thành công!\n⏳ Thời gian dùng thử 1 giờ đã bắt đầu tính từ bây giờ.`,
            true,
            false
          );
        }
      } else {
        await updateBotStatus(uidFrom, "running");
        // Re-read identity AFTER the bot is running: the process may have
        // resolved its admin identities during startup. Report restricted mode
        // only if it is STILL pending.
        const postLaunch = await checkBotExists(uidFrom).catch(() => ({ botInfo: botInfo }));
        const stillPending = postLaunch?.botInfo?.identityPending === true;
        if (!suppressMessages) {
          if (stillPending) {
            await sendMessageComplete(
              api,
              message,
              `✅ Khởi động bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} thành công!\n⚠️ Bot đang chạy ở chế độ hạn chế: danh tính chưa được xác minh (${postLaunch.botInfo.identityPendingReason || "thiếu 3 identity seeds"}). Chỉ UID của chính bot (${uidFrom}) có quyền cao; bot sẽ tự xác minh khi chạy.`,
              true,
              false
            );
          } else {
            await sendMessageComplete(api, message, `Khởi động bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} thành công!`, true, false);
          }
        }
      }
      return true;
    } else {
      if (botInfo.trialStatus === "pending") {
        await revertFailedTrialReactivation(uidFrom, { root: projectRoot }).catch(() => {});
      }
      if (!suppressMessages) {
        await sendMessageWarning(api, message, `Không thể khởi động bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom}. Vui lòng thử lại sau!`, true, false);
      }
      return false;
    }
  } catch (error) {
    await handleError(error, api, threadId, "khởi động bot", type, message);
    return false;
  }
}

export async function restartManagedBot(api, message, isAdminLevelHighest, args = [], suppressMessages = false, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;

  // Single-flight deduplication
  if (inProgressRestarts.has(uidFrom)) {
    try {
      return await inProgressRestarts.get(uidFrom);
    } catch {
      return false;
    }
  }

  const restartPromise = (async () => {
    try {
      const checkResult = await checkBotExists(uidFrom);
      if (!checkResult.exists) {
        if (!suppressMessages) {
          await sendMessageWarning(api, message, "Bạn chưa có BOT được tạo", true, false);
        }
        return false;
      }
      const botInfo = checkResult.botInfo;
      if (botInfo.status === "rejected") {
        if (!suppressMessages) {
          await sendMessageWarning(api, message, `Không thể khởi động lại bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} vì đã bị Bot Admin vô hiệu hóa!`, true, false);
        }
        return false;
      }
      if (["trialExpired", "expired"].includes(botInfo.status)) {
        if (!suppressMessages) {
          await sendMessageWarning(api, message, "Bot của bạn đã hết hạn! Hãy gia hạn để tiếp tục sử dụng.", true, false);
        }
        return false;
      }

      const restartResult = await restartBotRuntime(uidFrom);
      const isSuccess = Boolean(restartResult === true || restartResult?.success === true);
      if (isSuccess) {
        await updateBotStatus(uidFrom, "running");
        // Re-read identity AFTER restart: the process may have resolved its
        // admin identities. Report restricted mode only if STILL pending.
        const postLaunch = await checkBotExists(uidFrom).catch(() => ({ botInfo: botInfo }));
        const stillPending = postLaunch?.botInfo?.identityPending === true;
        if (!suppressMessages) {
          if (stillPending) {
            await sendMessageComplete(
              api,
              message,
              `✅ Khởi động lại bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} thành công!\n⚠️ Bot đang chạy ở chế độ hạn chế: danh tính chưa được xác minh (${postLaunch.botInfo.identityPendingReason || "thiếu 3 identity seeds"}). Chỉ UID của chính bot (${uidFrom}) có quyền cao; bot sẽ tự xác minh khi chạy.`,
              true,
              false
            );
          } else {
            await sendMessageComplete(api, message, `Khởi động lại bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom} thành công!`, true, false);
          }
        }
        return true;
      } else {
        if (!suppressMessages) {
          await sendMessageWarning(api, message, `Không thể khởi động lại bot ${botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom}. Vui lòng thử lại sau!`, true, false);
        }
        return false;
      }
    } catch (error) {
      await handleError(error, api, threadId, "khởi động lại bot", type, message);
      return false;
    }
  })();

  inProgressRestarts.set(uidFrom, restartPromise);
  try {
    return await restartPromise;
  } finally {
    inProgressRestarts.delete(uidFrom);
  }
}

export async function stopBot(api, message, isAdminLevelHighest, args, suppressMessages = false, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      if (!suppressMessages) {
        await sendMessageWarning(api, message, "Bạn không có bot để dừng", true, false);
      }
      return false;
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;

    let stopped = false;
    const pm2Status = await checkPM2Status(uidFrom);
    if (pm2Status.running) {
      const pm2Stopped = await stopPM2Process(uidFrom);
      stopped = stopped || pm2Stopped;
    }
    const spawnedStatus = await checkSpawnedProcessStatus(uidFrom);
    if (spawnedStatus.running) {
      const spawnedStopped = await killSpawnedProcess(uidFrom);
      stopped = stopped || spawnedStopped;
    }

    if (stopped || (!pm2Status.running && !spawnedStatus.running)) {
      await updateBotStatus(uidFrom, "stopped");
      if (!suppressMessages) {
        await sendMessageComplete(api, message, `Bot ${botName} đã tạm dừng trong hệ thống!`, true, false);
      }
      return true;
    } else {
      if (!suppressMessages) {
        await sendMessageWarning(api, message, "Không thể dừng bot. Vui lòng thử lại!", true, false);
      }
      return false;
    }
  } catch (error) {
    await handleError(error, api, threadId, "dừng bot", type, message);
    return false;
  }
}

export async function deleteBot(api, message, isAdminLevelHighest, args, suppressMessages = false, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      if (!suppressMessages) {
        await sendMessageComplete(api, message, "Bạn chưa có bot để xóa!", true, false);
      }
      return false;
    }

    const botInfo = checkResult.botInfo;
    if (isMainBot(botInfo, uidFrom)) {
      if (!suppressMessages) {
        await sendMessageWarning(api, message, "Không thể xóa Main Bot khỏi hệ thống!", true, false);
      }
      return false;
    }

    const deleteResult = await deleteChildBotLogic({
      projectRoot,
      registryPath: myBotsPath,
      botKey: uidFrom,
      actorId: requesterUid,
      killProcessFn: killSpawnedProcess,
      deleteProcessFn: deletePM2Process,
    });

    if (deleteResult.success) {
      const ownerToRelease = botInfo.ownerUid || botInfo.createdByUid || (/^\d{10,}$/.test(String(botInfo.createdBy || "")) ? botInfo.createdBy : null);
      if (ownerToRelease) {
        releaseCreationQuota(ownerToRelease, uidFrom, { projectRoot });
      }
      const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;
      if (!suppressMessages) {
        await sendMessageComplete(api, message, `Đã xóa bot ${botName} khỏi hệ thống quản lý bot!`, true, false);
      }
      return true;
    } else {
      if (!suppressMessages) {
        const errorMsg = deleteResult.error || deleteResult.detail || "Đã xảy ra lỗi khi xóa bot khỏi danh sách. Vui lòng thử lại!";
        await sendMessageWarning(api, message, errorMsg, true, false);
      }
      return false;
    }
  } catch (error) {
    await handleError(error, api, threadId, "xóa bot", type, message);
    return false;
  }
}

export async function extendBotExpiry(api, message, isAdminLevelHighest, timeStr, index, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, `Bot với mã ${uidFrom} không tồn tại!`, true, false);
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;

    const durationMs = parseDuration(timeStr);
    if (durationMs === null) {
      return await sendMessageWarning(
        api,
        message,
        `Định dạng thời gian không hợp lệ! Vui lòng dùng: <số><đơn vị> (ví dụ: 30m, 1h, 12h, 1d, 30d, 1mon, 1y) hoặc -1 để đặt vĩnh viễn`,
        true,
        false
      );
    }

    const result = await extendBotExpiryLogic({
      registryPath: myBotsPath,
      botKey: uidFrom,
      durationMs,
    });

    if (!result.success) {
      return await sendMessageWarning(api, message, result.error || "Không thể gia hạn bot!", true, false);
    }

    const newExpiry = result.newExpiry;
    // Sync to profile
    updateProfile(uidFrom, { expiryAt: newExpiry, trialStatus: "active" }, { root: projectRoot });

    const statusMessage = `Đã gia hạn bot thành công!\n\n🤖 Bot: ${botName}\n🆔 Bot ID: ${uidFrom}\n⏰ Hết hạn mới: ${newExpiry === "-1" ? "Vĩnh viễn" : formatDateTime(new Date(newExpiry))}\n👤 Gia hạn bởi: ${dName}`;
    await sendMessageComplete(api, message, statusMessage, true, false);
    return true;
  } catch (error) {
    await handleError(error, api, threadId, "gia hạn bot", type, message);
    return false;
  }
}

export async function reduceBotExpiry(api, message, isAdminLevelHighest, timeStr, index, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, `Bot với mã ${uidFrom} không tồn tại!`, true, false);
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;

    const durationMs = parseDuration(timeStr);
    if (durationMs === null) {
      return await sendMessageWarning(
        api,
        message,
        `Định dạng thời gian không hợp lệ! Sử dụng: <số><đơn vị> (ví dụ: 30m, 1h, 1d, 30d, 1mon, 1y) hoặc -1 để hết hạn ngay`,
        true,
        false
      );
    }

    const result = await reduceBotExpiryLogic({
      registryPath: myBotsPath,
      botKey: uidFrom,
      durationMs,
    });

    if (!result.success) {
      return await sendMessageWarning(api, message, result.error || "Không thể rút ngắn hạn bot!", true, false);
    }

    const newExpiry = result.newExpiry;
    updateProfile(uidFrom, { expiryAt: newExpiry }, { root: projectRoot });

    if (newExpiry !== "-1" && Date.parse(newExpiry) <= Date.now()) {
      await stopPM2Process(uidFrom).catch(() => {});
      await killSpawnedProcess(uidFrom).catch(() => {});
      await sendMessageComplete(
        api,
        message,
        `Bot ${botName} đã được đặt hết hạn ngay lập tức!\n🆔 Bot ID: ${uidFrom}\n⏰ Trạng thái: Hết hạn\n👤 Thực hiện bởi: ${dName}`,
        true,
        false
      );
    } else {
      await sendMessageComplete(
        api,
        message,
        `Đã rút ngắn thời gian bot thành công!\n🤖 Bot: ${botName}\n🆔 Bot ID: ${uidFrom}\n⏰ Hết hạn mới: ${formatDateTime(new Date(newExpiry))}\n👤 Rút ngắn bởi: ${dName}`,
        true,
        false
      );
    }
    return true;
  } catch (error) {
    await handleError(error, api, threadId, "rút ngắn thời gian bot", type, message);
    return false;
  }
}

export async function cleanExpiredBots(api, message, isAdminLevelHighest) {
  const { threadId, data: { dName }, type } = message;
  try {
    const startTime = Date.now();
    await sendMessageComplete(api, message, "Đang kiểm tra và xóa các bot đã hết hạn...", true, false);

    const report = await cleanExpiredBotsLogic({
      projectRoot,
      registryPath: myBotsPath,
      deleteFn: async ({ botKey }) => {
        return deleteBot(api, message, isAdminLevelHighest, [], true, botKey);
      },
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const cleanedCount = report.cleaned.length;
    const failedCount = report.failed.length;

    let responseMsg = `Đã dọn dẹp xong trong ${duration}s:\n- Thành công: ${cleanedCount} bot`;
    if (failedCount > 0) {
      responseMsg += `\n- Thất bại: ${failedCount} bot (${report.failed.map((f) => f.botKey).join(", ")})`;
    }

    await sendMessageComplete(api, message, responseMsg, true, false);
    return true;
  } catch (error) {
    await handleError(error, api, threadId, "xóa bot hết hạn", type, message);
    return false;
  }
}

export async function rejectBot(api, message, isAdminLevelHighest, isPermanent, rejecter, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      await sendMessageWarning(api, message, "Bot không tồn tại!", true, false);
      return false;
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;

    if (isMainBot(botInfo, uidFrom)) {
      await sendMessageWarning(api, message, "Không thể vô hiệu hóa Main Bot!", true, false);
      return false;
    }

    if (botInfo.status === "rejected") {
      await sendMessageWarning(api, message, `Bot ${botName} đã bị vô hiệu hóa trước đó!`, true, false);
      return false;
    }

    await stopPM2Process(uidFrom).catch(() => {});
    await killSpawnedProcess(uidFrom).catch(() => {});

    await updateBotField(uidFrom, "status", "rejected");
    await updateBotField(uidFrom, "rejecter", rejecter);
    updateProfile(uidFrom, { enabled: false }, { root: projectRoot });

    if (isPermanent) {
      const expiredTime = new Date(Date.now() - 1000).toISOString();
      await updateBotField(uidFrom, "expiryAt", expiredTime);
      updateProfile(uidFrom, { expiryAt: expiredTime }, { root: projectRoot });
    }

    const messageText = isPermanent
      ? `Bot ${botName} đã bị vô hiệu hóa vĩnh viễn và đánh dấu hết hạn bởi ${rejecter}!`
      : `Bot ${botName} đã bị vô hiệu hóa thành công bởi ${rejecter}!`;
    await sendMessageComplete(api, message, messageText, true, false);
    return true;
  } catch (error) {
    await handleError(error, api, threadId, "vô hiệu hóa bot", type, message);
    return false;
  }
}

export async function approveBot(api, message, isAdminLevelHighest, targetBotUid = null) {
  const { threadId, data: { uidFrom: requesterUid, dName }, type } = message;
  const uidFrom = targetBotUid || requesterUid;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      await sendMessageWarning(api, message, "Bot không tồn tại!", true, false);
      return false;
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;
    if (botInfo.status !== "rejected") {
      await sendMessageWarning(api, message, `Bot ${botName} không ở trạng thái bị vô hiệu hóa!`, true, false);
      return false;
    }
    const currentTime = new Date();
    const expiryTime = new Date(botInfo.expiryAt);
    const updatedStatus = botInfo.expiryAt === "-1" || expiryTime > currentTime ? "stopped" : "expired";

    await updateBotField(uidFrom, "status", updatedStatus);
    updateProfile(uidFrom, { enabled: true }, { root: projectRoot });

    await sendMessageComplete(
      api,
      message,
      `Bot ${botName} đã được cho phép hoạt động lại bởi ${dName}!\nTrạng thái: ${updatedStatus === "stopped" ? "Đã dừng" : "Hết hạn"}`,
      true,
      false
    );
    return true;
  } catch (error) {
    await handleError(error, api, threadId, "cho phép bot", type, message);
    return false;
  }
}

async function handleBatchAction(api, message, isAdminLevelHighest, action, targetBots = []) {
  const startTime = Date.now();
  const verbMap = {
    start: "khởi động",
    restart: "khởi động lại",
    stop: "dừng",
    delete: "xóa",
  };
  const verb = verbMap[action] || action;

  // Filter out Main Bot to ensure child-only action
  const childBots = targetBots.filter((b) => !isMainBot(b, b.key));

  if (childBots.length === 0) {
    return await sendMessageWarning(api, message, `Không có bot con nào hợp lệ để ${verb}!`, true, false);
  }

  // Send ACK immediately
  await sendMessageComplete(api, message, `⏳ Tiến hành ${verb} ${childBots.length} bot con...`, true, false);

  let successCount = 0;
  const failedBots = [];

  for (const bot of childBots) {
    const botName = bot.displayName || bot.nameServer || bot.name || bot.key;
    try {
      let ok = false;
      if (action === "start") {
        ok = await startBot(api, message, isAdminLevelHighest, [], true, bot.key);
      } else if (action === "restart") {
        ok = await restartManagedBot(api, message, isAdminLevelHighest, [], true, bot.key);
      } else if (action === "stop") {
        ok = await stopBot(api, message, isAdminLevelHighest, [], true, bot.key);
      } else if (action === "delete") {
        ok = await deleteBot(api, message, isAdminLevelHighest, [], true, bot.key);
      }
      if (ok) {
        successCount += 1;
      } else {
        failedBots.push({ key: bot.key, name: botName, reason: "Thao tác không thành công" });
      }
    } catch (err) {
      failedBots.push({ key: bot.key, name: botName, reason: err.message || "Lỗi ngoại lệ" });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  let summary = `📊 BÁO CÁO KẾT QUẢ ${verb.toUpperCase()} HÀNG LOẠT (${duration}s)\n\n` +
    `• Tổng số bot: ${childBots.length}\n` +
    `• ✅ Thành công: ${successCount}\n` +
    `• ❌ Thất bại: ${failedBots.length}\n`;

  if (failedBots.length > 0) {
    summary += `\nChi tiết các bot thất bại:\n`;
    failedBots.forEach((f, idx) => {
      summary += `${idx + 1}. [${f.key}] ${f.name}: ${f.reason}\n`;
    });
  }

  await sendMessageComplete(api, message, summary.trim(), true, false);
}

async function handleNotifyCommand(api, message, notifyMessage, myBots) {
  const childBots = resolveManagedBotList({
    projectRoot,
    registry: myBots,
    includeMain: false,
  });

  if (childBots.length === 0) {
    return await sendMessageWarning(api, message, "Hệ thống hiện không có bot con nào để gửi thông báo!", true, false);
  }

  await sendMessageComplete(api, message, `Đang gửi thông báo tới các chủ sở hữu của ${childBots.length} bot con...`, true, false);

  const report = await sendNotifyToOwners({
    targets: childBots,
    messageText: `[THÔNG BÁO TỪ HỆ THỐNG BOT]\n\n${notifyMessage}`,
    sendFn: async (ownerUid, text) => {
      return api.sendMessage({ msg: text }, ownerUid, 0);
    },
    concurrency: 3,
    timeoutMs: 10000,
    projectRoot,
  });

  let reportText = `📢 Kết quả gửi thông báo tới chủ bot:\n` +
    `• Tổng số bot con: ${report.totalChildBots}\n` +
    `• Số chủ sở hữu (đã dedupe): ${report.totalOwners}\n` +
    `• Đã gửi thành công: ${report.successCount}` +
    (report.deliveredCount > 0 ? ` (${report.deliveredCount} đã nhận, ${report.acceptedCount} đã tiếp nhận)\n` : `\n`);
  if (report.dedupedCount > 0) {
    reportText += `• Trùng lặp đã gộp: ${report.dedupedCount}\n`;
  }
  if (report.missingOwnerCount > 0) {
    reportText += `• Thiếu ownerUid (bỏ qua không gửi): ${report.missingOwnerCount}\n`;
  }
  if (report.failCount > 0) {
    reportText += `• Thất bại: ${report.failCount} (${report.failedOwners.map(f => f.ownerUid).join(", ")})\n`;
  }
  if (Array.isArray(report.missingOwnerBots) && report.missingOwnerBots.length > 0) {
    reportText += `\n⚠️ Danh sách bot thiếu UID chủ bot cần cập nhật (migration):\n`;
    report.missingOwnerBots.forEach((b, idx) => {
      reportText += `${idx + 1}. [${b.key}] ${b.name} (UID: ${b.uid})\n`;
    });
  }

  await sendMessageComplete(api, message, reportText.trim(), true, false);
}

async function handleListBots(api, threadId, type, message, { isSystemAdmin = true, callerUid = "" } = {}) {
  try {
    const myBots = loadMyBotsRegistry(myBotsPath);
    const visibleBots = resolveVisibleBots({
      projectRoot,
      registry: myBots,
      callerUid,
      isSystemAdmin,
    });

    if (visibleBots.length === 0) {
      if (!isSystemAdmin) {
        return await sendMessageWarning(
          api,
          message,
          "Bạn chưa sở hữu bot nào trong hệ thống!\nDùng lệnh !mybot qrlogin hoặc !mybot create để tạo bot mới.",
          true,
          false
        );
      }
      return await sendMessageWarning(api, message, "Danh sách bot trống!", true, false);
    }

    // Sync runtime status in parallel via Promise.allSettled: probe failure of one bot must not break the list
    const probeResults = await Promise.allSettled(
      visibleBots.map((bot) => resolveBotRuntimeState(bot, { customRoot: projectRoot, registry: myBots }))
    );

    visibleBots.forEach((bot, idx) => {
      const res = probeResults[idx];
      if (res.status === "fulfilled" && res.value) {
        bot.runtimeState = res.value;
        bot.status = res.value.status;
      } else {
        bot.runtimeState = {
          running: false,
          ready: false,
          status: bot.status || "stopped",
          probeError: true,
          label: "Không xác định runtime",
          error: res.reason?.message || "Probe error",
        };
      }
    });


    let filePath;
    try {
      filePath = await createBotListImage(visibleBots, api);
      await api.sendMessage({ msg: "", quote: message, attachments: [filePath], ttl: 60000 }, threadId, type);
    } catch (error) {
      console.error(`Lỗi tạo danh sách bot: ${error.message}`);
      await sendMessageWarning(api, message, "Lỗi khi tạo danh sách bot. Vui lòng thử lại!", true, false);
    } finally {
      if (filePath) await fs.unlink(filePath).catch(() => {});
    }
  } catch (error) {
    console.error(`Lỗi lấy danh sách bot: ${error.message}`);
    await sendMessageWarning(api, message, "Không thể lấy danh sách bot. Vui lòng thử lại sau!", true, false);
  }
}

async function updateBotCredentials(api, message, args, aliasCommand) {
  const { threadId, data: { uidFrom, dName }, type } = message;
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, "Bạn chưa có bot để cập nhật!", true, false);
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;

    const validationResult = validateCredentials(args, getGlobalPrefix(), aliasCommand);
    if (!validationResult.valid) {
      return await sendMessageWarning(api, message, validationResult.message, true, false);
    }
    const credentialsData = {
      cookie: {
        ...getZaloCookiePayload({ cookies: JSON.parse(args[1]) }, ZALO_RUNTIME),
      },
      imei: args[0],
      userAgent: args[2] || "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
    };
    const botConfig = createBotConfig(uidFrom, botInfo.webPort);
    await fs.writeFile(path.join(projectRoot, botConfig.configFilePath), JSON.stringify(credentialsData, null, 2), "utf-8");
    await sendMessageComplete(
      api,
      message,
      `Đã cập nhật thông tin đăng nhập cho bot ${botName} thành công!`,
      true,
      false
    );
    if (botInfo.status === "running") {
      await restartBotRuntime(uidFrom).catch(() => {});
    }
  } catch (error) {
    await handleError(error, api, threadId, "cập nhật thông tin đăng nhập bot", type, message);
  }
}

async function handleQrUpdate(api, message, threadId, type) {
  const { data: { dName, uidFrom } } = message;
  const sessionId = `update-${uidFrom}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let qrPath = path.join(projectRoot, ".cache", `qr_code_${sessionId}.png`);

  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, "Bạn chưa có bot để cập nhật!", true, false);
    }
    const botInfo = checkResult.botInfo;
    const botName = botInfo.displayName || botInfo.nameServer || botInfo.name || uidFrom;

    let session = await initSession({ sessionId, qrFilePath: qrPath });
    if (!session) {
      return await sendMessageWarning(api, message, `Không thể khởi tạo phiên đăng nhập! Vui lòng thử lại sau.`, true, false);
    }
    session = await verifyClient(session);
    if (!session) {
      return await sendMessageWarning(api, message, `Không thể xác minh phiên đăng nhập! Vui lòng thử lại sau.`, true, false);
    }
    const [code, updatedSession] = await generateQRCode(session, { sessionId, qrFilePath: qrPath });
    session = updatedSession;
    if (!code || !session) {
      return await sendMessageWarning(api, message, `Đã xảy ra lỗi khi tạo QR`, true, false);
    }
    qrPath = session.qrFilePath || qrPath;

    const expiresAt = Date.now() + 180_000;
    await api.sendMessage(
      {
        msg: `${dName}, mở app Zalo và quét mã QR này để cập nhật thông tin đăng nhập (hiệu lực 3 phút)!`,
        attachments: [qrPath],
        mentions: [{ pos: 0, uid: uidFrom, len: dName.length }],
        ttl: 180000,
      },
      threadId,
      type
    );

    const scanResult = await waitingScan(code, session, null, { expiresAt });
    if (!scanResult) {
      return await sendMessageWarning(api, message, `Cập nhật không thành công hoặc đã hết thời gian quét mã!`, true, false);
    }
    await sendMessageComplete(api, message, `Đã quét QR, vui lòng xác nhận cập nhật trên thiết bị của bạn.`, true, false);

    const [resultData, rawCookies] = await waitingConfirm(code, session, { expiresAt });
    if (!resultData || !rawCookies) {
      return await sendMessageWarning(api, message, `Cập nhật không thành công hoặc đã hết thời gian xác nhận!`, true, false);
    }

    const userInfo = await getUserInfo(session);
    const scannedUid = String(
      userInfo?.data?.uid ||
      userInfo?.data?.userId ||
      userInfo?.data?.info?.uid ||
      userInfo?.data?.info?.userId ||
      ""
    ).trim();
    if (scannedUid && scannedUid !== String(uidFrom).trim()) {
      return await sendMessageWarning(
        api,
        message,
        `Tài khoản Zalo vừa quét (${scannedUid}) không khớp với bot cần cập nhật (${uidFrom})! Đã hủy ghi đè thông tin đăng nhập.`,
        true,
        false
      );
    }

    const credentialsData = {
      cookie: {
        ...getZaloCookiePayload(rawCookies, ZALO_RUNTIME),
      },
      imei: resultData.imei,
      userAgent: ZALO_RUNTIME.userAgent,
    };
    const botConfig = createBotConfig(uidFrom, botInfo.webPort);
    await fs.writeFile(path.join(projectRoot, botConfig.configFilePath), JSON.stringify(credentialsData, null, 2), "utf-8");
    await sendMessageComplete(
      api,
      message,
      `Đã cập nhật thông tin đăng nhập cho bot ${botName} thành công!\nTên: ${userInfo?.data?.info?.name || ""}`,
      true,
      false
    );
    if (botInfo.status === "running") {
      await restartBotRuntime(uidFrom).catch(() => {});
    }
  } catch (error) {
    await handleError(error, api, threadId, "xử lý cập nhật qua QR", type, message);
  } finally {
    await fs.unlink(qrPath).catch(() => {});
  }
}

async function handleUpdateName(api, uidFrom, dName, newName, threadId, type, message) {
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, "Bạn chưa có bot nào được tạo!", true, false);
    }
    if (newName.length > 50) {
      return await sendMessageWarning(api, message, "Tên hiển thị không được quá 50 ký tự!", true, false);
    }
    const trimmedName = newName.trim();
    await updateBotField(uidFrom, "displayName", trimmedName);
    updateProfile(uidFrom, { nameServer: trimmedName }, { root: projectRoot, actor: uidFrom });
    await sendMessageComplete(
      api,
      message,
      `Đã cập nhật tên hiển thị thành công!\nTên mới: ${trimmedName}\nCập nhật bởi: ${dName}`,
      true,
      false
    );
  } catch (error) {
    await sendMessageWarning(api, message, "Đã xảy ra lỗi khi cập nhật tên hiển thị!", true, false);
  }
}

async function handleUpdateDescription(api, uidFrom, dName, newDescription, threadId, type, message) {
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, "Bạn chưa có bot nào được tạo!", true, false);
    }
    if (newDescription.length > 200) {
      return await sendMessageWarning(api, message, "Mô tả không được quá 200 ký tự!", true, false);
    }
    const trimmedDescription = newDescription.trim();
    await updateBotField(uidFrom, "description", trimmedDescription);
    updateProfile(uidFrom, { description: trimmedDescription }, { root: projectRoot, actor: uidFrom });
    await sendMessageComplete(
      api,
      message,
      `Đã cập nhật mô tả bot thành công!\n\nMô tả mới: ${trimmedDescription}\nCập nhật bởi: ${dName}`,
      true,
      false
    );
  } catch (error) {
    await sendMessageWarning(api, message, "Đã xảy ra lỗi khi cập nhật mô tả!", true, false);
  }
}

async function handleChangeNameServer(api, uidFrom, dName, newNameServer, threadId, type, message) {
  try {
    const checkResult = await checkBotExists(uidFrom);
    if (!checkResult.exists) {
      return await sendMessageWarning(api, message, "Bạn chưa có bot nào được tạo!", true, false);
    }
    if (newNameServer.length > 100) {
      return await sendMessageWarning(api, message, "Tên server không được quá 100 ký tự!", true, false);
    }
    const botConfig = createBotConfig(uidFrom, checkResult.botInfo.webPort);
    const databaseFilePath = path.join(projectRoot, botConfig.databaseFile);
    if (await fs.access(databaseFilePath).then(() => true).catch(() => false)) {
      const databaseConfig = JSON.parse(await fs.readFile(databaseFilePath, "utf8"));
      databaseConfig.nameServer = newNameServer.trim();
      await fs.writeFile(databaseFilePath, JSON.stringify(databaseConfig, null, 2));
    }
    await updateBotField(uidFrom, "displayName", newNameServer.trim());
    updateProfile(uidFrom, { nameServer: newNameServer.trim() }, { root: projectRoot, actor: uidFrom });
    await sendMessageComplete(
      api,
      message,
      `Đã cập nhật tên server thành công!\nTên server mới: ${newNameServer.trim()}\nCập nhật bởi: ${dName}`,
      true,
      false
    );
  } catch (error) {
    await sendMessageWarning(api, message, "Đã xảy ra lỗi khi cập nhật tên server!", true, false);
  }
}

export async function updateBotField(uidFrom, field, value) {
  try {
    const myBots = loadMyBotsRegistry(myBotsPath);
    if (!myBots[uidFrom]) {
      return false;
    }
    myBots[uidFrom][field] = value;
    myBots[uidFrom].lastUpdated = new Date().toISOString();
    saveMyBotsRegistry(myBots, myBotsPath);
    return true;
  } catch {
    return false;
  }
}

export async function getBotUidByIndex(index) {
  try {
    const myBots = loadMyBotsRegistry(myBotsPath);
    const sorted = getSortedBotList(myBots);
    if (index < 1 || index > sorted.length) return null;
    return sorted[index - 1].key;
  } catch {
    return null;
  }
}

export function parseTimeDuration(timeStr) {
  return parseDuration(timeStr);
}

function formatDateTime(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return "Không xác định";
  }
  return date.toLocaleString("vi-VN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
}

async function handleError(error, api, threadId, context, type, message) {
  console.error(`Lỗi ${context}: ${error.message}`);
  await sendMessageWarning(api, message, `Đã xảy ra lỗi khi ${context}!\n\nChi tiết: ${error.message}`, true, false);
}
