import { validateCredentials, createBotConfig } from "../System/pm2-manager.js";
import { createAllRequiredFilesWithCredentials } from "./qr-login-command.js";
import { readCommandConfig } from "../../../utils/io-json.js";
import { sendMessageComplete, sendMessageWarning } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { createDefaultProfile, saveProfile, getProfilePath } from "../System/mybot-profile-service.js";
import { resolveAdminIdentity, normalizeUsername, extractUsernameFromUserInfo } from "../System/mybot-identity.js";
import { validateAdminIdentitySeeds } from "../System/child-admin-resolver.js";
import { reserveCreationQuota, commitCreationQuota, releaseCreationQuota } from "../System/mybot-creation-quota.js";
import { getProjectRoot } from "../../../utils/env.js";
import { normalizeLoginCredential } from "../System/credential-normalizer.js";
import { verifyLoginCredential } from "../System/login-verification.js";
import { persistVerifiedBot } from "../System/verified-provisioning.js";

export async function createBot(api, message, groupAdmins, arg, aliasCommand = "mybot", options = {}) {
  const { data: { uidFrom, dName, content }, type } = message;
  const root = getProjectRoot();
  const prefix = readCommandConfig()?.prefix || "!";
  if (type === 1) return sendMessageWarning(api, message, "Vui lòng tạo bot ở chat cá nhân để bảo vệ thông tin đăng nhập.", true, false);
  const args = Array.isArray(arg) && arg.length >= 2 ? arg : String(content || "").split(/\s+/).slice(2);
  const validation = validateCredentials(args, prefix, aliasCommand);
  if (!validation.valid) return sendMessageWarning(api, message, validation.message, true, false);
  let reservation;
  try {
    const credential = normalizeLoginCredential(validation.credentials);
    const identity = await (options.verifyCredential || verifyLoginCredential)(credential, { root });
    let ownerUsername = null;
    try { ownerUsername = extractUsernameFromUserInfo(await api.getUserInfo([uidFrom]), uidFrom); } catch {}
    const main = resolveAdminIdentity({ projectRoot: root, api });
    const seeds = validateAdminIdentitySeeds({ ownerUsername, botAdminUsername: normalizeUsername(main.botAdminUsername || main.canonicalUsername), selfUsername: identity.canonicalUsername || null });
    reservation = reserveCreationQuota(uidFrom, `create-${uidFrom}-${Date.now()}`, { projectRoot: root });
    if (!reservation.allowed) return sendMessageWarning(api, message, "Bạn đang có một yêu cầu tạo bot khác. Vui lòng đợi hoàn tất.", true, false);
    const result = await persistVerifiedBot({
      root, credential, identity, ownerUid: uidFrom, ownerName: dName,
      profilePatch: { ownerUsername, adminIdentitySeeds: seeds.normalized, identityPending: false, identityPendingReason: null },
      initialize: async (botKey, stored, record, txn) => {
        await createAllRequiredFilesWithCredentials(botKey, stored, createBotConfig(botKey, record.webPort), txn);
        const profile = createDefaultProfile(botKey, { ownerUid: uidFrom, createdByUid: uidFrom, ownerName: dName, ownerUsername, nameServer: identity.displayName || dName, expiryAt: null, trialStatus: "pending", enabled: true, adminIdentitySeeds: seeds.normalized, identityPending: false, identityPendingReason: null, accountIdentityStatus: "verified", adminBindingStatus: "pending" });
        if (txn.writeJson) txn.writeJson(getProfilePath(botKey, root), profile);
        else saveProfile(botKey, profile, { root, actor: uidFrom });
      },
    });
    if (result.created) commitCreationQuota(uidFrom, result.botKey, { projectRoot: root, requestId: reservation.requestId });
    else releaseCreationQuota(uidFrom, reservation.requestId, { projectRoot: root });
    return sendMessageComplete(api, message, result.created
      ? `✅ Đã xác minh tài khoản và tạo bot ${result.botKey}.\nTrạng thái: Tạm dừng. Quyền quản trị trong phiên bot con đang chờ xác minh.\nDùng ${prefix}${aliasCommand} active để kích hoạt dùng thử 1 giờ.`
      : `✅ Đã xác minh và lưu thông tin đăng nhập bot ${result.botKey}.\nThông tin mới sẽ có hiệu lực ở lần khởi động lại tiếp theo; cấu hình và hạn dùng được giữ nguyên.`, true, false);
  } catch (error) {
    if (reservation?.requestId) releaseCreationQuota(uidFrom, reservation.requestId, { projectRoot: root });
    console.error(`[MYBOT CREATE] ${error.code || "CREATE_FAILED"} at ${error.stage || "create"}`);
    return sendMessageWarning(api, message, `Không tạo/cập nhật được bot (${error.code || "CREATE_FAILED"}, bước ${error.stage || "create"}). ${error.message}`, true, false);
  }
}
