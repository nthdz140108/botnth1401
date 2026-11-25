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

const dataFilePath = path.join(getProjectRoot(), "assets", "resources", "file");

function listRegularFiles() {
  if (!fs.existsSync(dataFilePath)) {
    fs.mkdirSync(dataFilePath, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(dataFilePath, { withFileTypes: true })
    .filter((entry) => {
      if (!entry || entry.name.startsWith(".")) return false;
      if (entry.isFile()) return true;
      if (entry.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(dataFilePath, entry.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi"));
}

function selectResourceFile(files, keyword) {
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

export async function handleSendFile(api, message, aliasCommand = "sendresourcesfile") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "sendresourcesfile";
  const keyword = extractCommandBody(message, prefix, cmdName);
  const files = listRegularFiles();

  if (!keyword) {
    if (files.length === 0) {
      await sendMessageCompleteRequest(
        api,
        message,
        {
          caption:
            `📂 Kho tài nguyên file hiện đang trống.\n` +
            `👉 Thêm file mới bằng lệnh: ${prefix}dlrsrc file|<tên_file> (reply tin nhắn chứa file hoặc kèm link).`,
        },
        100000,
      );
      return;
    }

    const fileList = files.map((file, index) => `${index + 1}. ${file}`).join("\n");
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption:
          `🔍 Danh sách file có thể chia sẻ (${files.length}):\n${fileList}\n\n` +
          `👉 Dùng lệnh: ${prefix}${cmdName} <STT hoặc tên file> để gửi file.`,
      },
      100000,
    );
    return;
  }

  if (files.length === 0) {
    await sendMessageFailed(
      api,
      message,
      `Kho file hiện đang trống! Hãy nạp file bằng lệnh ${prefix}dlrsrc file|<tên_file>.`,
      false,
    );
    return;
  }

  const resourceFile = selectResourceFile(files, keyword);
  if (!resourceFile) {
    await sendMessageFailed(
      api,
      message,
      `Không tìm thấy file với số thứ tự hoặc tên "${keyword}"! Gõ ${prefix}${cmdName} để xem danh sách.`,
      false,
    );
    return;
  }

  const filePath = path.join(dataFilePath, resourceFile);
  const nameLocalFile = path.parse(resourceFile).name;

  try {
    await api.sendMessage(
      {
        msg: `📄 File: ${nameLocalFile}`,
        attachments: [filePath],
        ttl: 3600000,
      },
      message.threadId,
      safeThreadType(message),
    );
  } catch (error) {
    console.error("[sendresourcesfile] Lỗi khi gửi file:", error);
    await sendMessageFailed(api, message, "Có lỗi xảy ra khi gửi file!", false);
  }
}
