import path from "path";
import { getGlobalPrefix, setGlobalPrefix } from "../../service-debug/service.js";
import { getBotInfoSync } from "../../utils/env.js";
import { reloadCommandConfig } from "../../utils/io-json.js";
import { removeMention } from "../../utils/format-util.js";
import { resolveInstanceAuthorization } from "../../utils/instance-authorization.js";
import {
  createBotRuntimeContext,
  updateCommandPrefixFile,
} from "../../utils/bot-runtime-context.js";
import { safeThreadType } from "../shared/command-input-utils.js";
import { invalidateRuntimePolicyCache } from "../command.js";

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRuntimeCommandPaths() {
  const botInfo = getBotInfoSync() || {};
  const runtimeContext = createBotRuntimeContext(botInfo);
  const paths = [
    runtimeContext.commandConfigPath,
    botInfo.commandFilePath ? path.join(runtimeContext.projectRoot, botInfo.commandFilePath) : null,
  ].filter(Boolean);
  return paths.filter((filePath, index, allPaths) => allPaths.indexOf(filePath) === index);
}

async function safeSendMessage(api, payload, threadId, messageType, quoteMessage) {
  const resolvedType = messageType ?? safeThreadType(quoteMessage);
  try {
    if (api && typeof api.sendMessage === "function") {
      try {
        return await api.sendMessage(
          { ...payload, quote: quoteMessage },
          threadId,
          resolvedType
        );
      } catch (quoteErr) {
        try {
          return await api.sendMessage(
            { ...payload, quote: undefined },
            threadId,
            resolvedType
          );
        } catch (fallbackErr) {
          console.error("Lỗi khi gửi tin nhắn fallback prefix:", fallbackErr?.message || fallbackErr);
        }
      }
    }
  } catch (err) {
    console.error("Lỗi safeSendMessage prefix:", err?.message || err);
  }
  return null;
}

export async function handlePrefixCommand(api, message, isAdminLevelHighestOrThreadId, maybeAdmin) {
  const hasExplicitAdminBoolean =
    typeof maybeAdmin === "boolean" || typeof isAdminLevelHighestOrThreadId === "boolean";
  const threadId = (typeof isAdminLevelHighestOrThreadId === "string" && isAdminLevelHighestOrThreadId)
    ? isAdminLevelHighestOrThreadId
    : (message?.threadId || message?.data?.idTo || message?.data?.threadId);
  const messageType = safeThreadType(message);

  const cleanedMentionText = removeMention(message);
  const rawContent = cleanedMentionText || message?.data?.content || message?.content || "";
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  const currentPrefix = getGlobalPrefix() || "!";
  const lowerContent = content.toLowerCase();

  const isBarePrefix = lowerContent === "prefix";
  const prefixedMatch = content.match(
    new RegExp(`^${escapeRegExp(currentPrefix)}prefix(?:\\s+([\\s\\S]*))?$`, "i")
  );

  if (isBarePrefix) {
    await safeSendMessage(
      api,
      {
        msg: `Prefix bây giờ của bot là: ${currentPrefix}`,
        ttl: 30000,
      },
      threadId,
      messageType,
      message
    );
    return true;
  }

  if (!prefixedMatch) {
    return false;
  }

  const args = (prefixedMatch[1] || "").trim();

  // Bare "<prefix>prefix" (no arguments) in BOTH group and DM displays current prefix to any caller
  if (!args) {
    await safeSendMessage(
      api,
      {
        msg: `Prefix bây giờ của bot là: ${currentPrefix}`,
        ttl: 30000,
      },
      threadId,
      messageType,
      message
    );
    return true;
  }

  let isAdmin = typeof maybeAdmin === "boolean"
    ? maybeAdmin
    : (typeof isAdminLevelHighestOrThreadId === "boolean" ? isAdminLevelHighestOrThreadId : false);

  if (!hasExplicitAdminBoolean) {
    const senderUid = String(message?.data?.uidFrom || message?.senderId || "").trim();
    if (senderUid) {
      isAdmin = Boolean(
        resolveInstanceAuthorization({ senderId: senderUid, threadId: threadId || "" }).isAdminLevelHigh
      );
    }
  }

  if (!isAdmin) {
    await safeSendMessage(
      api,
      {
        msg: "❌ Không có quyền thay đổi prefix của bot!",
        ttl: 30000,
      },
      threadId,
      messageType,
      message
    );
    return true;
  }

  if (/\s/.test(args)) {
    await safeSendMessage(
      api,
      {
        msg: "❌ Prefix không được chứa khoảng trắng!",
        ttl: 30000,
      },
      threadId,
      messageType,
      message
    );
    return true;
  }

  try {
    updatePrefix(args);
    setGlobalPrefix(args);
    reloadCommandConfig();
    invalidateRuntimePolicyCache();
  } catch (error) {
    console.error("Lỗi khi cập nhật prefix:", error);
    await safeSendMessage(
      api,
      {
        msg: "❌ Đã xảy ra lỗi khi thay đổi prefix!",
        ttl: 30000,
      },
      threadId,
      messageType,
      message
    );
    return true;
  }

  await safeSendMessage(
    api,
    {
      msg: `✅ Prefix của bot đã được cập nhật thành công!\nPrefix mới là: ${args}`,
      ttl: 60000,
    },
    threadId,
    messageType,
    message
  );

  return true;
}

function updatePrefix(newPrefix) {
  try {
    const paths = getRuntimeCommandPaths();
    for (const filePath of paths) {
      updateCommandPrefixFile(filePath, newPrefix);
    }
  } catch (error) {
    console.error("Lỗi khi cập nhật prefix:", error);
    throw error;
  }
}
