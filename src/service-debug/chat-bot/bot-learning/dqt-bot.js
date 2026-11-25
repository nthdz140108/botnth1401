import fs from "fs";
import path from "path";
import { getGroupName } from "../../info-service/group-info.js";
import { sendMessageComplete, sendMessageState, sendMessageStateQuote, sendMessageWarning } from "../../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service.js";
import { removeMention } from "../../../utils/format-util.js";
import { getBotInfoSync, getProjectRoot } from "../../../utils/env.js";
import { writeGroupSettings } from "../../../utils/io-json.js";
import { isGroupBotActive } from "../../../automations/chat-access-policy.js";
import { safeThreadType } from "../../../commands/shared/command-input-utils.js";

function resolveTrainingPath() {
  const projectRoot = getProjectRoot();
  const botInfo = getBotInfoSync();
  const relPath = botInfo?.dataTrainingPath || "assets/json-data/data-training.json";
  return path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
}

const SHARE_DIR = path.join(getProjectRoot(), "assets/resources/filegame");

export function resolveSafeShareFilePath(response, baseDir = SHARE_DIR) {
  const raw = String(response ?? "");
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const safeName = path.basename(raw);
  if (!safeName || safeName === "." || safeName === "..") {
    return null;
  }
  const resolvedBase = path.resolve(baseDir);
  const filePath = path.resolve(resolvedBase, safeName);
  if (!filePath.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return filePath;
}

// ====================== MAIN HANDLE ======================
export async function onMessage(api, message, groupSettings) {
  const threadId = message.threadId;

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = { learnEnabled: true, replyEnabled: true, nameGroup: "Group" };
  }

  // Xử lý lệnh trước
  const handledLearn = await handleLearnCommand(api, message, groupSettings);
  const handledReply = await handleReplyCommand(api, message, groupSettings);
  if (handledLearn || handledReply) return;

  // Nếu không phải lệnh -> chatbot xử lý
  await handleChatBot(api, message, threadId, groupSettings, groupSettings[threadId].nameGroup, false);
}

// ====================== CHATBOT REPLY ======================
export async function handleChatBot(api, message, threadId, groupSettings, nameGroup, isHandleCommand) {
  if (isHandleCommand) return;
  if (!isGroupBotActive(groupSettings, threadId)) return;
  let content = message.data.content;
  let responses = null;

  if (
    groupSettings[threadId].replyEnabled &&
    !content.startsWith(`${getGlobalPrefix()}`) &&
    !content.startsWith("!") &&
    !content.startsWith(".")
  ) {
    responses = findResponse(content, threadId);
  }

  if (responses && Array.isArray(responses) && responses.length > 0) {
    for (const response of responses) {
      const filePath = resolveSafeShareFilePath(response);
      if (filePath && fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".txt") {
          const fileContent = fs.readFileSync(filePath, "utf-8").trim();
          await api.sendMessage(
            {
              msg: fileContent,
              quote: message,
              ttl: 300000,
            },
            threadId,
            message.type
          );
        } else {
          await api.sendMessage(
            {
              msg: `📦 Đây là file bạn yêu cầu: ${response}`,
              attachments: [filePath],
              ttl: 300000,
            },
            threadId,
            message.type
          );
        }
      } else {
        await api.sendMessage(
          {
            msg: response,
            quote: message,
            ttl: 300000,
          },
          threadId,
          message.type
        );
      }
    }
  } else if (responses && !Array.isArray(responses)) {
    const filePath = resolveSafeShareFilePath(responses);
    if (filePath && fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".txt") {
        const fileContent = fs.readFileSync(filePath, "utf-8").trim();
        await api.sendMessage(
          {
            msg: fileContent,
            quote: message,
            ttl: 300000,
          },
          threadId,
          message.type
        );
      } else {
        await api.sendMessage(
          {
            msg: `📦 Đây là file bạn yêu cầu: ${responses}`,
            attachments: [filePath],
            ttl: 300000,
          },
          threadId,
          message.type
        );
      }
    } else {
      await api.sendMessage(
        {
          msg: responses,
          ttl: 3000000
        },
        threadId,
        message.type
      );
    }
  } else {
    if (groupSettings[threadId].learnEnabled && message.data.quote) {
      const nameQuote = message.data.quote.fromD;
      const botResponse = message.data.quote.msg;
      content = content.replace(nameQuote, "").replace("@", "").trim();
      if (content !== "" && content.length > 6) {
        learnFromChat(botResponse, threadId, content, nameGroup);
      }
    }
  }
}

// ====================== TRAINING DATA ======================
const trainingCaches = new Map();
const TRAINING_WRITE_DEBOUNCE_MS = Number(process.env.TRAINING_WRITE_DEBOUNCE_MS || 5000);
const MAX_TEMP_RESPONSES_PER_QUESTION = 20;
const MAX_TEMP_QUESTIONS_PER_GROUP = 300;
const TEMP_TRAINING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for auto-learned chat; !learn (!isTemporary) is permanent

function trainingFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function getTrainingCache() {
  const filePath = resolveTrainingPath();
  let entry = trainingCaches.get(filePath);
  if (!entry) {
    entry = { filePath, data: null, sig: null, dirty: false, timer: null };
    trainingCaches.set(filePath, entry);
  }
  return entry;
}

function persistTraining(entry) {
  entry.timer = null;
  if (!entry.dirty) return;
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(entry.filePath), { recursive: true });
    tmp = path.join(
      path.dirname(entry.filePath),
      `.tmp-training-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    );
    fs.writeFileSync(tmp, JSON.stringify(entry.data, null, 2), "utf-8");
    fs.renameSync(tmp, entry.filePath);
    entry.sig = trainingFileSignature(entry.filePath);
    entry.dirty = false;
  } catch (error) {
    try {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    console.error("Lỗi khi ghi file data-training.json:", error);
  }
}

function scheduleTrainingPersist(entry) {
  if (entry.timer) return;
  entry.timer = setTimeout(() => persistTraining(entry), TRAINING_WRITE_DEBOUNCE_MS);
  entry.timer.unref?.();
}

export function loadTrainingData() {
  const entry = getTrainingCache();
  const sig = trainingFileSignature(entry.filePath);
  // Serve from memory unless the file changed on disk (dashboard writes).
  if (entry.data !== null && (entry.dirty || entry.sig === sig)) {
    return entry.data;
  }
  try {
    if (!fs.existsSync(entry.filePath)) {
      fs.mkdirSync(path.dirname(entry.filePath), { recursive: true });
      fs.writeFileSync(entry.filePath, "{}", "utf-8");
      entry.data = {};
      entry.sig = null;
      return entry.data;
    }
    const data = JSON.parse(fs.readFileSync(entry.filePath, "utf-8").replace(/^\uFEFF/, ""));
    entry.data = data && typeof data === "object" ? data : {};
    entry.sig = sig;
    return entry.data;
  } catch (error) {
    console.error("Lỗi khi đọc file data-training.json:", error);
    entry.data = entry.data && typeof entry.data === "object" ? entry.data : {};
    return entry.data;
  }
}

export function saveTrainingData(data) {
  const entry = getTrainingCache();
  entry.data = data && typeof data === "object" ? data : {};
  entry.dirty = true;
  scheduleTrainingPersist(entry);
}

export function flushTrainingData() {
  for (const entry of trainingCaches.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    persistTraining(entry);
  }
}

process.once("beforeExit", flushTrainingData);
process.once("exit", flushTrainingData);

/**
 * Tỉa các câu tự học tạm (isTemporary: true) quá 7 ngày hoặc vượt trần 300 câu/nhóm.
 * BẢO VỆ TUYỆT ĐỐI 100% các câu do Admin dạy qua !learn / !learnnow (isTemporary: false).
 */
export function pruneTemporaryTrainingData(now = Date.now()) {
  const data = loadTrainingData();
  if (!data || typeof data !== "object") return false;
  const cutoff = now - TEMP_TRAINING_TTL_MS;
  let changed = false;

  for (const groupId of Object.keys(data)) {
    const listTrain = data[groupId]?.listTrain;
    if (!listTrain || typeof listTrain !== "object") continue;

    for (const q of Object.keys(listTrain)) {
      const raw = listTrain[q];
      const arr = Array.isArray(raw) ? raw : raw !== null && raw !== undefined ? [raw] : [];
      const filtered = [];
      for (const item of arr) {
        const isTemp = typeof item === "string" ? true : Boolean(item?.isTemporary);
        if (!isTemp) {
          filtered.push(item);
          continue;
        }
        const ts = typeof item === "object" ? Number(item?.updatedAt || item?.createdAt || 0) : 0;
        if (ts > 0 && ts < cutoff) {
          changed = true;
          continue;
        }
        filtered.push(item);
      }

      if (filtered.length > MAX_TEMP_RESPONSES_PER_QUESTION) {
        const permanent = filtered.filter((it) => typeof it === "object" && it?.isTemporary === false);
        const temps = filtered.filter((it) => typeof it === "string" || Boolean(it?.isTemporary));
        const allowedTemps = Math.max(0, MAX_TEMP_RESPONSES_PER_QUESTION - permanent.length);
        const keptTemps = temps.slice(-allowedTemps);
        if (keptTemps.length < temps.length) changed = true;
        listTrain[q] = [...permanent, ...keptTemps];
      } else if (filtered.length !== arr.length) {
        if (filtered.length === 0) {
          delete listTrain[q];
        } else {
          listTrain[q] = filtered;
        }
      }
    }

    // Cap temporary-only questions per group at MAX_TEMP_QUESTIONS_PER_GROUP (300)
    const tempQuestions = [];
    for (const q of Object.keys(listTrain)) {
      const arr = Array.isArray(listTrain[q]) ? listTrain[q] : [listTrain[q]];
      const allTemp = arr.every((it) => typeof it === "string" || Boolean(it?.isTemporary));
      if (allTemp) {
        const latestTs = arr.reduce((mx, it) => {
          const ts = typeof it === "object" ? Number(it?.updatedAt || it?.createdAt || 0) : 0;
          return ts > mx ? ts : mx;
        }, 0);
        tempQuestions.push({ q, latestTs });
      }
    }
    if (tempQuestions.length > MAX_TEMP_QUESTIONS_PER_GROUP) {
      tempQuestions
        .sort((a, b) => a.latestTs - b.latestTs)
        .slice(0, tempQuestions.length - MAX_TEMP_QUESTIONS_PER_GROUP)
        .forEach(({ q }) => {
          delete listTrain[q];
          changed = true;
        });
    }
  }

  if (changed) {
    saveTrainingData(data);
  }
  return changed;
}

export function learnFromChat(message, threadId, response, groupName) {
  if (isInvalidResponse(response)) return;
  const data = loadTrainingData();
  const now = Date.now();

  if (!data[threadId]) {
    data[threadId] = {
      nameGroup: groupName,
      listTrain: {},
    };
  }

  if (data[threadId].listTrain[message]) {
    const existingData = data[threadId].listTrain[message];
    let responses = [];
    if (Array.isArray(existingData)) {
      responses = existingData;
    } else if (typeof existingData === "string") {
      responses = [{ response: existingData, isTemporary: true, updatedAt: now }];
    } else {
      responses = [existingData];
    }

    responses.push({
      response: response,
      isTemporary: true,
      updatedAt: now,
    });

    if (responses.length > MAX_TEMP_RESPONSES_PER_QUESTION) {
      const tempIdx = responses.findIndex((r) => (typeof r === "string" ? true : Boolean(r?.isTemporary)));
      if (tempIdx !== -1) {
        responses.splice(tempIdx, 1);
      }
    }

    data[threadId].listTrain[message] = responses;
  } else {
    const listTrain = data[threadId].listTrain;
    const tempKeys = Object.keys(listTrain).filter((k) => {
      const items = Array.isArray(listTrain[k]) ? listTrain[k] : [listTrain[k]];
      return items.every((it) => (typeof it === "string" ? true : Boolean(it?.isTemporary)));
    });
    if (tempKeys.length >= MAX_TEMP_QUESTIONS_PER_GROUP) {
      delete listTrain[tempKeys[0]];
    }
    data[threadId].listTrain[message] = [
      {
        response: response,
        isTemporary: true,
        updatedAt: now,
      },
    ];
  }

  saveTrainingData(data);
}

// ====================== RESPONSE VALIDATION ======================
export function isInvalidResponse(response) {
  if (typeof response !== "string") return true;
  if (response.includes("..") || response.includes("/") || response.includes("\\")) {
    return true;
  }
  const responseLower = response.toLowerCase();
  const invalidKeywords = [
    "cặc",
    "lồn"
  ];

  return invalidKeywords.some((keyword) => responseLower.includes(keyword));
}

// ====================== FLATTEN / LIST HELPERS ======================
const DEFAULT_LEARN_LIST_PAGE_SIZE = 20;

function normalizeTrainingItem(item) {
  if (item === null || item === undefined) return null;
  if (typeof item === "string") {
    return { response: item, isTemporary: true };
  }
  if (typeof item === "object" && typeof item.response === "string") {
    return {
      response: item.response,
      isTemporary: Boolean(item.isTemporary),
    };
  }
  return null;
}

export function flattenGroupTraining(threadId) {
  const data = loadTrainingData();
  const listTrain = data?.[threadId]?.listTrain;
  const items = [];
  if (!listTrain || typeof listTrain !== "object") return items;

  const questions = Object.keys(listTrain);
  for (const question of questions) {
    const raw = listTrain[question];
    let entries;
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw === null || raw === undefined) {
      entries = [];
    } else {
      entries = [raw];
    }
    let position = 0;
    for (const entry of entries) {
      const normalized = normalizeTrainingItem(entry);
      if (normalized) {
        items.push({
          index: items.length + 1,
          question,
          response: normalized.response,
          isTemporary: normalized.isTemporary,
          position: position,
        });
        position += 1;
      }
    }
  }
  return items;
}

export function listLearnedResponses(threadId, page = 1, pageSize = DEFAULT_LEARN_LIST_PAGE_SIZE) {
  const items = flattenGroupTraining(threadId);
  const safePageSize = Math.max(1, Number(pageSize) || DEFAULT_LEARN_LIST_PAGE_SIZE);
  const total = items.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / safePageSize);
  const safePage = totalPages === 0 ? 1 : Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * safePageSize;
  const slice = items.slice(start, start + safePageSize);
  return {
    items: slice,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages,
  };
}

export function removeLearnedResponseByIndex(threadId, index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 1) {
    return { removed: false, reason: "invalid" };
  }
  const data = loadTrainingData();
  const listTrain = data?.[threadId]?.listTrain;
  if (!listTrain || typeof listTrain !== "object") {
    return { removed: false, reason: "not_found" };
  }
  const items = flattenGroupTraining(threadId);
  const target = items.find((it) => it.index === idx);
  if (!target) {
    return { removed: false, reason: "not_found" };
  }
  const raw = listTrain[target.question];
  if (raw === null || raw === undefined) {
    return { removed: false, reason: "not_found" };
  }
  if (!Array.isArray(raw)) {
    // Single-entry question: removing the indexed answer is the only answer
    delete listTrain[target.question];
    saveTrainingData(data);
    return {
      removed: true,
      question: target.question,
      response: target.response,
      questionRemoved: true,
    };
  }
  const position = target.position;
  if (position < 0 || position >= raw.length) {
    return { removed: false, reason: "not_found" };
  }
  raw.splice(position, 1);
  if (raw.length === 0) {
    delete listTrain[target.question];
  }
  saveTrainingData(data);
  return {
    removed: true,
    question: target.question,
    response: target.response,
    questionRemoved: raw.length === 0,
  };
}

// ====================== RESPONSE MANAGEMENT ======================
function removeSpecificResponse(threadId, question, responseToRemove) {
  const data = loadTrainingData();
  let removed = false;

  if (data[threadId]?.listTrain?.[question]) {
    const responses = data[threadId].listTrain[question];

    if (Array.isArray(responses)) {
      const filteredResponses = responses.filter((item) => {
        const response = typeof item === "string" ? item : item.response;
        return response.trim() !== responseToRemove.trim();
      });

      if (filteredResponses.length < responses.length) {
        removed = true;
        if (filteredResponses.length === 0) {
          delete data[threadId].listTrain[question];
        } else {
          data[threadId].listTrain[question] = filteredResponses;
        }
        saveTrainingData(data);
        console.log(`Đã xóa câu trả lời "${responseToRemove}" của câu hỏi "${question}"`);
      }
    } else {
      const response = typeof responses === "string" ? responses : responses.response;
      if (response.trim() === responseToRemove.trim()) {
        delete data[threadId].listTrain[question];
        removed = true;
        saveTrainingData(data);
        console.log(`Đã xóa câu trả lời "${responseToRemove}" của câu hỏi "${question}"`);
      }
    }
  }

  return removed;
}

function trackResponseUsage(threadId, question, response) {
  removeSpecificResponse(threadId, question, response);
  return true;
}

// ====================== FIND RESPONSE ======================
export function findResponse(message, threadId) {
  const data = loadTrainingData();

  if (data[threadId] && data[threadId].listTrain) {
    for (const question of Object.keys(data[threadId].listTrain)) {
      if (message.includes(question)) {
        const responses = data[threadId].listTrain[question];
        const validResponses = Array.isArray(responses)
          ? responses.filter((r) => !isInvalidResponse(typeof r === "string" ? r : r.response))
          : !isInvalidResponse(typeof responses === "string" ? responses : responses.response)
            ? [responses]
            : [];

        if (validResponses.length > 0) {
          const responseList = validResponses.map((r) => {
            const response = typeof r === "string" ? r : r.response;
            const isTemp = typeof r === "string" ? true : r.isTemporary;
            if (isTemp) {
              trackResponseUsage(threadId, question, response);
            }
            return response;
          });
          return responseList;
        }
      }
    }
  }
  return null;
}

// ====================== COMMAND HANDLERS ======================
function escapeCmdRegExp(str) {
  return String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLearnNowPair(rawPayload) {
  const cleaned = String(rawPayload || "").replace(/^[\s_]+/, "").trim();
  if (!cleaned) return null;

  if (cleaned.includes("|")) {
    const sepIdx = cleaned.indexOf("|");
    const question = cleaned.slice(0, sepIdx).trim();
    const answer = cleaned.slice(sepIdx + 1).trim().replace(/\\n/g, "\n");
    if (question && answer) return { question, answer };
    return null;
  }

  if (cleaned.includes("_")) {
    const sepIdx = cleaned.indexOf("_");
    const question = cleaned.slice(0, sepIdx).trim();
    const answer = cleaned.slice(sepIdx + 1).trim().replace(/\\n/g, "\n");
    if (question && answer) return { question, answer };
  }

  return null;
}

export async function handleLearnCommand(
  api,
  message,
  groupSettings,
  aliasCommand = "",
  forcedKind = ""
) {
  const threadId = message.threadId;
  const content = (removeMention(message) || String(message?.data?.content || "")).trim();
  const prefix = getGlobalPrefix();
  const escapedPrefix = escapeCmdRegExp(prefix);

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = { learnEnabled: false, replyEnabled: false };
  }

  const learnNowRegex = new RegExp(
    `^\\s*${escapedPrefix}\\s*${aliasCommand && forcedKind === "learnnow" ? escapeCmdRegExp(aliasCommand) : "learnnow"}(?=[\\s_]|$)`,
    "i"
  );
  const unlearnRegex = new RegExp(
    `^\\s*${escapedPrefix}\\s*${aliasCommand && forcedKind === "unlearn" ? escapeCmdRegExp(aliasCommand) : "unlearn"}(?:\\s+|$)`,
    "i"
  );
  const learnRegex = new RegExp(
    `^\\s*${escapedPrefix}\\s*${aliasCommand && forcedKind === "learn" ? escapeCmdRegExp(aliasCommand) : "learn"}(?:\\s+|$)`,
    "i"
  );

  if (forcedKind === "learnnow" || learnNowRegex.test(content)) {
    const payload = content.replace(learnNowRegex, "");
    const parsed = parseLearnNowPair(payload);
    if (parsed) {
      const { question, answer } = parsed;
      const success = await learnNewResponse(api, threadId, question, answer);
      if (success) {
        const caption = `Đã thêm câu trả lời cố định thành công. Khi người dùng gửi tin nhắn chứa "${question}", tôi sẽ trả lời:\n${answer}`;
        await sendMessageComplete(api, message, caption);
      } else {
        const caption = `Không thể lưu: Câu trả lời "${answer}" đã tồn tại hoặc chứa từ khóa không hợp lệ.`;
        await sendMessageWarning(api, message, caption);
      }
    } else {
      const caption =
        `Cú pháp: ${prefix}${aliasCommand || "learnnow"} [Câu hỏi] | [Câu trả lời] ` +
        `hoặc ${prefix}${aliasCommand || "learnnow"}_[Câu hỏi]_[Câu trả lời] (dùng \\n để xuống dòng)`;
      await sendMessageWarning(api, message, caption);
    }
    return true;
  }

  if (forcedKind === "unlearn" || unlearnRegex.test(content)) {
    await handleUnlearnCommand(api, message, aliasCommand || "unlearn");
    return true;
  }

  if (forcedKind === "learn" || learnRegex.test(content)) {
    const rest = content.replace(learnRegex, "").trim();
    const parts = rest ? rest.split(/\s+/).filter(Boolean) : [];
    const sub = (parts[0] || "").toLowerCase();

    if (sub === "list") {
      await handleLearnListCommand(api, message, parts[1]);
    } else if (parts.length === 0) {
      groupSettings[threadId].learnEnabled = !groupSettings[threadId].learnEnabled;
      writeGroupSettings(groupSettings);
      const caption = `Chế độ học tập đã được ${groupSettings[threadId].learnEnabled ? "bật" : "tắt"}!`;
      await sendMessageStateQuote(api, message, caption, groupSettings[threadId].learnEnabled, 30000, false);
    } else if (sub === "on" || sub === "off") {
      groupSettings[threadId].learnEnabled = sub === "on";
      writeGroupSettings(groupSettings);
      const caption = `Chế độ học tập đã được ${sub === "on" ? "bật" : "tắt"}!`;
      await sendMessageStateQuote(api, message, caption, groupSettings[threadId].learnEnabled, 30000, false);
    } else {
      await sendMessageWarning(
        api,
        message,
        `❌ Cú pháp không hợp lệ. Sử dụng ${prefix}learn, ${prefix}learn on/off để bật/tắt chế độ học tập, hoặc ${prefix}learn list [trang] để xem danh sách.`
      );
    }
    return true;
  }

  return false;
}

export async function handleReplyCommand(api, message, groupSettings, aliasCommand = "reply") {
  const threadId = message.threadId;
  const content = (removeMention(message) || String(message?.data?.content || "")).trim();
  const prefix = getGlobalPrefix();
  const replyRegex = new RegExp(
    `^\\s*${escapeCmdRegExp(prefix)}\\s*${escapeCmdRegExp(aliasCommand || "reply")}(?:\\s+|$)`,
    "i"
  );

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = { learnEnabled: false, replyEnabled: false };
  }

  if (replyRegex.test(content)) {
    const rest = content.replace(replyRegex, "").trim();
    const arg = (rest.split(/\s+/)[0] || "").toLowerCase();

    if (!arg) {
      groupSettings[threadId].replyEnabled = !groupSettings[threadId].replyEnabled;
      writeGroupSettings(groupSettings);
      const enabled = Boolean(groupSettings[threadId].replyEnabled);
      const caption = `Chế độ trả lời tự động đã được ${enabled ? "bật" : "tắt"}!`;
      await sendMessageStateQuote(api, message, caption, enabled, 30000, false);
    } else if (arg === "on" || arg === "off") {
      const enabled = arg === "on";
      groupSettings[threadId].replyEnabled = enabled;
      writeGroupSettings(groupSettings);
      const caption = `Chế độ trả lời tự động đã được ${enabled ? "bật" : "tắt"}!`;
      await sendMessageStateQuote(api, message, caption, enabled, 30000, false);
    } else {
      await sendMessageWarning(
        api,
        message,
        `❌ Cú pháp không hợp lệ. Sử dụng ${prefix}${aliasCommand || "reply"} hoặc ${prefix}${aliasCommand || "reply"} on/off để bật/tắt chế độ trả lời.`
      );
    }
    return true;
  }
  return false;
}

export async function learnNewResponse(api, threadId, question, answer) {
  if (isInvalidResponse(answer)) {
    return false;
  }
  const data = loadTrainingData();

  if (!data[threadId]) {
    data[threadId] = {
      nameGroup: await getGroupName(api, threadId),
      listTrain: {},
    };
  }

  if (data[threadId].listTrain[question]) {
    const existingData = data[threadId].listTrain[question];
    let responses = [];

    if (Array.isArray(existingData)) {
      responses = existingData;
    } else if (typeof existingData === "string") {
      responses = [{ response: existingData, isTemporary: false }];
    } else {
      responses = [existingData];
    }

    const isDuplicate = responses.some((r) => r.response === answer);
    if (!isDuplicate) {
      responses.push({
        response: answer,
        isTemporary: false,
      });
      data[threadId].listTrain[question] = responses;
      saveTrainingData(data);
      return true;
    } else {
      return false;
    }
  } else {
    data[threadId].listTrain[question] = [
      {
        response: answer,
        isTemporary: false,
      },
    ];
    saveTrainingData(data);
    return true;
  }
}

export async function handleUnlearnCommand(api, message, aliasCommand = "unlearn") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const content = (removeMention(message) || String(message?.data?.content || "")).trim();
  const prefix = getGlobalPrefix();
  const unlearnRegex = new RegExp(
    `^\\s*${escapeCmdRegExp(prefix)}\\s*${escapeCmdRegExp(aliasCommand || "unlearn")}(?:\\s+|$)`,
    "i"
  );

  if (unlearnRegex.test(content)) {
    const rawArg = content.replace(unlearnRegex, "").trim();
    if (rawArg) {
      if (/^[1-9]\d*$/.test(rawArg)) {
        const index = parseInt(rawArg, 10);
        const result = removeLearnedResponseByIndex(threadId, index);
        if (result.removed) {
          const shortResponse = shortenForMessage(result.response, 120);
          const note = result.questionRemoved
            ? ` (câu hỏi đã hết câu trả lời, đã xoá luôn câu hỏi)`
            : "";
          await api.sendMessage(
            {
              msg: `✅ Đã xóa mục #${index}: câu hỏi "${result.question}" → "${shortResponse}"${note}`,
              quote: message,
              ttl: 30000,
            },
            threadId,
            threadType
          );
        } else {
          const detail = result.reason === "invalid"
            ? "số không hợp lệ"
            : "không tồn tại";
          await api.sendMessage(
            {
              msg: `❌ Không tìm thấy mục #${index} (${detail}). Dùng ${prefix}learn list để xem số thứ tự hợp lệ.`,
              quote: message,
              ttl: 30000,
            },
            threadId,
            threadType
          );
        }
        return true;
      }
      const valueToRemove = rawArg.replace(/\\n/g, "\n");
      const removed = await removeLearnedResponse(threadId, valueToRemove);
      if (removed) {
        await api.sendMessage(
          {
            msg: `✅ Đã xóa thành công câu hỏi có câu trả lời "${valueToRemove}"`,
            quote: message,
            ttl: 30000,
          },
          threadId,
          threadType
        );
      } else {
        await api.sendMessage(
          {
            msg: `❌ Không tìm thấy câu hỏi nào có câu trả lời "${valueToRemove}". Gợi ý: dùng ${prefix}learn list rồi ${prefix}${aliasCommand || "unlearn"} <số> để xóa chính xác.`,
            quote: message,
            ttl: 30000,
          },
          threadId,
          threadType
        );
      }
    } else {
      await api.sendMessage(
        {
          msg:
            `💡 Hướng dẫn xóa dữ liệu học:\n` +
            `• Xem danh sách: ${prefix}learn list\n` +
            `• Xóa theo số thứ tự: ${prefix}${aliasCommand || "unlearn"} <số> (ví dụ: ${prefix}${aliasCommand || "unlearn"} 1)\n` +
            `• Xóa theo câu trả lời: ${prefix}${aliasCommand || "unlearn"} <nội dung câu trả lời>`,
          quote: message,
          ttl: 45000,
        },
        threadId,
        threadType
      );
    }
    return true;
  }
  return false;
}

function shortenForMessage(value, max) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r?\n/g, " ⏎ ");
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, Math.max(0, max - 1)) + "…";
}

function buildLearnListMessage(threadId, page) {
  const result = listLearnedResponses(threadId, page, DEFAULT_LEARN_LIST_PAGE_SIZE);
  if (result.total === 0) {
    return `📚 Nhóm này chưa có dữ liệu học nào.`;
  }
  const lines = [];
  lines.push(`📚 Danh sách câu học của nhóm (trang ${result.page}/${result.totalPages}, tổng ${result.total}):`);
  for (const item of result.items) {
    const tag = item.isTemporary ? "Tạm" : "Cố định";
    const q = shortenForMessage(item.question, 60);
    const r = shortenForMessage(item.response, 80);
    lines.push(`${item.index}. [${tag}] Hỏi: ${q} → Đáp: ${r}`);
  }
  lines.push(`💡 Dùng !unlearn <số> để xoá (ví dụ: !unlearn ${result.items[0].index}).`);
  return lines.join("\n");
}

export async function handleLearnListCommand(api, message, page) {
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const content = (removeMention(message) || String(message?.data?.content || "")).trim();
  let parsedPage = page;
  if (parsedPage === undefined) {
    const parts = content.split(/\s+/);
    parsedPage = parts.length >= 3 ? parts[2] : 1;
  }
  const pageNum = Number(parsedPage);
  const safePage = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : 1;
  const text = buildLearnListMessage(threadId, safePage);
  await api.sendMessage(
    {
      msg: text,
      quote: message,
      ttl: 60000,
    },
    threadId,
    threadType
  );
  return true;
}

export async function removeLearnedResponse(threadId, value) {
  const data = loadTrainingData();
  let removed = false;

  if (data[threadId] && data[threadId].listTrain) {
    const entries = Object.entries(data[threadId].listTrain);

    for (const [key, val] of entries) {
      if (Array.isArray(val)) {
        const filteredResponses = val.filter((item) => {
          const response = typeof item === "string" ? item : item.response;
          return response.trim() !== value.trim();
        });

        if (filteredResponses.length < val.length) {
          removed = true;
          console.log(`Đã xóa - Câu hỏi: "${key}" - Câu trả lời: "${value}"`);
          if (filteredResponses.length === 0) {
            delete data[threadId].listTrain[key];
          } else {
            data[threadId].listTrain[key] = filteredResponses;
          }
        }
      } else {
        const response = typeof val === "string" ? val : val.response;
        if (response && response.trim() === value.trim()) {
          delete data[threadId].listTrain[key];
          removed = true;
          console.log(`Đã xóa - Câu hỏi: "${key}" - Câu trả lời: "${value}"`);
        }
      }
    }

    if (removed) {
      saveTrainingData(data);
    }
  }

  return removed;
}

export async function handleBotReply(api, message, groupSettings) {
  const threadId = message.threadId;
  const content = message.data.content;
  const data = loadTrainingData();

  if (groupSettings[threadId]?.replyEnabled && data[threadId]?.listTrain) {
    for (const question of Object.keys(data[threadId].listTrain)) {
      if (content.includes(question)) {
        const responses = data[threadId].listTrain[question];
        const validResponses = Array.isArray(responses)
          ? responses.filter((r) => !isInvalidResponse(typeof r === "string" ? r : r.response))
          : !isInvalidResponse(typeof responses === "string" ? responses : responses.response)
            ? [responses]
            : [];

        if (validResponses.length > 0) {
          for (const r of validResponses) {
            const response = typeof r === "string" ? r : r.response;
            const isTemp = typeof r === "string" ? true : r.isTemporary;
            const filePath = resolveSafeShareFilePath(response);
            if (filePath && fs.existsSync(filePath)) {
              const ext = path.extname(filePath).toLowerCase();
              if (ext === ".txt") {
                const fileContent = fs.readFileSync(filePath, "utf-8").trim();
                await api.sendMessage(
                  {
                    msg: fileContent,
                    quote: message,
                    ttl: 300000,
                  },
                  threadId,
                  message.type
                );
              } else {
                await api.sendMessage(
                  {
                    msg: `📦 Đây là file bạn yêu cầu: ${response}`,
                    attachments: [filePath],
                    ttl: 300000,
                  },
                  threadId,
                  message.type
                );
              }
            } else {
              await api.sendMessage(
                {
                  msg: response,
                  quote: message,
                  ttl: 300000,
                },
                threadId,
                message.type
              );
            }
            if (isTemp) {
              trackResponseUsage(threadId, question, response);
            }
          }
          return true;
        }
      }
    }
  }
  return false;
}
