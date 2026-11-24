import { sendMessageFactory } from "../../api-zalo/apis/sendMessage.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../service.js";

export const MAX_BUFF_REQUESTS = 5;
const BUFF_TIMEOUT_MS = 8000;

export const des = {
  name: "tymtt",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
  alias: ["tymtt"],
};

export async function buffLink(url, count = 1, fetchImpl = globalThis.fetch) {
  const apiUrl = `http://apihoangthanhtung.ddns.net:5000/web=${encodeURIComponent(url)}/tym?key=duongca`;
  const capped = Math.max(1, Math.min(MAX_BUFF_REQUESTS, Number(count) || 1));
  const requests = Array.from({ length: capped }, () =>
    fetchImpl(apiUrl, { signal: AbortSignal.timeout(BUFF_TIMEOUT_MS) })
  );
  return Promise.allSettled(requests);
}

// Gọi API tăng tym và xử lý phản hồi (timeout 8s, tối đa <= 5 request)
export async function buffLike(url, fetchImpl = globalThis.fetch) {
  const apiUrl = `http://apihoangthanhtung.ddns.net:5000/web=${encodeURIComponent(url)}/tym?key=duongca`;

  const res = await fetchImpl(apiUrl, {
    signal: AbortSignal.timeout(BUFF_TIMEOUT_MS),
  });
  const data = await res.json();

  if (res.ok && data.status === "success") {
    data.by = "Nqduan";
    data.message = String(data.message || "").replace(/View\s*\/?\s*/gi, "").trim();
    return { success: true, data };
  }

  return {
    success: false,
    data: {
      status: data.status || "error",
      message: data.message || "Không rõ lỗi",
      by: "Nqduan",
    },
  };
}

export async function handleTymttCommand(api, message) {
  const threadId = message.threadId;
  const threadType = message.type ?? MessageType.GroupMessage;
  const content = message.data.content.trim();
  const messageId = message.messageId;
  const sendMessage = sendMessageFactory(api);
  const parts = content.split(/\s+/);
  const prefix = getGlobalPrefix();

  if (parts.length < 2) {
    return sendMessage(
      {
        msg: `❌ Định dạng sai! Dùng: ${prefix}tymtt <link TikTok>`,
        ttl: 60000,
        replyTo: messageId,
      },
      threadId,
      threadType,
    );
  }

  const url = parts[1];

  if (!url.startsWith("https://vt.tiktok.com/")) {
    return sendMessage(
      {
        msg: `❌ Link không hợp lệ!`,
        ttl: 60000,
        replyTo: messageId,
      },
      threadId,
      threadType,
    );
  }

  try {
    await sendMessage(
      {
        msg: `❤️ Đang tiến hành buff tym...`,
        ttl: 60000,
        replyTo: messageId,
      },
      threadId,
      threadType,
    );

    const result = await buffLike(url);

    if (result.success) {
      const { by } = result.data;
      await sendMessage(
        {
          msg: `✅Đã tiến hành buff tym thành công\nVui lòng chờ\n👤 Fonder: ${by}`,
          ttl: 60000,
          replyTo: messageId,
        },
        threadId,
        threadType,
      );
    } else {
      await sendMessage(
        {
          msg: `⚠️ Buff không thành công!\n📄 Lý do: ${result.data.message}`,
          ttl: 60000,
          replyTo: messageId,
        },
        threadId,
        threadType,
      );
    }
  } catch (err) {
    console.error("❌ Lỗi khi buff tym:", err);
    await sendMessage(
      {
        msg: `❌ Đã xảy ra lỗi khi buff tym!\nLỗi: ${err.message}`,
        ttl: 60000,
        replyTo: messageId,
      },
      threadId,
      threadType,
    );
  }
}
