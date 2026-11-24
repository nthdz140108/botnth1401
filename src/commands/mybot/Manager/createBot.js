import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  checkBotHealth,
  checkExistingBot,
  createAllRequiredFiles,
  createBotConfig,
  ensureDirectoriesExist,
  getAvailablePort,
  saveBotToMyBots,
  startBotWithLauncher,
  validateCredentials,
} from "../System/pm2-manager.js";
import { readCommandConfig } from "../../../utils/io-json.js";
import { sendMessageComplete, sendMessageWarning } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { createDefaultProfile, saveProfile, updateProfile } from "../System/mybot-profile-service.js";
import { resolveAdminIdentity, normalizeUsername, extractUsernameFromUserInfo } from "../System/mybot-identity.js";
import { validateAdminIdentitySeeds } from "../System/child-admin-resolver.js";
import { checkOwnerCreationQuota, reserveCreationQuota, commitCreationQuota, releaseCreationQuota } from "../System/mybot-creation-quota.js";
import { waitForAdminReady } from "./qr-login-admin-readiness.js";
import { getProjectRoot } from "../../../utils/env.js";

function getGlobalPrefix() {
  try {
    return readCommandConfig()?.prefix || "!";
  } catch {
    return "!";
  }
}

export async function createBot(api, message, groupAdmins, arg, aliasCommand = "mybot") {
  const { threadId, data: { uidFrom, dName, content }, type } = message;
  const projectRoot = getProjectRoot();
  const prefix = getGlobalPrefix();
  let args = content.split(/\s+/);
  if (arg && Array.isArray(arg) && arg.length > 0) args = arg;

  // Direct Message (type 0) required for secret credentials
  if (type === 1) {
    return await sendMessageWarning(api, message, "Vui lòng khởi tạo bot ở chat cá nhân, vì thông tin tạo bot là bảo mật an toàn.", true, false);
  }

  if (args.length < 3 && (!arg || arg.length < 2)) {
    return await sendMessageComplete(api, message, `Cách sử dụng hệ thống tạo bot:\nSử dụng lệnh ${prefix}${aliasCommand} create <ImeiUUID> <SessionCookies> để tạo bot.`, true, false);
  }

  const credentialArgs = arg && arg.length >= 2 ? arg : args.slice(2);
  const validationResult = validateCredentials(credentialArgs, prefix, aliasCommand);
  if (!validationResult.valid) {
    return await sendMessageWarning(api, message, validationResult.message, true, false);
  }

  let reservation = null;
  try {
    const myBotsPath = path.join(projectRoot, "mybot", "mybots.json");
    let myBots = {};
    if (fs.existsSync(myBotsPath)) {
      myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8"));
    }
    const adminReady = await waitForAdminReady({ api, projectRoot, registry: myBots }).catch(() => ({ ready: true }));
    if (!adminReady.ready && adminReady.reason === "cookie_dead") {
      return await sendMessageWarning(api, message, "Bot mặc định đã hết hạn phiên đăng nhập! Vui lòng khôi phục phiên bot mặc định trước khi thêm bot mới.", true, false);
    }

    const parsedCreds = validationResult.credentials;
    const targetBotUid = String(parsedCreds?.userInfo?.id || parsedCreds?.botUid || parsedCreds?.uid || uidFrom).trim();
    const checkResult = await checkExistingBot(targetBotUid);

    // 1. Quota Check & Atomic Reservation for Owner
    if (!checkResult.exists) {
      reservation = reserveCreationQuota(uidFrom, `create-${uidFrom}-${Date.now()}`, { projectRoot, registry: myBots });
      if (!reservation.allowed) {
        return await sendMessageWarning(
          api,
          message,
          `⚠️ Bạn đang có một yêu cầu khởi tạo bot khác đang xử lý.\nVui lòng đợi ít giây rồi thử lại!`,
          true,
          false
        );
      }
    }

    // 2. Resolve identity seeds: ownerUsername, botAdminUsername, selfUsername
    let ownerUsername = null;
    try {
      if (api && typeof api.getUserInfo === "function") {
        const uInfo = await api.getUserInfo([uidFrom]);
        ownerUsername = extractUsernameFromUserInfo(uInfo, uidFrom);
      }
    } catch {}

    const mainBotIdentity = resolveAdminIdentity({ projectRoot, api });
    const botAdminUsername = normalizeUsername(mainBotIdentity.botAdminUsername || mainBotIdentity.canonicalUsername);

    const selfUsername = extractUsernameFromUserInfo(parsedCreds?.userInfo || parsedCreds);

    // Credentials object seeded with the owner UID so child bot admin lists are
    // initialized as [botUid, ownerUid] during file provisioning.
    const credentialObject = {
      ...parsedCreds,
      uid: uidFrom, // owner / creator UID
    };

    const adminIdentitySeeds = {
      botAdminUsername,
      ownerUsername,
      selfUsername,
    };
    const seedVal = validateAdminIdentitySeeds(adminIdentitySeeds);
    // Identity seeds are informational only: bot UID + owner UID are always written
    // as Supreme Admins, so the bot is never left in a pending-identity state.
    const identityPending = false;
    const identityPendingReason = null;

    if (checkResult.exists) {
      // Safe update of existing bot credentials with backup & restore
      const existingBot = myBots[targetBotUid] || myBots[uidFrom] || {};
      const credPath = path.join(projectRoot, "mybot", "credentials", `${targetBotUid}.json`);
      const cfgPath = path.join(projectRoot, "mybot", "bots", `${targetBotUid}.json`);
      let credBackup = null;
      let cfgBackup = null;

      try {
        if (fs.existsSync(credPath)) credBackup = fs.readFileSync(credPath, "utf8");
        if (fs.existsSync(cfgPath)) cfgBackup = fs.readFileSync(cfgPath, "utf8");
      } catch {}

      try {
        const webPort = existingBot.webPort || getAvailablePort();
        const botConfig = createBotConfig(targetBotUid, webPort);
        await createAllRequiredFiles(targetBotUid, credentialObject, botConfig);

        const existingOwner = existingBot.ownerUid || existingBot.createdByUid;
        const finalOwner = existingOwner || uidFrom;
        const finalCreatedByUid = existingBot.createdByUid || existingBot.ownerUid || uidFrom;

        updateProfile(targetBotUid, {
          ownerUid: finalOwner,
          createdByUid: finalCreatedByUid,
          ownerName: existingBot.ownerName || dName,
          ownerUsername: existingBot.ownerUsername || ownerUsername,
          nameServer: existingBot.nameServer || dName,
          adminIdentitySeeds,
          identityPending,
          identityPendingReason,
        }, { root: projectRoot, actor: uidFrom });

        myBots[targetBotUid] = {
          ...existingBot,
          displayName: existingBot.displayName || dName,
          ownerUid: finalOwner,
          createdByUid: finalCreatedByUid,
          ownerName: existingBot.ownerName || dName,
          ownerUsername: existingBot.ownerUsername || ownerUsername,
          adminIdentitySeeds,
          identityPending,
          identityPendingReason,
          lastUpdated: new Date().toISOString(),
        };
        fs.writeFileSync(myBotsPath, JSON.stringify(myBots, null, 2), "utf8");

        return await sendMessageComplete(
          api,
          message,
          `✅ Đã cập nhật thông tin đăng nhập cho bot của ${dName} thành công!\n\n📋 Thông tin bot:\n• Bot ID: ${targetBotUid}\n• Tên Server: ${existingBot.nameServer || dName}\n• Trạng thái: ${existingBot.status || "stopped"}\n\n💡 Dùng lệnh: ${prefix}${aliasCommand} active để khởi động bot.`,
          true,
          false
        );
      } catch (err) {
        // Restore backups if update failed
        try {
          if (credBackup !== null) fs.writeFileSync(credPath, credBackup, "utf8");
          if (cfgBackup !== null) fs.writeFileSync(cfgPath, cfgBackup, "utf8");
        } catch {}
        return await handleError(err, api, threadId, "cập nhật bot", type, message);
      }
    }

    await ensureDirectoriesExist();
    const webPort = getAvailablePort();
    const botConfig = createBotConfig(targetBotUid, webPort);
    await createAllRequiredFiles(targetBotUid, credentialObject, botConfig);

    // Initialize bot profile as pending (do not auto-activate trial)
    const initialProfile = createDefaultProfile(targetBotUid, {
      ownerUid: uidFrom,
      createdByUid: uidFrom,
      ownerName: dName,
      ownerUsername,
      nameServer: dName,
      expiryAt: null,
      trialStatus: "pending",
      enabled: true,
      adminIdentitySeeds,
      identityPending,
      identityPendingReason,
    });
    saveProfile(targetBotUid, initialProfile, { root: projectRoot, actor: uidFrom });

    await saveBotToMyBots(targetBotUid, dName, webPort, null, dName, "", {
      ownerUid: uidFrom,
      createdByUid: uidFrom,
      ownerName: dName,
      ownerUsername,
      createdBy: dName,
      trialStatus: "pending",
      status: "stopped",
      adminIdentitySeeds,
      identityPending,
      identityPendingReason,
    });

    commitCreationQuota(uidFrom, targetBotUid, { projectRoot, requestId: reservation?.requestId });

    const pendingNote = identityPending
      ? `\n\n⚠️ Lưu ý: Bot đang ở trạng thái pending identity (${identityPendingReason}). Cần đăng nhập/xác thực username qua QR hoặc hydrate trước khi start.`
      : "";

    await sendMessageComplete(
      api,
      message,
      `🎉 Khởi tạo dữ liệu bot cho ${dName} thành công!\n\n📋 Thông tin bot:\n• Bot ID: ${targetBotUid}\n• Tên Server: ${dName}\n• Người tạo: ${dName}\n• Trạng thái: ⏸ Tạm dừng (pending trial)${pendingNote}\n\n💡 Dùng lệnh: ${prefix}${aliasCommand} active để kích hoạt dùng thử 1 giờ (1 lần / tuần lịch Bangkok).`,
      true,
      false
    );
    console.log(`Bot con "${targetBotUid}" đã được tạo thành công bởi ${dName} (status: stopped, trialStatus: pending)`);
  } catch (error) {
    // Release quota reservation on error
    if (reservation?.requestId) {
      try {
        releaseCreationQuota(uidFrom, reservation.requestId, { projectRoot });
      } catch {}
    }

    // Only delete newly created files for first-time bot creation
    try {
      const myBotsCheck = fs.existsSync(path.join(projectRoot, "mybot", "mybots.json"))
        ? JSON.parse(fs.readFileSync(path.join(projectRoot, "mybot", "mybots.json"), "utf8"))
        : {};
      if (!myBotsCheck[uidFrom]) {
        const credPath = path.join(projectRoot, "mybot", "credentials", `${uidFrom}.json`);
        const cfgPath = path.join(projectRoot, "mybot", "bots", `${uidFrom}.json`);
        if (fs.existsSync(credPath)) fs.unlinkSync(credPath);
        if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
      }
    } catch {}
    await handleError(error, api, threadId, "tạo bot", type, message);
  }
}

async function handleError(error, api, threadId, context, type, message) {
  console.error(`Lỗi ${context}: ${error.message}`);
  let errorDetails = error.message;
  if (error.code) errorDetails += ` (Code: ${error.code})`;
  await sendMessageWarning(api, message, `Đã xảy ra lỗi khi ${context}!\n\n🔍 Chi tiết: ${errorDetails}\n\n💡 Vui lòng kiểm tra logs và thử lại sau.`, true, false);
}
