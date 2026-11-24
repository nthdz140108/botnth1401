import fs from 'fs';
import path from 'path';
import { sendMessageFactory } from '../../../api-zalo/apis/sendMessage.js';
import { sendMessageStateQuote } from '../../../service-debug/chat-zalo/chat-style/chat-style.js';
import { getGlobalPrefix } from '../../../service-debug/service.js';
import { getProjectRoot } from '../../../utils/env.js';

// Đường dẫn tới tệp lưu trữ thông tin sử dụng trong data/
const GAY_TEST_FILE = path.join(getProjectRoot(), 'data', 'gay_test_usage.json');

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Hàm tải thông tin sử dụng từ tệp JSON
function loadUsageData() {
  if (fs.existsSync(GAY_TEST_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(GAY_TEST_FILE, 'utf8'));
    } catch (error) {
      console.error('Error reading gay_test_usage.json:', error.message);
      return {};
    }
  }
  return {};
}

// Hàm lưu thông tin sử dụng vào tệp JSON
function saveUsageData(data) {
  try {
    fs.mkdirSync(path.dirname(GAY_TEST_FILE), { recursive: true });
    fs.writeFileSync(GAY_TEST_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing gay_test_usage.json:', error.message);
  }
}

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

// Đối tượng mô tả lệnh gay
export const des = {
  name: 'gay',
  version: '1.0.0',
  credits: 'Thanh Hung',
  description: 'Check tỉ lệ gay của nam',
  countdown: 5,
  active: true,
};

// Hàm xử lý lệnh gay
export async function handleGayCommand(api, message) {
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

  // Kiểm tra lệnh hợp lệ (hỗ trợ tag trước hoặc sau)
  const commandRegex = new RegExp(
    `^${escapedPrefix}gay\\s*@(.+)|@(.+)\\s*${escapedPrefix}gay$`,
    'i'
  );
  if (!content.match(commandRegex)) {
    return sendMessage(
      { msg: `❌ Lệnh không hợp lệ! Dùng: ${currentPrefix}gay @<tên người dùng> hoặc @<tên người dùng> ${currentPrefix}gay 🚨`, ttl: 10000 },
      threadId,
      isGroup ? 1 : 0
    );
  }

  // Kiểm tra mentions
  const mentions = message.data.mentions || [];
  if (!mentions.length) {
    return sendMessage(
      { msg: `❌ Vui lòng đề cập đến một người dùng bằng @<tên người dùng>! 🚨`, ttl: 10000 },
      threadId,
      isGroup ? 1 : 0
    );
  }

  // Lấy user_id từ mention đầu tiên
  const userId = mentions[0].uid;

  // Lấy tên người được mention từ content
  const name = getUserName(content, mentions, userId);

  // Tải thông tin sử dụng
  const usageData = loadUsageData();
  const now = new Date();

  // Kiểm tra số lần sử dụng
  let gayPercentage;
  if (usageData[userId]) {
    gayPercentage = usageData[userId].gayPercentage;
    const lastUsed = new Date(usageData[userId].lastUsed);
    const count = usageData[userId].count;

    // Kiểm tra cooldown 24 giờ
    const oneDayInMs = 24 * 60 * 60 * 1000;
    if (count >= 5 && now - lastUsed < oneDayInMs) {
      const timeRemaining = oneDayInMs - (now - lastUsed);
      const hoursRemaining = Math.floor(timeRemaining / (60 * 60 * 1000));
      const minutesRemaining = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));
      const response = `❌ ${name} đã sử dụng quá số lần cho phép. Vui lòng quay lại sau ${hoursRemaining} giờ ${minutesRemaining} phút.`;
      return sendMessage(
        { msg: response, ttl: 10000 },
        threadId,
        isGroup ? 1 : 0
      );
    }

    // Cập nhật số lần sử dụng
    usageData[userId].count += 1;
    usageData[userId].lastUsed = now.toISOString();
  } else {
    // Lần đầu tiên, tạo ngẫu nhiên phần trăm
    gayPercentage = Math.floor(Math.random() * 100) + 1; // 1-100%
    usageData[userId] = {
      gayPercentage,
      count: 1,
      lastUsed: now.toISOString(),
    };
  }

  // Lưu lại thông tin sử dụng
  saveUsageData(usageData);

  // Tạo phản hồi
  const response = `🏳️‍🌈 Thằng được bạn tag có độ gay là ${gayPercentage}%! 🏳️‍🌈`;

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
      120000,
      false,
      styledMessage.style,
      mentionsParam
    );
  } catch (error) {
    console.error('Failed to send message with sendMessageStateQuote:', error.message);
    await sendMessage(
      { msg: response, ttl: 120000 },
      threadId,
      isGroup ? 1 : 0
    );
  }
}
