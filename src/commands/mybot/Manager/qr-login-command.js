import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
import {
  startBotWithLauncher, checkPM2Status,
  checkExistingBot, createBotConfig,
  getAvailablePort, createAllRequiredFiles,
  ensureDirectoriesExist,
  checkSpawnedProcessStatus, waitForIdentityHandshake, writeCredentialOnly, credentialsLookLikeAdmin
} from "../System/pm2-manager.js";
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
import { dedupeMyBotsRegistry, loadMyBotsRegistry, saveMyBotsRegistry } from "../System/mybots-registry.js";
import { waitForAdminReady } from "./qr-login-admin-readiness.js";
import {
  QR_LOGIN_EXPIRY_REASON,
} from "../../../utils/qr-login-expiry.js";
import { startQrLoginCountdown } from "../../../utils/qr-login-countdown.js";
import { getZaloCookiePayload, getZaloRuntimeConfig } from "../../../api-zalo/zalo-config.js";
import { createDefaultProfile, saveProfile, updateProfile } from "../System/mybot-profile-service.js";
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
import {
  withMyBotsTransaction,
  acquireActualUidLock,
} from "./qr-provisioning-registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../../..");
const myBotDir = path.join(projectRoot, "mybot");
const myBotsPath = path.join(myBotDir, "mybots.json");
const defaultCommand = path.join(myBotDir, "defaultCommand.json");
const botsDir = path.join(myBotDir, "bots");
const adminListPath = path.join(projectRoot, "assets", "json-data", "list_admin.json");
const adminStatePath = path.join(myBotDir, "state", "admin.json");
const launcherPath = path.join(projectRoot, "index.js");
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

async function runQrBootstrap(sessionId, credentialsData) {
  const bootstrapId = `qr-bootstrap-${sessionId}`;
  const bootstrapConfig = createBotConfig(bootstrapId, 0);
  const credentialPath = path.join(projectRoot, "mybot", "credentials", `${bootstrapId}.json`);
  const configPath = path.join(projectRoot, "mybot", "bots", `${bootstrapId}.json`);
  await ensureDirectoriesExist();
  writeJsonAtomic(credentialPath, credentialsData);
  writeJsonAtomic(configPath, {
    ...bootstrapConfig,
    name: bootstrapId,
    configFilePath: path.relative(projectRoot, credentialPath).replace(/\\/g, "/"),
  });
  try {
    const started = await startBotWithLauncher(bootstrapId, {
      botName: bootstrapId,
      configPath,
      skipHealthCheck: true,
      env: {
        QR_BOOTSTRAP_SESSION: sessionId,
        QR_BOOTSTRAP_ONLY: "true",
      },
    });
    if (!started || (started.success === false)) {
      throw new Error("Không khởi động được QR bootstrap process.");
    }
    return await waitForIdentityHandshake(sessionId, 30000);
  } finally {
    try {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } catch {}
    try {
      if (fs.existsSync(credentialPath)) fs.unlinkSync(credentialPath);
    } catch {}
  }
}

async function waitForReloadReady(uid, requestId, timeoutMs = 30000) {
  const reloadPath = path.join(projectRoot, "mybot", "state", "reload", `${uid}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = readJsonSafe(reloadPath, {});
    if (state.requestId === requestId && ["ready", "failed"].includes(state.status)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { uid, requestId, status: "failed", error: "reload timeout" };
}

export async function handleQrLogin(api, message, threadId, type, isAdminLevelHighest) {
  const { data: { dName, uidFrom } } = message;
  const qrSessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let qrPath = path.join(process.cwd(), ".cache", `qr_code-${qrSessionId}.png`);
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

    const [code, updatedSession, qrMeta] = await generateQRCode(zaloSession, {
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
    console.log(`[DEBUG] Waiting for scan for session: ${code}`);
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
    console.log(`[DEBUG] Waiting for confirmation for session: ${code}`);
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

    const baseCredentialsData = {
      cookie: getZaloCookiePayload(rawCookies, ZALO_RUNTIME),
      imei: confirmData.imei || "unknown",
      userAgent: ZALO_RUNTIME.userAgent,
    };

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

    const actualUid = handshake.uid;
    const scannedName = sanitizeInput(handshake.displayName || handshake.name || dName);
    const selfUsername = normalizeUsername(handshake.canonicalUsername || handshake.zaloUsername || handshake.username || "");
    const resultData = {
      imei: handshake.imei || baseCredentialsData.imei,
      name: scannedName,
      avatar: handshake.avatar || "",
      username: selfUsername || "",
      canonicalUsername: selfUsername || "",
    };

    // ---- 8. Admin bot check ----
    const adminConfigPath = path.join(projectRoot, "assets", "config.json");
    if (fs.existsSync(adminConfigPath)) {
      try {
        const adminConfig = JSON.parse(fs.readFileSync(adminConfigPath, "utf8").replace(/^\uFEFF/, ""));
        const adminUid = adminConfig.uid || adminConfig.userId || adminConfig.id;
        if (adminUid && String(actualUid).trim() === String(adminUid).trim()) {
          console.error(`[BLOCKED] QR login account ${actualUid} matches main admin bot account ${adminUid}`);
          await sendMessageWarning(
            api,
            message,
            `Không thể tạo bot! Tài khoản Zalo này (${scannedName}) chính là tài khoản của Main Bot. Vui lòng dùng tài khoản Zalo khác!`,
            true,
            false
          );
          return;
        }
      } catch (adminCheckErr) {
        console.error(`[WARN] Failed to check admin config: ${adminCheckErr.message}`);
      }
    }

    // ---- 9. Owner/re-ownership check (serialized by actualUid) ----
    if (!isAdminLevelHighest && actualUid !== uidFrom) {
      const allBots = loadMyBotsRegistry();
      const botRecord = allBots[actualUid];
      if (botRecord && botRecord.ownerUid && botRecord.ownerUid !== uidFrom) {
        await sendMessageWarning(
          api,
          message,
          `Tài khoản Zalo này (${scannedName}) đã được sử dụng bởi bot "${botRecord.name || actualUid}". Mỗi tài khoản chỉ được tạo 1 bot!`,
          true,
          false
        );
        return;
      }
    }

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

    // ---- 10. Safe provisioning: file-locked registry transaction ----
    const existingCheck = await checkExistingBot(actualUid);
    if (existingCheck.exists) {
      const currentBots = loadMyBotsRegistry();
      const existingBot = currentBots[actualUid];
      const pm2Status = await checkPM2Status(actualUid);
      const spawnedStatus = await checkSpawnedProcessStatus(actualUid);
      const isRunning = Boolean(pm2Status.running || spawnedStatus.running || (existingBot && existingBot.status === "running"));

      if (isRunning) {
        // Existing bot is running: only write new credentials to disk
        const credentialPath = path.join(projectRoot, "mybot", "credentials", `${actualUid}.json`);
        await writeCredentialOnly(actualUid, baseCredentialsData);

        const registry = loadMyBotsRegistry();
        const existingRecord = registry[actualUid] || existingBot || {};
        const verifiedOwner = existingRecord.ownerUid || existingRecord.createdByUid;
        const ownerUid = verifiedOwner || uidFrom;
        const createdByUid = existingRecord.createdByUid || verifiedOwner || uidFrom;

        registry[actualUid] = {
          ...existingRecord,
          displayName: scannedName,
          avatar: resultData.avatar || "",
          ownerUid,
          createdByUid,
          status: "running",
          lastUpdated: new Date().toISOString(),
          cookieUpdatedAt: new Date().toISOString(),
          ...(selfUsername ? { zaloUsername: selfUsername, canonicalUsername: selfUsername } : {}),
        };
        saveMyBotsRegistry(registry);

        await sendMessageComplete(
          api,
          message,
          `✅ Bot của ${scannedName} đã cập nhật cookie thành công!\n\n📌 Cookie mới sẽ có hiệu lực ở lần khởi động lại tiếp theo.`,
          true,
          false
        );
        return;
      }

      // Existing bot is stopped: update credentials and files, keep stopped
      const botConfig = createBotConfig(actualUid, existingBot?.webPort || getAvailablePort());
      const credentialsData = {
        cookie: getZaloCookiePayload(rawCookies, ZALO_RUNTIME),
        imei: resultData.imei,
        name: resultData.name || scannedName,
        avatar: resultData.avatar || "",
        userAgent: ZALO_RUNTIME.userAgent,
        uid: uidFrom,
      };
      await createAllRequiredFilesWithCredentials(actualUid, credentialsData, botConfig);

      const identityPending = false;
      const identityPendingReason = null;

      const existingRecord = existingBot || {};
      const verifiedOwner = existingRecord.ownerUid || existingRecord.createdByUid;
      const ownerUid = verifiedOwner || uidFrom;
      const createdByUid = existingRecord.createdByUid || verifiedOwner || uidFrom;

      updateProfile(actualUid, {
        ownerUid,
        createdByUid,
        ownerName: existingRecord.ownerName || dName,
        ownerUsername: ownerUsername || existingRecord?.ownerUsername || null,
        nameServer: scannedName,
        adminIdentitySeeds: seedValidation.valid ? seedValidation.normalized : (adminIdentitySeeds || null),
        identityPending,
        identityPendingReason,
      }, { root: projectRoot, actor: uidFrom });

      const registry = loadMyBotsRegistry();
      registry[actualUid] = {
        ...(registry[actualUid] || existingRecord),
        displayName: scannedName,
        avatar: resultData.avatar || "",
        ownerUid,
        createdByUid,
        ownerName: existingRecord.ownerName || dName,
        ownerUsername: ownerUsername || existingRecord?.ownerUsername || null,
        status: "stopped",
        lastUpdated: new Date().toISOString(),
        cookieUpdatedAt: new Date().toISOString(),
        ...(selfUsername ? { zaloUsername: selfUsername, canonicalUsername: selfUsername } : {}),
        adminIdentitySeeds: seedValidation.valid ? seedValidation.normalized : (adminIdentitySeeds || null),
        identityPending,
        identityPendingReason,
      };
      saveMyBotsRegistry(registry);

      await sendMessageComplete(
        api,
        message,
        `✅ Bot của ${scannedName} đã được cập nhật thông tin thành công!\n\n📊 Trạng thái: Tạm dừng (stopped)\n👉 Dùng lệnh: !mybot active để kích hoạt dùng thử 1 giờ.`,
        true,
        false
      );
      await promptForPrefix(api, message, actualUid, uidFrom, threadId);
      return;
    }

    // Brand new bot: use file-locked provisioning transaction
    if (seedValidation.missing.length > 0 || seedValidation.errors.length > 0) {
      const seedReasons = seedValidation.missing.length > 0
        ? `thiếu ${seedValidation.missing.join(", ")}`
        : (seedValidation.errors || []).join("; ");
      console.warn(`[QR] Bot ${actualUid} tạo thành công nhưng identity seeds chưa đầy đủ (${seedReasons}). Bot UID + owner UID sẽ tự động được ghi làm Admin Tối Cao.`);
    }

    await ensureDirectoriesExist();

    // Use the safe provisioning registry with file locking
    await acquireActualUidLock({ root: projectRoot, actualUid }, async () => {
      await withMyBotsTransaction({ root: projectRoot, registryPath: myBotsPath }, async (txn) => {
        const webPort = parseInt(txn.reserveProvisionedBot({
          uid: actualUid,
          displayName: scannedName,
          ownerUid: uidFrom,
          createdByUid: uidFrom,
          ownerName: dName,
          ownerUsername,
          zaloUsername: selfUsername,
          canonicalUsername: selfUsername,
        }).webPort, 10);

        const botConfig = createBotConfig(actualUid, webPort);

        const credentialsData = {
          cookie: getZaloCookiePayload(rawCookies, ZALO_RUNTIME),
          imei: resultData.imei,
          name: resultData.name || scannedName,
          avatar: resultData.avatar || "",
          userAgent: ZALO_RUNTIME.userAgent,
          uid: uidFrom,
        };

        await createAllRequiredFilesWithCredentials(actualUid, credentialsData, botConfig);
        dedupeMyBotsRegistry({ removeAliasFiles: true });

        // Save Profile
        const initialProfile = createDefaultProfile(actualUid, {
          ownerUid: uidFrom,
          createdByUid: uidFrom,
          ownerName: dName,
          ownerUsername,
          nameServer: scannedName,
          expiryAt: null,
          trialStatus: "pending",
          enabled: true,
          adminIdentitySeeds: seedValidation.normalized,
          identityPending: false,
          identityPendingReason: null,
        });
        saveProfile(actualUid, initialProfile, { root: projectRoot, actor: uidFrom });

        // Finalize registry: from "provisioning" to "stopped"
        txn.finalizeProvisionedBot(actualUid, {
          status: "stopped",
          displayName: scannedName,
          avatar: resultData.avatar || "",
          ownerUid: uidFrom,
          createdByUid: uidFrom,
          ownerName: dName,
          ownerUsername,
          createdBy: dName,
          zaloUsername: selfUsername,
          canonicalUsername: selfUsername,
          adminIdentitySeeds: seedValidation.normalized,
          identityPending: false,
          identityPendingReason: null,
          trialStatus: "pending",
        });

        // Commit quota
        commitCreationQuota(uidFrom, actualUid, { projectRoot, requestId: qrSessionId });
      });
    });

    await sendMessageComplete(
      api,
      message,
      `✅ Bot của ${scannedName} đã được khởi tạo thành công!\n\n👤 Người tạo: ${dName}\n🤖 Tên BOT: ${scannedName}\n📊 Trạng thái: Tạm dừng (stopped)\n⏳ Thời gian dùng thử: 1 giờ (bắt đầu sau khi kích hoạt thành công lần đầu)\n\n👉 Dùng lệnh: !mybot active để kích hoạt dùng thử 1 giờ.`,
      true,
      false
    );
    console.log(`Bot con "${actualUid}" đã được khởi tạo thành công bởi ${dName} (status: stopped, trial: pending)`);
    await promptForPrefix(api, message, actualUid, uidFrom, threadId);
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

export async function createAllRequiredFilesWithCredentials(uidFrom, credentialsData, botConfig) {
  if (uidFrom !== "admin" && credentialsLookLikeAdmin(credentialsData)) {
    throw new Error(`Credential mới của bot ${uidFrom} trùng session admin; dừng tạo bot con để tránh đá session bot chính.`);
  }
  const root = getProjectRoot();
  const runtimeContext = createBotRuntimeContext({ uid: uidFrom, ...botConfig });
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
      finalAdmins = [String(uidFrom).trim()].filter((s) => s && s.toLowerCase() !== "admin");
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
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      throw new Error(`Không thể tạo file ${filePath}: ${error.message}`);
    }
  }

  const commandStateStub = JSON.stringify(createCommandSeedStub(), null, 2);
  const legacyCommandFilePath = path.join(root, botConfig.commandFilePath);
  try {
    fs.mkdirSync(path.dirname(legacyCommandFilePath), { recursive: true });
    fs.writeFileSync(legacyCommandFilePath, commandStateStub);
    fs.writeFileSync(runtimeContext.commandConfigPath, commandStateStub);
  } catch (error) {
    throw new Error(`Không thể tạo file command state cho bot: ${error.message}`);
  }

  const botConfigPath = path.join(myBotDirPath, "bots", `${uidFrom}.json`);
  try {
    fs.writeFileSync(botConfigPath, JSON.stringify(botConfig, null, 4));
  } catch (error) {
    throw new Error(`Không thể tạo file config bot: ${error.message}`);
  }
}
