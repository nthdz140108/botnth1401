import { getBotName } from "../../utils/env.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { appContext } from "../../api-zalo/context.js";
import { getProfile } from "../mybot/System/mybot-profile-service.js";
import { sendMessageComplete } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { safeThreadType } from "../shared/command-input-utils.js";
import {
  createCustomCommand,
  removeCustomCommand,
  listCustomCommands,
} from "./store.js";
import { parseCmdaddInput, PARSE_CREATE, PARSE_LIST, PARSE_REMOVE, PARSE_INVALID } from "./parser.js";
import {
  resolveMediaFromMessage,
  cleanupTempFile,
  mediaKindOf,
} from "./media.js";
import { renderCustomCommandListImage } from "./renderer.js";
import { sendCustomCommand } from "./executor.js";

const MAX_TEXT_LENGTH = 2000;

export async function handleCmdaddCommand(api, message, commandParts, context = {}) {
  const root = context.root || process.env.PROJECT_ROOT || process.cwd();
  const input = Array.isArray(commandParts) ? commandParts.slice(1).join(" ") : "";
  const parsed = parseCmdaddInput(input);
  const senderId = message?.data?.uidFrom;

  if (parsed.kind === PARSE_LIST) {
    return handleList(api, message, parsed, { root });
  }

  if (parsed.kind === PARSE_REMOVE) {
    return handleRemove(api, message, parsed, { root, senderId });
  }

  if (parsed.kind === PARSE_INVALID) {
    const reason = reasonMessage(parsed.reason);
    return sendReply(api, message, `⚠️ ${reason}`);
  }

  if (parsed.kind === PARSE_CREATE) {
    return handleCreate(api, message, parsed, { root, senderId });
  }

  return sendReply(api, message, "⚠️ Không hiểu cú pháp. Dùng `!cmdadd <tên> | <nội dung>`.");
}

async function handleCreate(api, message, parsed, { root, senderId }) {
  const text = String(parsed.text ?? "").trim();
  if (!text) return sendReply(api, message, "⚠️ Nội dung lệnh không được để trống.");
  if (text.length > MAX_TEXT_LENGTH) {
    return sendReply(api, message, `⚠️ Nội dung lệnh quá dài (tối đa ${MAX_TEXT_LENGTH} ký tự).`);
  }

  let mediaCandidate = null;
  if (message?.data?.quote) {
    try {
      mediaCandidate = (await resolveMediaFromMessage(api, message, { root })) || null;
    } catch (mediaError) {
      if (mediaError?.filePath) {
        await cleanupTempFile(mediaError.filePath).catch(() => {});
      }
      if (mediaError?.code === "MEDIA_TOO_LARGE") {
        return sendReply(api, message, `⚠️ ${mediaError.message || "Media đính kèm vượt giới hạn dung lượng cho phép."}`);
      }
      if (mediaError?.code === "INVALID_MEDIA_KIND") {
        return sendReply(api, message, "⚠️ Định dạng media đính kèm không hợp lệ (chỉ hỗ trợ ảnh, âm thanh hoặc video).");
      }
      if (mediaError?.code === "EMPTY_MEDIA") {
        return sendReply(api, message, "⚠️ File media đính kèm bị rỗng hoặc lỗi.");
      }
      return sendReply(api, message, `⚠️ Không thể xử lý media đính kèm: ${mediaError?.message || "lỗi tải file"}.`);
    }
  }

  const mediaInput = mediaCandidate
    ? { tempPath: mediaCandidate.filePath, kind: mediaCandidate.kind }
    : null;

  try {
    const command = await createCustomCommand({
      name: parsed.name,
      text,
      media: mediaInput,
      createdBy: senderId,
      root,
    });
    if (command?.movedTempPath) await cleanupTempFile(command.movedTempPath).catch(() => {});
  } catch (error) {
    const removed = createCustomCommand.lastMovedPath;
    if (removed) await cleanupTempFile(removed).catch(() => {});
    if (mediaInput?.tempPath) await cleanupTempFile(mediaInput.tempPath).catch(() => {});
    if (error?.code === "DUPLICATE_COMMAND") {
      return sendReply(api, message, `⚠️ Lệnh "${parsed.name}" đã tồn tại. Hãy xóa rồi tạo lại.`);
    }
    if (error?.code === "INVALID_NAME") {
      return sendReply(api, message, "⚠️ Tên lệnh không hợp lệ.");
    }
    if (error?.code === "RESERVED_NAME") {
      return sendReply(api, message, `⚠️ Tên "${parsed.name}" trùng với lệnh hệ thống.`);
    }
    return sendReply(api, message, `⚠️ Không thể tạo lệnh: ${error?.message || "lỗi không xác định"}`);
  }

  await sendReply(api, message, `✅ Đã tạo lệnh custom "${parsed.name}". Mọi thành viên có thể gọi ngay: !${parsed.name}`);
  return;
}

async function handleList(api, message, parsed, { root }) {
  const threadType = safeThreadType(message);
  const list = listCustomCommands({ page: parsed.page, root });
  const pageCommands = list.commands.map((command) => ({
    id: command.id,
    name: command.name,
    description: shortText(command.text, 60),
    permission: "all",
    countdown: 30,
    icon: iconForMedia(command.media),
    conflict: Boolean(command.conflict),
    media: command.media,
  }));

  let imagePath = null;
  let renderFailed = false;
  try {
    imagePath = await renderCustomCommandListImage({
      pageCommands,
      page: list.page,
      totalPages: list.totalPages,
      totalCommands: list.total,
      botName: safeBotName(),
      prefix: getGlobalPrefix(),
    });
  } catch (error) {
    console.error("[!cmdadd list] render image failed, fallback text:", error);
    renderFailed = true;
  }

  if (imagePath && !renderFailed) {
    try {
      await api.sendMessage(
        {
          msg: `📄 Trang ${list.page}/${list.totalPages}`,
          attachments: [imagePath],
          quote: message,
          ttl: 180000,
        },
        message.threadId,
        threadType
      );
      return;
    } catch (error) {
      console.error("[!cmdadd list] send image failed, fallback text:", error);
    } finally {
      try {
        if (imagePath) await cleanupTempFile(imagePath);
      } catch {
        // ignore
      }
    }
  }

  const text = buildTextListFallback(list, pageCommands);
  const parts = splitMessage(text);
  for (let i = 0; i < parts.length; i++) {
    await api.sendMessage(
      { msg: parts[i], quote: i === 0 ? message : null, ttl: 180000 },
      message.threadId,
      threadType
    );
  }
}

async function handleRemove(api, message, parsed, { root, senderId }) {
  const removed = await removeCustomCommand(parsed.target, root);
  if (!removed) {
    return sendReply(api, message, `⚠️ Không tìm thấy lệnh custom "${parsed.target}".`);
  }
  await sendReply(api, message, `✅ Đã xóa lệnh custom "${removed.name}" (ID #${removed.id}).`);
}

function reasonMessage(reason) {
  const messages = {
    EMPTY: "Vui lòng nhập nội dung. Ví dụ: `!cmdadd <tên> | <nội dung>`.",
    MISSING_TEXT: "Thiếu nội dung sau dấu `|`. Dùng `!cmdadd <tên> | <nội dung>`.",
    EMPTY_TEXT: "Nội dung lệnh không được để trống.",
    MISSING_TARGET: "Thiếu tên hoặc ID lệnh cần xóa. Dùng `!cmdadd remove <tên|ID>`.",
    REMOVE_MISSING_TARGET: "Thiếu tên hoặc ID lệnh cần xóa. Dùng `!cmdadd remove <tên|ID>`.",
    RESERVED_SUBCOMMAND: "Đây là tên dành riêng của `!cmdadd`.",
    INVALID_NAME: "Tên lệnh phải bắt đầu bằng chữ Unicode, gồm chữ/số/`_`/`-`, không có khoảng trắng.",
    RESERVED_NAME: "Tên này trùng với lệnh hệ thống.",
  };
  return messages[reason] || "Cú pháp không hợp lệ.";
}

async function sendReply(api, message, text) {
  return sendMessageComplete(api, message, text, false);
}

function shortText(text, max) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function iconForMedia(media) {
  const kind = mediaKindOf({ media });
  if (kind === "image") return "🖼️";
  if (kind === "audio") return "🎤";
  if (kind === "video") return "🎬";
  return "🔖";
}

function safeBotName() {
  try {
    const uid = appContext.uid || "admin";
    const profile = getProfile(uid);
    if (profile?.nameServer) return profile.nameServer;
  } catch {
    // fallthrough
  }
  try {
    return getBotName() || "";
  } catch {
    // ignore
  }
  return "";
}

function buildTextListFallback(list, pageCommands) {
  if (pageCommands.length === 0) {
    return `Chưa có lệnh custom nào.\nDùng ${getGlobalPrefix()}cmdadd <tên> | <nội dung> để tạo lệnh đầu tiên.`;
  }
  const lines = [
    `📜 Danh sách lệnh custom (trang ${list.page}/${list.totalPages}):\n`,
    ...pageCommands.map((cmd) => {
      const badge = cmd.conflict ? " [⚠️ xung đột]" : "";
      return `#${cmd.id}. ${cmd.name}${badge} — ${cmd.description}`;
    }),
    "",
    `📄 Trang ${list.page}/${list.totalPages}`,
    `💡 Dùng ${getGlobalPrefix()}cmdadd remove <ID> để xóa lệnh.`,
  ];
  return lines.join("\n");
}

function splitMessage(text) {
  const str = String(text ?? "");
  let current = "";
  const buffer = [];
  const words = str.split(/\r?\n/);
  for (const word of words) {
    if (current.length + word.length + 1 > 3500 && current) {
      buffer.push(current);
      current = "";
    }
    current = current ? `${current}\n${word}` : word;
  }
  if (current) buffer.push(current);
  return buffer;
}

export async function invokeCustomCommand(api, message, customCommand, context = {}) {
  const senderName = message?.data?.dName || message?.data?.senderName || message?.senderName || "Admin";
  await sendCustomCommand(api, message, customCommand, {
    botName: context.botName || safeBotName(),
    senderName,
  });
  return true;
}
