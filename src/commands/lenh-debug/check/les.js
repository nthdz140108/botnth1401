import fs from 'fs';
import path from 'path';
import { sendMessageStateQuote } from '../../../service-debug/chat-zalo/chat-style/chat-style.js';
import { getActiveRuntimeContext } from '../../../utils/io-json.js';
import { getProjectRoot } from '../../../utils/env.js';
import { getQuotedUid, safeThreadType } from '../../shared/command-input-utils.js';

function resolveLesUsagePath() {
  const dataDir = getActiveRuntimeContext()?.dataDir;
  const baseDir = dataDir
    ? (path.isAbsolute(dataDir) ? dataDir : path.resolve(getProjectRoot(), dataDir))
    : path.join(getProjectRoot(), 'data');
  return path.join(baseDir, 'les_test_usage.json');
}

function loadUsageData() {
  const filePath = resolveLesUsagePath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.error('Error reading les_test_usage.json:', error.message);
      return {};
    }
  }
  return {};
}

function saveUsageData(data) {
  try {
    const filePath = resolveLesUsagePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing les_test_usage.json:', error.message);
  }
}

export const des = {
  name: 'les',
  version: '1.0.0',
  credits: 'Thanh Hung',
  description: 'Check tỉ lệ đồng tính của nữ',
  countdown: 5,
  active: true,
};

function getUserName(content, mentions, userId, fallbackName = '') {
  try {
    const mention = mentions.find((m) => String(m.uid) === String(userId));
    if (mention?.name) return mention.name;
    if (mention?.displayName) return mention.displayName;
    if (typeof content === 'string' && mention && Number.isInteger(mention.pos) && Number.isInteger(mention.len)) {
      const extracted = content.slice(mention.pos, mention.pos + mention.len).replace(/^@+/, '').trim();
      if (extracted) return extracted;
    }
    const match = String(content || '').match(/@([^\s]+)/);
    if (match?.[1]) return match[1].trim();
    return fallbackName || `UID: ${userId}`;
  } catch {
    return fallbackName || `UID: ${userId}`;
  }
}

function applyMessageStyle(text) {
  const COLORS = ['#f30505ff', '#15a85f', '#f27806', '#f7b503'];
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

export async function handleLesCommand(api, message) {
  const threadId = message.threadId;
  const senderId = String(message.data?.uidFrom || '');
  const senderName = message.data?.dName || 'Bạn';
  const content = String(message.data?.content || '').trim();
  const threadType = safeThreadType(message);

  const mentions = Array.isArray(message.data?.mentions) ? message.data.mentions : [];
  const quotedUid = getQuotedUid(message);

  let targetUserId = senderId;
  let isSelfTarget = true;
  if (mentions.length > 0 && mentions[0]?.uid) {
    targetUserId = String(mentions[0].uid);
    isSelfTarget = targetUserId === senderId;
  } else if (quotedUid) {
    targetUserId = quotedUid;
    isSelfTarget = targetUserId === senderId;
  }

  const targetName = isSelfTarget
    ? senderName
    : getUserName(content, mentions, targetUserId, message.data?.quote?.fromD || 'Người dùng');

  const usageData = loadUsageData();
  const now = new Date();
  const oneDayInMs = 24 * 60 * 60 * 1000;
  const existing = usageData[targetUserId];
  const isFresh = existing && (now.getTime() - new Date(existing.lastUsed || 0).getTime() < oneDayInMs);

  const probability = isFresh && typeof existing.lesPercentage === 'number'
    ? existing.lesPercentage
    : Math.floor(Math.random() * 101);

  usageData[targetUserId] = {
    lesPercentage: probability,
    count: isFresh ? (existing.count || 0) + 1 : 1,
    lastUsed: now.toISOString(),
  };
  saveUsageData(usageData);

  const response = isSelfTarget
    ? `🏳️‍🌈 Độ les của ${targetName} là ${probability}%! 🏳️‍🌈`
    : `🏳️‍🌈 Độ les của ${targetName} là ${probability}%! 🏳️‍🌈`;

  try {
    const styledMessage = applyMessageStyle(response);
    const pos = styledMessage.text.indexOf(targetName);
    const mentionsParam = pos >= 0 && targetUserId
      ? [{ uid: targetUserId, length: targetName.length, offset: pos }]
      : undefined;
    await sendMessageStateQuote(
      api,
      message,
      styledMessage.text,
      true,
      60000,
      false,
      styledMessage.style,
      mentionsParam
    );
  } catch (error) {
    console.error('Failed to send message with sendMessageStateQuote:', error.message);
    await api.sendMessage({ msg: response, quote: message, ttl: 60000 }, threadId, threadType);
  }
}
