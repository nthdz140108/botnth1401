import { MessageType } from "../../api-zalo/index.js";
import { removeMention } from "../../utils/format-util.js";
import { safeThreadType } from "../../commands/shared/command-input-utils.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";

export async function handleStickerLocalCommand(api, message) {
  const threadId = message?.threadId || message?.data?.idTo;
  if (!threadId) {
    return;
  }

  const threadType = safeThreadType(message, MessageType.GroupMessage);
  const content = (removeMention(message) || message?.data?.content || "").trim();
  const args = content ? content.split(/\s+/).slice(1) : [];
  const rawId = args[0] ?? "";
  const stickerId = /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : Number.NaN;

  if (!Number.isInteger(stickerId) || stickerId <= 0) {
    try {
      await sendMessageStateQuote(
        api,
        message,
        "Vui lòng cung cấp ID sticker hợp lệ (số nguyên dương lớn hơn 0)!",
        false,
        300000,
      );
    } catch {}
    return;
  }

  let cateId = 1;
  let stickerType = 1;
  try {
    const detailList = await api.getStickersDetail?.(stickerId);
    const detail = Array.isArray(detailList) ? detailList[0] : detailList;
    if (detail && typeof detail === "object") {
      const resolvedCateId = Number(detail.cateId ?? detail.catId);
      const resolvedType = Number(detail.type);
      if (Number.isInteger(resolvedCateId) && resolvedCateId > 0) {
        cateId = resolvedCateId;
      }
      if (Number.isInteger(resolvedType) && resolvedType > 0) {
        stickerType = resolvedType;
      }
    }
  } catch {
    // Fallback { cateId: 1, type: 1 } nếu API chi tiết không khả dụng
  }

  const sticker = { id: stickerId, cateId, type: stickerType };
  try {
    await api.sendSticker(sticker, threadId, threadType, 86400000);
    await sendMessageStateQuote(
      api,
      message,
      `Đã gửi sticker với ID ${stickerId}!`,
      true,
      300000,
    );
  } catch {
    try {
      await sendMessageStateQuote(
        api,
        message,
        `Không thể gửi sticker với ID ${stickerId}. Vui lòng kiểm tra lại ID!`,
        false,
        300000,
      );
    } catch {}
  }
}
