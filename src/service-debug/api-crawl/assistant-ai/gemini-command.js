import { getGlobalPrefix } from "../../service.js";
import { getContent } from "../../../utils/format-util.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageQuery,
  sendMessageStateQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { nameServer } from "../../../utils/server-config.js";

const chatSessions = new Map();

const requestQueue = [];
let isProcessing = false;
const DELAY_BETWEEN_REQUESTS = 3000;

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;
  try {
    while (requestQueue.length > 0) {
      const { resolve, reject, fn } = requestQueue.shift();
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUESTS));
    }
  } finally {
    isProcessing = false;
  }
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, fn });
    processQueue();
  });
}

async function callGeminiTextAPI(question) {
  if (GEMINI_KEYS.length === 0) {
    throw new Error("GEMINI_API_KEYS chua duoc cau hinh");
  }
  // Lightweight wrapper: the legacy import kept a single key here. Real keys
  // must come from env. We never embed API keys in source.
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(question);
  return result.response.text();
}

export async function callGeminiAPI(api, message, question, userId) {
  return enqueue(async () => {
    const session = getChatSession(userId);
    session.lastInteraction = Date.now();
    session.history.push({ role: "user", content: question });
    if (session.history.length > 20) session.history = session.history.slice(-20);
    const prompt = session.history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
    const response = await callGeminiTextAPI(prompt);
    session.history.push({ role: "assistant", content: response });
    cleanupOldSessions();
    return response;
  });
}

function getChatSession(userId) {
  if (!chatSessions.has(userId)) {
    chatSessions.set(userId, { history: [], lastInteraction: Date.now() });
  }
  return chatSessions.get(userId);
}

function cleanupOldSessions() {
  const MAX_IDLE_TIME = 30 * 60 * 1000;
  const now = Date.now();
  for (const [userId, session] of chatSessions.entries()) {
    if (now - session.lastInteraction > MAX_IDLE_TIME) chatSessions.delete(userId);
  }
}

export async function askGeminiCommand(api, message, aliasCommand) {
  const content = getContent(message);
  const userId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const question = content.replace(`${prefix}${aliasCommand}`, "").trim();
  if (question === "") {
    await sendMessageQuery(api, message, `Vui long nhap cau hoi can giai dap!\nDung ${prefix}${aliasCommand} reset de lam moi cuoc tro chuyen`);
    return;
  }
  if (question.toLowerCase() === "reset") {
    chatSessions.delete(userId);
    await sendMessageComplete(api, message, "Đã xóa lịch sử cuộc trò chuyện!", false);
    return;
  }
  if (GEMINI_KEYS.length === 0) {
    await sendMessageFailed(api, message, "GEMINI_API_KEYS chua duoc cau hinh.", true);
    return;
  }
  try {
    const replyText = await callGeminiAPI(api, message, question, userId);
    await sendMessageStateQuote(api, message, replyText || "", true, 1800000, false);
  } catch (error) {
    await sendMessageFailed(api, message, "Xin loi, co loi xay ra khi xu ly yeu cau.", true);
  }
}

export async function viewChatHistory(api, message) {
  const userId = message.senderID;
  const session = chatSessions.get(userId);
  if (!session || session.history.length === 0) {
    await sendMessageComplete(api, message, "Ban chua co lich su tro chuyen!", false);
    return;
  }
  const history = session.history
    .map((msg, index) => `${index + 1}. ${msg.role === "user" ? "Bạn" : nameServer}: ${msg.content}`)
    .join("\n\n");
  await sendMessageComplete(api, message, `Lịch sử trò chuyện:\n\n${history}`, false);
}