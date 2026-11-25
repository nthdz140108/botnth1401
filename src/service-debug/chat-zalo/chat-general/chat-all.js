import { getBotId } from "../../../index.js";
import { getGroupAdmins, getGroupInfoData } from "../../info-service/group-info.js";
import { getGlobalPrefix } from "../../service.js";
import { extractCommandBody, safeThreadType } from "../../../commands/shared/command-input-utils.js";

export async function chatAll(api, message, groupInfo, aliasCommand = "all") {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const botId = String(getBotId() || "");
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "all";
  const chatMessage = extractCommandBody(message, prefix, safeAlias);
  const [rawContentTag = "", rawCountTag = "1", rawDelayTag = "0", rawTtl = "0"] = chatMessage.split("|");
  const contentTag = rawContentTag.trim() || "📢 Thông báo tới toàn thể thành viên!";
  const countTag = Math.min(Math.max(parseInt(rawCountTag, 10) || 1, 1), 10);
  const delayTag = Math.max(parseInt(rawDelayTag, 10) || 0, 0);
  const parsedTtl = Math.max(parseInt(rawTtl, 10) || 0, 0);

  const resolvedGroupInfo = groupInfo || (await getGroupInfoData(api, threadId));
  const groupAdmins = (await getGroupAdmins(resolvedGroupInfo)) || [];
  const adminSet = new Set(groupAdmins.map((id) => String(id)));
  const botIsGroupAdmin = Boolean(botId) && adminSet.has(botId);

  for (let i = 0; i < countTag; i++) {
    if (!botIsGroupAdmin) {
      let newChatMessage = contentTag;
      const mentions = (resolvedGroupInfo?.memVerList || []).map((member) => {
        const pos = newChatMessage.length;
        newChatMessage += " ";
        return {
          pos,
          uid: String(member).trim().replace(/_\d+$/, ""),
          len: 1,
        };
      });
      await api.sendMessage(
        {
          msg: newChatMessage,
          mentions,
          ...(parsedTtl > 0 ? { ttl: parsedTtl } : {}),
        },
        threadId,
        threadType
      );
    } else {
      await api.sendMessage(
        {
          msg: contentTag,
          mentions: [{ pos: 0, uid: -1, len: contentTag.length }],
          ...(parsedTtl > 0 ? { ttl: parsedTtl } : {}),
        },
        threadId,
        threadType
      );
    }
    if (delayTag > 0 && i < countTag - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayTag));
    }
  }
}

export async function getObject(api, message, aliasCommand = "object") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const quote = message?.data?.quote;

  if (!quote) {
    return api.sendMessage(
      { msg: "Lỗi: Không tìm thấy thông tin quote (vui lòng reply vào tin nhắn cần xem).", ttl: 60000, quote: message },
      threadId,
      threadType
    );
  }

  let quoteCopy;
  try {
    quoteCopy = JSON.parse(JSON.stringify(quote));
  } catch {
    quoteCopy = { ...quote };
  }

  if (typeof quoteCopy?.attach === "string" && quoteCopy.attach.trim()) {
    try {
      quoteCopy.attach = JSON.parse(quoteCopy.attach);
    } catch {
      // Giữ nguyên chuỗi gốc nếu không phải JSON hợp lệ
    }
  }

  let objectAsString = JSON.stringify(quoteCopy, null, 2) || "{}";
  if (objectAsString.length > 3800) {
    objectAsString = `${objectAsString.slice(0, 3800)}\n... (đã cắt bớt do vượt giới hạn hiển thị)`;
  }

  return api.sendMessage({ msg: objectAsString, ttl: 60000 * 5, quote: message }, threadId, threadType);
}