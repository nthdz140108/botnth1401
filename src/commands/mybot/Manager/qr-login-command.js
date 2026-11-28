import fs from "fs";
import path from "path";
import { verifyLoginCredential } from "../System/login-verification.js";
import { normalizeLoginCredential } from "../System/credential-normalizer.js";
import { persistVerifiedBot } from "../System/verified-provisioning.js";
import { readCommandConfig } from "../../../utils/io-json.js";

function getGlobalPrefix() {
  try {
    return readCommandConfig()?.prefix || "!";
  } catch {
    return "!";
  }
}
import {
  createBotRuntimeContext,
  updateCommandPrefixFile,
  getInitialAdminList,
} from "../../../utils/bot-runtime-context.js";
import { getProjectRoot } from "../../../utils/env.js";
import { createBotConfig, credentialsLookLikeAdmin } from "../System/pm2-manager.js";
import { sendMessageComplete, sendMessageWarning } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { initSession, verifyClient, generateQRCode, waitingScan, waitingConfirm } from "../Credentials/qr-login.js";
import { writeJsonAtomic } from "../System/json-state.js";
import { createCommandSeedStub } from "../../../utils/command-runtime-state.js";
import {
  setAwaitingPrefix,
  setPrefixCountdown,
  extractQrLoginMessageId,
  clearAwaitingPrefix,
  isValidPrefix,
} from "../../../utils/qr-login-prefix-state.js";
import {
  startQrLoginPrefixCountdown,
} from "../../../utils/qr-login-prefix-countdown.js";
import { waitForAdminReady } from "./qr-login-admin-readiness.js";
import { startQrLoginCountdown } from "../../../utils/qr-login-countdown.js";
import { getZaloRuntimeConfig } from "../../../api-zalo/zalo-config.js";
import { createDefaultProfile, saveProfile, getProfilePath } from "../System/mybot-profile-service.js";
import { resolveAdminIdentity, normalizeUsername, extractUsernameFromUserInfo } from "../System/mybot-identity.js";
import { validateAdminIdentitySeeds } from "../System/child-admin-resolver.js";
import { commitCreationQuota } from "../System/mybot-creation-quota.js";
import {
  beginQrSession,
  markQrDisplayed,
  markWaitingConfirm,
  markCredentialsAcquired,
  failQrSession,
  expireQrSession,
  sweepExpiredQrSessions,
  QR_SESSION_STATES,
} from "./qr-login-session-coordinator.js";

const projectRoot = getProjectRoot();
const myBotDir = path.join(projectRoot, "mybot");
const defaultCommand = path.join(myBotDir, "defaultCommand.json");
const botsDir = path.join(myBotDir, "bots");
const adminStatePath = path.join(myBotDir, "state", "admin.json");
const ZALO_RUNTIME = getZaloRuntimeConfig();

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function sanitizeInput(input, maxLength = 1000) {
  if (typeof input !== "string") return String(input).slice(0, maxLength);
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
    .slice(0, maxLength);
}

async function sendMessage(api, msg, threadId, type, message) {
  try {
    await api.sendMessage({ msg: msg, quote: message, ttl: 120000 }, threadId, type);
  } catch (err) {
    console.error(`Lỗi khi gửi tin nhắn: ${err.message}`);
    try {
      await api.sendMessage({ msg: msg, ttl: 120000 }, threadId, type);
    } catch (fallbackErr) {
      console.error(`Lỗi khi gửi tin nhắn fallback: ${fallbackErr.message}`);
    }
  }
}

async function validateImageFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size < 100) {
      throw new Error("QR code image is too small or corrupted");
    }
    return true;
  } catch (error) {
    console.error(`Error validating image file ${filePath}: ${error.message}`);
    return false;
  }
}

export async function runQrBootstrap(sessionId, credentialsData, options = {}) {
  return verifyLoginCredential(credentialsData, { root: getProjectRoot(), ...options });
}


export async function handleQrLogin(api, message, threadId, type, isAdminLevelHighest, options = {}) {
  const { data: { dName, uidFrom } } = message;
  const qrSessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let qrPath = path.join(projectRoot, ".cache", `qr_code-${qrSessionId}.png`);
  let qrLifecycle = null;
  let expiredWarningSent = false;
  const sendExpiryWarningOnce = async () => {
    if (expiredWarningSent) return;
    expiredWarningSent = true;
    await sendMessageWarning(api, message, "Mã QR đã hết hạn. Phiên QR login đã dừng; vui lòng tạo phiên mới.", true, false);
  };

  // ---- 1. Check admin readiness and begin coordinator session ----
  try {
    const ready = await waitForAdminReady({ api, projectRoot });
    if (!ready.ready) {
      await sendMessageWarning(api, message, ready.message || "Bot admin chưa sẵn sàng để tạo QR login.", true, false);
      return;
    }

    // Begin a per-requester QR session; rejected if this requester already has one active
    const session = beginQrSession({ sessionId: qrSessionId, requesterUid: uidFrom });
    if (!session.ok) {
      await sendMessageWarning(
        api,
        message,
        "⚠️ Bạn đang có một phiên tạo mã QR khác đang được xử lý.\nVui lòng hoàn tất hoặc đợi phiên hiện tại kết thúc trước khi tạo phiên mới!",
        true,
        false
      );
      return;
    }

    // ---- 2. Init session, verify client, generate QR ----
    let zaloSession = await initSession();
    if (!zaloSession) {
      await sendMessageWarning(api, message, "Không thể khởi tạo session đăng nhập!", true, false);
      return;
    }
    zaloSession = await verifyClient(zaloSession);
    if (!zaloSession) {
      await sendMessageWarning(api, message, "Không thể xác minh session đăng nhập!", true, false);
      return;
    }

    const [code, updatedSession] = await generateQRCode(zaloSession, {
      sessionId: qrSessionId,
      qrFilePath: qrPath,
    });
    if (!code || !updatedSession) {
      await sendMessageWarning(api, message, "Không thể tạo mã QR đăng nhập!", true, false);
      return;
    }
    zaloSession = updatedSession;
    qrPath = zaloSession.qrFilePath || qrPath;

    const isValid = await validateImageFile(qrPath);
    if (!isValid) {
      await sendMessageWarning(api, message, "File ảnh mã QR bị lỗi. Vui lòng thử lại sau!", true, false);
      return;
    }

    // ---- 3. Send QR image and arm the 60s countdown ----
    let initialQrMessage = null;
    try {
      initialQrMessage = await api.sendMessage(
        {
          msg: `Quét mã QR dưới đây để đăng nhập Zalo:\n(Mã QR có hiệu lực trong 60 giây)\n\nSau khi quét, vui lòng nhấn "Xác nhận đăng nhập" trên điện thoại.`,
          attachments: [qrPath],
          ttl: 60000,
        },
        threadId,
        type
      );
    } catch (sendError) {
      console.error(`[ERROR] Failed to send QR code image: ${sendError.message}`);
      await sendMessageWarning(api, message, "Không thể gửi ảnh mã QR. Vui lòng thử lại sau!", true, false);
      return;
    }

    const expiresAt = Date.now() + 60000;
    markQrDisplayed(qrSessionId, { expiresAt });

    qrLifecycle = startQrLoginCountdown({
      api,
      threadId,
      type,
      initialMessage: initialQrMessage,
      quoteMessage: message,
      totalSeconds: 60,
      onExpired: async () => {
        expireQrSession(qrSessionId, "qr_expired");
        await sendExpiryWarningOnce();
      },
    });

    // ---- 4. Wait for scan ----

    const scanResult = await waitingScan(code, zaloSession, qrLifecycle.signal, {
      expiresAt,
      onExpired: sendExpiryWarningOnce,
    });

    if (!scanResult) {
      if (!expiredWarningSent) {
        await sendMessageWarning(api, message, "Đăng nhập thất bại hoặc đã hết thời gian quét mã!", true, false);
      }
      return;
    }

    // ---- 5. Wait for confirmation ----
    markWaitingConfirm(qrSessionId);

    const [confirmData, rawCookies, confirmMeta] = await waitingConfirm(code, zaloSession, {
      signal: qrLifecycle.signal,
      expiresAt,
      onExpired: sendExpiryWarningOnce,
    });

    if (!confirmData || !rawCookies) {
      if (confirmMeta?.cancelled) {
        await sendMessageWarning(api, message, "Người dùng đã từ chối xác nhận đăng nhập.", true, false);
      } else if (!expiredWarningSent) {
        await sendMessageWarning(api, message, "Xác nhận đăng nhập thất bại hoặc đã hết thời gian xác nhận!", true, false);
      }
      return;
    }

    // ---- 6. Stop countdown, mark credentials acquired, release requester ----
    if (qrLifecycle) {
      await qrLifecycle.stop();
      qrLifecycle = null;
    }

    const baseCredentialsData = normalizeLoginCredential({ rawCookies, imei: confirmData.imei, userAgent: ZALO_RUNTIME.userAgent });

    // Release the requester slot immediately — credentials are acquired.
    // Bootstrap/provisioning continues independently and no longer blocks
    // the requester from starting a new QR session.
    const acquired = markCredentialsAcquired(qrSessionId, { credentials: baseCredentialsData });
    if (!acquired || acquired.state !== QR_SESSION_STATES.qr_acquired) {
      // Confirmation arrived at/after the deadline; provisioning must not proceed.
      await sendMessageWarning(api, message, "Phiên QR đã hết hạn. Không thể tạo bot.", true, false);
      return;
    }

    // ---- 7. Bootstrap to resolve actual UID ----
    const handshake = await runQrBootstrap(qrSessionId, baseCredentialsData);
    if (!handshake?.uid) {
      await sendMessageWarning(api, message, "Không xác định được danh tính bot từ phiên QR.", true, false);
      return;
    }

    const scannedName = sanitizeInput(handshake.displayName || handshake.name || dName);
    const selfUsername = normalizeUsername(handshake.canonicalUsername || handshake.zaloUsername || handshake.username || "");



    // Resolve owner and main bot admin usernames
    let ownerUsername = null;
    try {
      if (api && typeof api.getUserInfo === "function") {
        const uInfo = await api.getUserInfo([uidFrom]);
        ownerUsername = extractUsernameFromUserInfo(uInfo, uidFrom);
      }
    } catch (fetchOwnerErr) {
      console.warn(`[QR] Could not fetch owner user info for ${uidFrom}: ${fetchOwnerErr.message}`);
    }

    const mainBotIdentity = resolveAdminIdentity({ projectRoot, api });
    const botAdminUsername = normalizeUsername(mainBotIdentity.botAdminUsername || mainBotIdentity.canonicalUsername);

    const adminIdentitySeeds = {
      botAdminUsername,
      ownerUsername,
      selfUsername,
    };

    const seedValidation = validateAdminIdentitySeeds(adminIdentitySeeds);

    const provisioned = await persistVerifiedBot({
      root: projectRoot, credential: baseCredentialsData, identity: handshake,
      ownerUid: uidFrom, ownerName: dName, allowAdmin: Boolean(isAdminLevelHighest), targetBotKey: options.targetBotKey,
      profilePatch: { adminIdentitySeeds: seedValidation.normalized, ownerUsername, accountIdentityStatus: "verified", adminBindingStatus: "pending", identityPending: false, identityPendingReason: null },
      initialize: async (botKey, credential, record, txn) => {
        const botConfig = createBotConfig(botKey, record.webPort);
        await createAllRequiredFilesWithCredentials(botKey, credential, botConfig, txn);
        const profile = createDefaultProfile(botKey, { ownerUid: uidFrom, createdByUid: uidFrom, ownerName: dName, ownerUsername, nameServer: scannedName, expiryAt: null, trialStatus: "pending", enabled: true, adminIdentitySeeds: seedValidation.normalized, identityPending: false, identityPendingReason: null, accountIdentityStatus: "verified", adminBindingStatus: "pending" });
        if (txn.writeJson) txn.writeJson(getProfilePath(botKey, projectRoot), profile);
        else saveProfile(botKey, profile, { root: projectRoot, actor: uidFrom });
      },
    });
    if (provisioned.created) commitCreationQuota(uidFrom, provisioned.botKey, { projectRoot, requestId: qrSessionId });
    await sendMessageComplete(api, message,
      provisioned.created
        ? `✅ Đã xác minh và tạo bot ${scannedName}.\nMã bot: ${provisioned.botKey}\nTrạng thái: Tạm dừng; quyền admin trong phiên bot con đang chờ xác minh.\nThời gian dùng thử: 1 giờ (bắt đầu sau khi kích hoạt thành công lần đầu)\nDùng lệnh: !mybot active để kích hoạt dùng thử 1 giờ.`
        : `✅ Đã xác minh và lưu thông tin đăng nhập cho bot ${provisioned.botKey}.\nThông tin mới có hiệu lực ở lần khởi động lại tiếp theo; cấu hình và hạn dùng được giữ nguyên.`, true, false);
    if (provisioned.created) await promptForPrefix(api, message, provisioned.botKey, uidFrom, threadId);
    return;

  } catch (error) {
    console.error(`[ERROR] Unexpected error in handleQrLogin: ${error.message}`);
    failQrSession(qrSessionId, error.message);
    try {
      await sendMessageWarning(
        api,
        message,
        `Đã xảy ra lỗi khi xử lý lệnh qrlogin: ${error.message}`,
        true,
        false
      );
    } catch {}
  } finally {
    if (qrLifecycle) {
      try { await qrLifecycle.stop(); } catch {}
    }
    // Cleanup QR file
    try {
      if (qrPath && fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
    } catch {}
    failQrSession(qrSessionId, "session_closed");
    // Sweep for any stale sessions
    try { sweepExpiredQrSessions(); } catch {}
  }
}

async function promptForPrefix(api, message, botUid, requesterUid, threadId) {
  const promptMsg = `✅ Bot mới đã được tạo thành công!\n\nReply tin nhắn này để đặt prefix cho bot mới (ví dụ: reply với dấu ? hoặc !).\n\nBạn có 1 phút để đặt prefix, sau đó bot sẽ dùng prefix mặc định là !`;
  try {
    const sent = await api.sendMessage(
      {
        msg: promptMsg,
        quote: message,
        ttl: 300000,
      },
      threadId,
      message.type
    );
    const globalMsgId = extractQrLoginMessageId(sent);
    const adminState = readJsonSafe(adminStatePath, {});
    const allowedRequesterUids = [requesterUid, botUid, adminState.uid];
    setAwaitingPrefix(botUid, requesterUid, threadId, globalMsgId, allowedRequesterUids);

    const sentMessage = Array.isArray(sent?.message) ? sent.message[0] : sent?.message;
    const sentData = sentMessage?.data || sentMessage || {};
    const promptReactionMessage = {
      type: message.type,
      threadId,
      data: {
        ...sentData,
        msgId: sentData.msgId || globalMsgId,
        cliMsgId: sentData.cliMsgId || sentData.clientId || "",
      },
    };
    const cancelCountdown = startQrLoginPrefixCountdown({
      botUid,
      api,
      message: promptReactionMessage,
      messageContext: message,
      seconds: 60,
      getCurrentPrefix: () => getCurrentPrefixForBot(botUid),
      onExpired: async () => {
        clearAwaitingPrefix(botUid);
      },
    });
    setPrefixCountdown(botUid, cancelCountdown);
  } catch (err) {
    console.error(`[ERROR] Failed to send prefix prompt: ${err.message}`);
  }
}

export function getCurrentPrefixForBot(botUid) {
  const fallbackCommand = readJsonSafe(defaultCommand, { prefix: "!" });
  const botInfoPath = path.join(botsDir, `${botUid}.json`);
  const botConfig = readJsonSafe(botInfoPath, {});
  const legacyCommandFilePath = botConfig.commandFilePath
    ? path.join(projectRoot, botConfig.commandFilePath)
    : defaultCommand;
  const runtimeCommandFilePath = createBotRuntimeContext({ uid: botUid }).commandConfigPath;
  const commandConfig = readJsonSafe(
    runtimeCommandFilePath,
    readJsonSafe(legacyCommandFilePath, fallbackCommand),
  );
  const prefix = String(commandConfig.prefix || fallbackCommand.prefix || "!").trim();
  return prefix || "!";
}

export async function applyPrefixToBot(botUid, newPrefix) {
  const sanitized = String(newPrefix || "").trim();
  if (!sanitized || sanitized.length === 0) {
    throw new Error("Prefix không được rỗng");
  }
  if (!isValidPrefix(sanitized)) {
    throw new Error("Prefix không hợp lệ. Chỉ chấp nhận 1-3 ký hiệu lệnh như !, ?, ., /, #, $, %, &, *, -, _, +");
  }

  const botInfoPath = path.join(botsDir, `${botUid}.json`);
  if (!fs.existsSync(botInfoPath)) {
    throw new Error(`Không tìm thấy config bot ${botUid}`);
  }
  const botConfig = JSON.parse(fs.readFileSync(botInfoPath, "utf8").replace(/^\uFEFF/, ""));
  const commandFilePath = path.join(projectRoot, botConfig.commandFilePath);
  if (!fs.existsSync(commandFilePath)) {
    throw new Error(`Không tìm thấy file command của bot ${botUid}`);
  }
  const runtimeCommandFilePath = createBotRuntimeContext({ uid: botUid }).commandConfigPath;
  if (!fs.existsSync(runtimeCommandFilePath)) {
    fs.mkdirSync(path.dirname(runtimeCommandFilePath), { recursive: true });
    fs.copyFileSync(commandFilePath, runtimeCommandFilePath);
  }
  updateCommandPrefixFile(runtimeCommandFilePath, sanitized);
  if (path.resolve(runtimeCommandFilePath) !== path.resolve(commandFilePath)) {
    updateCommandPrefixFile(commandFilePath, sanitized);
  }
  return sanitized;
}

export const persistBotPrefix = applyPrefixToBot;

export async function createAllRequiredFilesWithCredentials(uidFrom, credentialsData, botConfig, transaction = null, customRoot = null) {
  const write = (file, data) => transaction?.writeJson ? transaction.writeJson(file, data) : writeJsonAtomic(file, data);
  if (uidFrom !== "admin" && credentialsLookLikeAdmin(credentialsData)) {
    throw new Error(`Credential mới của bot ${uidFrom} trùng session admin; dừng tạo bot con để tránh đá session bot chính.`);
  }
  const root = customRoot || getProjectRoot();
  const runtimeContext = createBotRuntimeContext({ uid: uidFrom, ...botConfig });
  if (customRoot) {
    const originalRoot = runtimeContext.projectRoot;
    for (const [key, value] of Object.entries(runtimeContext)) {
      if (typeof value === "string" && path.isAbsolute(value) && !path.relative(originalRoot, value).startsWith("..")) runtimeContext[key] = path.join(root, path.relative(originalRoot, value));
    }
    runtimeContext.projectRoot = root;
  }
  const myBotDirPath = path.join(root, "mybot");
  const legacyAdminFilePath = path.join(root, botConfig.adminFilePath);
  const runtimeAdminFilePath = runtimeContext.adminListPath;
  const isChild = uidFrom && String(uidFrom).trim().toLowerCase() !== "admin";

  let finalAdmins = [];
  if (isChild) {
    // Child bot: initialize the admin list with the bot's own UID ONLY.
    // The owner/creator UID from the Main session (credentialsData.uid / uidFrom)
    // is NOT a valid local UID in this child session and must never be copied
    // into the child's admin list. Supreme Admins (owner, main bot) are resolved
    // through the child's own session after login by canonical username.
    // If a verified local admin list already exists (from a prior session
    // resolution), keep it.
    if (runtimeAdminFilePath && fs.existsSync(runtimeAdminFilePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(runtimeAdminFilePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existing) && existing.length > 0) {
          finalAdmins = existing.map(String).map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== "admin");
        }
      } catch {}
    }
    if (finalAdmins.length === 0) {
      finalAdmins = [String(credentialsData.accountUid || uidFrom).trim()].filter((s) => s && s.toLowerCase() !== "admin");
    }
  } else {
    const initialAdmins = getInitialAdminList(uidFrom, root);
    const mergedAdminSet = new Set(initialAdmins);

    if (fs.existsSync(legacyAdminFilePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(legacyAdminFilePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existing)) {
          for (const item of existing) {
            const uid = String(item).trim();
            if (uid && uid.toLowerCase() !== "admin") mergedAdminSet.add(uid);
          }
        }
      } catch {}
    }

    if (runtimeAdminFilePath && fs.existsSync(runtimeAdminFilePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(runtimeAdminFilePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existing)) {
          for (const item of existing) {
            const uid = String(item).trim();
            if (uid && uid.toLowerCase() !== "admin") mergedAdminSet.add(uid);
          }
        }
      } catch {}
    }

    finalAdmins = Array.from(mergedAdminSet).filter(Boolean);
  }

  const requiredDirs = [
    path.join(myBotDirPath, "credentials"),
    path.join(myBotDirPath, "configs"),
    path.join(myBotDirPath, "settings"),
    path.join(myBotDirPath, "json-data"),
    path.join(myBotDirPath, "bots"),
    path.join(root, "logs", uidFrom),
    path.join(root, "assets", "resources", uidFrom),
    path.join(root, "assets", "temp", uidFrom),
    path.join(root, "assets", "resources", "gif", uidFrom),
    runtimeContext.workspaceRoot,
    runtimeContext.dataDir,
    runtimeContext.logsDir,
    runtimeContext.tempDir,
    runtimeContext.resourcesDir,
  ];

  requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  const fileMap = {
    [path.join(root, botConfig.configFilePath)]: credentialsData,
    [path.join(root, botConfig.groupSettingsPath)]: {},
    [legacyAdminFilePath]: finalAdmins,
    [runtimeAdminFilePath]: finalAdmins,
    [runtimeContext.groupSettingsPath]: {},
    [path.join(root, botConfig.MANAGER_FILE_PATH)]: {
      "groupRequiredReset": "-1",
      "onGamePrivate": false,
      "onBotPrivate": false
    },
    [path.join(root, botConfig.DATA_GAME_FILE_PATH)]: {},
    [path.join(root, botConfig.PROPHYLACTIC_CONFIG_PATH)]: {
      "prophylacticUploadAttachment": {
        "enable": false,
        "lastBlocked": Date.now(),
        "numRequestZalo": 1,
        "lastRequestTime": Date.now()
      }
    },
    [path.join(root, botConfig.WEB_CONFIG_PATH)]: {
      selectedGroups: {},
      selectedFriends: {},
      privateEnabled: true,
      groupEnabled: true,
      prObjects: []
    },
    [path.join(root, botConfig.databaseFile)]: {
      "nameServer": "Thanh Hung",
      "host": "localhost",
      "user": "root",
      "password": "",
      "database": uidFrom === "admin" ? "nthdz" : `${uidFrom}`,
      "port": 3306,
      "tablePlayerZalo": "players_zalo",
      "tableAccount": "account",
      "dailyReward": 100000000000
    },
    [path.join(root, botConfig.dataTrainingPath)]: {},
    [path.join(root, botConfig.rankInfoPath)]: {}
  };

  for (const [filePath, data] of Object.entries(fileMap)) {
    try {
      if (filePath === path.join(root, botConfig.configFilePath) || !fs.existsSync(filePath)) {
        write(filePath, data);
      }
    } catch (error) {
      throw new Error(`Không thể tạo file ${filePath}: ${error.message}`);
    }
  }

  const commandStateStub = JSON.stringify(createCommandSeedStub(), null, 2);
  const legacyCommandFilePath = path.join(root, botConfig.commandFilePath);
  try {
    fs.mkdirSync(path.dirname(legacyCommandFilePath), { recursive: true });
    if (!fs.existsSync(legacyCommandFilePath)) write(legacyCommandFilePath, JSON.parse(commandStateStub));
    if (!fs.existsSync(runtimeContext.commandConfigPath)) write(runtimeContext.commandConfigPath, JSON.parse(commandStateStub));
  } catch (error) {
    throw new Error(`Không thể tạo file command state cho bot: ${error.message}`);
  }

  const botConfigPath = path.join(myBotDirPath, "bots", `${uidFrom}.json`);
  try {
    if (!fs.existsSync(botConfigPath)) write(botConfigPath, botConfig);
  } catch (error) {
    throw new Error(`Không thể tạo file config bot: ${error.message}`);
  }
}

export async function initializeVerifiedBotFiles({ root, botKey, credential, record, txn, prefix = "!" }) {
  const botConfig = createBotConfig(botKey, record.webPort);
  await createAllRequiredFilesWithCredentials(botKey, credential, botConfig, txn, root);
  const profile = createDefaultProfile(botKey, { ...record, nameServer: record.displayName, enabled: true, trialStatus: "pending", expiryAt: null, identityPending: false, accountIdentityStatus: "verified", adminBindingStatus: "pending" });
  if (txn?.writeJson) txn.writeJson(getProfilePath(botKey, root), profile);
  else saveProfile(botKey, profile, { root });
  if (prefix !== "!") {
    for (const file of [path.join(root, botConfig.commandFilePath), path.join(root, "mybot", "instances", botKey, "data", "command.json")]) {
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      if (txn?.writeJson) txn.writeJson(file, { ...config, prefix });
      else writeJsonAtomic(file, { ...config, prefix });
    }
  }
}
