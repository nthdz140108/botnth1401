import fs from "node:fs";
import fetch from "node-fetch";
import { getGlobalPrefix } from "../service.js";
import { removeMention } from "../../utils/format-util.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";
import { createTestflightImage } from "./testflight-canvas.js";

export const des = {
  name: "testflight",
  type: 1,
  permission: "all",
  countdown: 10,
  active: true,
};

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTestflightCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "testflight").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export async function handleTestflightCommand(api, message, aliasCommand = "testflight") {
  const threadId = message.threadId;
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "testflight";
  const threadType = safeThreadType(
    message,
    threadId && message?.data?.uidFrom && String(threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );

  if (!matchesTestflightCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const query = extractCommandBody(message, currentPrefix, effectiveAlias);
  if (!query) {
    return api.sendMessage(
      {
        msg: `❌ Vui lòng nhập tên ứng dụng cần tìm.\n👉 Ví dụ: ${currentPrefix}${effectiveAlias} locket`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  let imagePath = null;
  try {
    await api.sendMessage(
      { msg: `🔎 Đang tìm kiếm "${query}" trên TestFlight...`, ttl: 20000 },
      threadId,
      threadType
    );

    const apiUrl = `https://api.nemg.me/testflight?search=${encodeURIComponent(query)}`;
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`Máy chủ TestFlight phản hồi HTTP ${response.status}`);
    }
    const data = await response.json();

    if (!data?.success || !Array.isArray(data.ung_dung) || data.ung_dung.length === 0) {
      return api.sendMessage(
        {
          msg: `❌ Không tìm thấy ứng dụng nào khớp với "${query}".`,
          ttl: 60000,
        },
        threadId,
        threadType
      );
    }

    const apps = data.ung_dung.slice(0, 10);
    imagePath = await createTestflightImage(apps);

    const testflightLinks = apps
      .map((app, index) => {
        const cleanName = String(app?.ten || `App #${index + 1}`)
          .replace(/\s+/g, " ")
          .trim();
        const tfUrl = typeof app?.testflight === "string" ? app.testflight.trim() : "";
        if (tfUrl) {
          return `${index + 1}. ${cleanName}: ${tfUrl}`;
        }
        const refLink = typeof app?.link === "string" && app.link.trim() ? ` — ${app.link.trim()}` : "";
        return `${index + 1}. ${cleanName}: Đã đầy / Đóng beta${refLink}`;
      })
      .join("\n");

    const msg = ` KẾT QUẢ TÌM KIẾM TESTFLIGHT\n\n${testflightLinks}`;

    await api.sendMessage(
      {
        attachments: [imagePath],
        msg,
        ttl: 3600000,
      },
      threadId,
      threadType
    );
  } catch (err) {
    await api.sendMessage(
      {
        msg: `❌ Lỗi tra cứu TestFlight: ${err?.message || "Không xác định"}`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  } finally {
    if (imagePath) {
      await fs.promises.unlink(imagePath).catch(() => {});
    }
  }
}
