import fs from 'fs';
import path from 'path';
import { sendMessageStateQuote } from '../../../service-debug/chat-zalo/chat-style/chat-style.js';
import { getActiveRuntimeContext } from '../../../utils/io-json.js';
import { getProjectRoot } from '../../../utils/env.js';
import { getQuotedUid, safeThreadType } from '../../shared/command-input-utils.js';

const MAX_DAM_DAILY_USES = 5;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function resolveDamUsagePath() {
  const dataDir = getActiveRuntimeContext()?.dataDir;
  const baseDir = dataDir
    ? (path.isAbsolute(dataDir) ? dataDir : path.resolve(getProjectRoot(), dataDir))
    : path.join(getProjectRoot(), 'data');
  return path.join(baseDir, 'dam_test_usage.json');
}

function loadUsageData() {
  const filePath = resolveDamUsagePath();
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.error('Error reading dam_test_usage.json:', error.message);
      return {};
    }
  }
  return {};
}

function saveUsageData(data) {
  try {
    const filePath = resolveDamUsagePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing dam_test_usage.json:', error.message);
  }
}

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

export const des = {
  name: 'dam',
  version: '1.0.5',
  credits: 'Thanh Hung',
  description: 'Kiểm tra mức độ dâm vui nhộn của người dùng',
  countdown: 5,
  active: true,
};

export async function handleDamCommand(api, message) {
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
  const callerRecord = usageData[senderId];
  const lastUsedMs = callerRecord?.lastUsed ? new Date(callerRecord.lastUsed).getTime() : 0;
  const elapsedMs = now.getTime() - lastUsedMs;

  if (callerRecord && Number.isFinite(elapsedMs) && elapsedMs < ONE_DAY_MS) {
    if ((callerRecord.count || 0) >= MAX_DAM_DAILY_USES) {
      const timeRemaining = ONE_DAY_MS - elapsedMs;
      const hoursRemaining = Math.floor(timeRemaining / (60 * 60 * 1000));
      const minutesRemaining = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));
      const limitMsg = `❌ ${senderName} đã sử dụng hết ${MAX_DAM_DAILY_USES} lượt hôm nay. Vui lòng quay lại sau ${hoursRemaining} giờ ${minutesRemaining} phút.`;
      return api.sendMessage({ msg: limitMsg, quote: message, ttl: 30000 }, threadId, threadType);
    }
    usageData[senderId] = {
      ...callerRecord,
      count: (callerRecord.count || 0) + 1,
      lastUsed: now.toISOString(),
    };
  } else {
    // 24h elapsed or first time: reset count cleanly to 1
    usageData[senderId] = {
      ...(callerRecord || {}),
      count: 1,
      lastUsed: now.toISOString(),
    };
  }

  const targetKey = `target:${targetUserId}`;
  const targetRecord = usageData[targetKey];
  const targetElapsed = targetRecord?.lastUsed
    ? now.getTime() - new Date(targetRecord.lastUsed).getTime()
    : Infinity;

  let damPercentage;
  if (targetRecord && typeof targetRecord.damPercentage === 'number' && targetElapsed < ONE_DAY_MS) {
    damPercentage = targetRecord.damPercentage;
  } else {
    // Natural 0..100% random distribution
    damPercentage = Math.floor(Math.random() * 101);
    usageData[targetKey] = {
      damPercentage,
      lastUsed: now.toISOString(),
    };
  }

  saveUsageData(usageData);

  const response = `💦🌚 Độ dâm của ${targetName} là ${damPercentage}%! 💦🌚`;

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
      120000,
      false,
      styledMessage.style,
      mentionsParam
    );
  } catch (error) {
    console.error('Failed to send message with sendMessageStateQuote:', error.message);
    await api.sendMessage({ msg: response, quote: message, ttl: 120000 }, threadId, threadType);
  }
}
