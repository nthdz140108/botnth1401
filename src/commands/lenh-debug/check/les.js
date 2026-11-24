import fs from 'fs';
import path from 'path';
import { sendMessageFactory } from '../../../api-zalo/apis/sendMessage.js';
import { sendMessageStateQuote } from '../../../service-debug/chat-zalo/chat-style/chat-style.js';
import { getGlobalPrefix } from '../../../service-debug/service.js';
import { getProjectRoot } from '../../../utils/env.js';

const LES_TEST_FILE = path.join(getProjectRoot(), 'data', 'les_test_usage.json');

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadUsageData() {
  if (fs.existsSync(LES_TEST_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(LES_TEST_FILE, 'utf8'));
    } catch (error) {
      console.error('Error reading les_test_usage.json:', error.message);
      return {};
    }
  }
  return {};
}

function saveUsageData(data) {
  try {
    fs.mkdirSync(path.dirname(LES_TEST_FILE), { recursive: true });
    fs.writeFileSync(LES_TEST_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing les_test_usage.json:', error.message);
  }
}

// Đối tượng mô tả lệnh les
export const des = {
  name: 'les',
  version: '1.0.0',
  credits: 'Thanh Hung',
  description: 'Check tỉ lệ đồng tính của nữ',
  countdown: 5,
  active: true,
};

// Hàm lấy tên người dùng từ input hoặc mentions
function getUserName(content, mentions, userId) {
  try {
    const mention = mentions.find(m => m.uid === userId);
    if (mention && mention.name) {
      return mention.name;
    }
    if (mention && mention.displayName) {
      return mention.displayName;
    }

    const match = content.match(/@(.+)/);
    if (match && match[1]) {
      return match[1].trim();
    }

    return `UID: ${userId}`;
  } catch (error) {
    console.error('Error in getUserName:', error.message);
    return `UID: ${userId}`;
  }
}

// Hàm áp dụng style cho tin nhắn
function applyMessageStyle(text) {
  const COLORS = ["#f30505ff", "#15a85f", "#f27806", "#f7b503"];
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  return {
    text,
    style: {
      color,
      fontSize: 16,
      bold: true,
    },
  };
}

// Hàm xử lý lệnh les
export async function handleLesCommand(api, message) {
  const threadId = message.threadId;
  const uid = message.data.uidFrom;
  const content = message.data.content.trim();
  const currentPrefix = await getGlobalPrefix();
  const escapedPrefix = escapeRegExp(currentPrefix);
  const sendMessage = sendMessageFactory(api);

  // Xác định xem threadId là nhóm hay cá nhân
  let isGroup = threadId !== uid;
  if (typeof message.isGroup !== 'undefined') {
    isGroup = message.isGroup;
  }

  // Kiểm tra lệnh hợp lệ (thoát ký tự đặc biệt của prefix)
  const commandRegex = new RegExp(
    `^${escapedPrefix}les(?:\\b|\\s*@)|@(.+)\\s*${escapedPrefix}les$`,
    'i'
  );
  if (!content.match(commandRegex)) {
    return sendMessage(
      { msg: `❌ Lệnh không hợp lệ! Dùng: ${currentPrefix}les @<tên người dùng> 🚨`, ttl: 60000 },
      threadId,
      isGroup ? 1 : 0
    );
  }

  // Kiểm tra mentions
  const mentions = message.data.mentions || [];
  if (!mentions.length) {
    return sendMessage(
      { msg: '❌ Vui lòng đề cập đến một người dùng bằng @<tên người dùng>! 🚨', ttl: 60000 },
      threadId,
      isGroup ? 1 : 0
    );
  }

  // Lấy user_id từ mention đầu tiên
  const userId = mentions[0].uid;

  // Lấy tên người được mention từ content
  const name = getUserName(content, mentions, userId);

  const usageData = loadUsageData();
  const now = new Date();
  const probability = usageData[userId]?.lesPercentage ?? Math.floor(Math.random() * 101);
  usageData[userId] = {
    lesPercentage: probability,
    count: (usageData[userId]?.count || 0) + 1,
    lastUsed: now.toISOString(),
  };
  saveUsageData(usageData);

  const response = `🏳️‍🌈 Con được bạn tag có độ les là ${probability}%! 🏳️‍🌈`;

  // Thử gửi với style và mention (chỉ truyền mentions khi pos >= 0)
  try {
    const styledMessage = applyMessageStyle(response);
    const pos = styledMessage.text.indexOf(name);
    const mentionsParam = pos >= 0 ? [{
      uid: userId,
      length: name.length,
      offset: pos,
    }] : undefined;
    await sendMessageStateQuote(
      api,
      message,
      styledMessage.text,
      isGroup,
      60000,
      false,
      styledMessage.style,
      mentionsParam
    );
  } catch (error) {
    console.error('Failed to send message with sendMessageStateQuote:', error.message);
    await sendMessage(
      { msg: response, ttl: 60000 },
      threadId,
      isGroup ? 1 : 0
    );
  }
}
