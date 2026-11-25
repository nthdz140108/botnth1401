import fsPromises from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { join, resolve, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";

import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../chat-zalo/chat-style/chat-style.js";
import { nameServer } from "../../utils/server-config.js";

const PROJECT_ROOT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SKIPPED_FIND_DIRS = new Set([
  "node_modules",
  ".git",
  ".runtime",
  "logs",
  "video",
  "instances",
  "credentials",
  "dashboard-backups",
]);

export function isSensitiveShowcodeSegment(segment) {
  const value = String(segment ?? "").trim();
  if (!value) return false;
  return (
    /^\.env($|\.)/i.test(value) ||
    /^\.env/i.test(value) ||
    /cookie/i.test(value) ||
    /^config\.json$/i.test(value) ||
    /^instances$/i.test(value) ||
    /credentials/i.test(value) ||
    /^dashboard-backups$/i.test(value) ||
    /^vps-deploy\.local\.json$/i.test(value) ||
    /^list_admin/i.test(value)
  );
}

const getCleanNameServer = () => {
  const lines = nameServer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line);

  const tagLine = lines.find((line) => line.startsWith("@"));
  const boldLine = lines.find(
    (line) => /\*\*(.*?)\*\*/.test(line) || /__(.*?)__/.test(line),
  );

  return [tagLine, boldLine].filter(Boolean).join(" ");
};

export const des = {
  name: "showcode",
  type: 1,
  permission: "admin",
  countdown: 10,
  active: true,
};

function isRealPathInsideRoot(candidatePath, realRoot) {
  try {
    const realCandidate = realpathSync(candidatePath);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
      return { inside: false, realPath: realCandidate };
    }
    const relSegments = relative(realRoot, realCandidate).split(/\/|\\/).filter(Boolean);
    if (relSegments.some((seg) => isSensitiveShowcodeSegment(seg))) {
      return { inside: false, reason: "sensitive", realPath: realCandidate };
    }
    return { inside: true, realPath: realCandidate };
  } catch {
    return { inside: false, realPath: null };
  }
}

async function findFilesRecursive(dir, filename, results, realRoot, visitedDirs = new Set()) {
  if (!existsSync(dir)) {
    return;
  }

  const containment = isRealPathInsideRoot(dir, realRoot);
  if (!containment.inside || !containment.realPath) {
    return;
  }
  if (visitedDirs.has(containment.realPath)) {
    return;
  }
  visitedDirs.add(containment.realPath);

  let items;
  try {
    items = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (isSensitiveShowcodeSegment(item.name)) {
      continue;
    }
    const fullPath = join(dir, item.name);

    if (item.isSymbolicLink()) {
      const linkCheck = isRealPathInsideRoot(fullPath, realRoot);
      if (!linkCheck.inside) {
        continue;
      }
    }

    if (item.isDirectory()) {
      if (item.name.startsWith(".") || SKIPPED_FIND_DIRS.has(item.name)) {
        continue;
      }
      if (item.name === "target" && fullPath.endsWith(join("rust", "target"))) {
        continue;
      }
      await findFilesRecursive(fullPath, filename, results, realRoot, visitedDirs);
    } else if (item.isFile()) {
      if (item.name === filename) {
        const fileCheck = isRealPathInsideRoot(fullPath, realRoot);
        if (fileCheck.inside) {
          const rel = relative(realRoot, fileCheck.realPath);
          results.push(rel ? join("HHH", rel) : "HHH");
        }
      }
    }
  }
}

export function resolveSafeShowcodeTarget(argString, rootDir = PROJECT_ROOT_PATH) {
  const resolvedRoot = resolve(rootDir);
  const realRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
  const pathArgs = String(argString ?? "").split(/\/|\\/).filter(Boolean);
  if (pathArgs.some((seg) => isSensitiveShowcodeSegment(seg))) {
    return { ok: false, reason: "sensitive", targetPath: null, resolvedRoot: realRoot };
  }
  const targetPath = pathArgs.length > 0 ? resolve(realRoot, ...pathArgs) : realRoot;
  if (targetPath !== realRoot && !targetPath.startsWith(realRoot + sep)) {
    return { ok: false, reason: "traversal", targetPath, resolvedRoot: realRoot };
  }

  // Verify realpath containment against symlink escapes on existing path or nearest existing parent
  let probePath = targetPath;
  while (probePath && !existsSync(probePath)) {
    const parent = dirname(probePath);
    if (parent === probePath) break;
    probePath = parent;
  }
  if (probePath && existsSync(probePath)) {
    const realProbe = realpathSync(probePath);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
      return { ok: false, reason: "traversal", targetPath: realProbe, resolvedRoot: realRoot };
    }
    const relSegments = relative(realRoot, realProbe).split(/\/|\\/).filter(Boolean);
    if (relSegments.some((seg) => isSensitiveShowcodeSegment(seg))) {
      return { ok: false, reason: "sensitive", targetPath: null, resolvedRoot: realRoot };
    }
    if (probePath === targetPath) {
      return { ok: true, reason: null, targetPath: realProbe, resolvedRoot: realRoot };
    }
  }

  return { ok: true, reason: null, targetPath, resolvedRoot: realRoot };
}

export async function handleshowcodeCommand(api, message) {
  const content = String(message?.data?.content ?? "").trim();
  const currentPrefix = getGlobalPrefix();
  const lowerContent = content.toLowerCase();
  const lowerPrefix = currentPrefix.toLowerCase();

  let commandName = "";
  if (lowerContent.startsWith(`${lowerPrefix}showcode`)) {
    commandName = "showcode";
  } else if (lowerContent.startsWith(`${lowerPrefix}shocode`)) {
    commandName = "shocode";
  } else {
    return false;
  }

  const argString = content
    .slice(currentPrefix.length + commandName.length)
    .trim();
  const resolvedRoot = existsSync(PROJECT_ROOT_PATH)
    ? realpathSync(resolve(PROJECT_ROOT_PATH))
    : resolve(PROJECT_ROOT_PATH);

  try {
    if (/^find(?:\s+|$)/i.test(argString)) {
      const filenameToFind = argString.replace(/^find\s*/i, "").trim();

      if (!filenameToFind) {
        return sendMessageFailed(
          api,
          message,
          `${getCleanNameServer()}❌ Lỗi: Vui lòng nhập tên tệp cần tìm (ví dụ: ${currentPrefix}${commandName} find index.js).`,
          true,
        );
      }

      if (filenameToFind.includes("/") || filenameToFind.includes("\\")) {
        return sendMessageFailed(
          api,
          message,
          `${getCleanNameServer()}❌ Lỗi: Bạn chỉ cần nhập TÊN FILE (ví dụ: 'index.js'), không nhập đường dẫn.`,
          true,
        );
      }

      if (isSensitiveShowcodeSegment(filenameToFind)) {
        return sendMessageFailed(
          api,
          message,
          `${getCleanNameServer()}❌ Lỗi bảo mật: Bạn không được phép truy cập tệp nhạy cảm này.`,
          true,
        );
      }

      const searchResults = [];
      await findFilesRecursive(
        resolvedRoot,
        filenameToFind,
        searchResults,
        resolvedRoot,
      );

      let msg = `🔎 Kết quả tìm kiếm cho file: "${filenameToFind}"\n\n`;
      if (searchResults.length > 0) {
        msg += searchResults.map((p) => `  - ${p}`).join("\n");
      } else {
        msg += "  (Không tìm thấy file nào)";
      }

      return sendMessageStateQuote(
        api,
        message,
        `${getCleanNameServer()}${msg}`,
        true,
        120000,
        false,
      );
    }

    const targetCheck = resolveSafeShowcodeTarget(argString, resolvedRoot);
    if (!targetCheck.ok) {
      const callerUid = message?.data?.uidFrom || message?.senderId || "unknown";
      console.warn(
        `[SECURITY] Phát hiện truy cập trái phép (${targetCheck.reason}): User ${callerUid} | Input: ${argString}`,
      );
      return sendMessageFailed(
        api,
        message,
        `${getCleanNameServer()}❌ Lỗi bảo mật: Bạn không được phép truy cập đường dẫn này.`,
        true,
      );
    }
    const { targetPath } = targetCheck;

    const pathStats = await fsPromises.stat(targetPath);
    const rel = relative(resolvedRoot, targetPath);
    const relativePath = rel ? join("HHH", rel) : "HHH";

    if (pathStats.isDirectory()) {
      const items = await fsPromises.readdir(targetPath, { withFileTypes: true });
      const folders = [];
      const files = [];

      for (const entry of items) {
        const item = entry.name;
        if (item.startsWith(".") || isSensitiveShowcodeSegment(item)) continue;

        const fullItemPath = join(targetPath, item);
        const itemContainment = isRealPathInsideRoot(fullItemPath, resolvedRoot);
        if (!itemContainment.inside) continue;

        try {
          const stats = await fsPromises.stat(fullItemPath);
          if (stats.isDirectory()) {
            folders.push(item);
          } else if (stats.isFile()) {
            files.push(item);
          }
        } catch (statError) {
          console.warn(`Không thể đọc thông tin: ${item}`, statError.message);
        }
      }

      let msg = `🌳 Nội dung thư mục: ${relativePath || "HHH"}\n`;
      msg += "\n📂 Thư mục (Folders):\n";
      msg +=
        folders.length > 0
          ? folders.map((f) => `  - ${f}`).join("\n")
          : "  (Không có)";
      msg += "\n\n📄 Tệp (Files):\n";
      msg +=
        files.length > 0
          ? files.map((f) => `  - ${f}`).join("\n")
          : "  (Không có)";
      msg += `\n\n👉 Gõ ${currentPrefix}${commandName} [tên_thư_mục] để xem bên trong.`;
      msg += `\n👉 Gõ ${currentPrefix}${commandName} find [tên_file] để tìm file.`;

      return sendMessageStateQuote(
        api,
        message,
        `${getCleanNameServer()}${msg}`,
        true,
        120000,
        false,
      );
    } else {
      return sendMessageFailed(
        api,
        message,
        `${getCleanNameServer()}❌ Lỗi: "${relativePath}" là một TỆP TIN. Lệnh này chỉ dùng để xem thư mục.`,
        true,
      );
    }
  } catch (e) {
    console.error("Lỗi khi đọc project:", e);
    let errorMsg = `❌ Lỗi khi đọc: ${e.message}`;

    if (e.code === "ENOENT") {
      errorMsg = `❌ Lỗi: Đường dẫn "${argString}" không tồn tại.`;
    } else if (e.code === "EACCES") {
      errorMsg = `❌ Lỗi: Bot không có quyền truy cập vào đường dẫn đó.`;
    }

    return sendMessageFailed(
      api,
      message,
      `${getCleanNameServer()}${errorMsg}`,
      true,
    );
  }
}
