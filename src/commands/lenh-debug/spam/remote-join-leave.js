import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  sendMessageFromSQL,
  sendMessageWarningRequest,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import {
  extractCleanArgs,
  extractCommandBody,
  safeThreadType,
} from "../../shared/command-input-utils.js";

const SAFE_JOIN_LEAVE_DELAY_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleJoinLeaveGroup(api, message, aliasCommand = "spamjoin") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = String(aliasCommand || message?.aliasCommand || "spamjoin").trim().toLowerCase();

  // Branch explicitly on poll-service — NEVER trigger spam join/leave!
  if (effectiveAlias === "poll-service") {
    const isGroup =
      (message?.type !== MessageType.DirectMessage && message?.type !== 0) &&
      (safeThreadType(message) === MessageType.GroupMessage || message?.type === "group");
    if (!isGroup) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: "⚠️ Tính năng tạo bình chọn nhóm chỉ sử dụng được trong nhóm trò chuyện!",
        },
        false,
        30000
      );
      return true;
    }

    const body = extractCommandBody(message, prefix, "poll-service");
    const parts = body.split("|").map((item) => item.trim()).filter(Boolean);
    if (parts.length < 3) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message:
            `📊 Cú pháp tạo bình chọn nhóm:\n` +
            `${prefix}poll-service <Câu hỏi> | <Lựa chọn 1> | <Lựa chọn 2> [| Lựa chọn 3...]\n` +
            `Ví dụ: ${prefix}poll-service Tối nay họp lúc mấy giờ? | 20:00 | 21:00`,
        },
        false,
        60000
      );
      return true;
    }

    const [question, ...options] = parts;
    const cleanOptions = options.slice(0, 12);

    try {
      if (typeof api?.createPoll === "function") {
        await api.createPoll({ question, options: cleanOptions }, message.threadId);
        await sendMessageFromSQL(
          api,
          message,
          {
            success: true,
            message: `📊 Đã tạo bình chọn nhóm: "${question}" (${cleanOptions.length} lựa chọn).`,
          },
          true,
          60000
        );
      } else {
        const pollLines = cleanOptions.map((opt, idx) => `${idx + 1}. ${opt}`);
        await api.sendMessage(
          {
            msg: [
              `📊 BÌNH CHỌN NHÓM: ${question}`,
              "━━━━━━━━━━━━━━━━━━",
              ...pollLines,
              "",
              "💬 Hãy reply số thứ tự lựa chọn của bạn!",
            ].join("\n"),
            quote: message,
            ttl: 3600000,
          },
          message.threadId,
          MessageType.GroupMessage
        );
      }
    } catch (error) {
      await sendMessageWarningRequest(
        api,
        message,
        { caption: `Không thể tạo bình chọn: ${error?.message || error}` },
        30000
      );
    }
    return true;
  }

  const args = extractCleanArgs(message, prefix, effectiveAlias);
  const linkJoin = args[0];
  const hasExplicitCount = args[1] !== undefined;
  const rawIterations = hasExplicitCount ? Number.parseInt(args[1], 10) : 1;

  if (!linkJoin || !/^https?:\/\//i.test(linkJoin) || Number.isNaN(rawIterations) || rawIterations < 1) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Cú pháp: ${prefix}${effectiveAlias} <link_nhóm> [số_lần (1-20)]`,
      },
      false,
      30000
    );
    return;
  }

  const iterations = Math.min(rawIterations, 20);

  let groupInfo = null;
  try {
    groupInfo = await api.getGroupInfoByLink(linkJoin);
  } catch {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Link này không tồn tại nhóm/cộng đồng nào hoặc đã hết hạn!`,
      },
      true,
      30000
    );
    return;
  }

  if (!groupInfo) return;

  let successfulIterations = 0;
  let approvalErrors = 0;
  let otherErrors = 0;

  try {
    for (let i = 0; i < iterations; i++) {
      let joinedSuccessfully = false;
      try {
        await api.joinGroup(linkJoin);
        joinedSuccessfully = true;
      } catch (error) {
        const msg = String(error?.message || "");
        if (msg.includes("Waiting for approve") || msg.toLowerCase().includes("duyệt")) {
          approvalErrors++;
          if (i + 1 < iterations) await sleep(SAFE_JOIN_LEAVE_DELAY_MS);
          continue;
        } else if (msg.includes("đã là thành viên")) {
          joinedSuccessfully = true;
        } else {
          otherErrors++;
          if (i + 1 < iterations) await sleep(SAFE_JOIN_LEAVE_DELAY_MS);
          continue;
        }
      }

      await sleep(SAFE_JOIN_LEAVE_DELAY_MS);
      if (joinedSuccessfully) {
        try {
          await api.leaveGroup(groupInfo.groupId);
          successfulIterations++;
        } catch {
          otherErrors++;
        }
      }
      if (i + 1 < iterations) {
        await sleep(SAFE_JOIN_LEAVE_DELAY_MS);
      }
    }

    let messageContent = `✅ Hoàn thành ${successfulIterations}/${iterations} lần tham gia & rời nhóm "${groupInfo.name}"!`;
    if (approvalErrors > 0 || otherErrors > 0) {
      const notes = [];
      if (approvalErrors > 0) notes.push(`${approvalErrors} lần chờ phê duyệt thành viên`);
      if (otherErrors > 0) notes.push(`${otherErrors} lần lỗi khác`);
      messageContent += `\n⚠️ Chi tiết: ${notes.join(", ")}.`;
    }

    await sendMessageFromSQL(
      api,
      message,
      {
        success: successfulIterations > 0,
        message: messageContent,
      },
      true,
      60000
    );
  } catch (error) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Lỗi không xác định: ${error?.message || error}`,
      },
      60000
    );
  }
}