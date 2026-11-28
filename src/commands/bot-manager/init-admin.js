import { getBotInfo, getProjectRoot } from "../../utils/env.js";
import fs from "fs";
import path from "path";
import { appContext } from "../../api-zalo/context.js";
import { createBotRuntimeContext, getInitialAdminList } from "../../utils/bot-runtime-context.js";
import { resolveChildAdminIdentities } from "../mybot/System/child-admin-resolver.js";
import { getProfile } from "../mybot/System/mybot-profile-service.js";

/**
 * Fail-closed fallback: write ONLY the child bot's own UID as the admin list
 * when dynamic identity resolution fails. This bot's own session UID is always a
 * valid local Supreme Admin; the owner/main UIDs from another session are never
 * copied here. The profile is marked identityPending so high-privilege checks
 * fail closed until identities are resolved in the child's own session.
 * Never throws — returns the list written.
 */
async function fallbackWriteChildAdmins(botUid, { projectRoot, api, botKey } = {}) {
  const root = projectRoot || getProjectRoot();
  const bUid = String(botKey || process.env.BOT_KEY || botUid || "").trim();

  // Only the bot's own UID is guaranteed to be a valid local Supreme Admin.
  const selfUid = String((typeof api?.getOwnId === "function" ? api.getOwnId() : "") || botUid || "").trim();
  const admins = [selfUid].filter((s) => s && s.toLowerCase() !== "admin");

  const runtimeAdminPath = path.join(root, "mybot", "instances", bUid, "data", "admin-list.json");
  const legacyAdminPath = path.join(root, "mybot", "configs", `list_admin-${bUid}.json`);

  for (const targetPath of new Set([runtimeAdminPath, legacyAdminPath])) {
    if (!targetPath) continue;
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(admins, null, 2));
    } catch (e) {
      console.error(`[initAdminHandle] Không thể ghi fail-closed admin list ${targetPath}: ${e.message}`);
    }
  }

  // Mark identity pending: high privilege fails closed until owner/main are
  // resolved through the child's own session.
  try {
    const { getProfile, updateProfile } = await import("../mybot/System/mybot-profile-service.js");
    const profile = getProfile(bUid, { root }) || {};
    updateProfile(bUid, {
      ...profile,
      identityPending: true,
      adminBindingStatus: "pending",
      identityPendingReason: "Không resolve được owner/main username trong session bot; chỉ bot UID là Admin Tối Cao (fail-closed).",
      resolvedChildAdminUids: admins,
    }, { root });
  } catch {}

  console.log(`[initAdminHandle] Fail-closed admin list ${JSON.stringify(admins)} cho bot con ${bUid}`);
  return admins;
}

export async function initAdminHandle(api) {
  if (api?.is_main_bot) return;
  const botInfo = (await getBotInfo()) || {};
  const projectRoot = getProjectRoot();
  const runtimeContext = createBotRuntimeContext(botInfo);
  const botUid = appContext.uid ? String(appContext.uid).trim() : (botInfo.name || botInfo.uid);
  const botKey = String(process.env.BOT_KEY || botInfo.botKey || botInfo.name || botUid || "").trim();

  // For child bot, dynamic session resolution is the ONLY source for Supreme Admins.
  // Wrapped in try-catch: on ANY failure we fall back to writing [botUid, ownerUid]
  // as the admin list and continue bot startup normally — never block startup.
  if (botUid && botUid.toLowerCase() !== "admin") {
    try {
      const result = await resolveChildAdminIdentities({
        api,
        botUid,
        botKey,
        projectRoot,
      });
      console.log(`[initAdminHandle] Đã resolve Admin Tối Cao cho bot con ${botUid}:`, result.resolvedAdmins);
      return;
    } catch (err) {
      console.error(`[initAdminHandle] Dynamic identity resolution thất bại cho bot con ${botUid}: ${err.message}. Fallback ghi [botUid, ownerUid] làm admin.`);
      try {
        await fallbackWriteChildAdmins(botUid, { projectRoot, api, botKey });
      } catch (fallbackErr) {
        console.error(`[initAdminHandle] Fallback ghi admin list cũng thất bại cho bot con ${botUid}: ${fallbackErr.message}`);
      }
      // Continue bot startup normally — do NOT rethrow.
      return;
    }
  }

  // Main bot admin list initialization
  const adminFilePath = botInfo.adminFilePath
    ? path.resolve(projectRoot, botInfo.adminFilePath)
    : runtimeContext.adminListPath;

  const adminSet = new Set();
  const addUid = (raw) => {
    if (raw === undefined || raw === null) return;
    const uid = String(raw).trim();
    if (uid && uid.toLowerCase() !== "admin") {
      adminSet.add(uid);
    }
  };

  // 1. Read existing legacy adminFilePath
  if (fs.existsSync(adminFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(adminFilePath, "utf8").replace(/^\uFEFF/, ""));
      if (Array.isArray(parsed)) {
        for (const id of parsed) addUid(id);
      }
    } catch (e) {
      console.error("Lỗi khi đọc admin list từ adminFilePath:", e);
    }
  }

  // 2. Read existing runtime adminListPath
  if (runtimeContext.adminListPath && fs.existsSync(runtimeContext.adminListPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runtimeContext.adminListPath, "utf8").replace(/^\uFEFF/, ""));
      if (Array.isArray(parsed)) {
        for (const id of parsed) addUid(id);
      }
    } catch (e) {
      console.error("Lỗi khi đọc runtime admin list:", e);
    }
  }

  // 3. Ensure default initial admins are present for main bot
  const defaultAdmins = getInitialAdminList(botUid || "admin", projectRoot);
  for (const adminId of defaultAdmins) {
    if (adminId && !adminSet.has(adminId)) {
      addUid(adminId);
    }
  }

  const finalAdminList = Array.from(adminSet).filter(Boolean);
  try {
    if (adminFilePath) {
      fs.mkdirSync(path.dirname(adminFilePath), { recursive: true });
      fs.writeFileSync(adminFilePath, JSON.stringify(finalAdminList, null, 2));
    }
    if (runtimeContext.adminListPath && path.resolve(runtimeContext.adminListPath) !== path.resolve(adminFilePath)) {
      fs.mkdirSync(path.dirname(runtimeContext.adminListPath), { recursive: true });
      fs.writeFileSync(runtimeContext.adminListPath, JSON.stringify(finalAdminList, null, 2));
    }
  } catch (e) {
    console.error("Lỗi khi lưu admin list:", e);
  }
}
