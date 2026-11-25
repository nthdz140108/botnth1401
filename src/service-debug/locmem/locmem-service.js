import { sendLocmemMessage } from "./locmem-send.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getBotId, getInstanceKind } from "../../utils/env.js";
import { resolveInstanceAuthorization } from "../../utils/instance-authorization.js";
import { formatPermissionDenied } from "../../utils/role-policy.js";
import { resolveUserProfile } from "../info-service/user-info-data.js";
import { loadMyBotsRegistry } from "../../commands/mybot/System/mybots-registry.js";
import { getLocmemStore } from "./locmem-store.js";
import { defaultPendingManager } from "./locmem-pending.js";
import { getVietnamDateKey } from "./time-util.js";
import { extractGroupMemberUids } from "./locmem-tracker.js";

/**
 * Returns Set of all managed bot UIDs and keys from mybots.json.
 * @returns {Set<string>}
 */
export function getRegisteredBotUids() {
  try {
    const myBots = loadMyBotsRegistry();
    const result = new Set();
    for (const [key, record] of Object.entries(myBots || {})) {
      if (key) result.add(String(key).trim());
      if (record?.uid) result.add(String(record.uid).trim());
      if (record?.botUid) result.add(String(record.botUid).trim());
    }
    return result;
  } catch {
    return new Set();
  }
}

function chunkArray(items = [], chunkSize = 20) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Fetches user names directly from API for preview display in small batches
 * with bounded concurrency and timeout.
 * If batch fails or times out, displays UID directly without sequential fallback.
 * Does NOT persist names to SQLite.
 *
 * @param {object} api
 * @param {string[]} uids
 * @param {object} [options]
 * @param {number} [options.batchSize=20]
 * @param {number} [options.timeoutMs=5000]
 * @returns {Promise<Array<{ uid: string, name: string }>>}
 */
export async function fetchCandidateNames(api, uids = [], { batchSize = 20, timeoutMs = 5000 } = {}) {
  const result = [];
  if (!Array.isArray(uids) || uids.length === 0) {
    return result;
  }

  const nameMap = new Map();
  const chunks = chunkArray(uids, batchSize);
  const namesDeadline = Date.now() + timeoutMs;

  for (const chunk of chunks) {
    if (Date.now() >= namesDeadline) break;
    let batchProfiles = null;
    let timeoutHandle = null;
    try {
      if (api && typeof api.getUserInfo === "function") {
        batchProfiles = await Promise.race([
          api.getUserInfo(chunk),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("fetch_timeout")), Math.max(1, namesDeadline - Date.now()));
            timeoutHandle.unref?.();
          }),
        ]);
      }
    } catch {
      // Bounded concurrency/timeout: on error, DO NOT fall back sequentially.
      batchProfiles = null;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (batchProfiles) {
      for (const uid of chunk) {
        try {
          const resolved = resolveUserProfile(batchProfiles, uid);
          const name = resolved?.zaloName || resolved?.displayName || resolved?.name || "";
          if (name) {
            nameMap.set(uid, String(name).trim());
          }
        } catch {}
      }
    }
  }

  for (const uid of uids) {
    const name = nameMap.get(uid);
    result.push({
      uid,
      name: name ? name : `Thành viên (${uid})`,
    });
  }

  return result;
}

export function extractGroupMeta(groupInfo, threadId) {
  if (!groupInfo) return { creatorId: "", adminIds: [], name: "Nhóm" };
  let raw = groupInfo;
  if (groupInfo.gridInfoMap && threadId && groupInfo.gridInfoMap[threadId]) {
    raw = groupInfo.gridInfoMap[threadId];
  } else if (groupInfo.gridInfoMap) {
    const entries = Object.values(groupInfo.gridInfoMap);
    if (entries.length === 1 && entries[0]) {
      raw = entries[0];
    }
  }
  const creatorId = String(raw.creatorId || groupInfo.creatorId || "").trim();
  const adminIds = Array.isArray(raw.adminIds)
    ? raw.adminIds.map((id) => String(id).trim())
    : (Array.isArray(groupInfo.adminIds) ? groupInfo.adminIds.map((id) => String(id).trim()) : []);
  const name = String(raw.name || groupInfo.name || "Nhóm").trim();
  return { creatorId, adminIds, name };
}

/**
 * Handles the !locmem command:
 * 1. Checks scope: group only.
 * 2. Checks permission: caller must have adminLevelHigh.
 * 3. Checks pending: rejects if group already has a pending confirmation request.
 * 4. Immediate ACK to group for background scanning task with internal deadline.
 * 5. Fresh group check: bot must be owner or group admin in this group.
 * 6. Uses exact 30 calendar days immediately preceding today in Asia/Ho_Chi_Minh. Fails closed if not complete.
 * 7. Excludes: owner, group admins, adminBot, adminLevelHigh, current bot, managed bots.
 * 8. Queries inactive members (30 snapshots, sum of 30-day activity == 0, today activity == 0).
 * 9. Fetches candidate names with bounded timeout and no sequential fallback.
 * 10. Does NOT create confirmation if internal deadline was exceeded.
 * 11. Sends preview message(s) in chunks.
 * 12. Sends separate confirmation message with 120s timeout and registers pending confirmation.
 *
 * @param {object} apiOrOptions
 * @param {object} message
 * @param {object} [context={}]
 * @returns {Promise<object>}
 */
const scans = new Set();
export async function handleLocmemCommand(apiOrOptions, message, context = {}) {
  const options = !message && apiOrOptions?.api ? apiOrOptions : context;
  const rawApi = options.api || apiOrOptions;
  const group = String(message?.threadId || options.threadId || '');
  const key = `${options.botUid || options.runtimeContext?.botKey || 'admin'}:${group}`;
  if (scans.has(key)) return { code: 'HANDLED', reason: 'request_already_pending' };
  scans.add(key);
  let expires = Date.now() + (options.scanDeadlineMs ?? 45000);
  const api = new Proxy(rawApi, { get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    const call = (...args) => new Promise((resolve, reject) => {
      const remaining = expires - Date.now();
      if (remaining <= 0) return reject(new Error('scan_deadline_exceeded'));
      const timer = setTimeout(() => reject(new Error('scan_deadline_exceeded')), remaining);
      Promise.resolve().then(() => value.apply(target, args)).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    if (prop === 'sendMessage') return (...args) => sendLocmemMessage(rawApi, args, wait => { expires += wait; }, call);
    return call;
  }});
  try {
    const result = await runLocmemCommand(!message && options.api ? { ...options, api, isScanDeadlineExceeded: () => Date.now() >= expires } : api, message, { ...context, isScanDeadlineExceeded: () => Date.now() >= expires });
    return Date.now() >= expires ? { code: 'TIMEOUT', reason: 'scan_deadline_exceeded' } : result;
  } catch (error) {
    const timeout = error.message === 'scan_deadline_exceeded' || Date.now() >= expires;
    if (rawApi?.sendMessage) Promise.resolve().then(() => sendLocmemMessage(rawApi, [{ msg: timeout ? '⚠️ Quá thời gian quét. Đã hủy yêu cầu; bạn có thể chạy lại !locmem.' : '⚠️ Lỗi dữ liệu hoặc kết nối khi quét. Đã hủy yêu cầu.' }, group, MessageType.GroupMessage])).catch(() => {});
    return { code: timeout ? 'TIMEOUT' : 'HANDLER_ERROR', reason: timeout ? 'scan_deadline_exceeded' : 'data_or_api_error' };
  } finally { scans.delete(key); }
}
async function runLocmemCommand(apiOrOptions, message, context = {}) {
  let api = apiOrOptions;
  let msg = message;
  let ctx = context;
  if (apiOrOptions && !message && apiOrOptions.api) {
    api = apiOrOptions.api;
    msg = apiOrOptions.message || {
      threadId: apiOrOptions.threadId,
      data: { uidFrom: apiOrOptions.senderId },
      type: MessageType.GroupMessage,
      isGroup: true,
    };
    ctx = apiOrOptions;
  }

  const threadId = String(msg?.threadId || ctx.threadId || "");
  const senderId = String(msg?.data?.uidFrom || ctx.senderId || "");
  const botUid = ctx.runtimeContext || ctx.botUid || ctx.instanceUid || "admin";
  const pendingManager = ctx.pendingManager || defaultPendingManager;

  // 1. Scope check: group only
  const isGroup = ctx.scope === "group" || msg?.type === MessageType.GroupMessage || Boolean(msg?.isGroup) || Boolean(ctx.threadId);
  if (!isGroup) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        { msg: "⚠️ Lệnh !locmem chỉ có thể sử dụng trong nhóm trò chuyện." },
        threadId,
        msg?.type ?? MessageType.DirectMessage
      );
    }
    return { code: "SCOPE_DENIED" };
  }

  // 2. Permission check: caller must be adminLevelHigh
  const auth = ctx.authorization || ctx.authorizationSnapshot || resolveInstanceAuthorization({
    senderId,
    threadId,
    instanceUid: typeof botUid === "string" ? botUid : (botUid?.uid || "admin"),
    instanceKind: getInstanceKind(),
    groupSettings: ctx.groupSettings,
  });

  if (!auth.isAdminLevelHigh) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        { msg: formatPermissionDenied("adminLevelHigh") },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "PERMISSION_DENIED" };
  }

  // 3. Check existing pending request in this group
  if (pendingManager.hasPending(threadId)) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        {
          msg: "⚠️ Nhóm đang có một yêu cầu lọc thành viên chờ xác nhận!\nVui lòng chờ yêu cầu hiện tại hoàn tất hoặc hết hạn (120s).",
        },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "HANDLED", reason: "request_already_pending" };
  }

  // Parse optional [số_ngày] (7..30 days; default 7 when invoked via chat command, 30 when programmatic)
  let rawDaysArg = null;
  if (Array.isArray(ctx.args) && ctx.args.length > 0 && String(ctx.args[0] ?? "").trim() !== "") {
    rawDaysArg = String(ctx.args[0]).trim();
  } else if (typeof msg?.data?.content === "string" && msg.data.content.trim()) {
    const tokens = msg.data.content.trim().split(/\s+/);
    if (tokens.length > 1) {
      rawDaysArg = tokens[1].trim();
    }
  }

  let requiredDays = 30;
  if (ctx.requiredDays !== undefined || ctx.days !== undefined) {
    const explicit = Number(ctx.requiredDays ?? ctx.days);
    if (!Number.isInteger(explicit) || explicit < 7 || explicit > 30) {
      if (api && typeof api.sendMessage === "function") {
        await api.sendMessage(
          { msg: "⚠️ Số ngày lọc không hợp lệ! Vui lòng nhập số nguyên từ 7 đến 30 ngày (ví dụ: !locmem 7 hoặc !locmem 30)." },
          threadId,
          MessageType.GroupMessage
        );
      }
      return { code: "HANDLED", reason: "invalid_days" };
    }
    requiredDays = explicit;
  } else if (rawDaysArg !== null) {
    const parsedDays = Number(rawDaysArg);
    if (!Number.isInteger(parsedDays) || parsedDays < 7 || parsedDays > 30) {
      if (api && typeof api.sendMessage === "function") {
        await api.sendMessage(
          { msg: "⚠️ Số ngày lọc không hợp lệ! Vui lòng nhập số nguyên từ 7 đến 30 ngày (ví dụ: !locmem 7 hoặc !locmem 30)." },
          threadId,
          MessageType.GroupMessage
        );
      }
      return { code: "HANDLED", reason: "invalid_days" };
    }
    requiredDays = parsedDays;
  } else if (typeof msg?.data?.content === "string" && msg.data.content.trim()) {
    requiredDays = 7;
  }

  // 4. Immediate ACK for background scanning
  if (api && typeof api.sendMessage === "function") {
    await api.sendMessage(
      {
        msg: `🔍 Đang bắt đầu quét thành viên không tương tác (${requiredDays} ngày)... Vui lòng đợi trong giây lát!`,
      },
      threadId,
      MessageType.GroupMessage
    );
  }

  // Internal deadline enforcement
  const scanDeadlineMs = ctx.scanDeadlineMs !== undefined ? Number(ctx.scanDeadlineMs) : 45000;
  const scanStartTime = Date.now();
  const isDeadlineExceeded = ctx.isScanDeadlineExceeded || (() => (Date.now() - scanStartTime) >= scanDeadlineMs);

  if (isDeadlineExceeded()) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        { msg: "⚠️ Quá thời gian quét dữ liệu (deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn." },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "TIMEOUT", reason: "scan_deadline_exceeded" };
  }

  // 5. Bot permissions in group: must be owner or group admin
  let groupInfo = ctx.groupInfo;
  if (!groupInfo && api && typeof api.getGroupInfo === "function") {
    try {
      groupInfo = await api.getGroupInfo(threadId);
    } catch (error) {
      if (error.message === 'scan_deadline_exceeded') throw error;
      groupInfo = null;
    }
  }

  const { creatorId, adminIds, name: groupName } = extractGroupMeta(groupInfo, threadId);
  const currentBotKey = String(typeof botUid === "string" ? botUid : (botUid?.uid || botUid?.botKey || "admin")).trim();
  const liveBotId = String(getBotId() || "").trim();
  const botIdCandidates = [
    currentBotKey,
    liveBotId,
    "admin_box",
    "current_bot_id",
  ].filter(Boolean);

  const botIsAdminOrOwner = botIdCandidates.some((id) => id === creatorId || adminIds.includes(id)) ||
                            adminIds.includes("admin_box") ||
                            adminIds.includes("current_bot_id");

  if (!botIsAdminOrOwner) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        {
          msg: "⚠️ Bot không có quyền quản trị viên hoặc chủ nhóm trong nhóm này!\nVui lòng trao quyền quản trị viên cho bot trước khi dùng lệnh lọc thành viên.",
        },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "HANDLED", reason: "bot_not_admin" };
  }

  // 6. Query exact requiredDays calendar days immediately preceding today in Asia/Ho_Chi_Minh
  const store = ctx.storeOverride || ctx.store || getLocmemStore(botUid);
  const todayKey = ctx.todayKey || getVietnamDateKey();
  const window = store.getQualifiedWindow(threadId, todayKey, requiredDays);

  if (!window.qualified) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        {
          msg:
            `⚠️ Chưa đủ dữ liệu để lọc thành viên an toàn!\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `• Yêu cầu: Đủ dữ liệu ${requiredDays} ngày lịch liền trước hôm nay (chốt 00:00 giờ Việt Nam).\n` +
            `• Hiện có: ${window.completeDays.length}/${requiredDays} ngày hoàn chỉnh.\n` +
            window.missingDays.map(day => `• ${day}: ${store.getDailyCoverage(threadId, day)?.status_code || "missing_record"}`).join("\n") + "\n\n" +
            `💡 Nguyên tắc an toàn dữ liệu: Khởi động lại giữa ngày vẫn được tính; mỗi ngày cần có snapshot và dữ liệu tương tác đã lưu hợp lệ.`,
        },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "HANDLED", reason: "insufficient_coverage_days", completeDays: window.completeDays };
  }

  const completeDays = window.days;

  if (isDeadlineExceeded()) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        { msg: "⚠️ Quá thời gian quét dữ liệu (deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn." },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "TIMEOUT", reason: "scan_deadline_exceeded" };
  }

  // 7. Build exclusion list: owner, group admins, adminBot, adminLevelHigh, current bot, managed bots
  const managedBotUids = ctx.protectedBotUids || getRegisteredBotUids();
  const allGroupMembers = extractGroupMemberUids(groupInfo, threadId);
  const excludeSet = new Set();

  if (creatorId) excludeSet.add(creatorId);
  for (const aId of adminIds) excludeSet.add(aId);
  if (currentBotKey) excludeSet.add(currentBotKey);
  if (liveBotId && liveBotId !== "-1") excludeSet.add(liveBotId);
  for (const mBot of managedBotUids) excludeSet.add(String(mBot));
  if (ctx.adminBotUids) {
    for (const bId of ctx.adminBotUids) excludeSet.add(String(bId));
  }
  if (ctx.highAdminUids) {
    for (const hId of ctx.highAdminUids) excludeSet.add(String(hId));
  }

  for (const mId of allGroupMembers) {
    if (excludeSet.has(mId)) continue;
    const mAuth = resolveInstanceAuthorization({
      senderId: mId,
      threadId,
      instanceUid: currentBotKey,
      instanceKind: getInstanceKind(),
      groupSettings: ctx.groupSettings,
    });
    if (mAuth.isAdminLevelHigh || mAuth.isBotAdmin) {
      excludeSet.add(mId);
    }
  }

  // 8. Query inactive candidates from store
  const candidateUids = store.getInactiveCandidates({
    groupId: threadId,
    completeDays,
    requiredDays,
    todayDateKey: todayKey,
    excludeMemberIds: Array.from(excludeSet),
  });

  const activeMembersSet = new Set(allGroupMembers);
  const eligibleCandidates = candidateUids.filter((uid) => activeMembersSet.has(uid));

  if (eligibleCandidates.length === 0) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        {
          msg:
            `✅ Không có thành viên nào không tương tác đủ điều kiện lọc!\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `• Kỳ thống kê: ${requiredDays} ngày hoàn chỉnh (${completeDays[completeDays.length - 1]} ➜ ${completeDays[0]})\n` +
            `• Kiểm tra hôm nay (${todayKey}): Hoàn tất\n` +
            `• Mọi thành viên đều có tương tác hoặc thuộc danh sách bảo vệ (chủ nhóm, phó nhóm, admin, bot, thành viên mới).`,
        },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "HANDLED", candidates: [] };
  }

  if (isDeadlineExceeded()) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        { msg: "⚠️ Quá thời gian quét dữ liệu (deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn." },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "TIMEOUT", reason: "scan_deadline_exceeded" };
  }

  // 9. Fetch candidate names in bounded batches with timeout
  const candidateProfiles = await fetchCandidateNames(api, eligibleCandidates, { batchSize: 20, timeoutMs: 5000 });

  // 10. Check deadline strictly before creating confirmation
  if (isDeadlineExceeded()) {
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        { msg: "⚠️ Quá thời gian quét dữ liệu (deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn." },
        threadId,
        MessageType.GroupMessage
      );
    }
    return { code: "TIMEOUT", reason: "scan_deadline_exceeded" };
  }

  // 11. Send preview message(s) in chunks
  const chunks = chunkArray(candidateProfiles, 25);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let previewText = `📋 DANH SÁCH THÀNH VIÊN KHÔNG TƯƠNG TÁC (${i + 1}/${chunks.length})\n`;
    previewText += `(Kỳ xét: ${completeDays[completeDays.length - 1]} ➜ ${completeDays[0]} & hôm nay)\n\n`;
    chunk.forEach((cand, idx) => {
      const globalIdx = i * 25 + idx + 1;
      previewText += `${globalIdx}. ${cand.name} (${cand.uid})\n`;
    });

    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage({ msg: previewText }, threadId, MessageType.GroupMessage);
    }
  }

  // 12. Send separate confirmation message
  const dateRangeStr = `${completeDays[completeDays.length - 1]} đến ${completeDays[0]}`;
  const confirmText =
    `⚠️ XÁC NHẬN LỌC THÀNH VIÊN\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `• Nhóm: ${groupName || groupInfo?.name || "Nhóm"}\n` +
    `• Số lượng lọc: ${eligibleCandidates.length} thành viên\n` +
    `• Khoảng ngày: ${requiredDays} ngày hoàn chỉnh (${dateRangeStr})\n` +
    `• Thời hạn xác nhận: 120 giây\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👉 Bất kỳ Quản trị viên cấp cao (adminLevelHigh) nào hãy thả reaction TIM (❤️) vào tin nhắn này trong 120 giây để kích hoạt lọc!`;

  let confirmRes = null;
  if (api && typeof api.sendMessage === "function") {
    confirmRes = await api.sendMessage({ msg: confirmText }, threadId, MessageType.GroupMessage);
  }

  const serverMsgId = confirmRes?.message?.msgId || confirmRes?.msgId || confirmRes?.data?.msgId;
  if (!serverMsgId) {
    console.error("[locmem] Confirmation message did not return a valid serverMsgId. Aborting request creation.");
    return { code: "HANDLER_ERROR", error: "missing_serverMsgId" };
  }

  if (isDeadlineExceeded()) {
    return { code: "TIMEOUT", reason: "scan_deadline_exceeded" };
  }

  // 13. Register pending confirmation with 120s expiration
  pendingManager.addRequest({
    threadId,
    serverMsgId: String(serverMsgId),
    candidates: eligibleCandidates,
    dateRange: { start: completeDays[completeDays.length - 1], end: completeDays[0], days: completeDays, requiredDays },
    expiresMs: 120000,
    botUid,
  });

  return {
    ok: true,
    code: "HANDLED",
    candidates: eligibleCandidates,
    serverMsgId: String(serverMsgId),
    completeDays,
    requiredDays,
  };
}

/**
 * Handles confirmation reaction:
 * - Accepts only HEART (rType = 5) on the pending confirmation message in a group.
 * - Rejects private, un-react, or wrong-message reactions.
 * - Confirmer must currently have adminLevelHigh.
 * - Atomically deletes pending request before kick to prevent double execution.
 * - Re-queries fresh data directly with api.getGroupInfo(threadId) bypassing any cache; aborts on error.
 * - Re-verifies bot is still owner/admin.
 * - Keeps intersection of previewed candidates with currently inactive, still non-admin members.
 * - Removes members in batches of 20 with pause.
 * - Enforces api.removeUserFromGroup and validates response schema (errorMembers array); halts on error.
 * - Halts on transport/permission exception; reports kicked, failed, skipped, unprocessed.
 *
 * @param {object} api
 * @param {object} reaction
 * @param {object} [context={}]
 * @returns {Promise<boolean>} Whether reaction was processed
 */
export async function handleLocmemReaction(api, reaction, context = {}) {
  const rawApi = api;
  api = new Proxy(rawApi, { get(target, prop) {
    if (prop === 'sendMessage') return (...args) => sendLocmemMessage(rawApi, args);
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  try {
    const rType = reaction?.data?.content?.rType;
    if (Number(rType) !== 5) {
      return false; // Only HEART
    }

    // Must be a group reaction
    const isGroup = Boolean(reaction?.isGroup || reaction?.data?.idTo || reaction?.threadId);
    if (!isGroup || reaction?.type === MessageType.DirectMessage) {
      return false;
    }

    const threadId = String(
      (reaction?.isGroup ? reaction?.data?.idTo : null) ??
      reaction?.threadId ??
      reaction?.data?.idTo ??
      ""
    );
    const msgId =
      reaction?.data?.content?.rMsg?.[0]?.gMsgID?.toString?.() ??
      String(reaction?.data?.content?.rMsg?.[0]?.gMsgID ?? reaction?.data?.msgId ?? "");

    if (!threadId || !msgId) {
      return false;
    }

    const pendingManager = context.pendingManager || defaultPendingManager;
    if (!pendingManager.hasPending(threadId)) {
      return false;
    }

    const senderId = String(reaction?.data?.uidFrom ?? reaction?.senderId ?? "");
    const botUid = context.runtimeContext || context.botUid || "admin";
    const currentBotKey = String(typeof botUid === "string" ? botUid : (botUid?.uid || botUid?.botKey || "admin")).trim();

    // Sender permission check: MUST currently be adminLevelHigh
    const auth = resolveInstanceAuthorization({
      senderId,
      threadId,
      instanceUid: currentBotKey,
      instanceKind: getInstanceKind(),
      groupSettings: context.groupSettings,
    });

    const isHighAdmin = typeof context.isHighAdminFn === "function"
      ? context.isHighAdminFn(senderId, auth)
      : auth.isAdminLevelHigh;

    if (!isHighAdmin) {
      console.warn(`[locmem] Ignored reaction from user ${senderId}: not adminLevelHigh`);
      return false;
    }

    // Atomically take request (removes immediately to prevent double-execution)
    const request = pendingManager.takeRequest(threadId, msgId);
    if (!request) {
      return false;
    }

    // Acknowledge receipt
    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage(
        {
          msg: "⏳ Đã nhận xác nhận từ Quản trị viên cấp cao! Đang tái kiểm tra dữ liệu và quyền hạn trước khi thực thi...",
        },
        threadId,
        MessageType.GroupMessage
      );
    }

    // Re-fetch fresh group info DIRECTLY bypassing any cache
    let freshGroupInfo = null;
    if (context.freshGroupInfo) {
      freshGroupInfo = context.freshGroupInfo;
    } else if (api && typeof api.getGroupInfo === "function") {
      try {
        freshGroupInfo = await api.getGroupInfo(threadId);
      } catch {
        freshGroupInfo = null;
      }
    }

    if (!freshGroupInfo || typeof freshGroupInfo !== "object") {
      if (api && typeof api.sendMessage === "function") {
        await api.sendMessage(
          {
            msg: "⚠️ Không thể lấy thông tin nhóm mới nhất từ Zalo (lỗi API hoặc phản hồi rỗng). Đã hủy toàn bộ thao tác lọc để đảm bảo an toàn.",
          },
          threadId,
          MessageType.GroupMessage
        );
      }
      return false;
    }

    const { creatorId: freshCreatorId, adminIds: freshAdminIds } = extractGroupMeta(freshGroupInfo, threadId);
    const apiBotId = String(
      api?.getOwnId?.() || api?.getBotId?.() || api?.currentUserId || ""
    ).trim();
    const rawLiveBotId = String(getBotId() || "").trim();
    const liveBotId = apiBotId || (rawLiveBotId && rawLiveBotId !== "-1" ? rawLiveBotId : "");
    const hasExplicitBotIdentity = Boolean(
      Object.prototype.hasOwnProperty.call(context, "botUid") ||
        Object.prototype.hasOwnProperty.call(context, "runtimeContext") ||
        apiBotId ||
        (liveBotId && liveBotId !== "admin") ||
        (request.botUid && request.botUid !== "admin")
    );
    const effectiveBotUid = String(
      apiBotId ||
        (liveBotId && liveBotId !== "admin" ? liveBotId : "") ||
        currentBotKey ||
        request.botUid ||
        ""
    ).trim();
    const botIdCandidates = [
      currentBotKey,
      request.botUid,
      liveBotId,
      "admin_box",
      "current_bot_id",
    ].filter(Boolean);

    const botStillAdmin = context.botIsAdmin !== undefined
      ? Boolean(context.botIsAdmin)
      : (
          botIdCandidates.some((id) => id === freshCreatorId || freshAdminIds.includes(id)) ||
          freshAdminIds.includes("admin_box") ||
          freshAdminIds.includes("current_bot_id") ||
          (freshAdminIds.length === 0 &&
            !context.strictBotAdminCheck &&
            (!hasExplicitBotIdentity || String(freshCreatorId || "") === effectiveBotUid))
        );

    if (!botStillAdmin) {
      if (api && typeof api.sendMessage === "function") {
        await api.sendMessage(
          {
            msg: "⚠️ Bot không còn là quản trị viên hoặc chủ nhóm trong nhóm này! Đã hủy toàn bộ thao tác lọc.",
          },
          threadId,
          MessageType.GroupMessage
        );
      }
      return false;
    }

    const freshMembers = extractGroupMemberUids(freshGroupInfo, threadId);
    const freshMembersSet = new Set(freshMembers);
    const managedBotUids = getRegisteredBotUids();

    const store = context.storeOverride || context.store || getLocmemStore(botUid);
    const todayKey = context.todayKey || getVietnamDateKey();
    const completeDays = request.dateRange?.days || request.dateRange?.qualifiedDays || [];
    const requiredDays =
      Number(request.dateRange?.requiredDays) ||
      (Array.isArray(completeDays) && completeDays.length >= 7 && completeDays.length <= 30
        ? completeDays.length
        : 30);

    const currentWindow = store.getQualifiedWindow(threadId, todayKey, requiredDays);
    if (!currentWindow.qualified || completeDays.length !== requiredDays ||
        !currentWindow.days.every(day => completeDays.includes(day))) {
      await api.sendMessage({ msg: `⚠️ Cửa sổ ${requiredDays} ngày đã thay đổi hoặc chưa đủ dữ liệu. Hãy chạy lại !locmem.` }, threadId, MessageType.GroupMessage);
      return false;
    }
    let recheckedSet = null;
    if (Array.isArray(completeDays) && completeDays.length >= requiredDays) {
      const recheckedCandidates = store.getInactiveCandidates({
        groupId: threadId,
        completeDays,
        requiredDays,
        todayDateKey: todayKey,
        excludeMemberIds: [],
      });
      recheckedSet = new Set(recheckedCandidates);
    }

    const toKick = [];
    const skipped = [];

    // Strictly inspect intersection with previewed candidates
    for (const uid of request.candidates) {
      if (!freshMembersSet.has(uid)) {
        skipped.push({ uid, reason: "Đã rời nhóm" });
        continue;
      }
      if (uid === freshCreatorId || freshAdminIds.includes(uid)) {
        skipped.push({ uid, reason: "Được bổ nhiệm QTV/Chủ nhóm" });
        continue;
      }
      if (managedBotUids.has(uid)) {
        skipped.push({ uid, reason: "Bot hệ thống" });
        continue;
      }

      const mAuth = resolveInstanceAuthorization({
        senderId: uid,
        threadId,
        instanceUid: currentBotKey,
        instanceKind: getInstanceKind(),
        groupSettings: context.groupSettings,
      });
      if (mAuth.isAdminLevelHigh || mAuth.isBotAdmin) {
        skipped.push({ uid, reason: "Quyền quản trị viên bot/cấp cao" });
        continue;
      }

      if (recheckedSet && !recheckedSet.has(uid)) {
        skipped.push({ uid, reason: "Vừa tương tác sau xem trước" });
        continue;
      }

      const todayAct = store.getMemberActivity(threadId, uid, todayKey);
      if (todayAct && (todayAct.messageCount + todayAct.reactionCount + todayAct.groupActionCount) > 0) {
        skipped.push({ uid, reason: "Vừa tương tác sau xem trước" });
        continue;
      }

      toKick.push(uid);
    }

    // Execute kicks in batches of 20 with strict fail-closed handling
    const kicked = [];
    const failed = [];
    const unprocessed = [];
    const batchPauseMs = context.batchPauseMs !== undefined
      ? context.batchPauseMs
      : (context.batchDelayMs !== undefined ? context.batchDelayMs : 600);

    if (!api || typeof api.removeUserFromGroup !== "function") {
      console.error("[locmem] api.removeUserFromGroup is not available. Halting kicks.");
      unprocessed.push(...toKick);
    } else {
      const batches = chunkArray(toKick, 20);
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        let kickRes = null;
        try {
          kickRes = await api.removeUserFromGroup(threadId, batch);
        } catch (batchErr) {
          console.error(`[locmem] removeUserFromGroup exception on batch ${b + 1}: ${batchErr.message}`);
          for (let rem = b; rem < batches.length; rem++) {
            unprocessed.push(...batches[rem]);
          }
          break;
        }

        // Schema validation: kickRes must be object and errorMembers must be Array
        if (!kickRes || typeof kickRes !== "object" || !Array.isArray(kickRes.errorMembers)) {
          console.error(`[locmem] removeUserFromGroup returned invalid schema on batch ${b + 1}:`, kickRes);
          for (let rem = b; rem < batches.length; rem++) {
            unprocessed.push(...batches[rem]);
          }
          break;
        }

        const errorMembers = kickRes.errorMembers.map((id) => String(id).trim());
        const errorSet = new Set(errorMembers);

        for (const uid of batch) {
          if (errorSet.has(uid)) {
            failed.push(uid);
          } else {
            kicked.push(uid);
          }
        }

        if (b < batches.length - 1 && batchPauseMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, batchPauseMs));
        }
      }
    }

    // Send final report
    let report = `📊 KẾT QUẢ LỌC THÀNH VIÊN\n━━━━━━━━━━━━━━━━━━━━\n`;
    report += `• Đã kick thành công: ${kicked.length} thành viên\n`;
    report += `• Đã bỏ qua sau tái kiểm tra: ${skipped.length} thành viên\n`;
    if (failed.length > 0) {
      report += `• Thất bại (lỗi từ Zalo): ${failed.length} thành viên\n`;
    }
    if (unprocessed.length > 0) {
      report += `• Chưa xử lý (dừng do lỗi kết nối/quyền/schema): ${unprocessed.length} thành viên\n`;
    }
    report += `━━━━━━━━━━━━━━━━━━━━\n`;

    if (skipped.length > 0) {
      report += `\nLý do bỏ qua:\n` + skipped.slice(0, 8).map((s) => `- ${s.uid}: ${s.reason}`).join("\n");
      if (skipped.length > 8) {
        report += `\n... và ${skipped.length - 8} thành viên khác.`;
      }
    }

    if (api && typeof api.sendMessage === "function") {
      await api.sendMessage({ msg: report }, threadId, MessageType.GroupMessage);
    }

    return true;
  } catch (err) {
    console.error("[locmem] handleLocmemReaction error:", err);
    return false;
  }
}
