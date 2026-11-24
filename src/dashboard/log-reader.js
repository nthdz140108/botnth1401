import fs from "node:fs/promises";
import path from "node:path";

function assertSafeLogBotId(botId) {
  if (typeof botId !== "string" || !botId.trim() || botId.includes("..") || /[\\/\0]/.test(botId) || !/^[a-zA-Z0-9._-]+$/.test(botId) || botId === "." || botId === "..") {
    const error = new Error("Invalid botId");
    error.status = 400;
    error.code = "INVALID_BOT_ID";
    throw error;
  }
}

export async function readLogs({ root = process.cwd(), botId, severity, search, limit = 200 } = {}) {
  const resolvedRoot = path.resolve(root);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const logRoot = path.resolve(resolvedRoot, "logs");
  const logRootPrefix = logRoot.endsWith(path.sep) ? logRoot : `${logRoot}${path.sep}`;
  if (!logRoot.startsWith(rootPrefix)) {
    const error = new Error("Invalid log root");
    error.status = 400;
    error.code = "INVALID_LOG_PATH";
    throw error;
  }

  let dirs;
  if (botId !== undefined && botId !== null && String(botId) !== "") {
    const normalizedBotId = String(botId);
    assertSafeLogBotId(normalizedBotId);
    const botDir = path.resolve(logRoot, normalizedBotId);
    if (!botDir.startsWith(rootPrefix) || !botDir.startsWith(logRootPrefix)) {
      const error = new Error("Invalid botId");
      error.status = 400;
      error.code = "INVALID_BOT_ID";
      throw error;
    }
    dirs = [botDir];
  } else {
    dirs = await listLogDirs(logRoot, rootPrefix, logRootPrefix);
  }

  const rows = [];
  for (const dir of dirs) {
    if (!(dir === logRoot || dir.startsWith(logRootPrefix)) || !dir.startsWith(rootPrefix)) continue;
    const files = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && /\.(log|txt|jsonl?)$/i.test(entry.name));
    const currentBotId = (botId !== undefined && botId !== null && String(botId) !== "") ? String(botId) : path.basename(dir);
    for (const file of files) {
      const filePath = path.resolve(dir, file.name);
      if (!filePath.startsWith(rootPrefix) || !filePath.startsWith(logRootPrefix)) continue;
      const content = await fs.readFile(filePath, "utf8").catch(() => "");
      for (const [index, line] of content.split(/\r?\n/).filter(Boolean).entries()) {
        const level = /error|exception|fatal/i.test(line) ? "error" : /warn/i.test(line) ? "warn" : "info";
        if (severity && level !== severity) continue;
        if (search && !line.toLowerCase().includes(String(search).toLowerCase())) continue;
        rows.push({ botId: currentBotId, file: file.name, line: index + 1, severity: level, message: line });
      }
    }
  }
  return rows.slice(-Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

async function listLogDirs(logRoot, rootPrefix, logRootPrefix) {
  const entries = await fs.readdir(logRoot, { withFileTypes: true }).catch(() => []);
  const subdirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.includes("..") && !/[\\/\0]/.test(entry.name))
    .map((entry) => path.resolve(logRoot, entry.name))
    .filter((dir) => dir.startsWith(rootPrefix) && dir.startsWith(logRootPrefix));
  return [logRoot, ...subdirs];
}
