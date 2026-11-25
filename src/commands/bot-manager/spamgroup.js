import { getGlobalPrefix } from "../../service-debug/service.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { loadPendingTasks, removePendingTask, addPendingTask } from "../../skills/task-persistence.js";
import { extractCommandBody, safeThreadType } from "../shared/command-input-utils.js";

const spamSessions = new Map();
const MIN_DELAY_MS = 1000;
const MAX_REPEAT = 20;

function stopSpamSession(threadId) {
  const session = spamSessions.get(threadId);
  if (session?.interval) {
    clearInterval(session.interval);
    session.interval = null;
  }
  if (session) {
    session.isSpamming = false;
    session.sentCount = 0;
  }
  removePendingTask(`spamgroup_${threadId}`);
}

function startBoundedSpamLoop(api, threadId, session) {
  if (session.interval) {
    clearInterval(session.interval);
  }
  session.isSpamming = true;
  session.sentCount = 0;
  session.interval = setInterval(async () => {
    if (!session.isSpamming || session.sentCount >= session.maxRepeat) {
      stopSpamSession(threadId);
      return;
    }
    session.sentCount += 1;
    await sendSpam(api, threadId, session.text, session.ttl);
    if (session.sentCount >= session.maxRepeat) {
      stopSpamSession(threadId);
    }
  }, session.delay);
  session.interval.unref?.();
}

export async function resumeSpamSessions(api) {
  const tasks = loadPendingTasks().filter((t) => t.type === "spamgroup" && t.status === "pending");
  for (const task of tasks) {
    if (!task.data?.threadId || !task.data?.text) continue;
    const { threadId, text, delay, ttl } = task.data;
    const session = {
      isSpamming: false,
      text: String(text),
      delay: Math.max(Number(delay) || MIN_DELAY_MS, MIN_DELAY_MS),
      ttl: Math.max(Number(ttl) || 10000, 0),
      sentCount: 0,
      maxRepeat: MAX_REPEAT,
      interval: null,
    };
    spamSessions.set(threadId, session);
    startBoundedSpamLoop(api, threadId, session);
  }
}

export async function spamgroup(api, message, aliasCommand = "spamgroup") {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "spamgroup";
  let args = extractCommandBody(message, prefix, safeAlias);
  if (args.toLowerCase().startsWith(`${prefix}spamgr`.toLowerCase())) {
    args = extractCommandBody(message, prefix, "spamgr");
  } else if (args.toLowerCase().startsWith(`${prefix}spamgroup`.toLowerCase())) {
    args = extractCommandBody(message, prefix, "spamgroup");
  }

  const sendSyntaxError = () =>
    api.sendMessage(
      {
        msg:
          `⚠️ Cú pháp sai. Dùng:\n` +
          `- ${prefix}${safeAlias} <nội dung>|<delay >= ${MIN_DELAY_MS}ms>[|<số lần <= ${MAX_REPEAT}>]\n` +
          `- ${prefix}${safeAlias} delay|<giá trị mới >= ${MIN_DELAY_MS}>\n` +
          `- ${prefix}${safeAlias} set|<ttl (ms)>\n` +
          `- ${prefix}${safeAlias} stop`,
        quote: message,
      },
      threadId,
      threadType,
      60000,
    );

  if (!args) {
    return sendSyntaxError();
  }

  let session = spamSessions.get(threadId);
  if (!session) {
    session = {
      isSpamming: false,
      text: "",
      delay: MIN_DELAY_MS,
      ttl: 10000,
      sentCount: 0,
      maxRepeat: MAX_REPEAT,
      interval: null,
    };
    spamSessions.set(threadId, session);
  }

  if (args.toLowerCase() === "stop") {
    if (session.isSpamming) {
      stopSpamSession(threadId);
      return api.sendMessage({ msg: "✅ Đã dừng spam.", quote: message }, threadId, threadType);
    }
    return api.sendMessage({ msg: "⚠️ Không có spam nào đang chạy.", quote: message }, threadId, threadType);
  }

  if (args.toLowerCase().startsWith("delay|")) {
    const rawDelay = Number.parseInt(args.split("|")[1], 10);
    if (Number.isNaN(rawDelay) || rawDelay < 1) {
      return api.sendMessage({ msg: "⚠️ Delay không hợp lệ.", quote: message }, threadId, threadType);
    }
    session.delay = Math.max(rawDelay, MIN_DELAY_MS);
    if (session.isSpamming) {
      startBoundedSpamLoop(api, threadId, session);
    }
    return api.sendMessage(
      { msg: `✅ Đã đổi delay thành ${session.delay}ms.`, quote: message },
      threadId,
      threadType,
    );
  }

  if (args.toLowerCase().startsWith("set|")) {
    const newTTL = Number.parseInt(args.split("|")[1], 10);
    if (Number.isNaN(newTTL) || newTTL < 0) {
      return api.sendMessage({ msg: "⚠️ TTL không hợp lệ.", quote: message }, threadId, threadType);
    }
    session.ttl = newTTL;
    return api.sendMessage({ msg: `✅ TTL đã đặt thành ${session.ttl}ms.`, quote: message }, threadId, threadType);
  }

  if (args.includes("|")) {
    const parts = args.split("|");
    const msgContent = (parts[0] || "").trim();
    const rawDelay = Number.parseInt(parts[1], 10);
    const rawRepeat = parts[2] ? Number.parseInt(parts[2], 10) : MAX_REPEAT;
    if (!msgContent || Number.isNaN(rawDelay) || rawDelay < 1) {
      return sendSyntaxError();
    }

    session.text = msgContent;
    session.delay = Math.max(rawDelay, MIN_DELAY_MS);
    session.maxRepeat = Math.min(Math.max(Number.isFinite(rawRepeat) ? rawRepeat : MAX_REPEAT, 1), MAX_REPEAT);

    startBoundedSpamLoop(api, threadId, session);

    addPendingTask({
      id: `spamgroup_${threadId}`,
      type: "spamgroup",
      status: "pending",
      data: {
        threadId,
        text: session.text,
        delay: session.delay,
        ttl: session.ttl,
      },
    });

    return api.sendMessage(
      {
        msg: `✅ Bắt đầu gửi lặp:\n"${session.text}"\n⏱ Delay: ${session.delay}ms | Tối đa: ${session.maxRepeat} lần\n🕒 TTL: ${session.ttl}ms`,
        quote: message,
      },
      threadId,
      threadType,
    );
  }

  return sendSyntaxError();
}

async function sendSpam(api, threadId, text, ttl) {
  if (!text) return;
  try {
    await api.sendMessage({ msg: text, ttl }, threadId, MessageType.GroupMessage);
  } catch (error) {
    console.error(`Lỗi khi gửi lặp nhóm ${threadId}:`, error?.message || error);
  }
}
