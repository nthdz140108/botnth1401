import path from "node:path";
import fs from "node:fs";
import { getGlobalPrefix } from "../service.js";
import { getProjectRoot } from "../../utils/env.js";
import { removeMention } from "../../utils/format-util.js";
import { downloadFile, checkExstentionFileRemote } from "../../utils/util.js";
import { sendMessageWarningRequest, sendMessageCompleteRequest } from "../chat-zalo/chat-style/chat-style.js";

function getResourceBasePath() {
  return path.resolve(getProjectRoot(), "assets", "resources");
}

function resolveSafeResourceDir(rawDirName) {
  const basePath = getResourceBasePath();
  const safeDir = path.basename(String(rawDirName || "").trim());
  if (!safeDir || safeDir === "." || safeDir === "..") {
    return null;
  }
  const fullPath = path.resolve(basePath, safeDir);
  if (!fullPath.startsWith(basePath + path.sep)) {
    return null;
  }
  return fullPath;
}

function isValidDirectory(rawDirName) {
  const fullPath = resolveSafeResourceDir(rawDirName);
  return Boolean(fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory());
}

export async function handleDownloadResource(api, message, aliasCommand) {
  const prefix = getGlobalPrefix();
  const content = removeMention(message);
  const args = content.replace(`${prefix}${aliasCommand}`, "").trim().split("|").map((item) => item.trim());

  if (args.length < 2) {
    await sendMessageWarningRequest(api, message, {
      caption: `Vui lòng nhập đúng cú pháp: ${prefix}${aliasCommand} [thư mục]|[tên file]|[link (nếu không reply)]`,
    }, 30000);
    return;
  }

  const [rawDirName, rawFileName, link] = args;
  const dirPath = resolveSafeResourceDir(rawDirName);
  const dirName = path.basename(String(rawDirName || "").trim());
  const cleanFileBase = path.basename(String(rawFileName || "").trim());

  if (!dirPath || !isValidDirectory(rawDirName) || !cleanFileBase || cleanFileBase === "." || cleanFileBase === "..") {
    await sendMessageWarningRequest(api, message, {
      caption: `Thư mục "${rawDirName}" hoặc tên file không hợp lệ trong resource!`,
    }, 30000);
    return;
  }

  let fileUrl = null;
  const quote = message.data?.quote;
  if (quote?.attach) {
    try {
      const parseMessage = typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
      fileUrl = parseMessage?.href || null;
    } catch {}
  } else if (link) {
    fileUrl = link;
  }

  if (!fileUrl) {
    await sendMessageWarningRequest(api, message, {
      caption: "Vui lòng cung cấp link hoặc reply tin nhắn chứa file cần tải!",
    }, 30000);
    return;
  }

  try {
    const ext = await checkExstentionFileRemote(fileUrl);
    const fullFileName = path.basename(cleanFileBase.includes(".") ? cleanFileBase : `${cleanFileBase}.${ext || "bin"}`);
    const savePath = path.resolve(dirPath, fullFileName);
    if (!savePath.startsWith(dirPath + path.sep)) {
      throw new Error("Path traversal blocked");
    }

    if (fs.existsSync(savePath)) {
      await sendMessageWarningRequest(api, message, {
        caption: `❌ File "${fullFileName}" đã tồn tại trong thư mục "${dirName}"!\nVui lòng chọn tên file khác.`,
      }, 30000);
      return;
    }

    fs.mkdirSync(dirPath, { recursive: true });
    await downloadFile(fileUrl, savePath);

    await sendMessageCompleteRequest(api, message, {
      caption: `✅ Đã tải và lưu file thành công!\n📂 Thư mục: ${dirName}\n📄 Tên file: ${fullFileName}`,
    }, 30000);
  } catch (error) {
    console.error("Lỗi khi tải file resource:", error?.message || error);
    await sendMessageWarningRequest(api, message, {
      caption: "❌ Đã xảy ra lỗi khi tải file. Vui lòng thử lại sau!",
    }, 30000);
  }
}

export async function handleDeleteResource(api, message, aliasCommand) {
  const prefix = getGlobalPrefix();
  const content = removeMention(message);
  const args = content.replace(`${prefix}${aliasCommand}`, "").trim().split("|").map((item) => item.trim());

  if (args.length < 2) {
    await sendMessageWarningRequest(api, message, {
      caption: `Vui lòng nhập đúng cú pháp: ${prefix}${aliasCommand} [thư mục]|[tên file]`,
    }, 30000);
    return;
  }

  const [rawDirName, rawFileName] = args;
  const dirPath = resolveSafeResourceDir(rawDirName);
  const dirName = path.basename(String(rawDirName || "").trim());
  const cleanPrefix = path.basename(String(rawFileName || "").trim());

  if (!dirPath || !isValidDirectory(rawDirName) || !cleanPrefix || cleanPrefix === "." || cleanPrefix === "..") {
    await sendMessageWarningRequest(api, message, {
      caption: `Thư mục "${rawDirName}" hoặc tên file không hợp lệ trong resource!`,
    }, 30000);
    return;
  }

  const files = fs.readdirSync(dirPath);
  const matchingFiles = files.filter((file) => file.toLowerCase().startsWith(cleanPrefix.toLowerCase()));

  if (matchingFiles.length === 0) {
    await sendMessageWarningRequest(api, message, {
      caption: `Không tìm thấy file "${cleanPrefix}" trong thư mục "${dirName}"!`,
    }, 30000);
    return;
  }

  try {
    for (const file of matchingFiles) {
      const filePath = path.resolve(dirPath, path.basename(file));
      if (filePath.startsWith(dirPath + path.sep) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    await sendMessageCompleteRequest(api, message, {
      caption: `✅ Đã xóa ${matchingFiles.length} file thành công!\n📂 Thư mục: ${dirName}\n📄 Các file đã xóa: ${matchingFiles.join(", ")}`,
    }, 30000);
  } catch (error) {
    console.error("Lỗi khi xóa file resource:", error?.message || error);
    await sendMessageWarningRequest(api, message, {
      caption: "❌ Đã xảy ra lỗi khi xóa file. Vui lòng thử lại sau!",
    }, 30000);
  }
}
