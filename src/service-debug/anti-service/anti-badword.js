import { MessageMention } from "../../api-zalo/models/index.js";
import { extendMuteDuration } from "./mute-user.js";
import { isInWhiteList } from "./white-list.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { getBotId } from "../../utils/env.js";
import { getGlobalPrefix } from "../service.js";
import { getAntiState, updateAntiConfig } from "./index.js";

function getEffectiveBadWords(groupSettings, threadId) {
  const defaultBadWords = Array.isArray(getAntiState()?.data?.badWords)
    ? getAntiState().data.badWords
    : [];
  const threadCfg = groupSettings?.[threadId] || {};
  const customBadWords = Array.isArray(threadCfg.badWords) ? threadCfg.badWords : [];
  const removedDefaults = new Set(
    (Array.isArray(threadCfg.removedDefaultBadWords) ? threadCfg.removedDefaultBadWords : [])
      .map((w) => normalizeText(String(w || "")))
      .filter(Boolean)
  );

  const merged = [];
  const seen = new Set();
  for (const raw of [...defaultBadWords, ...customBadWords]) {
    const str = String(raw ?? "").trim();
    if (!str) continue;
    const norm = normalizeText(str);
    if (!norm || seen.has(norm)) continue;
    if (removedDefaults.has(norm) && !customBadWords.some((cw) => normalizeText(String(cw || "")) === norm)) {
      continue;
    }
    seen.add(norm);
    merged.push(str);
  }
  return merged;
}

// Hàm kiểm tra từ cấm theo từng nhóm (kết hợp danh sách mặc định chung)
function checkBadWords(content, groupSettings = null, threadId = "") {
  const badWords = getEffectiveBadWords(groupSettings, threadId);
  const normalizedContent = normalizeText(content);
  const words = normalizedContent.split(/\s+/);

  for (const badWord of badWords) {
    const normalizedBadWord = normalizeText(badWord);
    if (!normalizedBadWord) continue;

    for (const word of words) {
      if (word === normalizedBadWord) {
        return {
          found: true,
          word: badWord,
        };
      }
    }

    if (normalizedBadWord.includes(" ") && normalizedContent.includes(normalizedBadWord)) {
      return {
        found: true,
        word: badWord,
      };
    }
  }

  return {
    found: false,
    word: null,
  };
}

async function checkBotHasGroupKey(api, threadId) {
  try {
    if (typeof api?.getGroupInfo !== "function" || !threadId) return null;
    const res = await api.getGroupInfo(threadId);
    const gridInfo = res?.gridInfoMap?.[threadId];
    if (!gridInfo) return null;
    const botUid = String(api?.getOwnId?.() || api?.getBotId?.() || api?.appContext?.uid || getBotId() || "");
    if (!botUid || botUid === "-1") return null;
    const adminIds = [gridInfo.creatorId, ...(gridInfo.adminIds || gridInfo.admins || [])]
      .filter(Boolean)
      .map(String);
    return adminIds.includes(botUid);
  } catch {
    return null;
  }
}

async function handleBadWordModification(api, message, groupSettings, action, rawWord) {
  const threadId = message.threadId;
  const word = String(rawWord ?? "").trim();

  if (!word) {
    await api.sendMessage(
      {
        msg: `Vui lòng nhập từ khóa cần ${action === "add" ? "thêm" : "xóa"}`,
        quote: message,
      },
      threadId,
      message.type
    );
    return false;
  }

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }
  if (!Array.isArray(groupSettings[threadId].badWords)) {
    groupSettings[threadId].badWords = [];
  }
  if (!Array.isArray(groupSettings[threadId].removedDefaultBadWords)) {
    groupSettings[threadId].removedDefaultBadWords = [];
  }

  const normalizedTarget = normalizeText(word);
  const effectiveWords = getEffectiveBadWords(groupSettings, threadId);
  const existsInEffective = effectiveWords.some((w) => normalizeText(w) === normalizedTarget);

  if (action === "add") {
    if (!existsInEffective) {
      groupSettings[threadId].removedDefaultBadWords = groupSettings[threadId].removedDefaultBadWords.filter(
        (w) => normalizeText(w) !== normalizedTarget
      );
      if (!groupSettings[threadId].badWords.some((w) => normalizeText(w) === normalizedTarget)) {
        groupSettings[threadId].badWords.push(word);
      }

      await api.sendMessage(
        {
          msg: `Đã thêm "${word}" vào danh sách từ cấm của nhóm này`,
          quote: message,
          ttl: 30000,
        },
        threadId,
        message.type
      );
      return true;
    } else {
      await api.sendMessage(
        {
          msg: `Từ "${word}" đã có trong danh sách từ cấm của nhóm`,
          quote: message,
          ttl: 30000,
        },
        threadId,
        message.type
      );
      return false;
    }
  } else if (action === "remove") {
    if (existsInEffective) {
      groupSettings[threadId].badWords = groupSettings[threadId].badWords.filter(
        (w) => normalizeText(w) !== normalizedTarget
      );
      const defaultBadWords = Array.isArray(getAntiState()?.data?.badWords)
        ? getAntiState().data.badWords
        : [];
      if (
        defaultBadWords.some((w) => normalizeText(w) === normalizedTarget) &&
        !groupSettings[threadId].removedDefaultBadWords.some((w) => normalizeText(w) === normalizedTarget)
      ) {
        groupSettings[threadId].removedDefaultBadWords.push(word);
      }

      await api.sendMessage(
        {
          msg: `Đã xóa "${word}" khỏi danh sách từ cấm của nhóm này`,
          quote: message,
          ttl: 30000,
        },
        threadId,
        message.type
      );
      return true;
    } else {
      await api.sendMessage(
        {
          msg: `Không tìm thấy "${word}" trong danh sách từ cấm của nhóm`,
          quote: message,
          ttl: 30000,
        },
        threadId,
        message.type
      );
      return false;
    }
  }
  return false;
}

async function showBadWordsList(api, message, groupSettings) {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  try {
    const wordsList = getEffectiveBadWords(groupSettings, threadId).map((pattern) => {
      return pattern
        .replace(/\\b/g, "")
        .replace(/\+/g, "")
        .replace(/\\/g, "")
        .replace(/\*/g, " ");
    });

    if (wordsList.length === 0) {
      await api.sendMessage(
        {
          msg: "Hiện tại nhóm chưa có từ ngữ nào bị cấm.",
          quote: message,
        },
        threadId,
        message.type
      );
      return;
    }

    const formattedList = wordsList.map((word) => `${word}`).join(", ");
    await api.sendMessage(
      {
        msg: `📝 Danh sách từ ngữ bị cấm của nhóm (${wordsList.length} từ):\n[${formattedList}]\n\n💡 Dùng lệnh:\n- ${prefix}antibadword add [từ] để thêm\n- ${prefix}antibadword remove [từ] để xóa`,
        quote: message,
        ttl: 30000,
      },
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi đọc danh sách từ cấm:", error);
    await api.sendMessage(
      {
        msg: "Đã xảy ra lỗi khi đọc danh sách từ cấm.",
        quote: message,
        ttl: 30000,
      },
      threadId,
      message.type
    );
  }
}

export async function handleAntiBadWordCommand(api, message, groupSettings) {
  const content = removeMention(message);
  const threadId = message.threadId;
  const args = content.trim().split(/\s+/);
  const command = args[1]?.toLowerCase();

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  if (command === "list") {
    await showBadWordsList(api, message, groupSettings);
    return false;
  }

  if (command === "show") {
    await showViolationHistory(api, message, threadId);
    return false;
  }

  if (command === "add" || command === "remove") {
    const word = args.slice(2).join(" ");
    return await handleBadWordModification(api, message, groupSettings, command, word);
  }

  if (command === "on") {
    groupSettings[threadId].filterBadWords = true;
  } else if (command === "off") {
    groupSettings[threadId].filterBadWords = false;
  } else {
    groupSettings[threadId].filterBadWords =
      !groupSettings[threadId].filterBadWords;
  }

  const isEnabled = Boolean(groupSettings[threadId].filterBadWords);
  const newStatus = isEnabled ? "bật" : "tắt";
  let caption = `Chức năng lọc từ khóa thô tục đã được ${newStatus}!`;
  if (isEnabled) {
    const botHasKey = await checkBotHasGroupKey(api, threadId);
    if (botHasKey === false) {
      caption += "\n⚠️ Lưu ý: Bot hiện chưa có Key Bạc/Vàng trong nhóm nên chưa thể tự động xóa tin nhắn vi phạm.";
    }
  }
  await sendMessageStateQuote(
    api,
    message,
    caption,
    isEnabled,
    300000
  );
  return true;
}

// Hàm chuẩn hóa văn bản
function normalizeText(text) {
  return (
    text
      .toLowerCase()
      // .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, "a")
      // .replace(/[èéẹẻẽêềếệểễ]/g, "e")
      // .replace(/[ìíịỉĩ]/g, "i")
      // .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, "o")
      // .replace(/[ùúụủũưừứựửữ]/g, "u")
      // .replace(/[ỳýỵỷỹ]/g, "y")
      // .replace(/đ/g, "d")
      // .replace(/\s+/g, " ")
      .trim()
  );
}

// Hàm lưu vi phạm
async function saveViolation(threadId, userId, userName, badWord) {
  const antiState = getAntiState();
  const violations = antiState.data.violations || {};
  
  if (!violations[threadId]) {
    violations[threadId] = {};
  }

  if (!violations[threadId][userId]) {
    violations[threadId][userId] = {
      count: 0,
      words: [],
      name: userName
    };
  }

  violations[threadId][userId].count++;
  violations[threadId][userId].words.push({
    word: badWord,
    time: Date.now()
  });

  if (violations[threadId][userId].words.length > 3) {
    violations[threadId][userId].words = 
      violations[threadId][userId].words.slice(-3);
  }

  updateAntiConfig({
    ...antiState.data,
    violations
  });

  return violations[threadId][userId];
}

export async function antiBadWord(
  api,
  message,
  groupSettings,
  isAdminBox,
  botIsAdminBox,
  isSelf
) {
  if (isSelf) return false;
  pruneExpiredBadWordViolations();
  let content = message.data.content;
  content = content?.title ? content.title : content;
  const threadId = message.threadId;
  const senderId = message.data.uidFrom;
  const isPlainText = typeof content === "string";

  if (isPlainText && groupSettings[threadId]?.filterBadWords) {
    if (
      !botIsAdminBox ||
      isAdminBox ||
      isInWhiteList(groupSettings, threadId, senderId)
    )
      return false;

    const normalizedContent = content.toLowerCase();
    const checkBadWordsResult = checkBadWords(normalizedContent, groupSettings, threadId);

    if (checkBadWordsResult.found) {
      try {
        await api.deleteMessage(message, false).catch(console.error);
        const senderName = message.data.dName;
        const senderId = message.data.uidFrom;

        const violation = await saveViolation(
          threadId,
          senderId,
          senderName,
          checkBadWordsResult.word
        );

        let warningMsg = `${senderName} -> Tin nhắn bị xóa vì chứa từ ngữ bị cấm: "${checkBadWordsResult.word}"\n`;
        warningMsg += `Cảnh cáo lần ${violation.count}/3`;

        if (violation.count >= 3) {
          await extendMuteDuration(
            threadId,
            senderId,
            senderName,
            groupSettings,
            900
          );

          const antiState = getAntiState();
          const violations = {...antiState.data.violations};
          
          if (violations[threadId]?.[senderId]) {
            violations[threadId][senderId].count = 0;
            
            updateAntiConfig({
              ...antiState.data,
              violations
            });
          }

          warningMsg += "\n⚠️ Vi phạm 3 lần, bạn bị cấm chat trong 15 phút!";
        }

        await api.sendMessage(
          {
            msg: warningMsg,
            quote: message,
            mentions: [MessageMention(senderId, senderName.length, 0)],
            ttl: 30000,
          },
          threadId,
          message.type
        );
        return true;
      } catch (error) {
        console.error("Có lỗi xảy ra khi anti badword:", error.message);
      }
    }
  }
  return false;
}

// Sửa lại hàm showViolationHistory để gộp thông báo
export async function showViolationHistory(api, message, threadId) {
  try {
    pruneExpiredBadWordViolations(true);
    const mentions = message.data.mentions;

    if (!mentions || mentions.length === 0) {
      await api.sendMessage(
        {
          msg: "Vui lòng tag (@mention) người dùng để xem lịch sử vi phạm.",
          quote: message,
          ttl: 30000,
        },
        threadId,
        message.type
      );
      return;
    }

    const antiState = getAntiState();
    const violations = antiState.data.violations || {};

    let responseMsg = "📝 Lịch sử vi phạm:\n\n";
    const messageMentions = [];
    let mentionPosition = responseMsg.length;

    for (const mention of mentions) {
      const userId = mention.uid;
      const userName = message.data.content
        .substr(mention.pos, mention.len)
        .replace("@", "");
      const userViolations = violations[threadId]?.[userId];

      // Thêm mention vào danh sách
      messageMentions.push(
        MessageMention(userId, userName.length, mentionPosition)
      );

      if (!userViolations || userViolations.words.length === 0) {
        responseMsg += `${userName} chưa có vi phạm nào.\n\n`;
      } else {
        const countViolations = userViolations.count;
        let recentViolations = "Những vi phạm gần nhất:\n";
        recentViolations += userViolations.words
          .slice(-3)
          .map(
            (v, i) =>
              `  ${i + 1}. "${v.word}" - ${new Date(v.time).toLocaleString()}`
          )
          .join("\n");

        responseMsg += `${userName}:\n`;
        responseMsg += `Số lần vi phạm: ${countViolations}\n`;
        responseMsg += `${recentViolations}\n`;
      }

      mentionPosition = responseMsg.length;
    }

    await api.sendMessage(
      {
        msg: responseMsg.trim(),
        quote: message,
        mentions: messageMentions,
        ttl: 30000,
      },
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi đọc lịch sử vi phạm:", error);
    await api.sendMessage(
      {
        msg: "Đã xảy ra lỗi khi đọc lịch sử vi phạm.",
        quote: message,
        ttl: 30000,
      },
      threadId,
      message.type
    );
  }
}

let lastViolationPruneMs = 0;

export function pruneExpiredBadWordViolations(force = false) {
  const currentTime = Date.now();
  if (!force && currentTime - lastViolationPruneMs < 60 * 1000) return;
  lastViolationPruneMs = currentTime;

  try {
    const antiState = getAntiState();
    let hasChanges = false;
    const VIOLATION_TIMEOUT = 30 * 60 * 1000;
    const violations = { ...(antiState.data.violations || {}) };

    for (const threadId of Object.keys(violations)) {
      for (const userId of Object.keys(violations[threadId] || {})) {
        const userViolations = violations[threadId][userId];
        const words = Array.isArray(userViolations?.words) ? userViolations.words : [];
        const recentViolations = words.filter((v) => currentTime - v.time < VIOLATION_TIMEOUT);
        if (recentViolations.length < words.length) {
          hasChanges = true;
          userViolations.words = recentViolations;
          userViolations.count = recentViolations.length;
          if (recentViolations.length === 0) {
            delete violations[threadId][userId];
          }
        }
      }
      if (Object.keys(violations[threadId] || {}).length === 0) {
        hasChanges = true;
        delete violations[threadId];
      }
    }

    if (hasChanges) {
      updateAntiConfig({
        ...antiState.data,
        violations,
      });
    }
  } catch (error) {
    console.error("Lỗi khi dọn vi phạm từ khóa cũ:", error?.message || error);
  }
}

export async function startBadWordViolationCheck() {
  pruneExpiredBadWordViolations(true);
}
