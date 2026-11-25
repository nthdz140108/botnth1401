import { GroupMessage, Message, MessageMention, MessageType } from "../../api-zalo/index.js";
import { getCommandConfig, reloadCommandConfig, writeCommandConfig, writeGroupSettings } from "../../utils/io-json.js";
import { isAdmin, ROLE_LEVELS } from "../../utils/role-policy.js";
import { sendMessageFailed, sendMessageFromSQL, sendMessageStateQuote } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { removeMention } from "../../utils/format-util.js";
import { getPermissionCommandName } from "../manager-command/set-command.js";
import { handleCmdaddCommand } from "../custom-commands/cmdadd-command.js";
import { listCustomCommands } from "../custom-commands/store.js";
import { listCommands } from "../instructions/help.js";
import { commandRegistry } from "../command-registry.js";
import {
  extractCleanArgs,
  extractCommandBody,
  getQuoteData,
  getQuotedUid,
  resolveTargetUsers,
  safeThreadType,
} from "../shared/command-input-utils.js";

const PROTECTED_CANONICAL_COMMANDS = new Set(["alias", "fixcmd", "setcmd"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectMentionUids(message) {
  const mentions = message?.data?.mentions;
  if (!mentions) return [];
  const arr = Array.isArray(mentions) ? mentions : Object.values(mentions);
  return arr
    .map((m) => String(m?.uid ?? m?.id ?? "").trim().split("_")[0])
    .filter((id) => /^\d+$/.test(id));
}

function parseUnderscoreTaskPayload(body, message, maxRepeatCap = 20) {
  let contentText = "";
  let repeatCount = 1;
  const extraTokens = [];

  if (body.includes("_")) {
    const segs = body.split("_").map((s) => s.trim());
    contentText = segs[0] || "";
    if (segs.length >= 2 && segs[1]) {
      const subTokens = segs[1].split(/\s+/).filter(Boolean);
      const parsedCount = Number.parseInt(subTokens[0], 10);
      if (!Number.isNaN(parsedCount) && parsedCount > 0) {
        repeatCount = parsedCount;
        extraTokens.push(...subTokens.slice(1));
      } else {
        extraTokens.push(...subTokens);
      }
    }
    for (let i = 2; i < segs.length; i++) {
      if (segs[i]) {
        extraTokens.push(...segs[i].split(/\s+/).filter(Boolean));
      }
    }
  } else {
    const tokens = body.trim().split(/\s+/).filter(Boolean);
    const hasMentionsOrQuote = collectMentionUids(message).length > 0 || Boolean(getQuotedUid(message));
    if (!hasMentionsOrQuote && tokens.length >= 2 && /^\d{6,24}$/.test(tokens[tokens.length - 1])) {
      extraTokens.push(tokens.pop());
    }
    contentText = tokens.join(" ").trim();
  }

  const userIds = resolveTargetUsers(message, extraTokens);
  repeatCount = Math.min(Math.max(repeatCount, 1), maxRepeatCap);
  return { contentText, repeatCount, userIds };
}

async function syncPolicyCaches() {
  reloadCommandConfig();
  try {
    const mod = await import("../command.js");
    if (typeof mod.invalidateRuntimePolicyCache === "function") {
      mod.invalidateRuntimePolicyCache();
    }
  } catch {}
}

let activeTodo = false;

export function stopTodo() {
  activeTodo = false;
}

export async function handleChangeGroupLink(api, message) {
  try {
    const threadId = message.threadId;
    const res = await api.changeGroupLink(threadId);
    const newLink = typeof res === "string"
      ? res.trim()
      : String(res?.link || res?.url || res?.groupLink || res?.data?.link || "").trim();
    const confirmMsg = newLink
      ? `✅ Đã đổi link nhóm thành công!\n🔗 Link mới: ${newLink}`
      : "✅ Đã đổi link nhóm thành công!";
    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: confirmMsg,
      },
      true,
      120000
    );
  } catch (error) {
    const errText = error?.message || String(error);
    await sendMessageFailed(api, message, `Lỗi khi đổi link nhóm: ${errText}`);
  }
}

export { handleUndoMessage } from "./undo-message.js";

export async function handleSendToDo(api, message, aliasCommand = "todo") {
  const senderId = String(message?.data?.uidFrom || "");
  const prefix = getGlobalPrefix();
  const effectiveAlias = String(aliasCommand || message?.aliasCommand || "todo").trim();
  const msgType = safeThreadType(message);

  const cleaned = (removeMention(message) || String(message?.data?.content || "")).trim();
  const stripPattern = new RegExp(
    `^\\s*${escapeRegExp(prefix)}\\s*(?:${escapeRegExp(effectiveAlias)}|todo)(?:[\\s_]+|$)`,
    "i"
  );
  const body = stripPattern.test(cleaned) ? cleaned.replace(stripPattern, "").trim() : "";

  if (body.toLowerCase() === "stop") {
    if (activeTodo) {
      stopTodo();
      await sendMessageFromSQL(
        api,
        message,
        {
          success: true,
          message: "Đã dừng tất cả các todo đang chạy!",
        },
        false,
        30000
      );
    } else {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: "Không có todo nào đang chạy!",
        },
        false,
        30000
      );
    }
    return;
  }

  if (!body) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message:
          `Cú pháp không đúng. Vui lòng sử dụng:\n` +
          `${prefix}todo_[Nội dung công việc]_[Số lần] @user\n` +
          `hoặc: ${prefix}todo [Nội dung công việc]_[Số lần] @user\n` +
          `hoặc: ${prefix}todo stop`,
      },
      false,
      30000
    );
    return;
  }

  try {
    const parsed = parseUnderscoreTaskPayload(body, message, 20);
    const todoContent = parsed.contentText;
    let repeatCount = parsed.repeatCount;
    let userIds = parsed.userIds;

    if (!todoContent) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không có nội dung công việc!`,
        },
        false,
        30000
      );
      return;
    }

    if (!isAdmin(senderId) && repeatCount > 3) {
      repeatCount = 3;
    }

    if (
      userIds.length === 0 &&
      msgType === MessageType.DirectMessage &&
      message?.threadId &&
      String(message.threadId) !== senderId &&
      /^\d+$/.test(String(message.threadId))
    ) {
      userIds = [String(message.threadId)];
    }

    if (userIds.length === 0) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không tìm thấy mục tiêu để giao việc! Hãy @tag, reply hoặc nhập UID người nhận.`,
        },
        false,
        30000
      );
      return;
    }

    const userInfo = await getUserInfoData(api, userIds[0]).catch(() => null);
    const targetName = userInfo?.name || userIds[0];

    const targetText =
      userIds.length === 1 && userIds[0] === senderId
        ? "bản thân"
        : userIds.length === 1
          ? `người dùng ${targetName}`
          : `${userIds.length} người`;

    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: `Đã giao việc "${todoContent}" ${repeatCount} lần cho ${targetText}`,
      },
      false,
      30000
    );

    activeTodo = true;
    for (let i = 0; i < repeatCount; i++) {
      if (!activeTodo) {
        break;
      }
      await api.sendTodo(message, todoContent, userIds, -1, todoContent);
      if (i + 1 < repeatCount) {
        await sleep(400);
      }
    }
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi giao việc: ${error.message}`,
      },
      false,
      30000
    );
  }
}

/**
 * Tính độ tương đồng giữa 2 chuỗi sử dụng thuật toán Levenshtein Distance
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1)
    .fill()
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j - 1] + 1, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
      }
    }
  }

  return dp[m][n];
}

/**
 * Tìm các lệnh tương tự dựa trên độ tương đồng của chuỗi
 */
function findSimilarCommands(command, availableCommands, threshold = 0.6) {
  const similarCommands = [];
  const commandLower = command.toLowerCase();

  // Tách command thành các ký tự riêng lẻ
  const commandChars = commandLower.split("");

  // Map các viết tắt phổ biến
  const commonShortcuts = {
    dy: "daily",
    dk: "dangky",
    nt: "nongtrai",
    tx: "taixiu",
    kbb: "keobuabao",
    tt: "thongtin",
    bg: "background",
  };

  for (const cmd of availableCommands) {
    const cmdNameLower = cmd.name.toLowerCase();

    // Kiểm tra các trường hợp:
    const isStartsWith = cmdNameLower.startsWith(commandLower);

    // Kiểm tra viết tắt phổ biến
    const isCommonShortcut = commonShortcuts[commandLower] === cmdNameLower;

    // Kiểm tra xem các ký tự của command có xuất hiện theo thứ tự trong tên lệnh Không
    let matchesSequence = true;
    let lastIndex = -1;
    for (const char of commandChars) {
      const index = cmdNameLower.indexOf(char, lastIndex + 1);
      if (index === -1) {
        matchesSequence = false;
        break;
      }
      lastIndex = index;
    }

    // Tính độ tương đồng bằng Levenshtein
    const distance = levenshteinDistance(commandLower, cmdNameLower);
    const similarity = 1 - distance / Math.max(command.length, cmd.name.length);

    // Thêm vào danh sách nếu thỏa mãn một trong các điều kiện
    if (isStartsWith || isCommonShortcut || matchesSequence || similarity >= threshold) {
      similarCommands.push({
        command: cmd,
        similarity: isStartsWith ? 1 : isCommonShortcut ? 0.95 : matchesSequence ? 0.9 : similarity,
      });
    }
  }

  return similarCommands
    .sort((a, b) => {
      // Đầu tiên sắp xếp theo quyền hạn
      const permissionDiff = (ROLE_LEVELS[a.permission] ?? 0) - (ROLE_LEVELS[b.permission] ?? 0);
      if (permissionDiff !== 0) return permissionDiff;

      // Nếu cùng quyền hạn thì sắp xếp theo độ tương đồng (cao xuống thấp)
      return b.similarity - a.similarity;
    })
    .slice(0, 5)
    .map((item) => item.command);
}

/**
 * Kiểm tra và gợi ý lệnh khi Không tìm thấy command
 */
export async function checkNotFindCommand(api, message, command, availableCommands) {
  const prefix = getGlobalPrefix();

  if (!command || command.trim() === "") {
    try {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message:
            `Nếu Mày Thắc Mắc Tao Có Những Lệnh Gì, Hãy:\n` +
            `${prefix}help - Xem hướng dẫn sử dụng\n` +
            `${prefix}game - Xem hướng dẫn chơi game\n` +
            `${prefix}command - Xem danh sách lệnh có sẵn`,
        },
        false,
        30000
      );
    } catch (error) {
      console.error("Lỗi khi gửi tin nhắn không tìm thấy lệnh (rỗng):", error);
    }
    return;
  }

  const similarCommands = findSimilarCommands(command, availableCommands);

  try {
    if (similarCommands.length > 0) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message:
            `Không tìm thấy lệnh "${command}"\n` +
            `Có phải mày muốn dùng:\n` +
            similarCommands.map((cmd) => `${prefix}${cmd.name} [${getPermissionCommandName(cmd)}]`).join("\n"),
        },
        false,
        30000
      );
    } else {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message:
            `Không tìm thấy lệnh "${command}". Vui lòng sử dụng:\n` +
            `${prefix}help - Xem hướng dẫn sử dụng\n` +
            `${prefix}game - Xem hướng dẫn chơi game\n` +
            `${prefix}command - Xem danh sách lệnh có sẵn`,
        },
        false,
        30000
      );
    }
  } catch (error) {
    console.error("Lỗi khi gửi tin nhắn không tìm thấy lệnh:", error);
  }
}

async function handleAcpFriendAlias(api, message) {
  const prefix = getGlobalPrefix();
  const cleanArgs = extractCleanArgs(message, prefix, "acp");
  const sub = (cleanArgs[0] || "").trim().toLowerCase();

  if (typeof api?.acceptFriendRequest !== "function") {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: "API hiện tại chưa hỗ trợ chấp nhận lời mời kết bạn.",
      },
      false,
      30000
    );
    return true;
  }

  if (sub === "all") {
    try {
      let requests = [];
      if (typeof api.getPendingFriendRequests === "function") {
        const res = await api.getPendingFriendRequests().catch(() => null);
        requests = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      }
      if (requests.length === 0 && typeof api.getFriendRequests === "function") {
        const res = await api.getFriendRequests().catch(() => null);
        requests = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      }
      const uids = [
        ...new Set(
          requests
            .map((item) => String(item?.userId ?? item?.uid ?? item?.id ?? "").trim())
            .filter(Boolean)
        ),
      ];
      if (uids.length === 0) {
        await sendMessageFromSQL(
          api,
          message,
          {
            success: false,
            message: "📭 Hiện không có lời mời kết bạn nào đang chờ duyệt!",
          },
          false,
          60000
        );
        return true;
      }

      let okCount = 0;
      let failCount = 0;
      for (let i = 0; i < uids.length; i++) {
        try {
          await api.acceptFriendRequest(uids[i]);
          okCount++;
        } catch {
          failCount++;
        }
        if (i + 1 < uids.length) {
          await sleep(500);
        }
      }

      await sendMessageFromSQL(
        api,
        message,
        {
          success: okCount > 0,
          message: `✅ Đã chấp nhận ${okCount}/${uids.length} lời mời kết bạn${failCount > 0 ? ` (Thất bại: ${failCount})` : ""}!`,
        },
        true,
        120000
      );
    } catch (error) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Lỗi khi duyệt danh sách kết bạn: ${error?.message || error}`,
        },
        false,
        60000
      );
    }
    return true;
  }

  const targets = resolveTargetUsers(message, cleanArgs);
  if (targets.length === 0) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message:
          `📌 Hướng dẫn duyệt lời mời kết bạn:\n` +
          `• ${prefix}acp <UID | @mention | reply>: Chấp nhận lời mời kết bạn\n` +
          `• ${prefix}acp all: Chấp nhận tất cả lời mời đang chờ\n` +
          `💡 Gõ ${prefix}waitinglist để xem danh sách chờ kết bạn.`,
      },
      false,
      90000
    );
    return true;
  }

  const accepted = [];
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const uid = targets[i];
    try {
      await api.acceptFriendRequest(uid);
      accepted.push(uid);
    } catch (error) {
      failed.push(`${uid} (${error?.message || "Lỗi"})`);
    }
    if (i + 1 < targets.length) {
      await sleep(400);
    }
  }

  const lines = [];
  if (accepted.length > 0) lines.push(`✅ Đã chấp nhận kết bạn: ${accepted.join(", ")}`);
  if (failed.length > 0) lines.push(`❌ Không thể chấp nhận: ${failed.join(", ")}`);

  await sendMessageFromSQL(
    api,
    message,
    {
      success: accepted.length > 0,
      message: lines.join("\n"),
    },
    true,
    120000
  );
  return true;
}

async function handleFixCmdAlias(api, message) {
  try {
    const cfg = reloadCommandConfig() || { prefix: "!", commands: [] };
    if (!Array.isArray(cfg.commands)) cfg.commands = [];

    const validAliasPool = new Set();
    for (const def of commandRegistry?.definitions || []) {
      for (const a of def.aliases || []) {
        if (a) validAliasPool.add(String(a).trim().toLowerCase());
      }
    }

    let cleanedAliasEntries = 0;
    for (const cmd of cfg.commands) {
      if (!Array.isArray(cmd.alias)) continue;
      const before = cmd.alias.length;
      const unique = [
        ...new Set(
          cmd.alias
            .map((a) => String(a || "").trim().toLowerCase())
            .filter((a) => a && a !== String(cmd.name || "").toLowerCase())
        ),
      ];
      cleanedAliasEntries += Math.max(0, before - unique.length);
      cmd.alias = unique;
      for (const a of unique) validAliasPool.add(a);
    }

    const rawDisabled = Array.isArray(cfg.disabledAliases) ? cfg.disabledAliases : [];
    const cleanedDisabled = [
      ...new Set(
        rawDisabled
          .map((item) => String(item || "").trim().toLowerCase())
          .filter((item) => item && !PROTECTED_CANONICAL_COMMANDS.has(item) && validAliasPool.has(item))
      ),
    ];
    const removedDisabledCount = Math.max(0, rawDisabled.length - cleanedDisabled.length);
    cfg.disabledAliases = cleanedDisabled;

    writeCommandConfig(cfg);
    await syncPolicyCaches();

    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message:
          `✅ Đã làm mới cấu hình lệnh & đồng bộ bộ nhớ đệm thành công!\n` +
          `• Tổng lệnh cấu hình: ${cfg.commands.length}\n` +
          `• Đã dọn alias trùng/lỗi: ${cleanedAliasEntries}\n` +
          `• Đã làm sạch disabledAliases: ${removedDisabledCount} mục lỗi (hiện có ${cleanedDisabled.length})`,
      },
      true,
      120000
    );
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi đồng bộ lại cấu hình lệnh: ${error?.message || error}`,
      },
      false,
      60000
    );
  }
  return true;
}

/**
 * Xử lý thêm alias cho command & các alias tiện ích (acp, addcmd, removecmd, cmdfind, fixcmd)
 */
export async function handleAliasCommand(api, message, commandParts = [], options = {}) {
  const prefix = getGlobalPrefix();
  const invokedAlias = String(
    options?.aliasCommand || message?.aliasCommand || commandParts?.[0] || "alias"
  )
    .trim()
    .toLowerCase();

  if (invokedAlias === "acp") {
    return handleAcpFriendAlias(api, message);
  }

  if (invokedAlias === "addcmd") {
    const body = extractCommandBody(message, prefix, "addcmd");
    const rest = body
      ? [body]
      : Array.isArray(commandParts) && commandParts.length > 1
        ? commandParts.slice(1)
        : [];
    return handleCmdaddCommand(api, message, ["cmdadd", ...rest], { root: options?.root });
  }

  if (invokedAlias === "removecmd") {
    let rest = Array.isArray(commandParts) && commandParts.length > 1
      ? commandParts.slice(1)
      : extractCleanArgs(message, prefix, "removecmd");
    if (["del", "remove", "rm", "delete"].includes(String(rest[0] || "").toLowerCase())) {
      rest = rest.slice(1);
    }
    return handleCmdaddCommand(api, message, ["cmdadd", "del", ...rest], { root: options?.root });
  }

  if (invokedAlias === "cmdfind") {
    const rest = Array.isArray(commandParts) && commandParts.length > 1
      ? commandParts.slice(1)
      : extractCleanArgs(message, prefix, "cmdfind");
    return listCommands(api, message, ["find", ...rest]);
  }

  if (invokedAlias === "fixcmd") {
    return handleFixCmdAlias(api, message);
  }

  const parts = Array.isArray(commandParts) && commandParts.length > 0
    ? commandParts
    : ["alias", ...extractCleanArgs(message, prefix, "alias")];
  const subCommand = parts[1]?.toLowerCase();
  const arg1 = parts[2]?.toLowerCase();
  const arg2 = parts[3]?.toLowerCase();

  if (!subCommand) {
    await handleListAlias(api, message, undefined, options?.root);
    return;
  }

  switch (subCommand) {
    case "add":
      if (!arg1 || !arg2) {
        await sendMessageFromSQL(
          api,
          message,
          {
            success: false,
            message: `Cú pháp không đúng. Vui lòng sử dụng:\n${prefix}alias add [tên lệnh] [tên alias]`,
          },
          false,
          300000
        );
        return;
      }
      await handleAddAlias(api, message, arg1, arg2);
      break;

    case "remove":
      if (!arg1) {
        await sendMessageFromSQL(
          api,
          message,
          {
            success: false,
            message:
              `Cú pháp không đúng. Vui lòng sử dụng:\n` +
              `• ${prefix}alias remove [tên lệnh] [tên alias]\n` +
              `• ${prefix}alias remove [tên alias]`,
          },
          false,
          300000
        );
        return;
      }
      await handleRemoveAlias(api, message, arg2 ? arg1 : null, arg2 || arg1);
      break;

    case "list":
      await handleListAlias(api, message, arg1, options?.root);
      break;

    default:
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message:
            `Cú pháp không đúng. Sử dụng:\n` +
            `${prefix}alias add [tên lệnh] [tên alias] - Thêm alias\n` +
            `${prefix}alias remove [tên lệnh] [tên alias] - Xóa/tắt alias\n` +
            `${prefix}alias list [tên lệnh] - Xem danh sách alias\n` +
            `${prefix}alias - Xem tất cả alias`,
        },
        false,
        300000
      );
      break;
  }
}

export async function handleAddAlias(api, message, commandName, aliasName) {
  try {
    const commandConfig = getCommandConfig();
    const command = commandConfig.commands.find((cmd) => cmd.name === commandName);

    if (!command) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không tìm thấy lệnh "${commandName}" để thêm alias`,
        },
        false,
        300000
      );
      return;
    }

    if (!Array.isArray(command.alias)) {
      command.alias = [];
    }

    const disabledSet = new Set(
      (Array.isArray(commandConfig.disabledAliases) ? commandConfig.disabledAliases : [])
        .map((a) => String(a || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const wasDisabled = disabledSet.has(aliasName);
    if (wasDisabled) {
      disabledSet.delete(aliasName);
      commandConfig.disabledAliases = [...disabledSet];
    }

    const registryDef = commandRegistry?.definitions?.find((d) => d.name === commandName);
    const isBuiltInOfSameCmd = Boolean(
      registryDef?.aliases?.some((a) => String(a).toLowerCase() === aliasName)
    );

    if (command.alias.includes(aliasName) || (isBuiltInOfSameCmd && wasDisabled)) {
      if (wasDisabled) {
        if (!command.alias.includes(aliasName)) {
          command.alias.push(aliasName);
        }
        writeCommandConfig(commandConfig);
        await syncPolicyCaches();
        await sendMessageFromSQL(
          api,
          message,
          {
            success: true,
            message: `Đã khôi phục alias "${aliasName}" cho lệnh "${commandName}"`,
          },
          false,
          300000
        );
        return;
      }

      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Alias "${aliasName}" đã tồn tại cho lệnh "${commandName}"`,
        },
        false,
        300000
      );
      return;
    }

    const isAliasExist = commandConfig.commands.some(
      (cmd) => cmd.name === aliasName || (cmd.alias && cmd.alias.includes(aliasName))
    );

    if (isAliasExist) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không thể thêm alias "${aliasName}" vì đã tồn tại như một lệnh hoặc alias khác`,
        },
        false,
        300000
      );
      return;
    }

    command.alias.push(aliasName);
    commandConfig.disabledAliases = [...disabledSet];
    writeCommandConfig(commandConfig);
    await syncPolicyCaches();

    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: `Đã thêm alias "${aliasName}" cho lệnh "${commandName}"`,
      },
      false,
      300000
    );
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi thêm alias: ${error.message}`,
      },
      false,
      300000
    );
  }
}

/**
 * Xử lý xóa alias của command (kèm lưu vào disabledAliases để vô hiệu hóa được cả alias mặc định)
 */
export async function handleRemoveAlias(api, message, commandName, aliasName) {
  try {
    const normalizedTargetAlias = String(aliasName || "").trim().toLowerCase();
    if (!normalizedTargetAlias || PROTECTED_CANONICAL_COMMANDS.has(normalizedTargetAlias)) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không thể xóa/vô hiệu hóa lệnh hệ thống "${normalizedTargetAlias}"!`,
        },
        false,
        300000
      );
      return;
    }

    const commandConfig = getCommandConfig();
    let command = commandName
      ? commandConfig.commands.find((cmd) => cmd.name === commandName)
      : commandConfig.commands.find((cmd) => Array.isArray(cmd.alias) && cmd.alias.includes(normalizedTargetAlias));

    let registryOwner = commandRegistry?.definitions?.find((def) =>
      (commandName ? def.name === commandName : true) &&
      Array.isArray(def.aliases) &&
      def.aliases.some((a) => String(a).toLowerCase() === normalizedTargetAlias)
    );

    if (!command && registryOwner) {
      command = commandConfig.commands.find((cmd) => cmd.name === registryOwner.name) || null;
    }

    if (commandName && !command && !registryOwner) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không tìm thấy lệnh "${commandName}" để xóa alias`,
        },
        false,
        300000
      );
      return;
    }

    const hasInConfig = Boolean(command?.alias && command.alias.includes(normalizedTargetAlias));
    const hasInRegistry = Boolean(registryOwner);

    if (!hasInConfig && !hasInRegistry) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: commandName
            ? `Không tìm thấy alias "${normalizedTargetAlias}" trong lệnh "${commandName}"`
            : `Không tìm thấy alias "${normalizedTargetAlias}" trong hệ thống`,
        },
        false,
        300000
      );
      return;
    }

    if (command && Array.isArray(command.alias)) {
      command.alias = command.alias.filter((a) => a !== normalizedTargetAlias);
    }

    const disabledSet = new Set(
      (Array.isArray(commandConfig.disabledAliases) ? commandConfig.disabledAliases : [])
        .map((a) => String(a || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (hasInRegistry || hasInConfig) {
      disabledSet.add(normalizedTargetAlias);
    }
    commandConfig.disabledAliases = [...disabledSet];

    writeCommandConfig(commandConfig);
    await syncPolicyCaches();

    const ownerLabel = command?.name || registryOwner?.name || commandName || "hệ thống";
    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: `Đã xóa/vô hiệu hóa alias "${normalizedTargetAlias}" khỏi lệnh "${ownerLabel}"`,
      },
      false,
      300000
    );
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi xóa alias: ${error.message}`,
      },
      false,
      300000
    );
  }
}

/**
 * Xử lý hiển thị danh sách alias của command
 */
export async function handleListAlias(api, message, commandName, root = undefined) {
  try {
    const commandConfig = getCommandConfig();
    const disabledSet = new Set(
      (Array.isArray(commandConfig.disabledAliases) ? commandConfig.disabledAliases : [])
        .map((a) => String(a || "").trim().toLowerCase())
        .filter(Boolean)
    );

    if (commandName) {
      const command = commandConfig.commands.find((cmd) => cmd.name === commandName);
      const regDef = commandRegistry?.definitions?.find((d) => d.name === commandName);

      if (!command && !regDef) {
        await sendMessageFromSQL(
          api,
          message,
          {
            success: false,
            message: `Không tìm thấy lệnh "${commandName}"`,
          },
          false,
          300000
        );
        return;
      }

      const mergedAliases = [
        ...new Set([...(regDef?.aliases || []), ...(command?.alias || [])]),
      ].filter((a) => !disabledSet.has(String(a).toLowerCase()));

      await sendMessageFromSQL(
        api,
        message,
        {
          success: true,
          message:
            mergedAliases.length > 0
              ? `Danh sách alias của lệnh "${commandName}":\n${mergedAliases.join(", ")}`
              : `Lệnh "${commandName}" không có alias nào đang bật`,
        },
        false,
        300000
      );
    } else {
      const byCommand = new Map();
      for (const def of commandRegistry?.definitions || []) {
        if (Array.isArray(def.aliases) && def.aliases.length > 0) {
          byCommand.set(def.name, new Set(def.aliases));
        }
      }
      for (const cmd of commandConfig.commands || []) {
        if (Array.isArray(cmd.alias) && cmd.alias.length > 0) {
          if (!byCommand.has(cmd.name)) byCommand.set(cmd.name, new Set());
          const set = byCommand.get(cmd.name);
          for (const a of cmd.alias) set.add(a);
        }
      }

      const aliasLines = [];
      for (const [name, set] of byCommand.entries()) {
        const activeAliases = [...set].filter((a) => !disabledSet.has(String(a).toLowerCase()));
        if (activeAliases.length > 0) {
          aliasLines.push(`• ${name}: ${activeAliases.join(", ")}`);
        }
      }

      let customSection = "";
      try {
        const customRes = listCustomCommands({ page: 1, root });
        if (Array.isArray(customRes?.commands) && customRes.commands.length > 0) {
          customSection = `\n\n🧩 Lệnh custom (${customRes.total ?? customRes.commands.length}): ${customRes.commands.map((c) => c.name).join(", ")}`;
        }
      } catch {}

      const disabledNote = disabledSet.size > 0
        ? `\n🚫 Alias đang tắt (${disabledSet.size}): ${[...disabledSet].join(", ")}`
        : "";

      const fullText = aliasLines.length > 0
        ? `📋 Danh sách alias của các lệnh (${aliasLines.length} lệnh):\n${aliasLines.slice(0, 60).join("\n")}${aliasLines.length > 60 ? `\n... và ${aliasLines.length - 60} lệnh khác` : ""}${customSection}${disabledNote}`
        : `Không có alias nào được cấu hình${customSection}${disabledNote}`;

      await sendMessageFromSQL(
        api,
        message,
        {
          success: true,
          message: fullText,
        },
        false,
        300000
      );
    }
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi hiển thị alias: ${error.message}`,
      },
      false,
      300000
    );
  }
}

export async function handleSendMessagePrivate(api, message, aliasCommand = "sendp") {
  const senderId = String(message?.data?.uidFrom || "");
  const prefix = getGlobalPrefix();
  const effectiveAlias = String(aliasCommand || message?.aliasCommand || "sendp").trim();

  const cleaned = (removeMention(message) || String(message?.data?.content || "")).trim();
  const stripPattern = new RegExp(
    `^\\s*${escapeRegExp(prefix)}\\s*(?:${escapeRegExp(effectiveAlias)}|sendprivate|sendp)(?:[\\s_]+|$)`,
    "i"
  );
  const body = stripPattern.test(cleaned) ? cleaned.replace(stripPattern, "").trim() : "";

  if (!body) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message:
          `Cú pháp không đúng. Vui lòng sử dụng:\n` +
          `${prefix}sendp_[Nội dung tin nhắn]_[Số lần <= 20] @user\n` +
          `hoặc: ${prefix}sendp [Nội dung tin nhắn]_[Số lần <= 20] [UID | @user]`,
      },
      false,
      30000
    );
    return;
  }

  try {
    const parsed = parseUnderscoreTaskPayload(body, message, 20);
    const smsContent = parsed.contentText;
    const repeatCount = Math.min(Math.max(parsed.repeatCount, 1), 20);
    const userIds = parsed.userIds;

    if (!smsContent) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không có nội dung tin nhắn!`,
        },
        false,
        30000
      );
      return;
    }

    if (userIds.length === 0) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không tìm thấy người nhận! Hãy @tag, reply hoặc nhập UID người nhận.`,
        },
        false,
        30000
      );
      return;
    }

    const userInfo = await getUserInfoData(api, userIds[0]).catch(() => null);
    const targetName = userInfo?.name || userIds[0];

    const targetText =
      userIds.length === 1 && userIds[0] === senderId
        ? "bản thân"
        : userIds.length === 1
          ? `người dùng ${targetName}`
          : `${userIds.length} người`;

    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: `Đã bắt đầu gửi tin nhắn riêng "${smsContent}" ${repeatCount} lần cho ${targetText}`,
      },
      false,
      30000
    );

    let sentCount = 0;
    let failedCount = 0;

    for (let uIdx = 0; uIdx < userIds.length; uIdx++) {
      const userId = userIds[uIdx];
      for (let i = 0; i < repeatCount; i++) {
        try {
          await api.sendMessage(smsContent, userId, MessageType.DirectMessage);
          sentCount++;
        } catch (error) {
          failedCount++;
          console.error(`Lỗi khi gửi tin nhắn riêng cho ${userId}:`, error?.message || error);
        }
        if (i + 1 < repeatCount || uIdx + 1 < userIds.length) {
          await sleep(600);
        }
      }
    }

    await sendMessageFromSQL(
      api,
      message,
      {
        success: sentCount > 0,
        message: `Đã hoàn thành gửi tin nhắn riêng cho ${targetText}: Thành công ${sentCount}${failedCount > 0 ? `, Thất bại ${failedCount}` : ""}.`,
      },
      false,
      30000
    );
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi gửi tin nhắn riêng: ${error.message}`,
      },
      false,
      30000
    );
  }
}

export async function handleSendTaskCommand(api, message, groupSettings, commandConfig = null) {
  const content = removeMention(message);
  const status = content.split(" ")[1]?.toLowerCase();
  const threadId = message.threadId;

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  let newStatus;
  if (status === "on") {
    groupSettings[threadId].sendTask = true;
    newStatus = "bật";
  } else if (status === "off") {
    groupSettings[threadId].sendTask = false;
    newStatus = "tắt";
  } else {
    groupSettings[threadId].sendTask = !groupSettings[threadId].sendTask;
    newStatus = groupSettings[threadId].sendTask ? "bật" : "tắt";
  }

  writeGroupSettings(groupSettings);
  const caption = resolveSendtaskCaption(commandConfig, { status, state: newStatus });
  await sendMessageStateQuote(api, message, caption, groupSettings[threadId].sendTask, 300000);

  return true;
}

export const SENDTASK_FALLBACK_TEMPLATES = Object.freeze({
  on: "Đã bật chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!",
  off: "Đã tắt chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!",
  toggle: "Đã {state} chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!",
});

export function resolveSendtaskCaption(commandConfig, { status, state }) {
  let templates = SENDTASK_FALLBACK_TEMPLATES;
  try {
    const effective = commandConfig?.effective;
    if (effective) {
      templates = {
        on: effective["responses.messages.on"] || SENDTASK_FALLBACK_TEMPLATES.on,
        off: effective["responses.messages.off"] || SENDTASK_FALLBACK_TEMPLATES.off,
        toggle: effective["responses.messages.toggle"] || SENDTASK_FALLBACK_TEMPLATES.toggle,
      };
    }
  } catch {}
  if (status === "on") return templates.on;
  if (status === "off") return templates.off;
  return String(templates.toggle).replace(/\{state\}/g, state);
}

export async function handleGetLinkInQuote(api, message) {
  const quote = getQuoteData(message);
  if (!quote) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Vui lòng reply vào tin nhắn chứa ảnh, video, file hoặc đường dẫn để lấy link!`,
      },
      false,
      30000
    );
    return;
  }

  try {
    const seen = new Set();
    const urls = [];
    const pushUrl = (raw) => {
      if (!raw || typeof raw !== "string") return;
      const unescaped = raw.replace(/\\\//g, "/").trim().replace(/[),.;'"<>\]}]+$/, "");
      if (!/^https?:\/\//i.test(unescaped) || seen.has(unescaped)) return;
      seen.add(unescaped);
      urls.push(unescaped);
    };

    const extractUrlsFromText = (text) => {
      if (!text || typeof text !== "string") return;
      const normalized = text.replace(/\\\//g, "/");
      const matches = normalized.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      for (const m of matches) pushUrl(m);
    };

    if (quote.attach) {
      let attachData = null;
      if (typeof quote.attach === "object") {
        attachData = quote.attach;
      } else if (typeof quote.attach === "string") {
        try {
          attachData = JSON.parse(quote.attach);
        } catch {
          extractUrlsFromText(quote.attach);
        }
      }

      if (attachData && typeof attachData === "object") {
        for (const key of [
          "hdUrl",
          "oriUrl",
          "normalUrl",
          "href",
          "fileUrl",
          "thumbUrl",
          "url",
          "streamUrl",
        ]) {
          if (typeof attachData[key] === "string") {
            pushUrl(attachData[key]);
          }
        }
        if (attachData.params) {
          if (typeof attachData.params === "string") {
            try {
              const pObj = JSON.parse(attachData.params);
              for (const k of ["hd", "hdUrl", "oriUrl", "rawUrl", "url", "href"]) {
                if (typeof pObj?.[k] === "string") pushUrl(pObj[k]);
              }
            } catch {
              extractUrlsFromText(attachData.params);
            }
          } else if (typeof attachData.params === "object") {
            for (const k of ["hd", "hdUrl", "oriUrl", "rawUrl", "url", "href"]) {
              if (typeof attachData.params[k] === "string") pushUrl(attachData.params[k]);
            }
          }
        }
      }
    }

    extractUrlsFromText(quote.msg);
    if (typeof quote.content === "string") {
      extractUrlsFromText(quote.content);
    } else if (quote.content && typeof quote.content === "object") {
      for (const key of ["href", "hdUrl", "oriUrl", "normalUrl", "fileUrl", "thumbUrl", "title", "description"]) {
        if (typeof quote.content[key] === "string") {
          extractUrlsFromText(quote.content[key]);
        }
      }
    }

    if (urls.length === 0) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không tìm thấy link trong tin nhắn được reply!`,
        },
        false,
        30000
      );
      return;
    }

    const formatted = urls.length === 1
      ? `Link: ${urls[0]}`
      : `🔗 Tìm thấy ${urls.length} link:\n${urls.map((u, idx) => `${idx + 1}. ${u}`).join("\n")}`;

    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: formatted,
      },
      false,
      180000
    );
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Lỗi khi xử lý link: ${error.message}`,
      },
      false,
      30000
    );
  }
}
