import fs from "fs";
import path from "path";
import { createBotRuntimeContext, updateCommandPrefixFile } from "./bot-runtime-context.js";
import { getProjectRoot } from "./env.js";
import { isValidPrefix, extractPrefixFromReply } from "./qr-login-prefix-state.js";

export { isValidPrefix, extractPrefixFromReply };

export async function persistBotPrefix(botUid, newPrefix, { projectRoot = getProjectRoot() } = {}) {
  const sanitized = String(newPrefix || "").trim();
  if (!sanitized || sanitized.length === 0) {
    throw new Error("Prefix không được rỗng");
  }
  if (!isValidPrefix(sanitized)) {
    throw new Error("Prefix không hợp lệ. Chỉ chấp nhận 1-3 ký hiệu lệnh như !, ?, ., /, #, $, %, &, *, -, _, +");
  }


  const root = path.resolve(projectRoot);
  const botInfoPath = path.join(root, "mybot", "bots", `${botUid}.json`);
  let botConfig = {};
  if (fs.existsSync(botInfoPath)) {
    try {
      botConfig = JSON.parse(fs.readFileSync(botInfoPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {}
  }

  const commandFilePath = botConfig.commandFilePath
    ? path.join(root, botConfig.commandFilePath)
    : path.join(root, "mybot", "json-data", `command-${botUid}.json`);

  const runtimeContext = createBotRuntimeContext({ uid: botUid, ...botConfig });
  const runtimeCommandFilePath = runtimeContext.commandConfigPath;

  if (fs.existsSync(commandFilePath)) {
    updateCommandPrefixFile(commandFilePath, sanitized);
  } else {
    fs.mkdirSync(path.dirname(commandFilePath), { recursive: true });
    fs.writeFileSync(commandFilePath, JSON.stringify({ prefix: sanitized }, null, 2), "utf8");
  }

  if (runtimeCommandFilePath && path.resolve(runtimeCommandFilePath) !== path.resolve(commandFilePath)) {
    if (fs.existsSync(runtimeCommandFilePath)) {
      updateCommandPrefixFile(runtimeCommandFilePath, sanitized);
    } else {
      fs.mkdirSync(path.dirname(runtimeCommandFilePath), { recursive: true });
      fs.writeFileSync(runtimeCommandFilePath, JSON.stringify({ prefix: sanitized }, null, 2), "utf8");
    }
  }

  return sanitized;
}

export async function restartBotAfterStop({ botUid, checkStatus, killBot, startBot }) {
  const status = await checkStatus(botUid);
  if (status?.running) {
    const stopped = await killBot(botUid);
    if (!stopped && (await checkStatus(botUid))?.running) return false;
  }
  return Boolean(await startBot(botUid));
}

export async function applyPrefixAndRestart({
  botUid,
  newPrefix,
  applyPrefixToBot,
  restartBot,
}) {
  const appliedPrefix = typeof applyPrefixToBot === "function"
    ? await applyPrefixToBot(botUid, newPrefix)
    : await persistBotPrefix(botUid, newPrefix);

  if (typeof restartBot === "function") {
    const restarted = await restartBot(botUid);
    if (!restarted) {
      throw new Error(`Không thể khởi động lại bot ${botUid}`);
    }
  }
  return appliedPrefix;
}
