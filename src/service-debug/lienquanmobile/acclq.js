import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGlobalPrefix } from "../service.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { getActiveRuntimeContext } from "../../utils/io-json.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
} from "../../commands/shared/command-input-utils.js";

export const des = {
  name: "acclq",
  type: 1,
  permission: "adminLevelHigh",
  countdown: 5,
  active: true,
  alias: ["acclq"],
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const fallbackSeedPath = path.join(moduleDir, "lq.txt");

function withSafeMessageType(message) {
  const fallbackType =
    message?.threadId &&
    message?.data?.uidFrom &&
    String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage;
  const resolvedType = safeThreadType(message, fallbackType);
  return message?.type === resolvedType ? message : { ...message, type: resolvedType };
}

export function resolveInstanceLqFilePath() {
  const ctx = getActiveRuntimeContext();
  return path.join(ctx.dataDir, "lq.txt");
}

export function splitAccountCredentials(rawLine) {
  const trimmed = String(rawLine ?? "").trim();
  const idx = trimmed.indexOf(":");
  if (idx <= 0) return null;
  const username = trimmed.slice(0, idx).trim();
  const password = trimmed.slice(idx + 1).trim();
  if (!username || !password) return null;
  return [username, password];
}

export function fisherYatesShuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseValidAccountLines(rawContent) {
  return String(rawContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => splitAccountCredentials(line) !== null);
}

function loadAccountPool() {
  const instancePath = resolveInstanceLqFilePath();
  if (fs.existsSync(instancePath)) {
    return {
      sourcePath: instancePath,
      isInstanceStore: true,
      accounts: parseValidAccountLines(fs.readFileSync(instancePath, "utf8")),
    };
  }
  if (fs.existsSync(fallbackSeedPath)) {
    return {
      sourcePath: fallbackSeedPath,
      isInstanceStore: false,
      accounts: parseValidAccountLines(fs.readFileSync(fallbackSeedPath, "utf8")),
    };
  }
  return {
    sourcePath: instancePath,
    isInstanceStore: true,
    accounts: [],
  };
}

async function addAccountsToInstancePool(newLines) {
  const instancePath = resolveInstanceLqFilePath();
  const { accounts: existing } = loadAccountPool();
  const seen = new Set(existing);
  let added = 0;

  for (const raw of newLines) {
    const parsed = splitAccountCredentials(raw);
    if (!parsed) continue;
    const normalized = `${parsed[0]}:${parsed[1]}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      existing.push(normalized);
      added += 1;
    }
  }

  await fs.promises.mkdir(path.dirname(instancePath), { recursive: true });
  await fs.promises.writeFile(instancePath, `${existing.join("\n")}\n`, "utf8");
  return { added, total: existing.length, instancePath };
}

export async function handleAcclqCommand(api, message, aliasCommand = "acclq") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "acclq";
  const msgCtx = withSafeMessageType(message);
  const body = extractCommandBody(msgCtx, prefix, effectiveAlias);
  const tokens = body.split(/\s+/).filter(Boolean);
  const sub = (tokens[0] || "").toLowerCase();

  if (!sub) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❗ Cú pháp quản lý & lấy acc Liên Quân:\n` +
        `• ${prefix}${effectiveAlias} <1-10> → Lấy ngẫu nhiên 1–10 tài khoản\n` +
        `• ${prefix}${effectiveAlias} count → Xem tổng số tài khoản trong kho\n` +
        `• ${prefix}${effectiveAlias} add <tk:mk> → Thêm tài khoản mới vào kho dữ liệu bot`,
      false,
      60000,
      true
    );
  }

  if (sub === "count") {
    const { accounts, isInstanceStore } = loadAccountPool();
    return sendMessageStateQuote(
      api,
      msgCtx,
      `📊 Kho tài khoản Liên Quân hiện có: ${accounts.length} tài khoản hợp lệ\n` +
        `📂 Nguồn lưu trữ: ${isInstanceStore ? "Kho dữ liệu riêng của Bot" : "Kho mặc định ban đầu"}`,
      true,
      120000,
      true
    );
  }

  if (sub === "add") {
    const rawRest = body.replace(/^add\s*/i, "").trim();
    const candidates = rawRest
      .split(/[\r\n\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const validEntries = candidates.filter((c) => splitAccountCredentials(c) !== null);
    if (validEntries.length === 0) {
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Định dạng không hợp lệ! Vui lòng nhập theo mẫu:\n` +
          `${prefix}${effectiveAlias} add taikhoan:matkhau`,
        false,
        60000,
        true
      );
    }

    const { added, total } = await addAccountsToInstancePool(validEntries);
    return sendMessageStateQuote(
      api,
      msgCtx,
      `✅ Đã nạp thêm ${added} tài khoản mới (bỏ qua ${validEntries.length - added} trùng lặp).\n` +
        `📦 Tổng số tài khoản trong kho hiện tại: ${total}`,
      true,
      120000,
      true
    );
  }

  const count = Number.parseInt(sub, 10);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❗ Số lượng tài khoản cần lấy phải từ 1 đến 10 (hoặc dùng "count" / "add <tk:mk>").`,
      false,
      60000,
      true
    );
  }

  const { accounts } = loadAccountPool();
  if (accounts.length === 0) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Kho tài khoản Liên Quân hiện đang trống!\n` +
        `👉 Dùng ${prefix}${effectiveAlias} add <tk:mk> để nạp thêm tài khoản.`,
      false,
      60000,
      true
    );
  }

  const shuffled = fisherYatesShuffle(accounts);
  const selected = shuffled.slice(0, count);

  const accInfo = selected
    .map((acc, index) => {
      const [tk, mk] = splitAccountCredentials(acc) || ["", ""];
      return `${index + 1}. 📱 Tài khoản: ${tk}\n   🔑 Mật khẩu: ${mk}`;
    })
    .join("\n\n");

  const msg = `🎮 ACC LIÊN QUÂN NGẪU NHIÊN (${selected.length}/${accounts.length}):\n\n${accInfo}`;
  return sendMessageStateQuote(api, msgCtx, msg, true, 600000, false);
}
