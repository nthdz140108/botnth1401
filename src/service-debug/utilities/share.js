import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../service.js";
import { getProjectRoot } from "../../utils/env.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../commands/shared/command-input-utils.js";

export async function uploadOnce(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error("File does not exist:", filePath);
    return null;
  }
  const fileName = path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);
  const url = `https://soiz.online/${encodeURIComponent(fileName)}`;
  const headers = {
    "Max-Downloads": "1",
    "Max-Days": "1",
    "Content-Type": "application/octet-stream",
  };

  try {
    const response = await axios.put(url, fileStream, { headers, timeout: 30000 });
    return response.data;
  } catch (error) {
    console.error("Upload failed:", error.message);
    return null;
  }
}

function scanRegularFiles(directory) {
  let results = [];
  if (!fs.existsSync(directory)) return results;

  try {
    const items = fs.readdirSync(directory, { withFileTypes: true });
    for (const item of items) {
      if (!item || item.name.startsWith(".")) continue;
      const itemPath = path.join(directory, item.name);
      try {
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          results = results.concat(scanRegularFiles(itemPath));
        } else if (stat.isFile()) {
          results.push(itemPath);
        }
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.error(`[sendsrc] Lỗi khi đọc thư mục ${directory}:`, error);
  }

  return results;
}

export async function shareSrc(api, message, aliasCommand = "sendsrc") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message, MessageType.GroupMessage);
  const senderId = message.data?.uidFrom;
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "sendsrc";
  const keyword = extractCommandBody(message, prefix, cmdName);

  const SHARE_DIR = path.join(getProjectRoot(), "assets", "resources", "file");
  if (!fs.existsSync(SHARE_DIR)) {
    fs.mkdirSync(SHARE_DIR, { recursive: true });
  }

  async function shareFile(filePath) {
    try {
      await api.sendMessage(
        {
          msg: `📩 Đã gửi file "${path.basename(filePath)}" cho bạn qua tin nhắn riêng! Vui lòng kiểm tra hộp thư (hoặc bật nhận tin nhắn từ người lạ).`,
          quote: message,
          ttl: 60000 * 60,
        },
        threadId,
        threadType,
      );
      await api.sendMessage(
        {
          msg: `Xin chào!\n🗂️ Đây là file "${path.basename(filePath)}" bạn yêu cầu, vui lòng kiểm tra.`,
          attachments: [filePath],
          ttl: 60000 * 60,
        },
        senderId,
        MessageType.DirectMessage,
      );
    } catch (error) {
      console.error("[sendsrc] Lỗi khi gửi file:", error);
      await api.sendMessage(
        {
          msg: `❌ Không thể gửi file qua tin nhắn riêng (${error?.message || "lỗi gửi DM"}). Hãy kết bạn với bot hoặc mở chặn tin nhắn người lạ!`,
          quote: message,
          ttl: 60000,
        },
        threadId,
        threadType,
      );
    }
  }

  const allFilesUnsorted = scanRegularFiles(SHARE_DIR);

  if (allFilesUnsorted.length === 0) {
    return await api.sendMessage(
      {
        msg:
          `⚠️ Hiện chưa có file nào để chia sẻ trong thư mục!\n` +
          `👉 Bạn có thể thêm file bằng lệnh: ${prefix}dlrsrc file|<tên_file> (reply tin nhắn chứa file hoặc kèm link).`,
        quote: message,
        ttl: 60000 * 60,
      },
      threadId,
      threadType,
    );
  }

  const filesByFolder = {};
  for (const file of allFilesUnsorted) {
    const relativePath = path.relative(SHARE_DIR, file);
    const parts = relativePath.split(path.sep);
    const folderName = parts.length > 1 ? parts[0] : "Other";
    if (!filesByFolder[folderName]) {
      filesByFolder[folderName] = [];
    }
    filesByFolder[folderName].push(file);
  }

  const sortedFiles = [];
  let fileList =
    "🔍 Danh sách file có thể chia sẻ:\n*Lưu ý: Đây là những tài nguyên được lưu trữ trên hệ thống\n\n";
  let counter = 1;

  const folderKeys = Object.keys(filesByFolder).sort((a, b) => a.localeCompare(b, "vi"));
  for (const folder of folderKeys) {
    if (folder === "Other" && folderKeys.length > 1) continue;
    fileList += `🗂️ ${folder}:\n`;
    const sortedFolderFiles = filesByFolder[folder].sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), "vi"),
    );
    for (const file of sortedFolderFiles) {
      const relativePath = path.relative(SHARE_DIR, file);
      const displayPath =
        folder === "Other" ? path.basename(file) : relativePath.substring(folder.length + 1);
      fileList += `${counter}. ${displayPath}\n`;
      sortedFiles.push(file);
      counter += 1;
    }
    fileList += "\n";
  }

  if (filesByFolder.Other && folderKeys.length > 1) {
    fileList += `🗂️ Other:\n`;
    const sortedOtherFiles = filesByFolder.Other.sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), "vi"),
    );
    for (const file of sortedOtherFiles) {
      fileList += `${counter}. ${path.basename(file)}\n`;
      sortedFiles.push(file);
      counter += 1;
    }
    fileList += "\n";
  }

  if (!keyword) {
    const helpText =
      `${fileList.trim()}\n\n` +
      `👉 Để nhận file, hãy dùng:\n` +
      `${prefix}${cmdName} <STT hoặc tên file>\n` +
      `🗨️ File sẽ được gửi qua tin nhắn riêng.`;

    return await api.sendMessage(
      {
        msg: helpText,
        quote: message,
        ttl: 60000 * 60,
      },
      threadId,
      threadType,
    );
  }

  if (/^\d+$/.test(keyword)) {
    const argNum = Number.parseInt(keyword, 10);
    if (argNum >= 1 && argNum <= sortedFiles.length) {
      return await shareFile(sortedFiles[argNum - 1]);
    }
  }

  const lowerReq = keyword.toLowerCase();
  const matchedFile = sortedFiles.find((file) => {
    const relativePath = path.relative(SHARE_DIR, file).toLowerCase();
    const base = path.basename(file).toLowerCase();
    const stem = path.parse(file).name.toLowerCase();
    return relativePath === lowerReq || base === lowerReq || stem === lowerReq;
  });

  if (matchedFile) {
    return await shareFile(matchedFile);
  }

  return await api.sendMessage(
    {
      msg: `⚠️ Không tìm thấy file "${keyword}". Vui lòng kiểm tra lại hoặc gõ "${prefix}${cmdName}" để xem danh sách file.`,
      quote: message,
      ttl: 30000,
    },
    threadId,
    threadType,
  );
}
