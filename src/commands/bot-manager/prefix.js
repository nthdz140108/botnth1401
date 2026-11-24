import path from "path";
import { getGlobalPrefix, setGlobalPrefix } from "../../service-debug/service.js";
import { getBotInfo } from "../../utils/env.js";
import {
  createBotRuntimeContext,
  updateCommandPrefixFile,
} from "../../utils/bot-runtime-context.js";

function getRuntimeCommandPaths() {
  const botInfo = getBotInfo() || {};
  const runtimeContext = createBotRuntimeContext(botInfo);
  const paths = [
    runtimeContext.commandConfigPath,
    botInfo.commandFilePath ? path.join(runtimeContext.projectRoot, botInfo.commandFilePath) : null,
  ].filter(Boolean);
  return paths.filter((filePath, index, allPaths) => allPaths.indexOf(filePath) === index);
}

async function safeSendMessage(api, payload, threadId, messageType, quoteMessage) {
  try {
    if (api && typeof api.sendMessage === "function") {
      try {
        return await api.sendMessage(
          { ...payload, quote: quoteMessage },
          threadId,
          messageType
        );
      } catch (quoteErr) {
        // Fallback to sending without quote
        try {
          return await api.sendMessage(
            { ...payload, quote: undefined },
            threadId,
            messageType
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
  const isAdmin = typeof maybeAdmin === "boolean"
    ? maybeAdmin
    : (typeof isAdminLevelHighestOrThreadId === "boolean" ? isAdminLevelHighestOrThreadId : false);
  const threadId = (typeof isAdminLevelHighestOrThreadId === "string" && isAdminLevelHighestOrThreadId)
    ? isAdminLevelHighestOrThreadId
    : (message?.threadId || message?.data?.idTo || message?.data?.threadId);
  const messageType = message?.type;

  const rawContent = message?.data?.content || message?.content || "";
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  const currentPrefix = getGlobalPrefix() || "!";
  const lowerContent = content.toLowerCase();
  const lowerPrefix = currentPrefix.toLowerCase();

  const isBarePrefix = lowerContent === "prefix";
  const isPrefixedPrefixQuery = lowerContent === `${lowerPrefix}prefix`;
  const isPrefixedPrefixChange = lowerContent.startsWith(`${lowerPrefix}prefix `);

  // Bare "prefix" query or "<prefix>prefix" query without arguments
  if (isBarePrefix || isPrefixedPrefixQuery) {
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

  // Changing prefix MUST be prefixed with current prefix: "<currentPrefix>prefix <newPrefix>"
  if (!isPrefixedPrefixChange) {
    return false;
  }

  const args = content.slice(currentPrefix.length + 6).trim(); // +6 for "prefix"

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

  if (args.includes(" ")) {
    await safeSendMessage(
      api,
      {
        msg: "❌ Prefix Không được chứa khoảng trắng!",
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

