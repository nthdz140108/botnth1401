import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { writeGroupSettings, readGroupSettings } from "../../utils/io-json.js";
import {
  sendMessageComplete,
  sendMessageInsufficientAuthority,
  sendMessageQuery,
  sendMessageWarning,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { createAdminListImage } from "../../utils/canvas/listadmin-canvas.js";
import { resolveUserProfile } from "../../service-debug/info-service/user-info-data.js";
import { getBotInfo, getBotInfoSync, getProjectRoot } from "../../utils/env.js";
import { appContext } from "../../api-zalo/context.js";
import { createBotRuntimeContext, getInitialAdminList } from "../../utils/bot-runtime-context.js";
import { parseAdminCommand as parseAdminCommandCore } from "../../utils/admin-command-parser.js";
import {
  addHighAdminViaCommand,
  removeHighAdminViaCommand,
  mutateBotAdmin,
  mutateChildHighAdmin,
  mutateBoxAdmin,
  readListFromFile,
} from "../../utils/admin-role-store.js";
import {
  listInstanceSupremeAdmins,
  readMainInstanceAdminUids,
  resolveInstanceAuthorization,
  resolveMainBotUid,
  AUTH_SOURCES,
} from "../../utils/instance-authorization.js";

function getBotId() {
  return appContext.uid || "";
}

/**
 * Atomic write helper to prevent corrupted JSON writes
 */
async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

/**
 * Resolve the canonical global admin list file path for the active bot
 */
export async function resolveAdminListPath(runtimePath, botUid) {
  if (runtimePath && typeof runtimePath === "string") {
    return runtimePath;
  }
  const botInfo = botUid || (await getBotInfo()) || getBotInfoSync() || {};
  const runtimeCtx = createBotRuntimeContext(botInfo);
  return runtimeCtx.adminListPath;
}

/**
 * Legacy helper kept for backward compatibility: reads (never writes) a list file.
 */
export async function loadGlobalAdmins(adminFilePath, botUid) {
  let admins = [];
  try {
    if (adminFilePath && fsSync.existsSync(adminFilePath)) {
      const data = await fs.readFile(adminFilePath, "utf8");
      const parsed = JSON.parse(data.replace(/^\uFEFF/, ""));
      if (Array.isArray(parsed)) {
        admins = parsed.map((id) => String(id).trim()).filter((id) => id.length > 0);
      }
    }
  } catch (error) {
    console.error(`Lỗi khi đọc ${adminFilePath}:`, error.message);
  }
  if (admins.length === 0) {
    const resolvedBotUid = botUid || appContext.uid || getBotId();
    admins = getInitialAdminList(resolvedBotUid, getProjectRoot()).map((id) => String(id).trim()).filter(Boolean);
  }
  return admins;
}

export function parseAdminCommand(rawContent, prefix = "!", message = {}, scope = "group") {
  return parseAdminCommandCore(rawContent, prefix, message, scope);
}

const TIER_LABELS = Object.freeze({
  high: "Quản trị Tối cao",
  bot: "Quản trị Bot đa-nhóm",
  box: "Quản trị Nhóm",
});

async function buildStoragePaths({ projectRoot, botUid, context }) {
  const direct = context.overrides || {};
  return {
    highFilePath: context.runtimeHighFilePath || context.highFilePath || direct.highFilePath,
    highCommandPath: context.runtimeHighCommandPath || context.highCommandPath || direct.highCommandPath,
    botAdminsPath: await resolveAdminListPath(
      context.runtimeAdminListPath || context.botAdminsPath || direct.botAdminsPath,
      botUid
    ),
  };
}

async function sendDeny(api, message, text) {
  await sendMessageInsufficientAuthority(api, message, text);
}

export async function executeAdminCommand(context = {}) {
  const {
    api,
    message,
    groupSettings = {},
    scope = "group",
    botUid = null,
    auditPath = null,
    instanceKind: explicitInstanceKind,
  } = context;

  const prefix = getGlobalPrefix();
  const rawContent = message?.data?.content || "";
  const senderId = String(message?.data?.uidFrom || "");
  const threadId = message?.threadId || "";
  const isPrivate = scope === "private" || message?.type === 0;

  const currentBotUid = String(botUid || appContext.uid || getBotId() || "");
  const projectRoot = context.projectRoot || getProjectRoot();
  const overrides = await buildStoragePaths({ projectRoot, botUid: currentBotUid, context });
  const effectiveAuditPath = auditPath || path.join(projectRoot, "logs", "admin-role-audit.jsonl");
  const persistFns = {
    readGroupSettings: context.persistReadGroupSettings || readGroupSettings,
    writeGroupSettings: context.persistWriteGroupSettings || writeGroupSettings,
  };

  // Without an explicit kind (legacy callers/tests) fall back to main-instance
  // semantics so display and permissions stay identical to the legacy behaviour.
  const instanceKind = String(explicitInstanceKind || "").trim() === "child"
    ? "child"
    : "main";

  const authorizationSnapshot = resolveInstanceAuthorization({
    senderId,
    threadId: isPrivate ? "" : threadId,
    instanceUid: currentBotUid,
    instanceKind,
    mainBotUid: context.mainBotUid,
    groupSettings,
    projectRoot,
    overrides,
  });
  const isCallerHigh = authorizationSnapshot.isAdminLevelHigh;
  const isCallerAtLeastBot = authorizationSnapshot.isBotAdmin;

  const parsed = parseAdminCommand(rawContent, prefix, message, scope);

  if (parsed.action === "guide" || parsed.action === "unknown") {
    if (parsed.action === "unknown") {
      await sendMessageWarning(
        api,
        message,
        `Không tồn tại lệnh "${prefix}admin ${parsed.subcommand || ""}". Dùng "${prefix}admin" để xem hướng dẫn.`,
        true,
        false
      );
      return true;
    }
    const guideMessage = [
      "📌 HƯỚNG DẪN QUẢN LÝ ADMIN",
      `- ${prefix}admin list: Xem danh sách admin.`,
      `- ${prefix}admin add @user|UID: Thêm admin bot đa-nhóm (chỉ admin tối cao).`,
      `- ${prefix}admin remove @user|UID: Xóa admin bot đa-nhóm (chỉ admin tối cao).`,
      `- ${prefix}admin add box @user|UID: Thêm quản trị nhóm này (admin trở lên).`,
      `- ${prefix}admin remove box @user|UID: Xóa quản trị nhóm này (admin trở lên).`,
      `- ${prefix}admin add qtv @user|UID: Thêm quản trị tối cao nguồn COMMAND.`,
      `- ${prefix}admin remove qtv @user|UID: Xóa quản trị tối cao nguồn COMMAND.`,
    ].join("\n");
    await api.sendMessage({ msg: guideMessage, quote: message }, threadId, message.type);
    return true;
  }

  // ============================ LIST ============================
  if (parsed.action === "list") {
    const supremeEntries = listInstanceSupremeAdmins({
      instanceUid: currentBotUid,
      instanceKind: authorizationSnapshot.instanceKind,
      mainBotUid: context.mainBotUid,
      projectRoot,
      overrides,
    });
    const allHighUids = supremeEntries.map((entry) => entry.uid);
    const sourceOf = (uid) => supremeEntries
      .filter((entry) => entry.uid === uid)
      .map((entry) => entry.source)
      .join("+");

    const botAdminUids = overrides.botAdminsPath ? readListFromFile(overrides.botAdminsPath) : [];
    const highUids = new Set(allHighUids);
    const botUidSet = new Set(botAdminUids.filter((uid) => uid !== currentBotUid && !highUids.has(uid)));
    const groupAdminEntries = (!isPrivate && threadId && groupSettings[threadId]?.adminList)
      ? Object.entries(groupSettings[threadId].adminList).filter(([uid]) => (
        uid !== currentBotUid && !highUids.has(uid) && !botUidSet.has(uid)
      ))
      : [];

    const profileUids = [...new Set([
      ...allHighUids,
      ...botAdminUids,
      ...groupAdminEntries.map(([uid]) => uid),
    ])];
    let profileInfo = { unchanged_profiles: {}, changed_profiles: {} };
    if (profileUids.length > 0 && typeof api?.getUserInfo === "function") {
      try {
        profileInfo = await api.getUserInfo(profileUids);
      } catch (error) {
        console.error("Lỗi khi lấy thông tin quản trị:", error.message);
      }
    }
    const groupNameOf = (uid) => groupSettings?.[threadId]?.adminList?.[uid];
    const profileOf = (uid) => resolveUserProfile(profileInfo, uid) || null;

    const listMainBotUid = resolveMainBotUid({ projectRoot });

    // Child bots often cannot resolve Zalo profiles for the main-bot/owner
    // UIDs (not friends). Resolve names and avatars from credentials, state, and registry.
    const accountNames = {};
    const accountAvatars = {};

    // 1. Read credentials directory for real Zalo account name & avatar
    for (const pUid of profileUids) {
      const credCandidates = [
        path.join(projectRoot, "mybot", "credentials", `${pUid}.json`),
        (listMainBotUid && pUid === listMainBotUid) || pUid === "admin"
          ? path.join(projectRoot, "mybot", "credentials", "admin.json")
          : null,
      ].filter(Boolean);

      for (const cPath of credCandidates) {
        try {
          if (fsSync.existsSync(cPath)) {
            const credData = JSON.parse(fsSync.readFileSync(cPath, "utf8").replace(/^\uFEFF/, ""));
            const credAvatar = credData?.userInfo?.avatar || credData?.avatar || credData?.photo || null;
            const credName = credData?.userInfo?.name || credData?.userInfo?.zaloName || credData?.displayName || credData?.name || null;
            if (credAvatar && !accountAvatars[pUid]) accountAvatars[pUid] = credAvatar;
            if (credName && !accountNames[pUid]) accountNames[pUid] = credName;
          }
        } catch {}
      }
    }

    // 2. Read state directory
    for (const pUid of profileUids) {
      const stateCandidates = [
        path.join(projectRoot, "mybot", "state", `${pUid}.json`),
        (listMainBotUid && pUid === listMainBotUid) || pUid === "admin"
          ? path.join(projectRoot, "mybot", "state", "admin.json")
          : null,
      ].filter(Boolean);

      for (const sPath of stateCandidates) {
        try {
          if (fsSync.existsSync(sPath)) {
            const stateData = JSON.parse(fsSync.readFileSync(sPath, "utf8").replace(/^\uFEFF/, ""));
            const sAvatar = stateData?.avatar || stateData?.avatarUrl || stateData?.photo || null;
            const sName = stateData?.displayName || stateData?.name || stateData?.zaloName || null;
            if (sAvatar && !accountAvatars[pUid]) accountAvatars[pUid] = sAvatar;
            if (sName && !accountNames[pUid]) accountNames[pUid] = sName;
          }
        } catch {}
      }
    }

    // 3. Read registry (mybot/mybots.json)
    try {
      const registryPath = path.join(projectRoot, "mybot", "mybots.json");
      if (fsSync.existsSync(registryPath)) {
        const registry = JSON.parse(fsSync.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
        for (const [key, entry] of Object.entries(registry || {})) {
          if (!entry || typeof entry !== "object") continue;
          const entryUid = String(entry.uid || key || "").trim();
          const entryName = String(entry.displayName || entry.name || "").trim();
          const entryAvatar = entry.avatar || entry.avatarUrl || entry.avatar_url || entry.photo || null;
          if (entryUid && entryUid.toLowerCase() !== "admin") {
            if (entryName && !accountNames[entryUid] && entryName !== "Admin Bot") accountNames[entryUid] = entryName;
            if (entryAvatar && !accountAvatars[entryUid]) accountAvatars[entryUid] = entryAvatar;
          }
        }
        if (registry.admin && typeof registry.admin === "object") {
          const adminUid = String(registry.admin.uid || "").trim();
          const adminAvatar = registry.admin.avatar || registry.admin.avatarUrl || registry.admin.avatar_url || registry.admin.photo || null;
          const adminName = registry.admin.displayName || registry.admin.name || registry.admin.zaloName || null;
          if (adminAvatar && adminUid && !accountAvatars[adminUid]) accountAvatars[adminUid] = adminAvatar;
          if (adminName && adminName !== "Admin Bot" && adminUid && !accountNames[adminUid]) accountNames[adminUid] = adminName;
        }
      }
    } catch {}

    // 4. Current running bot context
    if (currentBotUid) {
      const curAvatar = appContext.avatar || null;
      const curName = appContext.name || appContext.dName || null;
      if (curAvatar && !accountAvatars[currentBotUid]) accountAvatars[currentBotUid] = curAvatar;
      if (curName && !accountNames[currentBotUid]) accountNames[currentBotUid] = curName;
    }

    const SOURCE_LABELS = Object.freeze({
      "MAIN-BOT": "Main Bot",
      "SELF": "Bot này",
      "MAIN-ADMIN": "Admin chính",
      "FILE": "FILE",
      "COMMAND": "COMMAND",
    });
    const sourceLabelOf = (uid) => SOURCE_LABELS[sourceOf(uid)] || sourceOf(uid);
    const fallbackNameOf = (uid) =>
      accountNames[uid]
      || (listMainBotUid && uid === listMainBotUid ? "Bot Admin (Main Bot)" : "")
      || (currentBotUid && uid === currentBotUid ? "Bot này" : "")
      || "";
    const nameOf = (uid) =>
      profileOf(uid)?.zaloName
      || profileOf(uid)?.displayName
      || profileOf(uid)?.name
      || accountNames[uid]
      || groupNameOf(uid)
      || fallbackNameOf(uid)
      || uid;
    const avatarOf = (uid) => {
      const profile = profileOf(uid) || {};
      const direct = profile.avatar || profile.avatarUrl || profile.avatar_url || profile.photo || null;
      if (direct && typeof direct === "string" && direct.trim()) return direct.trim();
      if (accountAvatars[uid]) return accountAvatars[uid];
      return null;
    };

    const textLines = [
      "📋 DANH SÁCH QUẢN TRỊ VIÊN BOT",
      "━━━━━━━━━━━━━━━━━━",
      "👑 QUẢN TRỊ TỐI CAO:",
    ];
    if (allHighUids.length === 0) {
      textLines.push("  (Chưa có)");
    } else {
      allHighUids.forEach((uid, index) => {
        textLines.push(`  ${index + 1}. ${nameOf(uid)} (${uid}) - Quản trị Tối cao [${sourceLabelOf(uid)}]`);
      });
    }

    textLines.push("");
    textLines.push("🛡️ QUẢN TRỊ BOT ĐA-NHÓM:");
    if (botUidSet.size === 0) {
      textLines.push("  (Chưa có)");
    } else {
      [...botUidSet].forEach((uid, index) => {
        textLines.push(`  ${index + 1}. ${nameOf(uid)} (${uid}) - Quản trị Bot đa-nhóm`);
      });
    }

    if (!isPrivate) {
      textLines.push("");
      textLines.push("🏷️ QUẢN TRỊ NHÓM (adminBox):");
      if (groupAdminEntries.length === 0) {
        textLines.push("  (Chưa có)");
      } else {
        groupAdminEntries.forEach(([uid], index) => {
          textLines.push(`  ${index + 1}. ${nameOf(uid)} (${uid}) - Quản trị Nhóm`);
        });
      }
    } else {
      textLines.push("");
      textLines.push("(Danh sách quản trị nhóm chỉ xem được trong nhóm.)");
    }

    const listText = textLines.join("\n");

    const highAdmins = [
      ...allHighUids.map((uid) => ({
        id: uid,
        name: nameOf(uid),
        role: `Quản trị Tối cao [${sourceLabelOf(uid)}]`,
        avatar: avatarOf(uid),
      })),
    ];
    const botAdmins = [...botUidSet].map((uid) => ({
        id: uid,
        name: nameOf(uid),
        role: "Quản trị Bot đa-nhóm",
        avatar: avatarOf(uid),
      }));
    const groupAdmins = isPrivate ? [] : groupAdminEntries.map(([uid]) => ({
        id: uid,
        name: nameOf(uid),
        role: "Quản trị Nhóm",
        avatar: avatarOf(uid),
      }));

    let imagePath = null;
    try {
      const renderAdminListImage = context.createAdminListImage || createAdminListImage;
      if (typeof renderAdminListImage === "function" && (highAdmins.length || botAdmins.length || groupAdmins.length)) {
        imagePath = await renderAdminListImage({ highAdmins, botAdmins, groupAdmins, isPrivate });
      }
    } catch (err) {
      console.warn("Không thể tạo ảnh danh sách quản trị (dùng fallback text):", err.message);
      imagePath = null;
    }

    if (imagePath && fsSync.existsSync(imagePath)) {
      try {
        await api.sendMessage({ msg: listText, attachments: [imagePath], ttl: 600000 }, threadId, message.type);
        setTimeout(async () => {
          try {
            await fs.unlink(imagePath);
          } catch {}
        }, 30000);
        return true;
      } catch (sendError) {
        console.warn("Lỗi khi gửi kèm ảnh, chuyển sang gửi text thuần:", sendError.message);
      }
    }

    await api.sendMessage({ msg: listText, ttl: 600000 }, threadId, message.type);
    return true;
  }

  // ========================= ADD / REMOVE =========================
  const action = parsed.action;
  const tier = parsed.targetTier;

  if (parsed.targets.length === 0) {
    const syntaxHelp =
      tier === "high"
        ? `Vui lòng nhập UID: ${prefix}admin ${action} qtv <@user|UID>`
        : tier === "bot"
          ? `Vui lòng nhập UID: ${prefix}admin ${action} <@user|UID>`
          : `Vui lòng đề cập (@mention) hoặc nhập UID: ${prefix}admin ${action} box <@user|UID>`;
    await sendMessageQuery(api, message, syntaxHelp);
    return true;
  }

  if (tier === "box") {
    if (isPrivate) {
      await sendDeny(api, message, 'Lệnh "box" chỉ dùng trong nhóm. Hãy vào nhóm cần cấp quyền rồi dùng lại.');
      return true;
    }
    if (!isCallerAtLeastBot) {
      await sendDeny(api, message, "Chỉ quản trị bot trở lên mới được quản lý adminBox của nhóm này!");
      return true;
    }

    for (const target of parsed.targets) {
      const targetId = String(target.uid).trim();
      const targetName = target.name || targetId;
      try {
        const result = await mutateBoxAdmin({
          uid: targetId,
          mode: action,
          actorId: senderId,
          botUid: currentBotUid,
          threadId,
          groupSettings,
          auditPath: effectiveAuditPath,
          persist: persistFns,
        });
        if (result.changed) {
          await sendMessageComplete(
            api,
            message,
            action === "add"
              ? `Đã thêm ${targetName} (${targetId}) làm quản trị nhóm này.`
              : `Đã xóa ${targetName} (${targetId}) khỏi quản trị nhóm này.`,
          );
        } else {
          await sendMessageWarning(
            api,
            message,
            action === "add"
              ? `${targetName} (${targetId}) đã có trong danh sách quản trị nhóm này.`
              : `${targetName} (${targetId}) không có trong danh sách quản trị nhóm này.`,
          );
        }
      } catch (error) {
        console.error("[admin] box mutation failed:", error.code || error.message);
        await sendMessageWarning(api, message, `Thao tác thất bại, đã phục hồi dữ liệu gốc. (${error.code || "ERROR"})`);
      }
    }
    return true;
  }

  const listMainBotUid = resolveMainBotUid({ projectRoot });

  if (tier === "bot") {
    if (!isCallerHigh) {
      await sendDeny(api, message, "Chỉ quản trị viên tối cao mới được thêm/xóa admin bot đa-nhóm!");
      return true;
    }

    for (const target of parsed.targets) {
      const targetId = String(target.uid).trim();
      const targetName = target.name || targetId;
      if (targetId === currentBotUid) {
        await sendMessageWarning(api, message, "Không thể thao tác trên UID của chính bot!");
        continue;
      }
      if (instanceKind === "child" && targetId === listMainBotUid) {
        if (action === "add") {
          await sendMessageComplete(api, message, `Bot Admin (${targetName}) đã có quyền Quản trị Tối cao mặc định trên bot con rồi!`);
        } else {
          await sendMessageWarning(api, message, `Không thể xóa Quản trị Tối cao mặc định (${targetName}) của bot con!`);
        }
        continue;
      }
      try {
        const result = await mutateBotAdmin({
          uid: targetId,
          mode: action,
          actorId: senderId,
          botUid: currentBotUid,
          threadId,
          projectRoot,
          auditPath: effectiveAuditPath,
          overrides,
        });
        if (result.changed) {
          if (action === "remove") {
            // Re-run authorization resolution for the target AFTER removal. If
            // the target still holds a HIGHER privilege from another source
            // (FILE / COMMAND high, or a child supreme admin assignment), tell
            // the caller which source remains effective instead of implying
            // the target lost all privileges.
            const targetAuth = resolveInstanceAuthorization({
              senderId: targetId,
              threadId: isPrivate ? "" : threadId,
              instanceUid: currentBotUid,
              instanceKind,
              mainBotUid: context.mainBotUid,
              groupSettings,
              projectRoot,
              overrides,
            });
            if (targetAuth.role === "adminLevelHigh") {
              await sendMessageWarning(
                api,
                message,
                `Đã xóa ${targetName} (${targetId}) khỏi admin bot đa-nhóm, nhưng UID vẫn còn quyền Tối cao từ nguồn khác (${targetAuth.source}).`,
              );
            } else {
              await sendMessageComplete(
                api,
                message,
                `Đã xóa ${targetName} (${targetId}) khỏi admin bot đa-nhóm của bot hiện tại.`,
              );
            }
          } else {
            await sendMessageComplete(
              api,
              message,
              `Đã thêm ${targetName} (${targetId}) làm admin bot đa-nhóm của bot hiện tại.`,
            );
          }
        } else {
          await sendMessageWarning(
            api,
            message,
            action === "add"
              ? `${targetName} (${targetId}) đã là admin bot đa-nhóm.`
              : `${targetName} (${targetId}) không phải admin bot đa-nhóm.`,
          );
        }
      } catch (error) {
        console.error("[admin] bot mutation failed:", error.code || error.message);
        await sendMessageWarning(api, message, `Thao tác thất bại, đã phục hồi dữ liệu gốc. (${error.code || "ERROR"})`);
      }
    }
    return true;
  }

  // tier === "high" (nguồn COMMAND — quản trị tối cao nguồn COMMAND)
  // Matrix: chỉ admin tối cao nguồn FILE mới được thêm/xóa admin tối cao nguồn
  // COMMAND trên MAIN bot. Admin tối cao nguồn COMMAND KHÔNG được quản lý cùng
  // cấp. Trên bot con, lệnh qtv quản lý danh sách admin-high RIÊNG của bot con
  // (người vận hành chính luôn được phép), nên giới hạn này chỉ áp dụng cho main.
  const callerSource = authorizationSnapshot.source;
  const callerIsCommandHigh = isCallerHigh && callerSource === AUTH_SOURCES.GLOBAL_HIGH_COMMAND;
  if (!isCallerHigh) {
    await sendDeny(api, message, "Chỉ quản trị viên tối cao mới được sử dụng lệnh này!");
    return true;
  }
  if (instanceKind !== "child" && callerIsCommandHigh) {
    await sendDeny(api, message, "Admin tối cao nguồn COMMAND không được phép quản lý cùng cấp (chỉ admin tối cao nguồn FILE).");
    return true;
  }

  for (const target of parsed.targets) {
    const targetId = String(target.uid).trim();
    const targetName = target.name || targetId;
    if (targetId === currentBotUid) {
      await sendMessageWarning(api, message, "Không thể thao tác trên UID của chính bot!");
      continue;
    }
    if (instanceKind === "child" && targetId === listMainBotUid) {
      if (action === "add") {
        await sendMessageComplete(api, message, `Bot Admin (${targetName}) đã có quyền Quản trị Tối cao mặc định trên bot con rồi!`);
      } else {
        await sendMessageWarning(api, message, `Không thể xóa Quản trị Tối cao mặc định (${targetName}) của bot con!`);
      }
      continue;
    }

    // ON CHILD BOT: !admin add/remove qtv operates ONLY on this child bot's own admin-high.json list!
    if (instanceKind === "child") {
      try {
        const result = await mutateChildHighAdmin({
          uid: targetId,
          mode: action,
          actorId: senderId,
          botUid: currentBotUid,
          threadId,
          projectRoot,
          auditPath: effectiveAuditPath,
          overrides,
        });
        if (result.changed) {
          await sendMessageComplete(
            api,
            message,
            action === "add"
              ? `Đã thêm ${targetName} (${targetId}) vào quản trị tối cao của bot con hiện tại.`
              : `Đã xóa ${targetName} (${targetId}) khỏi quản trị tối cao của bot con hiện tại.`,
          );
        } else {
          await sendMessageWarning(
            api,
            message,
            action === "add"
              ? `${targetName} (${targetId}) đã là quản trị tối cao của bot con.`
              : `${targetName} (${targetId}) không có trong danh sách quản trị tối cao của bot con.`,
          );
        }
      } catch (error) {
        console.error("[admin] child supreme admin mutation failed:", error.code || error.message);
        await sendMessageWarning(api, message, `Thao tác thất bại, đã phục hồi dữ liệu gốc. (${error.code || "ERROR"})`);
      }
      continue;
    }

    // ON MAIN BOT: modify global high command admin list
    try {
      const result = action === "add"
        ? await addHighAdminViaCommand({
          uid: targetId,
          actorId: senderId,
          botUid: currentBotUid,
          threadId,
          projectRoot,
          auditPath: effectiveAuditPath,
          overrides,
        })
        : await removeHighAdminViaCommand({
          uid: targetId,
          actorId: senderId,
          botUid: currentBotUid,
          threadId,
          projectRoot,
          auditPath: effectiveAuditPath,
          overrides,
        });
      if (result.changed) {
        await sendMessageComplete(
          api,
          message,
          action === "add"
            ? `Đã thêm ${targetName} (${targetId}) vào quản trị tối cao nguồn COMMAND.`
            : `Đã xóa ${targetName} (${targetId}) khỏi quản trị tối cao nguồn COMMAND.`,
        );
      } else {
        await sendMessageWarning(
          api,
          message,
          action === "add"
            ? `${targetName} (${targetId}) đã có trong danh sách quản trị tối cao.`
            : `${targetName} (${targetId}) không có trong quản trị tối cao nguồn COMMAND.`,
        );
      }
    } catch (error) {
      if (error.code === "FILE_SOURCE_PROTECTED") {
        await sendMessageWarning(api, message, `${targetName} (${targetId}) thuộc nguồn FILE — chỉ sửa trực tiếp trong file.`);
        continue;
      }
      if (error.code === "LAST_ADMIN_PROTECTED") {
        await sendMessageWarning(api, message, "Phải còn ít nhất một quản trị tối cao hiệu lực sau thao tác!");
        continue;
      }
      console.error("[admin] high mutation failed:", error.code || error.message);
      await sendMessageWarning(api, message, `Thao tác thất bại, đã phục hồi dữ liệu gốc. (${error.code || "ERROR"})`);
    }
  }
  return true;
}

/**
 * Handlers for command router integration and backward compatibility
 */
export async function handleAdminCommand(api, message, groupAdmins, groupSettings, authorization = null) {
  const scope = message?.type === 0 ? "private" : "group";
  return executeAdminCommand({ api, message, groupSettings, scope, instanceKind: authorization?.instanceKind });
}

export async function handleListAdmin(api, message, groupSettings, authorization = null) {
  const scope = message?.type === 0 ? "private" : "group";
  return executeAdminCommand({ api, message, groupSettings, scope, instanceKind: authorization?.instanceKind });
}

export async function handleAdminHighLevelCommands(api, message, groupAdmins, groupSettings, isAdminLevelHighest, authorization = null) {
  const scope = message?.type === 0 ? "private" : "group";
  return executeAdminCommand({ api, message, groupSettings, scope, instanceKind: authorization?.instanceKind });
}
