import { sendMessageFactory } from '../../api-zalo/apis/sendMessage.js';
import { MessageType } from '../../api-zalo/models/Message.js';
import { getGlobalPrefix } from '../service.js';

export const MAX_BUFF_REQUESTS = 5;
const BUFF_TIMEOUT_MS = 8000;

export const des = {
  name: 'viewtt',
  type: 1,
  permission: 'all',
  countdown: 5,
  active: true,
  alias: ['viewtt'],
};

export async function buffLink(url, time, fetchImpl = globalThis.fetch) {
  const apiUrl = `https://apitiktok.kingapi.x10.mx/buffviewtik?url=${encodeURIComponent(url)}&time=${encodeURIComponent(time)}`;
  const requests = Array.from({ length: MAX_BUFF_REQUESTS }, () =>
    fetchImpl(apiUrl, { signal: AbortSignal.timeout(BUFF_TIMEOUT_MS) })
  );
  await Promise.allSettled(requests);
}

export async function handleViewttCommand(api, message) {
  const threadId = message.threadId;
  const threadType = message.type ?? MessageType.GroupMessage;
  const content = message.data.content.trim();
  const senderName = message.data.dName || 'Người dùng';
  const messageId = message.messageId;
  const sendMessage = sendMessageFactory(api);
  const parts = content.split(/\s+/);
  const prefix = getGlobalPrefix();

  if (parts.length < 3) {
    return sendMessage({
      msg: `❌ Định dạng sai, @${senderName}!\nDùng: ${prefix}viewtt <link TikTok> <thời gian giây>`,
      ttl: 60000,
      replyTo: messageId
    }, threadId, threadType);
  }

  const url = parts[1];
  const time = parts[2];

  if (!url.includes('tiktok.com')) {
    return sendMessage({
      msg: `❌ URL TikTok không hợp lệ, @${senderName}!`,
      ttl: 60000,
      replyTo: messageId
    }, threadId, threadType);
  }

  try {
    await sendMessage({
      msg: `🚀 Đang chạy ${time} giây cho ${url}\n⏳ Vui lòng chờ...`,
      ttl: 60000,
      replyTo: messageId
    }, threadId, threadType);

    await buffLink(url, time);

    await sendMessage({
      msg: `✅ Hoàn tất buff view cho bạn, @${senderName}!\n🔗 Link: ${url}\n⏱️ Thời gian: ${time} giây\n🚀 Đã gửi ${MAX_BUFF_REQUESTS} requests tới API.`,
      ttl: 60000,
      replyTo: messageId
    }, threadId, threadType);
  } catch (err) {
    console.error('Lỗi khi buff:', err);
    await sendMessage({
      msg: `❌ Đã xảy ra lỗi khi buff view cho bạn, @${senderName}!`,
      ttl: 60000,
      replyTo: messageId
    }, threadId, threadType);
  }
}
