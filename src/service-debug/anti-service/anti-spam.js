import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { LRUCache } from "lru-cache";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";

const MESSAGE_THRESHOLD = 3;
const MESSAGE_THRESHOLD_REPEATED = 5;
const MESSAGE_THRESHOLD_LONG = 3;
const TIME_WINDOW = 3000;
const REPEATED_TIME_WINDOW = 30000;
const WARNING_RESET_TIME = 1800000;
const kickedUsers = new LRUCache({ max: 2000, ttl: 10000 });
const userMessageTimestamps = new LRUCache({ max: 5000, ttl: REPEATED_TIME_WINDOW });
const userWarnings = new LRUCache({ max: 5000, ttl: WARNING_RESET_TIME * 4 });
export const SPAM_PATTERNS = {
  RAPID_MESSAGES: "RAPID_MESSAGES",
  REPEATED_CONTENT: "REPEATED_CONTENT",
  BULK_MESSAGES: "BULK_MESSAGES",
};

export async function antiSpam(
  api,
  message,
  isAdminBox,
  groupSettings,
  botIsAdminBox,
  isSelf
) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const threadId = message.threadId;
  const timestamp = Number(message.data.ts) || Date.now();
  const userKey = `${threadId}:${senderId}`;

  if (
    isAdminBox ||
    kickedUsers.has(userKey) ||
    isSelf ||
    !botIsAdminBox ||
    isInWhiteList(groupSettings, threadId, senderId)
  )
    return false;

  if (groupSettings[threadId]?.antiSpam ?? false) {
    if (!userMessageTimestamps.has(userKey)) {
      userMessageTimestamps.set(userKey, []);
    }

    const timestamps = userMessageTimestamps.get(userKey);
    timestamps.push({
      time: timestamp,
      content: message.data.content,
      length: message.data.content?.length || 0,
    });

    const latestTime = timestamps.reduce(
      (max, msg) => Math.max(max, Number(msg.time) || 0),
      timestamp
    );
    const recentTimestamps = timestamps.filter(
      (msg) => latestTime - msg.time <= REPEATED_TIME_WINDOW
    );
    userMessageTimestamps.set(userKey, recentTimestamps);

    const spamAnalysis = analyzeSpamBehavior(recentTimestamps);

    if (spamAnalysis.isSpam) {
      try {
        await api.deleteMessage(message, false).catch(() => {});
        const warningResult = await handleWarning(
          api,
          message,
          threadId,
          senderId,
          senderName,
          spamAnalysis.type
        );

        if (warningResult.shouldBlock) {
          await handleSpamDetected(
            api,
            message,
            threadId,
            senderId,
            senderName,
            spamAnalysis.type
          );
        }
      } catch (error) {
        console.error("Lỗi khi xử lý spam:", error);
      }
      return true;
    }
  }

  return false;
}

export function analyzeSpamBehavior(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { isSpam: false };
  }

  const windowEnd = messages.reduce(
    (max, msg) => Math.max(max, Number(msg.time) || 0),
    0
  );
  const rapidMessages = messages.filter(
    (msg) => windowEnd - msg.time <= TIME_WINDOW
  );

  if (rapidMessages.length >= MESSAGE_THRESHOLD) {
    const timeSpan =
      rapidMessages[rapidMessages.length - 1].time - rapidMessages[0].time;
    if (timeSpan < TIME_WINDOW) {
      return { isSpam: true, type: SPAM_PATTERNS.RAPID_MESSAGES };
    }
  }

  const contentMap = new Map();
  for (const msg of messages) {
    let normalizedContent = "";

    if (typeof msg.content === "object") {
      normalizedContent = normalizeObjectContent(msg.content);
    } else {
      normalizedContent = String(msg.content || "").trim();
    }

    if (normalizedContent) {
      let isContentSimilar = false;
      for (const [existingContent] of contentMap) {
        const similarity = calculateContentSimilarity(
          normalizedContent,
          existingContent
        );
        if (similarity > 0.8) {
          const count = contentMap.get(existingContent) + 1;
          contentMap.set(existingContent, count);
          if (count >= MESSAGE_THRESHOLD_REPEATED) {
            return { isSpam: true, type: SPAM_PATTERNS.REPEATED_CONTENT };
          }
          isContentSimilar = true;
          break;
        }
      }

      if (!isContentSimilar) {
        contentMap.set(normalizedContent, 1);
      }
    }
  }

  const longMessages = messages.filter((msg) => {
    const contentLength =
      typeof msg.content === "object"
        ? JSON.stringify(msg.content).length
        : msg.content?.length || 0;
    return contentLength > 100;
  });

  if (longMessages.length >= MESSAGE_THRESHOLD_LONG) {
    return { isSpam: true, type: SPAM_PATTERNS.BULK_MESSAGES };
  }

  return { isSpam: false };
}

function normalizeObjectContent(content) {
  try {
    if (!content) return "";

    if (content.title) return content.title;
    if (content.text) return content.text;
    if (content.caption) return content.caption;
    if (content.description) return content.description;
    if (content.message) return content.message;

    const contentCopy = { ...content };
    delete contentCopy.timestamp;
    delete contentCopy.id;
    delete contentCopy.time;
    delete contentCopy.date;

    return JSON.stringify(contentCopy);
  } catch (error) {
    console.error("Lỗi khi chuẩn hóa content:", error);
    return "";
  }
}

function calculateContentSimilarity(str1, str2) {
  if (typeof str1 !== "string" || typeof str2 !== "string") {
    return 0;
  }

  str1 = str1.toLowerCase().trim();
  str2 = str2.toLowerCase().trim();

  if (str1 === str2) return 1;

  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1;
  if (Math.abs(str1.length - str2.length) / maxLength > 0.2) return 0;

  if (maxLength > 120) {
    const sample1 = str1.slice(0, 120);
    const sample2 = str2.slice(0, 120);
    if (sample1 === sample2) return 0.9;
    let matches = 0;
    const len = Math.min(sample1.length, sample2.length);
    for (let i = 0; i < len; i++) {
      if (sample1[i] === sample2[i]) matches++;
    }
    return matches / Math.max(sample1.length, sample2.length);
  }

  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLength;
}

function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(prev[j - 1] + 1, prev[j] + 1, curr[j - 1] + 1);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

async function handleSpamDetected(
  api,
  message,
  threadId,
  senderId,
  senderName,
  spamType
) {
  const userKey = `${threadId}:${senderId}`;

  try {
    kickedUsers.set(userKey, true);
    await api.blockUsers(threadId, [senderId]);
  } catch (error) {
    console.error("Lỗi khi xử lý kick spam:", error);
  } finally {
    const timer = setTimeout(() => {
      kickedUsers.delete(userKey);
    }, 5000);
    timer.unref?.();
    userMessageTimestamps.delete(userKey);
  }
}

async function handleWarning(
  api,
  message,
  threadId,
  senderId,
  senderName,
  spamType
) {
  const userKey = `${threadId}:${senderId}`;
  if (!userWarnings.has(userKey)) {
    userWarnings.set(userKey, {
      count: 0,
      lastWarningTime: Date.now(),
    });
  }

  const warning = userWarnings.get(userKey);
  const currentTime = Date.now();

  const warningReductions = Math.floor(
    (currentTime - warning.lastWarningTime) / WARNING_RESET_TIME
  );
  if (warningReductions > 0) {
    warning.count = Math.max(0, warning.count - warningReductions);
  }

  warning.count++;
  warning.lastWarningTime = currentTime;

  if (warning.count < 5) {
    let caption = `⚠️ Cảnh cáo ${senderName}!\nChậm cái tay lại bạn êy, tay hơi nhanh rồi đấy!`;
    if (warning.count === 3) {
      caption = `⚠️ Cảnh cáo ${senderName}!\nNhắn chậm lại, tao xút Bạn ra khỏi box bây giờ!`;
    }
    await api.sendMessage(
      {
        msg: caption,
        mentions: [
          MessageMention(senderId, senderName.length, "⚠️ Cảnh cáo ".length),
        ],
        ttl: 8000,
      },
      threadId,
      MessageType.GroupMessage
    );
    return { shouldBlock: false };
  } else {
    userWarnings.delete(userKey);
    return { shouldBlock: true };
  }
}

export async function handleAntiSpamCommand(
  api,
  message,
  groupSettings
) {
  const threadId = message.threadId;
  const content = removeMention(message);
  const status = content.split(" ")[1];

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  let newStatus;
  if (status === "on") {
    groupSettings[threadId].antiSpam = true;
    newStatus = "bật";
  } else if (status === "off") {
    groupSettings[threadId].antiSpam = false;
    newStatus = "tắt";
  } else {
    groupSettings[threadId].antiSpam = !groupSettings[threadId].antiSpam;
    newStatus = groupSettings[threadId].antiSpam ? "bật" : "tắt";
  }
  const caption = `Chức năng chống spam đã được ${newStatus}!`;
  await sendMessageStateQuote(
    api,
    message,
    caption,
    groupSettings[threadId].antiSpam,
    300000
  );

  return true;
}
