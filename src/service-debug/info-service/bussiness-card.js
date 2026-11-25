import { extractCommandBody, safeThreadType } from "../../commands/shared/command-input-utils.js";
import { getGlobalPrefix } from "../service.js";

export async function userBussinessCardCommand(api, message, aliasCommand) {
  const threadId = message.threadId;
  const senderId = message.data.uidFrom;
  const prefixCommand = getGlobalPrefix();
  const textString = extractCommandBody(message, prefixCommand, aliasCommand || "card");
  const threadType = safeThreadType(message);

  const targetUserIds =
    message.data.mentions?.length > 0
      ? [...new Set(message.data.mentions.map((mention) => mention.uid).filter(Boolean))]
      : [senderId];

  for (const userId of targetUserIds) {
    try {
      await api.sendBusinessCard(
        null,
        userId,
        textString,
        threadType,
        threadId,
        600000
      );
    } catch (error) {
      console.error("Lỗi khi gửi danh thiếp người dùng:", error);
      try {
        await api.sendMessage(
          {
            msg: "⚠️ Không thể gửi danh thiếp lúc này (người dùng đã tắt mã QR Zalo hoặc giới hạn quyền riêng tư).",
            quote: message,
            ttl: 30000,
          },
          threadId,
          threadType
        );
      } catch {}
    }
  }
}
