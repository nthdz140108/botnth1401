import * as cv from "../../utils/canvas/index.js";
import { extractCommandBody } from "../../commands/shared/command-input-utils.js";
import { getGlobalPrefix } from "../service.js";
import { getUserInfoData } from "./user-info-data.js";
import { getInstanceKind, getBotName } from "../../utils/env.js";

function logStage(stage, details = {}) {
  console.log(`[command:media] instance=${getInstanceKind()}:${getBotName()} command=info scope=${details.scope || "unknown"} stage=${stage}`, details);
}

export { getUserInfoData } from "./user-info-data.js";

function hasTextFlagToken(body) {
  const tokens = String(body || "").trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => /^-?text$/i.test(token));
}

function stripTextFlagTokens(body) {
  const tokens = String(body || "").trim().split(/\s+/).filter(Boolean);
  return tokens.filter((token) => !/^-?text$/i.test(token)).join(" ").trim();
}

export async function userInfoCommand(api, message, aliasCommand) {
  const threadId = message.threadId;
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const content = extractCommandBody(message, prefix, aliasCommand || "info");
  if (hasTextFlagToken(content)) {
    await userInfoCommandText(api, message, aliasCommand);
    return;
  }
  let imagePath = null;
  const mediaScope = message.type === 0 ? "private" : "group";
  try {
    const targetUserId = message.data.mentions?.[0]?.uid
        || (content === "-f" ? message.data?.idTo
        || threadId : content ? content : senderId);
    logStage("profile", { targetUserId, scope: mediaScope });
    const userInfo = await getUserInfoData(api, targetUserId);
    if (!userInfo) {
      await sendErrorMessage(api, message, threadId, "❌ Không thể lấy thông tin người dùng này.");
      return;
    }
    logStage("render", { targetUserId, scope: mediaScope });
    imagePath = await cv.createUserInfoImage(userInfo);
    logStage("upload", { imagePath, scope: mediaScope });
    await api.sendMessage(
      { msg: "", attachments: [imagePath], ttl: 6000000 }, // Added ttl: 6000000
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi lấy thông tin người dùng:", error);
    await sendErrorMessage(
      api,
      message,
      threadId,
      "❌ Đã xảy ra lỗi khi lấy thông tin người dùng. Vui lòng thử lại sau."
    );
  } finally {
    if (imagePath) {
      await cv.clearImagePath(imagePath);
    }
  }
}

export async function userInfoCommandText(api, message, aliasCommand) {
  const threadId = message.threadId;
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const rawBody = extractCommandBody(message, prefix, aliasCommand || "info");
  const content = stripTextFlagTokens(rawBody);
  try {
    const targetUserId = message.data.mentions?.[0]?.uid
        || (content === "-f" ? message.data?.idTo
        || threadId : content ? content : senderId);
    const userInfo = await getUserInfoData(api, targetUserId);
    if (!userInfo) {
      await sendErrorMessage(api, message, threadId, "❌ Không thể lấy thông tin người dùng này.");
      return;
    }
    const userInfoText = Object.entries(userInfo)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    await api.sendMessage(
      { msg: userInfoText, ttl: 6000000 }, // Added ttl: 6000000
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi lấy thông tin người dùng:", error);
    await sendErrorMessage(
      api,
      message,
      threadId,
      "❌ Đã xảy ra lỗi khi lấy thông tin người dùng. Vui lòng thử lại sau."
    );
  }
}

async function sendErrorMessage(api, message, threadId, errorMsg) {
  await api.sendMessage({ msg: errorMsg, quote: message, ttl: 6000000 }, threadId, message.type); // Added ttl: 6000000
}
