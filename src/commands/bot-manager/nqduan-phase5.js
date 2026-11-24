import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";

import { appContext } from "../../api-zalo/context.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { getBotId, getProjectRoot } from "../../utils/env.js";
import { tempDir } from "../../utils/io-json.js";
import { acquireTempLease, releaseTempLease } from "../../utils/temp-lease-manager.js";
import { removeMention } from "../../utils/format-util.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import {
  sendMessageCompleteRequest,
  sendMessageStateQuote,
  sendMessageWarningRequest,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";

const MAX_REPEAT = 20;

const FALLBACK_SENDUSER_LINES = [
  "Xin chao, day la thong diep mau.",
  "Bot dang gui tin nhan theo yeu cau.",
];

function normalizeId(value) {
  return String(value ?? "").trim();
}

function getMentions(message) {
  const mentions = message?.data?.mentions;
  if (Array.isArray(mentions)) return mentions;
  if (mentions && typeof mentions === "object") {
    return Object.values(mentions).filter((item) => item && typeof item === "object" && item.uid);
  }
  return [];
}

function getReplyMention(message) {
  const reply = message?.data?.reply;
  if (!reply?.uid) return null;
  return { uid: reply.uid, dName: reply.dName || "Nguoi dung" };
}

async function readSendUserLines() {
  const filePath = path.join(getProjectRoot(), "src", "commands", "bot-manager", "data", "noidung.txt");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines.slice(0, MAX_REPEAT) : [...FALLBACK_SENDUSER_LINES];
  } catch {
    return [...FALLBACK_SENDUSER_LINES];
  }
}

async function sendText(api, message, text, ttl = 30000) {
  await api.sendMessage({ msg: text, ttl }, message.threadId, message.type);
}

export async function handleSendMessageToMentioned(api, message) {
  const prefix = getGlobalPrefix();
  const content = removeMention(message).trim();
  const commandParts = content.split("|").map((part) => part.trim());

  if (commandParts.length < 3) {
    await sendMessageCompleteRequest(api, message, {
      caption: `Sai cu phap. Vui long dung: ${prefix}senduser @Ten|delay(500-10000ms)|so lan(1-${MAX_REPEAT})`,
    }, 10000);
    return true;
  }

  const rawDelay = Number.parseInt(commandParts[1], 10);
  const rawRepeat = Number.parseInt(commandParts[2], 10);
  const delayMs = Math.min(Math.max(Number.isFinite(rawDelay) ? rawDelay : 1000, 500), 10000);
  const repeatCount = Math.min(Math.max(Number.isFinite(rawRepeat) ? rawRepeat : 1, 1), MAX_REPEAT);
  const mentions = getMentions(message);

  if (mentions.length === 0) {
    await sendMessageCompleteRequest(api, message, {
      caption: "Khong co ai duoc tag trong tin nhan.",
    }, 10000);
    return true;
  }

  const lines = await readSendUserLines();
  const targets = mentions.map((mention) => ({
    uid: normalizeId(mention.uid),
    name: mention.dName || mention.name || normalizeId(mention.uid),
  }));

  await sendMessageCompleteRequest(api, message, {
    caption: `Dang gui tin nhan den ${targets.map((item) => item.name).join(", ")}...`,
  }, 30000);

  for (let index = 0; index < repeatCount; index += 1) {
    for (const target of targets) {
      for (const line of lines) {
        await api.sendMessage({ msg: line, ttl: 5000000 }, target.uid, MessageType.DirectMessage);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  await sendMessageCompleteRequest(api, message, {
    caption: `Da hoan thanh gui tin nhan den ${targets.map((item) => item.name).join(", ")}.`,
  }, 30000);
  return true;
}

export async function handleSendFriendRequest(api, message, aliasCommand = "addfriend") {
  const prefix = getGlobalPrefix();
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName || "Nguoi dung";
  const mentions = [...getMentions(message)];
  const replyMention = getReplyMention(message);
  if (replyMention) mentions.push(replyMention);

  if (mentions.length === 0) {
    await sendMessageStateQuote(api, message, `Cach dung lenh:\n${prefix}${aliasCommand} @mention, reply`, false, 60000);
    return true;
  }

  await sendMessageStateQuote(api, message, "Dang gui loi moi ket ban...", true, 10000);
  const successList = [];
  const failedList = [];

  for (const mention of mentions) {
    try {
      await api.sendFriendRequest(normalizeId(mention.uid), "Chao ban, toi la bot cua HHH.", "vi");
      successList.push(`@${mention.dName || mention.name || mention.uid}`);
    } catch (error) {
      failedList.push(`@${mention.dName || mention.name || mention.uid} (${error.message})`);
    }
  }

  await api.sendMessage(
    {
      msg: [
        `(@${senderName}) Ket qua gui loi moi ket ban:`,
        successList.length > 0 ? `Thanh cong: ${successList.join(", ")}` : null,
        failedList.length > 0 ? `That bai: ${failedList.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      mentions: [{ uid: senderId, pos: 1, len: senderName.length + 1 }],
      ttl: 120000,
    },
    message.threadId,
    message.type,
  );
  return true;
}

export async function handleUndoFriendRequest(api, message, aliasCommand = "undofriend") {
  const prefix = getGlobalPrefix();
  const mentions = [...getMentions(message)];
  const replyMention = getReplyMention(message);
  if (replyMention) mentions.push(replyMention);

  if (mentions.length === 0) {
    await sendMessageStateQuote(api, message, `Cach dung:\n${prefix}${aliasCommand} @mention, reply`, false, 60000);
    return true;
  }

  await sendMessageStateQuote(api, message, "Dang huy loi moi ket ban...", true, 10000);
  const successList = [];
  const failedList = [];

  for (const mention of mentions) {
    try {
      await api.undoFriendRequest(normalizeId(mention.uid));
      successList.push(`@${mention.dName || mention.name || mention.uid}`);
    } catch (error) {
      failedList.push(`@${mention.dName || mention.name || mention.uid} (${error.message})`);
    }
  }

  await api.sendMessage(
    {
      msg: [
        "Ket qua huy loi moi ket ban:",
        successList.length > 0 ? `Thanh cong: ${successList.join(", ")}` : null,
        failedList.length > 0 ? `That bai: ${failedList.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      ttl: 120000,
    },
    message.threadId,
    message.type,
  );
  return true;
}

export async function handleRejectFriendRequest(api, message, aliasCommand = "rejectfriend") {
  const prefix = getGlobalPrefix();
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName || "Nguoi dung";
  const mentions = [...getMentions(message)];
  const replyMention = getReplyMention(message);
  if (replyMention) mentions.push(replyMention);

  if (mentions.length === 0) {
    await sendMessageStateQuote(api, message, `Cach dung lenh tu choi loi moi ket ban:\n${prefix}${aliasCommand} @mention, reply`, false, 60000);
    return true;
  }

  await sendMessageStateQuote(api, message, "Dang tu choi loi moi ket ban...", true, 10000);
  const successList = [];
  const failedList = [];

  for (const mention of mentions) {
    try {
      await api.rejectFriendRequest(normalizeId(mention.uid));
      successList.push(`@${mention.dName || mention.name || mention.uid}`);
    } catch (error) {
      failedList.push(`@${mention.dName || mention.name || mention.uid} (${error.message})`);
    }
  }

  await api.sendMessage(
    {
      msg: [
        `(@${senderName}) Ket qua tu choi loi moi ket ban:`,
        successList.length > 0 ? `Da tu choi: ${successList.join(", ")}` : null,
        failedList.length > 0 ? `Khong the tu choi: ${failedList.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      mentions: [{ uid: senderId, pos: 1, len: senderName.length + 1 }],
      ttl: 120000,
    },
    message.threadId,
    message.type,
  );
  return true;
}

export async function handleRemoveFriend(api, message, aliasCommand = "removefriend") {
  const prefix = getGlobalPrefix();
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName || "Nguoi dung";
  const mentions = [...getMentions(message)];
  const replyMention = getReplyMention(message);
  if (replyMention) mentions.push(replyMention);

  if (mentions.length === 0) {
    await api.sendMessage(
      {
        msg: `(@${senderName}) Vui long @mention hoac reply nguoi ban muon huy ket ban!`,
        mentions: [{ uid: senderId, pos: 0, len: senderName.length + 3 }],
        ttl: 360000,
      },
      message.threadId,
      message.type,
    );
    return true;
  }

  const successfulRemovals = [];
  for (const mention of mentions) {
    try {
      await api.removeFriend(normalizeId(mention.uid));
      successfulRemovals.push({
        uid: normalizeId(mention.uid),
        dName: mention.dName || mention.name || "Nguoi dung",
      });
    } catch (error) {
      console.error(`Khong the huy ket ban voi ${mention.uid}:`, error.message);
    }
  }

  if (successfulRemovals.length === 0) {
    await api.sendMessage(
      {
        msg: `(@${senderName}) Khong the huy ket ban voi bat ky ai.`,
        mentions: [{ uid: senderId, pos: 0, len: senderName.length + 3 }],
        ttl: 360000,
      },
      message.threadId,
      message.type,
    );
    return true;
  }

  const mentionData = [{ uid: senderId, pos: 0, len: senderName.length + 3 }];
  let mentionText = `(@${senderName}), da huy ket ban voi: `;
  let currentPos = mentionText.length;
  for (const mention of successfulRemovals) {
    const displayName = mention.dName || "Nguoi dung";
    mentionText += `(@${displayName}) `;
    mentionData.push({
      uid: mention.uid,
      pos: currentPos,
      len: displayName.length + 3,
    });
    currentPos += displayName.length + 4;
  }

  await api.sendMessage(
    {
      msg: mentionText.trim(),
      mentions: mentionData,
      ttl: 360000,
    },
    message.threadId,
    message.type,
  );
  return true;
}

export async function handleDsBanBe(api, message) {
  const threadId = message.threadId;
  const msgType = message.type || MessageType.GroupMessage;
  try {
    await api.sendMessage({ msg: "Dang tai danh sach ban be...", ttl: 15000 }, threadId, msgType);
    const result = await api.getAllFriends(30000, 1);
    const data = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.data?.data)
        ? result.data.data
        : Array.isArray(result?.data?.friends)
          ? result.data.friends
          : [];

    if (data.length === 0) {
      await api.sendMessage({ msg: "Khong co ban be nao!", ttl: 30000 }, threadId, msgType);
      return true;
    }

    const names = data.slice(0, 50).map((friend, index) => {
      const name = String(friend.displayName || friend.zaloName || "Nguoi dung Zalo").trim();
      return `${index + 1}. ${name}`;
    });

    await api.sendMessage({ msg: `Danh sach ban be (${data.length} nguoi):\n${names.join("\n")}`, ttl: 300000 }, threadId, msgType);
    return true;
  } catch (error) {
    await api.sendMessage({ msg: `Loi: ${error.message}`, ttl: 30000 }, threadId, msgType);
    return true;
  }
}

export async function handleAddFriendAll(api, message, aliasCommand = "addfriendall") {
  const threadId = message.threadId;
  const msgType = message.type || MessageType.GroupMessage;
  try {
    const groupInfo = await api.getGroupInfo?.(threadId);
    const gridInfo = groupInfo?.gridInfoMap?.[threadId] || groupInfo;
    const rawMembers = Array.isArray(gridInfo?.memVerList)
      ? gridInfo.memVerList.map((m) => String(m).replace(/_\d+$/, ""))
      : Array.isArray(gridInfo?.memberIds)
        ? gridInfo.memberIds.map(String)
        : [];
    const selfUid = normalizeId(getBotId() || appContext?.uid);

    const friendIds = new Set();
    try {
      const friendsRes = await api.getAllFriends?.(30000, 1);
      const friendsList = Array.isArray(friendsRes?.data)
        ? friendsRes.data
        : Array.isArray(friendsRes?.data?.friends)
          ? friendsRes.data.friends
          : Array.isArray(friendsRes)
            ? friendsRes
            : [];
      for (const f of friendsList) {
        const fid = normalizeId(f?.userId || f?.uid || f?.id);
        if (fid) friendIds.add(fid);
      }
    } catch {}

    const candidates = [...new Set(rawMembers.map(normalizeId).filter(Boolean))]
      .filter((uid) => uid !== selfUid && !friendIds.has(uid))
      .slice(0, MAX_REPEAT);

    if (candidates.length === 0) {
      await sendMessageStateQuote(
        api,
        message,
        "Không có thành viên mới nào cần gửi lời mời kết bạn trong nhóm này.",
        false,
        60000,
      );
      return true;
    }

    await sendMessageStateQuote(
      api,
      message,
      `Đang gửi lời mời kết bạn tới ${candidates.length} thành viên (tối đa ${MAX_REPEAT}/lần)...`,
      true,
      20000,
    );

    let successCount = 0;
    let failCount = 0;
    for (const uid of candidates) {
      try {
        await api.sendFriendRequest(uid, "Chào bạn, kết bạn với mình nhé!", "vi");
        successCount += 1;
      } catch {
        failCount += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    await api.sendMessage(
      {
        msg: `Kết quả ${aliasCommand}: Thành công ${successCount}/${candidates.length}${failCount > 0 ? ` (Thất bại: ${failCount})` : ""}.`,
        ttl: 120000,
      },
      threadId,
      msgType,
    );
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Không thể gửi lời mời kết bạn hàng loạt: ${error.message}`, false, 60000);
    return true;
  }
}

export async function handleFriendWaitingList(api, message) {
  const threadId = message.threadId;
  const msgType = message.type || MessageType.GroupMessage;
  try {
    let requests = [];
    if (typeof api.getPendingFriendRequests === "function") {
      const res = await api.getPendingFriendRequests();
      requests = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    } else if (typeof api.getFriendRequests === "function") {
      const res = await api.getFriendRequests();
      requests = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    } else if (typeof api.getGroupPendingMembers === "function" && threadId) {
      const pending = await api.getGroupPendingMembers(threadId);
      requests = Array.isArray(pending?.users) ? pending.users : [];
    }

    if (requests.length === 0) {
      await sendMessageStateQuote(api, message, "Hiện không có lời mời kết bạn nào đang chờ duyệt.", true, 60000);
      return true;
    }

    const lines = requests.slice(0, 40).map((item, idx) => {
      const uid = item?.userId || item?.uid || item?.id || "unknown";
      const name = item?.displayName || item?.zaloName || item?.dName || item?.name || "Người dùng";
      const note = item?.recommInfo?.message ? ` - "${item.recommInfo.message}"` : "";
      return `${idx + 1}. ${name} (${uid})${note}`;
    });

    await api.sendMessage(
      {
        msg: `📋 Danh sách lời mời kết bạn đang chờ (${requests.length}):\n${lines.join("\n")}`,
        ttl: 300000,
      },
      threadId,
      msgType,
    );
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Không thể tải danh sách lời mời đang chờ: ${error.message}`, false, 60000);
    return true;
  }
}

export async function spamCallInGroup(api, message, aliasCommand = "call") {
  const prefix = getGlobalPrefix();
  const mentions = [...getMentions(message)];
  const replyMention = getReplyMention(message);
  if (replyMention) mentions.push(replyMention);

  if (mentions.length === 0) {
    await sendMessageStateQuote(api, message, `Cach dung:\n${prefix}${aliasCommand} @mention [|so_lan(1-${MAX_REPEAT})]`, false, 60000);
    return true;
  }

  const rawContent = removeMention(message).trim();
  const pipeParts = rawContent.split("|").map((p) => p.trim());
  const parsedCount = pipeParts.length > 1 ? Number.parseInt(pipeParts[1], 10) : 1;
  const repeatCount = Math.min(Math.max(Number.isFinite(parsedCount) ? parsedCount : 1, 1), MAX_REPEAT);

  const targetUid = normalizeId(mentions[0].uid);
  const targetLabel = mentions[0].dName || mentions[0].name || targetUid;
  await sendMessageStateQuote(api, message, `Dang goi dien toi ${targetLabel} (${repeatCount} lan)...`, true, 15000);
  for (let i = 0; i < repeatCount; i += 1) {
    await api.sendCallVoice(targetUid);
    if (i + 1 < repeatCount) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  await sendText(api, message, `Da kich hoat ${repeatCount} cuoc goi toi ${targetLabel}`, 30000);
  return true;
}

export async function handle4KImage(api, message) {
  const threadId = message.threadId;
  const quote = message.data?.quote;
  const senderName = message.data?.dName || "Nguoi dung";
  const senderId = message.data?.uidFrom;

  if (!quote || !quote.attach) {
    await sendMessageStateQuote(api, message, "Vui long reply vao mot tin nhan chua anh de dat lam net!", false, 30000);
    return true;
  }

  let enhancedImagePath = null;
  let leaseId = null;
  try {
    const attachData = JSON.parse(quote.attach);
    const fileUrl = attachData.hdUrl || attachData.href || attachData.oriUrl || attachData.normalUrl || attachData.thumbUrl;
    if (!fileUrl) throw new Error("Khong tim thay URL hop le tu anh duoc reply!");

    const apiKey = process.env.HOANGDEV_API_KEY || "";
    const enhanceApiUrl = `https://hoangdev.io.vn/media/lamnet?input_url=${encodeURIComponent(fileUrl)}&apikey=${encodeURIComponent(apiKey)}`;
    const response = await axios.get(enhanceApiUrl, { timeout: 15000 });
    const result = response.data;
    if (!result.success || !result.url) {
      throw new Error(result.message || "API tra ve that bai.");
    }

    await fs.mkdir(tempDir, { recursive: true });
    enhancedImagePath = path.resolve(tempDir, `enhanced_image_${Date.now()}.png`);
    leaseId = acquireTempLease(enhancedImagePath, 120000, "4k-enhance");
    const imageResponse = await axios.get(result.url, { responseType: "arraybuffer", timeout: 15000 });
    await fs.writeFile(enhancedImagePath, Buffer.from(imageResponse.data));

    await api.sendMessage(
      {
        msg: `@${senderName}\nAnh 4K cua Anh day`,
        mentions: [{ uid: senderId, pos: 0, len: senderName.length + 1 }],
        attachments: [enhancedImagePath],
        ttl: 5000000,
      },
      threadId,
      message.type,
    );

    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Khong lam net duoc anh, loi: ${error.message}`, false, 30000);
    return true;
  } finally {
    if (leaseId) releaseTempLease(leaseId);
    if (enhancedImagePath) {
      try {
        await fs.unlink(enhancedImagePath);
      } catch {}
    }
  }
}

export async function handleDownloadData(api, message, aliasCommand = "datavideo") {
  const prefix = getGlobalPrefix();
  const content = removeMention(message);
  const args = content.replace(`${prefix}${aliasCommand}`, "").trim().split("|");
  const firstPart = args[0]?.trim();
  const saveFolder = path.join(getProjectRoot(), "src", "service-debug", "chat-zalo", "chat-special", "data-send");
  const fileUrl = args[1]?.trim();
  const isAdminUser = Boolean(appContext.uid && String(message.data?.uidFrom) === String(appContext.uid));
  const sanitizeTxtFileName = (raw) => {
    const base = path.basename(String(raw || "").trim());
    if (!base) return "";
    return base.endsWith(".txt") ? base : `${base}.txt`;
  };

  if ((firstPart === "list" || firstPart === "show") && args.length === 1) {
    try {
      const files = (await fs.readdir(saveFolder)).filter((f) => f.endsWith(".txt"));
      await sendMessageCompleteRequest(api, message, { caption: `Danh sach file:\n${files.map((f) => `- ${f}`).join("\n") || "Khong co file nao."}` });
      return true;
    } catch (error) {
      await sendMessageWarningRequest(api, message, { caption: `Khong the doc thu muc: ${error.message}` });
      return true;
    }
  }

  if (firstPart?.startsWith("list ")) {
    const fileName = sanitizeTxtFileName(firstPart.substring(5));
    const savePath = path.join(saveFolder, fileName);
    try {
      const contentFile = await fs.readFile(savePath, "utf8");
      const lines = contentFile.split("\n").filter(Boolean);
      await sendMessageCompleteRequest(api, message, { caption: `File '${fileName}' chua tong cong ${lines.length} link.` }, 60000);
      return true;
    } catch {
      await sendMessageWarningRequest(api, message, { caption: `Khong tim thay file '${fileName}'.` });
      return true;
    }
  }

  if (firstPart?.startsWith("show ")) {
    if (!isAdminUser) {
      await sendMessageWarningRequest(api, message, { caption: "Chi quan tri vien cap cao moi duoc xem chi tiet link!" }, 30000);
      return true;
    }

    const fileName = sanitizeTxtFileName(firstPart.substring(5));
    const savePath = path.join(saveFolder, fileName);
    try {
      const contentFile = await fs.readFile(savePath, "utf8");
      const lines = contentFile.split("\n").filter(Boolean);
      await sendMessageCompleteRequest(api, message, { caption: `File '${fileName}' co tong cong ${lines.length} link.` }, 60000);
      return true;
    } catch {
      await sendMessageWarningRequest(api, message, { caption: `Khong tim thay file '${fileName}'.` });
      return true;
    }
  }

  if (firstPart?.startsWith("add ") || firstPart?.startsWith("remove ")) {
    const [action, rawFileName] = firstPart.split(" ");
    const fileName = sanitizeTxtFileName(rawFileName);
    const savePath = path.join(saveFolder, fileName);

    if (!isAdminUser) {
      const label = action === "add" ? "tao" : "xoa";
      await sendMessageWarningRequest(api, message, { caption: `Chi admin cap cao moi duoc phep ${label} file!` }, 30000);
      return true;
    }

    if (!fileName) {
      await sendMessageWarningRequest(api, message, { caption: `Vui long cung cap ten file sau '${action}'.` }, 30000);
      return true;
    }

    await fs.mkdir(saveFolder, { recursive: true });
    if (action === "add") {
      try {
        await fs.access(savePath);
        await sendMessageWarningRequest(api, message, { caption: `File '${fileName}' da ton tai.` }, 20000);
        return true;
      } catch {
        await fs.writeFile(savePath, "", "utf8");
        await sendMessageCompleteRequest(api, message, { caption: `Da tao file '${fileName}' thanh cong.` }, 20000);
        return true;
      }
    }

    if (action === "remove") {
      if (fileUrl) {
        try {
          const contentFile = await fs.readFile(savePath, "utf8");
          const lines = contentFile.split("\n").filter(Boolean);
          const updated = lines.filter((line) => line.trim() !== fileUrl.trim());
          if (updated.length === lines.length) {
            await sendMessageWarningRequest(api, message, { caption: `Link khong ton tai trong file '${fileName}'.` });
            return true;
          }
          await fs.writeFile(savePath, `${updated.join("\n")}\n`, "utf8");
          await sendMessageCompleteRequest(api, message, { caption: `Da xoa link khoi file '${fileName}'` }, 20000);
          return true;
        } catch {
          await sendMessageWarningRequest(api, message, { caption: `Khong tim thay file '${fileName}' de xoa link.` });
          return true;
        }
      }

      try {
        await fs.unlink(savePath);
        await sendMessageCompleteRequest(api, message, { caption: `Da xoa file '${fileName}' thanh cong.` }, 20000);
      } catch {
        await sendMessageWarningRequest(api, message, { caption: `Khong tim thay file '${fileName}' de xoa.` });
      }
      return true;
    }
  }

  if (!fileUrl) {
    await sendMessageWarningRequest(api, message, {
      caption: `Sai cu phap. Vui long dung: ${prefix}${aliasCommand} <list|show|add|remove> | <link>`,
    }, 30000);
    return true;
  }

  const fileName = sanitizeTxtFileName(firstPart || "data");
  const filePath = path.join(saveFolder, fileName);
  try {
    await fs.mkdir(saveFolder, { recursive: true });
    await fs.appendFile(filePath, `${fileUrl}\n`, "utf8");
    await sendMessageStateQuote(api, message, `Da luu link vao: ${fileName}`, true, 30000);
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Da xay ra loi khi xu ly: ${error.message}`, false, 30000);
    return true;
  }
}
