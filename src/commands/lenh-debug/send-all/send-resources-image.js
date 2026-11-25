import fs from "node:fs";
import path from "node:path";
import {
  sendMessageCompleteRequest,
  sendMessageFailed,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { getProjectRoot } from "../../../utils/env.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../shared/command-input-utils.js";

const dataImagePath = path.join(getProjectRoot(), "assets", "resources", "image");

function listRegularImageFiles() {
  if (!fs.existsSync(dataImagePath)) {
    fs.mkdirSync(dataImagePath, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(dataImagePath, { withFileTypes: true })
    .filter((entry) => {
      if (!entry || entry.name.startsWith(".")) return false;
      if (entry.isFile()) return true;
      if (entry.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(dataImagePath, entry.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi"));
}

function selectImageFile(files, keyword) {
  const trimmed = String(keyword || "").trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    if (index >= 0 && index < files.length) {
      return files[index];
    }
  }

  const lower = trimmed.toLowerCase();
  return (
    files.find((file) => file.toLowerCase() === lower) ||
    files.find((file) => path.parse(file).name.toLowerCase() === lower) ||
    null
  );
}

export async function handleSendImage(api, message, aliasCommand = "sendresourcesimage") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "sendresourcesimage";
  const keyword = extractCommandBody(message, prefix, cmdName);
  const files = listRegularImageFiles();

  if (!keyword) {
    if (files.length === 0) {
      await sendMessageCompleteRequest(
        api,
        message,
        {
          caption:
            `🖼️ Kho hình ảnh lưu trữ hiện đang trống.\n` +
            `👉 Thêm ảnh mới bằng lệnh: ${prefix}dlrsrc image|<tên_ảnh> (reply ảnh hoặc kèm link).`,
        },
        60000,
      );
      return;
    }

    const fileList = files.map((file, index) => `${index + 1}. ${path.parse(file).name}`).join("\n");
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption:
          `🖼️ Danh sách hình ảnh đã lưu trữ (${files.length}):\n${fileList}\n\n` +
          `👉 Dùng lệnh: ${prefix}${cmdName} <STT hoặc tên ảnh> để gửi ảnh.`,
      },
      60000,
    );
    return;
  }

  if (files.length === 0) {
    await sendMessageFailed(
      api,
      message,
      `Kho ảnh đang trống! Hãy nạp ảnh bằng lệnh ${prefix}dlrsrc image|<tên_ảnh>.`,
      false,
    );
    return;
  }

  const imageFile = selectImageFile(files, keyword);
  if (!imageFile) {
    await sendMessageFailed(
      api,
      message,
      `Không tìm thấy ảnh với số thứ tự hoặc tên "${keyword}"! Gõ ${prefix}${cmdName} để xem danh sách.`,
      false,
    );
    return;
  }

  const imagePath = path.join(dataImagePath, imageFile);
  const nameLocalImage = path.parse(imageFile).name;

  try {
    await api.sendMessage(
      {
        msg: `🖼️ Ảnh: ${nameLocalImage}`,
        attachments: [imagePath],
        ttl: 3600000,
      },
      message.threadId,
      safeThreadType(message),
    );
  } catch (error) {
    console.error("[sendresourcesimage] Lỗi khi gửi ảnh:", error);
    await sendMessageFailed(api, message, "Có lỗi xảy ra khi gửi ảnh!", false);
  }
}
