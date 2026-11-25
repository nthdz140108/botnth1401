import path from "path";
import fs from "fs";
import { readWebConfig, writeWebConfig } from "../../utils/io-json.js";
import { normalizeWebPrConfig } from "./pr-config.js";
import { getInstancePrPaths } from "./pr-zalo.js";
import {
  sendMessageWarningRequest,
  sendMessageCompleteRequest,
  sendMessageComplete,
} from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { checkExstentionFileRemote, downloadFile, deleteFile } from "../../utils/util.js";
import { getGroupInfoData, getDataAllGroup } from "../info-service/group-info.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { appContext } from "../../api-zalo/context.js";
import { resolveInstanceAuthorization } from "../../utils/instance-authorization.js";
import { extractCommandBody } from "../../commands/shared/command-input-utils.js";

export function resolveSafePrMediaPath(dirPath, rawFileName) {
  const raw = String(rawFileName ?? "").trim();
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const safeName = path.basename(raw);
  if (!safeName || safeName === "." || safeName === "..") {
    return null;
  }
  const resolvedDir = path.resolve(dirPath);
  const fullPath = path.resolve(resolvedDir, safeName);
  if (!fullPath.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return { fileName: safeName, filePath: fullPath };
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function isValidTimeFormat(time) {
  return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time);
}

function isValidPeriodicTimeFormat(input) {
  return /^(\d+)(s|min|h|d|m|y)$/.test(String(input || ""));
}

function parsePeriodicMs(input) {
  const m = String(input || "").match(/^(\d+)(s|min|h|d|m|y)$/);
  if (!m) return 0;
  const val = Number.parseInt(m[1], 10);
  switch (m[2]) {
    case "s":
      return val * 1000;
    case "min":
      return val * 60 * 1000;
    case "h":
      return val * 3600 * 1000;
    case "d":
      return val * 86400 * 1000;
    case "m":
      return val * 30 * 86400 * 1000;
    case "y":
      return val * 365 * 86400 * 1000;
    default:
      return 0;
  }
}

function getMsgTypeByCliMsgType(cliMsgType) {
  switch (cliMsgType) {
    case 1:
      return "webchat";
    case 31:
      return "chat.voice";
    case 32:
      return "chat.photo";
    case 36:
      return "chat.sticker";
    case 37:
      return "chat.doodle";
    case 38:
      return "chat.recommended";
    case 43:
      return "chat.location.new";
    case 44:
      return "chat.video.msg";
    case 46:
      return "share.file";
    case 49:
      return "chat.gif";
    default:
      return "unknown";
  }
}

function checkIsGlobalPrAdmin(message, api, options = {}) {
  if (options?.isAdminLevelHighest || options?.callerIsBotAdmin) {
    return true;
  }
  const snap = options?.authorizationSnapshot;
  if (snap?.isAdminLevelHigh || snap?.isAdminBot) {
    return true;
  }
  try {
    const senderId = message?.data?.uidFrom || message?.senderID || message?.senderId || "";
    const instanceUid = String(
      api?.getBotId?.() || api?.getOwnId?.() || api?.currentUserId || appContext?.uid || ""
    ).trim();
    const auth = resolveInstanceAuthorization({
      senderId,
      threadId: message?.threadId || "",
      instanceUid,
    });
    return Boolean(auth?.isAdminLevelHigh || auth?.isAdminBot);
  } catch {
    return false;
  }
}

function createDefaultPrObject(prName = "") {
  return {
    ten: prName,
    idZalo: "-1",
    noiDung: "",
    hinhAnh: [],
    video: [],
    link: {},
    thoiGianGui: [],
    customContent: {},
    isContentActive: true,
    isImageActive: true,
    isVideoActive: true,
    isCardActive: true,
  };
}

function buildBasicHelpText(prefix, aliasCommand, isGlobalAdmin) {
  if (!isGlobalAdmin) {
    return (
      `Cách sử dụng PR Service (Quản trị viên nhóm):\n\n` +
      `• ${prefix}${aliasCommand} show: Xem trạng thái nhận quảng cáo của nhóm hiện tại\n` +
      `• ${prefix}${aliasCommand} on / off: Bật / tắt nhận quảng cáo cho nhóm này\n` +
      `• ${prefix}${aliasCommand} add [thời gian]: Đăng ký nhóm nhận quảng cáo (tối thiểu 60s, vd: 30min, 1h)\n` +
      `• ${prefix}${aliasCommand} remove: Gỡ nhóm hiện tại khỏi danh sách nhận quảng cáo`
    );
  }

  return (
    `Cách sử dụng PR Service:\n\n` +
    `• ${prefix}${aliasCommand} show: Hiển thị chi tiết quảng cáo\n` +
    `• ${prefix}${aliasCommand} on / off: Bật / tắt quảng cáo cho nhóm hoặc hội thoại hiện tại\n` +
    `• ${prefix}${aliasCommand} add [thời gian]: Thêm nhóm hiện tại vào danh sách PR\n` +
    `• ${prefix}${aliasCommand} add all [thời gian]: Thêm tất cả nhóm vào danh sách PR\n` +
    `• ${prefix}${aliasCommand} remove: Xóa nhóm/bạn khỏi danh sách PR\n` +
    `• ${prefix}${aliasCommand} off all: Tắt quảng cáo cho tất cả nhóm và bạn bè\n` +
    `• ${prefix}${aliasCommand} set ...: Tùy chỉnh nội dung/media/lịch quảng cáo\n` +
    `• Dùng ${prefix}${aliasCommand} help service để xem hướng dẫn chi tiết!`
  );
}

async function rejectGlobalActionForGroupAdmin(api, message) {
  await sendMessageWarningRequest(
    api,
    message,
    {
      caption:
        "⛔ Quyền hạn không đủ! Quản trị viên nhóm chỉ được quản lý nhận PR cho nhóm hiện tại (on/off/add/remove/show). Các thao tác toàn cục (add all, off all, set, xóa media/cấu hình chung) chỉ dành cho Admin Bot.",
    },
    30000
  );
}

export async function handlePRCommand(api, message, aliasCommand = "pr", options = {}) {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "pr";
  const body = extractCommandBody(message, prefix, cmdName);
  const args = body ? body.split(/\s+/).filter(Boolean) : [];
  const threadId = message.threadId;
  const threadType = message.type === MessageType.GroupMessage ? "GroupMessage" : "DirectMessage";
  const isGlobalAdmin = checkIsGlobalPrAdmin(message, api, options);
  const { imagePrDir, videoPrDir } = getInstancePrPaths();

  if (args.length === 0) {
    await sendMessageComplete(api, message, buildBasicHelpText(prefix, cmdName, isGlobalAdmin));
    return;
  }

  const config = normalizeWebPrConfig(await readWebConfig());
  const subCommand = args[0].toLowerCase();

  if (subCommand === "help") {
    const helpType = args[1]?.toLowerCase();
    if (helpType === "service" && isGlobalAdmin) {
      await sendMessageComplete(
        api,
        message,
        `Chi tiết về quản lý dịch vụ PR:\n\n` +
          `Cách sử dụng tùy chỉnh nội dung:\n` +
          `${prefix}${cmdName} set [Nội dung]: Thay đổi nội dung\n` +
          `${prefix}${cmdName} set (quote): Thêm nội dung từ tin nhắn được quote\n` +
          `${prefix}${cmdName} set [Tên ảnh/video] (quote): Thêm media như ảnh hoặc video\n` +
          `${prefix}${cmdName} set [Tên ảnh/video]|[Link]: Thêm media từ link\n` +
          `${prefix}${cmdName} set @Ai đó hoặc [Uid] hoặc me: Tùy chỉnh Business Card\n` +
          `${prefix}${cmdName} set [HH:MM,HH:MM,...]: Tùy chỉnh thời gian\n\n` +
          `Cách bật/tắt nội dung:\n` +
          `${prefix}${cmdName} on / off: Bật/tắt quảng cáo cho nhóm/bạn\n` +
          `${prefix}${cmdName} on/off [card|image|video|content]: Bật/tắt loại nội dung\n` +
          `${prefix}${cmdName} add all / off all: Bật tất cả nhóm / tắt toàn bộ\n\n` +
          `Cách xóa media và cấu hình:\n` +
          `${prefix}${cmdName} remove [all|image|video|time|card]`
      );
      return;
    }
    await sendMessageComplete(api, message, buildBasicHelpText(prefix, cmdName, isGlobalAdmin));
    return;
  }

  if (subCommand === "show") {
    const prObject = config.prObjects.find((pr) => pr.ten === "");
    if (!prObject) {
      await sendMessageWarningRequest(
        api,
        message,
        { caption: "Không tìm thấy cấu hình PR để hiển thị!" },
        30000
      );
      return;
    }

    if (!isGlobalAdmin) {
      const enabledHere = Boolean(config.selectedGroups["-1"] || config.selectedGroups[threadId]);
      const periodicHere = prObject.customContent?.[threadId]?.periodicTime;
      let response = `Trạng thái PR nhóm hiện tại:\n`;
      response += `• Trạng thái nhận PR: ${enabledHere ? "Đang bật" : "Đang tắt"}\n`;
      response += `• Thời gian gửi cố định: ${prObject.thoiGianGui.length > 0 ? prObject.thoiGianGui.join(", ") : "Chưa cài đặt"}`;
      if (periodicHere) {
        response += `\n• Thời gian định kỳ nhóm: ${periodicHere}`;
      }
      await sendMessageCompleteRequest(api, message, { caption: response }, 30000);
      return;
    }

    let groupNames = "Chưa có nhóm nào";
    try {
      const groupIds = Object.keys(config.selectedGroups).filter((id) => config.selectedGroups[id]);
      const groupNamesArray = [];

      if (groupIds.includes("-1")) {
        await getDataAllGroup(api).catch(() => []);
        groupNamesArray.push("Tất cả nhóm");
      } else {
        for (const groupId of groupIds) {
          try {
            const groupInfo = await getGroupInfoData(api, [groupId]);
            groupNamesArray.push(groupInfo.name || `Nhóm ${groupId}`);
          } catch {
            groupNamesArray.push(`Nhóm ${groupId}`);
          }
        }
      }
      groupNames = groupNamesArray.length > 0 ? groupNamesArray.join(", ") : "Chưa có nhóm nào";
    } catch {
      groupNames =
        Object.keys(config.selectedGroups)
          .filter((id) => config.selectedGroups[id])
          .map((id) => (id === "-1" ? "Tất cả nhóm" : `Nhóm ${id}`))
          .join(", ") || "Chưa có nhóm nào";
    }

    let response = `Chi tiết quảng cáo:\n`;
    response += `Nội dung: ${prObject.noiDung || "Chưa có nội dung"}\n`;
    if (prObject.hinhAnh.length > 0) {
      response += `Hình ảnh: Có ${prObject.hinhAnh.length} ảnh\n`;
    }
    if (prObject.video.length > 0) {
      response += `Video: Có ${prObject.video.length} video\n`;
    }
    response += `Thời gian gửi cố định: ${prObject.thoiGianGui.length > 0 ? prObject.thoiGianGui.join(", ") : "Chưa cài đặt"}\n`;
    if (threadType === "GroupMessage" && prObject.customContent[threadId]?.periodicTime) {
      response += `Thời gian định kỳ: ${prObject.customContent[threadId].periodicTime}\n`;
    }
    response += `Nhóm đã bật: ${groupNames}`;

    await sendMessageCompleteRequest(api, message, { caption: response }, 30000);
    return;
  }

  if (subCommand === "on" || subCommand === "off") {
    const type = args[1]?.toLowerCase();
    const isOn = subCommand === "on";

    if (!type) {
      if (threadType === "GroupMessage") {
        if (isOn && config.selectedGroups[threadId]) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Nhóm ${threadId} đã được bật quảng cáo!` },
            30000
          );
          return;
        }
        if (!isOn && !config.selectedGroups[threadId]) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Nhóm ${threadId} chưa được bật quảng cáo!` },
            30000
          );
          return;
        }
        config.selectedGroups[threadId] = isOn;
        if (!isOn) {
          delete config.selectedGroups[threadId];
          const prObject = config.prObjects.find((pr) => pr.ten === "");
          if (prObject && prObject.customContent[threadId]) {
            delete prObject.customContent[threadId];
          }
        }
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã ${isOn ? "bật" : "tắt"} quảng cáo cho nhóm ${threadId}` },
          30000
        );
      } else {
        if (!isGlobalAdmin) {
          await rejectGlobalActionForGroupAdmin(api, message);
          return;
        }
        if (isOn && config.selectedFriends[threadId]) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Bạn ${threadId} đã được bật quảng cáo!` },
            30000
          );
          return;
        }
        if (!isOn && !config.selectedFriends[threadId]) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Bạn ${threadId} chưa được bật quảng cáo!` },
            30000
          );
          return;
        }
        config.selectedFriends[threadId] = isOn;
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã ${isOn ? "bật" : "tắt"} quảng cáo cho bạn ${threadId}` },
          30000
        );
      }
      return;
    }

    if (!isGlobalAdmin) {
      await rejectGlobalActionForGroupAdmin(api, message);
      return;
    }

    if (type === "all") {
      if (subCommand === "off") {
        config.selectedGroups = {};
        config.selectedFriends = {};
        const prObject = config.prObjects.find((pr) => pr.ten === "");
        if (prObject) {
          prObject.customContent = {};
        }
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: "Đã tắt quảng cáo cho tất cả nhóm và bạn bè" },
          30000
        );
        return;
      }
      await sendMessageWarningRequest(
        api,
        message,
        { caption: `Vui lòng sử dụng "${prefix}${cmdName} add all" để bật quảng cáo cho tất cả nhóm!` },
        30000
      );
      return;
    }

    if (type === "time") {
      await sendMessageWarningRequest(api, message, { caption: `Không thể bật/tắt "${type}"!` }, 30000);
      return;
    }

    const validTypes = ["card", "image", "video", "content"];
    if (!validTypes.includes(type)) {
      await sendMessageWarningRequest(
        api,
        message,
        { caption: `Loại nội dung "${type}" không hợp lệ! Chỉ hỗ trợ: card, image, video, content.` },
        30000
      );
      return;
    }

    let prObject = config.prObjects.find((pr) => pr.ten === "");
    if (!prObject) {
      prObject = createDefaultPrObject("");
      config.prObjects.push(prObject);
    }

    const typeToFlag = {
      content: "isContentActive",
      image: "isImageActive",
      video: "isVideoActive",
      card: "isCardActive",
    };

    prObject[typeToFlag[type]] = isOn;
    await writeWebConfig(config);
    await sendMessageCompleteRequest(
      api,
      message,
      { caption: `Đã ${isOn ? "bật" : "tắt"} nội dung loại "${type}" cho PR` },
      30000
    );
    return;
  }

  if (subCommand === "add") {
    if (args.length === 1) {
      if (threadType === "GroupMessage") {
        config.selectedGroups[threadId] = true;
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã thêm nhóm ${threadId} vào danh sách PR` },
          30000
        );
      } else {
        if (!isGlobalAdmin) {
          await rejectGlobalActionForGroupAdmin(api, message);
          return;
        }
        config.selectedFriends[threadId] = true;
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã thêm bạn ${threadId} vào danh sách PR` },
          30000
        );
      }
      return;
    }

    if (args[1]?.toLowerCase() === "all") {
      if (!isGlobalAdmin) {
        await rejectGlobalActionForGroupAdmin(api, message);
        return;
      }

      const periodicTime = args[2];
      if (periodicTime && !isValidPeriodicTimeFormat(periodicTime)) {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption: `Thời gian định kỳ "${periodicTime}" không hợp lệ! Vui lòng dùng định dạng <số>s/min/h/d/m/y, ví dụ: 15s, 30min, 1h, 2d`,
          },
          30000
        );
        return;
      }

      let prObject = config.prObjects.find((pr) => pr.ten === "");
      if (!prObject) {
        prObject = createDefaultPrObject("");
        config.prObjects.push(prObject);
      }

      config.selectedGroups = { "-1": true };

      if (periodicTime) {
        const groups = await getDataAllGroup(api);
        for (const group of groups) {
          prObject.customContent[group.groupId] = prObject.customContent[group.groupId] || {};
          prObject.customContent[group.groupId].periodicTime = periodicTime;
          config.selectedGroups[group.groupId] = true;
        }
      }

      await writeWebConfig(config);
      await sendMessageCompleteRequest(
        api,
        message,
        {
          caption: `Đã thêm tất cả nhóm vào danh sách PR${periodicTime ? ` với thời gian định kỳ ${periodicTime}` : ""}`,
        },
        30000
      );
      return;
    }

    if (args.length === 2 && threadType === "GroupMessage") {
      const periodicTime = args[1];
      if (!isValidPeriodicTimeFormat(periodicTime)) {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption: `Thời gian định kỳ "${periodicTime}" không hợp lệ! Vui lòng dùng định dạng <số>s/min/h/d/m/y, ví dụ: 60s, 30min, 1h`,
          },
          30000
        );
        return;
      }

      if (!isGlobalAdmin && parsePeriodicMs(periodicTime) < 60 * 1000) {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: "⏰ Quản trị viên nhóm chỉ được đặt chu kỳ PR tối thiểu từ 60s (1min) trở lên!" },
          30000
        );
        return;
      }

      let prObject = config.prObjects.find((pr) => pr.ten === "");
      if (!prObject) {
        prObject = createDefaultPrObject("");
        config.prObjects.push(prObject);
      }

      prObject.customContent[threadId] = prObject.customContent[threadId] || {};
      prObject.customContent[threadId].periodicTime = periodicTime;
      config.selectedGroups[threadId] = true;
      await writeWebConfig(config);
      await sendMessageCompleteRequest(
        api,
        message,
        { caption: `Đã thêm thời gian định kỳ ${periodicTime} cho nhóm ${threadId}` },
        30000
      );
      return;
    }

    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Lệnh không hợp lệ! Dùng "${prefix}${cmdName} add" để thêm nhóm/bạn, hoặc "${prefix}${cmdName} add <thời gian>" (như 30min/1h) cho nhóm`,
      },
      30000
    );
    return;
  }

  if (subCommand === "set") {
    if (!isGlobalAdmin) {
      await rejectGlobalActionForGroupAdmin(api, message);
      return;
    }

    let prObject = config.prObjects.find((pr) => pr.ten === "");
    if (!prObject) {
      prObject = createDefaultPrObject("");
      config.prObjects.push(prObject);
    }

    const input = body.replace(/^set(?:\s+|$)/i, "").trim();
    const quote = message.data?.quote;

    if (quote) {
      try {
        const parseMessage =
          typeof quote.attach === "string" ? JSON.parse(quote.attach || "{}") : quote.attach || {};
        const fileUrl = parseMessage?.href || parseMessage?.hdUrl || parseMessage?.normalUrl;
        const msgType = getMsgTypeByCliMsgType(quote.cliMsgType);

        if (args.length === 1) {
          if (msgType === "chat.recommended" && quote.title) {
            prObject.noiDung = quote.title.trim();
            if (threadType === "GroupMessage") {
              prObject.customContent[threadId] = prObject.customContent[threadId] || {};
              prObject.customContent[threadId].noiDung = quote.title.trim();
            }
            await writeWebConfig(config);
            await sendMessageCompleteRequest(
              api,
              message,
              { caption: "Đã cập nhật nội dung PR từ tiêu đề tin nhắn được quote" },
              30000
            );
            return;
          }
          if (quote.msg && quote.msg.trim()) {
            prObject.noiDung = quote.msg.trim();
            if (threadType === "GroupMessage") {
              prObject.customContent[threadId] = prObject.customContent[threadId] || {};
              prObject.customContent[threadId].noiDung = quote.msg.trim();
            }
            await writeWebConfig(config);
            await sendMessageCompleteRequest(
              api,
              message,
              { caption: "Đã cập nhật nội dung PR từ tin nhắn quote" },
              30000
            );
            return;
          }
          await sendMessageWarningRequest(
            api,
            message,
            { caption: "Tin nhắn được quote không chứa nội dung hợp lệ!" },
            30000
          );
          return;
        }

        if (msgType === "chat.photo" || msgType === "chat.video.msg") {
          if (!fileUrl) {
            await sendMessageWarningRequest(
              api,
              message,
              { caption: "Tin nhắn được quote không chứa file hợp lệ!" },
              30000
            );
            return;
          }

          const fileName = args[1];
          const setType = msgType === "chat.video.msg" ? "video" : "image";
          const ext = await checkExstentionFileRemote(fileUrl);
          const candidateName = fileName.includes(".") ? fileName : `${fileName}.${ext}`;
          const dirPath = setType === "video" ? videoPrDir : imagePrDir;
          const resolvedMedia = resolveSafePrMediaPath(dirPath, candidateName);
          if (!resolvedMedia) {
            await sendMessageWarningRequest(
              api,
              message,
              { caption: `Tên file "${fileName}" không hợp lệ!` },
              30000
            );
            return;
          }
          const { fileName: fullFileName, filePath: savePath } = resolvedMedia;

          if (fs.existsSync(savePath)) {
            await sendMessageWarningRequest(
              api,
              message,
              { caption: `File "${fullFileName}" đã tồn tại!` },
              30000
            );
            return;
          }

          ensureDirectoryExists(dirPath);
          await downloadFile(fileUrl, savePath);

          if (setType === "video") {
            prObject.video.push(fullFileName);
            if (threadType === "GroupMessage") {
              prObject.customContent[threadId] = prObject.customContent[threadId] || {};
              prObject.customContent[threadId].video = prObject.customContent[threadId].video || [];
              prObject.customContent[threadId].video.push(fullFileName);
            }
          } else {
            prObject.hinhAnh.push(fullFileName);
            if (threadType === "GroupMessage") {
              prObject.customContent[threadId] = prObject.customContent[threadId] || {};
              prObject.customContent[threadId].hinhAnh =
                prObject.customContent[threadId].hinhAnh || [];
              prObject.customContent[threadId].hinhAnh.push(fullFileName);
            }
          }

          await writeWebConfig(config);
          await sendMessageCompleteRequest(
            api,
            message,
            { caption: `Đã thêm ${setType} "${fullFileName}" vào PR` },
            30000
          );
          return;
        }

        await sendMessageWarningRequest(
          api,
          message,
          { caption: "Tin nhắn được quote không phải ảnh hoặc video!" },
          30000
        );
        return;
      } catch (error) {
        console.error("Lỗi khi xử lý quote PR:", error?.message || error);
        await sendMessageWarningRequest(
          api,
          message,
          { caption: "Đã xảy ra lỗi khi xử lý file từ quote. Vui lòng thử lại!" },
          30000
        );
        return;
      }
    }

    if (input.includes("|") && !input.startsWith("@")) {
      const [fileName, link] = input.split("|").map((s) => s.trim());
      if (!fileName || !link) {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: "Vui lòng cung cấp tên file và link hợp lệ!" },
          30000
        );
        return;
      }
      try {
        const ext = await checkExstentionFileRemote(link);
        const lowerExt = String(ext || "").toLowerCase();
        const setType = ["png", "jpg", "jpeg", "gif", "webp"].includes(lowerExt)
          ? "image"
          : lowerExt === "mp4"
            ? "video"
            : null;

        if (!setType) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Định dạng file "${ext}" không được hỗ trợ!` },
            30000
          );
          return;
        }

        const candidateName = fileName.includes(".") ? fileName : `${fileName}.${lowerExt}`;
        const dirPath = setType === "video" ? videoPrDir : imagePrDir;
        const resolvedMedia = resolveSafePrMediaPath(dirPath, candidateName);
        if (!resolvedMedia) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Tên file "${fileName}" không hợp lệ!` },
            30000
          );
          return;
        }
        const { fileName: fullFileName, filePath: savePath } = resolvedMedia;

        if (fs.existsSync(savePath)) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `File "${fullFileName}" đã tồn tại!` },
            30000
          );
          return;
        }
        ensureDirectoryExists(dirPath);
        await downloadFile(link, savePath);
        if (setType === "video") {
          prObject.video.push(fullFileName);
          if (threadType === "GroupMessage") {
            prObject.customContent[threadId] = prObject.customContent[threadId] || {};
            prObject.customContent[threadId].video = prObject.customContent[threadId].video || [];
            prObject.customContent[threadId].video.push(fullFileName);
          }
        } else {
          prObject.hinhAnh.push(fullFileName);
          if (threadType === "GroupMessage") {
            prObject.customContent[threadId] = prObject.customContent[threadId] || {};
            prObject.customContent[threadId].hinhAnh =
              prObject.customContent[threadId].hinhAnh || [];
            prObject.customContent[threadId].hinhAnh.push(fullFileName);
          }
        }

        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã thêm ${setType} "${fullFileName}" vào PR` },
          30000
        );
        return;
      } catch (error) {
        console.error("Lỗi khi xử lý link PR:", error?.message || error);
        await sendMessageWarningRequest(
          api,
          message,
          { caption: "Đã xảy ra lỗi khi thêm file từ link. Vui lòng thử lại!" },
          30000
        );
        return;
      }
    }

    const firstMentionUid =
      Array.isArray(message.data?.mentions) && message.data.mentions.length > 0
        ? message.data.mentions[0]?.uid
        : message.data?.mentions?.uid;

    if (
      firstMentionUid ||
      input.startsWith("@") ||
      /^\d+$/.test(input) ||
      input.toLowerCase() === "me"
    ) {
      let zaloId;
      if (input.toLowerCase() === "me") {
        zaloId = message.senderId || message.data?.uidFrom;
      } else if (firstMentionUid) {
        zaloId = firstMentionUid;
      } else if (input.startsWith("@")) {
        if (input.includes("|")) {
          const [, uid] = input.split("|");
          zaloId = uid?.trim();
        }
        if (!zaloId) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: "Không tìm thấy UID từ @mention!" },
            30000
          );
          return;
        }
      } else {
        zaloId = input;
      }

      zaloId = String(zaloId || "").trim();
      if (!/^\d+$/.test(zaloId)) {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: `ID Zalo "${zaloId}" không hợp lệ! Phải là số.` },
          30000
        );
        return;
      }

      prObject.idZalo = zaloId;
      await writeWebConfig(config);
      await sendMessageCompleteRequest(
        api,
        message,
        { caption: `Đã cập nhật ID Zalo ${zaloId} cho PR` },
        30000
      );
      return;
    }

    const maybeTimes = input.split(",").map((t) => t.trim()).filter(Boolean);
    if (maybeTimes.length > 0 && maybeTimes.every((t) => /^\d{1,2}:\d{2}$/.test(t))) {
      const invalidTimes = maybeTimes.filter((t) => !isValidTimeFormat(t));
      if (invalidTimes.length > 0) {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: `Thời gian "${invalidTimes.join(", ")}" không hợp lệ! Vui lòng dùng định dạng HH:MM` },
          30000
        );
        return;
      }

      const addedTimes = [];
      for (const rawTime of maybeTimes) {
        const [hh, mm] = rawTime.split(":");
        const normalizedTime = `${hh.padStart(2, "0")}:${mm}`;
        if (!prObject.thoiGianGui.includes(normalizedTime)) {
          prObject.thoiGianGui.push(normalizedTime);
          addedTimes.push(normalizedTime);
        }
      }

      if (addedTimes.length === 0) {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: "Tất cả thời gian đã tồn tại trong PR!" },
          30000
        );
        return;
      }

      await writeWebConfig(config);
      await sendMessageCompleteRequest(
        api,
        message,
        { caption: `Đã thêm thời gian ${addedTimes.join(", ")} cho PR` },
        30000
      );
      return;
    }

    if (!input) {
      await sendMessageWarningRequest(
        api,
        message,
        { caption: "Vui lòng cung cấp nội dung PR hoặc quote tin nhắn!" },
        30000
      );
      return;
    }

    prObject.noiDung = input;
    if (threadType === "GroupMessage") {
      prObject.customContent[threadId] = prObject.customContent[threadId] || {};
      prObject.customContent[threadId].noiDung = input;
    }
    await writeWebConfig(config);
    await sendMessageCompleteRequest(api, message, { caption: "Đã cập nhật nội dung PR" }, 30000);
    return;
  }

  if (subCommand === "remove") {
    const removeType = args[1]?.toLowerCase();

    if (!removeType) {
      if (threadType === "GroupMessage") {
        if (config.selectedGroups[threadId]) {
          delete config.selectedGroups[threadId];
          const prObject = config.prObjects.find((pr) => pr.ten === "");
          if (prObject && prObject.customContent[threadId]) {
            delete prObject.customContent[threadId];
          }
          await writeWebConfig(config);
          await sendMessageCompleteRequest(
            api,
            message,
            { caption: `Đã xóa nhóm ${threadId} khỏi danh sách PR` },
            30000
          );
        } else {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Nhóm ${threadId} không có trong danh sách PR` },
            30000
          );
        }
      } else {
        if (!isGlobalAdmin) {
          await rejectGlobalActionForGroupAdmin(api, message);
          return;
        }
        if (config.selectedFriends[threadId]) {
          delete config.selectedFriends[threadId];
          await writeWebConfig(config);
          await sendMessageCompleteRequest(
            api,
            message,
            { caption: `Đã xóa bạn ${threadId} khỏi danh sách PR` },
            30000
          );
        } else {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Bạn ${threadId} không có trong danh sách PR` },
            30000
          );
        }
      }
      return;
    }

    if (!isGlobalAdmin) {
      await rejectGlobalActionForGroupAdmin(api, message);
      return;
    }

    const prObject = config.prObjects.find((pr) => pr.ten === "");
    if (!prObject) {
      await sendMessageWarningRequest(
        api,
        message,
        { caption: "Không tìm thấy PR để xóa dữ liệu" },
        30000
      );
      return;
    }

    if (removeType === "image") {
      if (args.length === 2) {
        if (
          prObject.hinhAnh.length === 0 &&
          (!prObject.customContent[threadId] || !prObject.customContent[threadId].hinhAnh)
        ) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: "Không có hình ảnh nào để xóa" },
            30000
          );
          return;
        }
        for (const fileName of prObject.hinhAnh) {
          const resolvedMedia = resolveSafePrMediaPath(imagePrDir, fileName);
          if (!resolvedMedia) continue;
          await deleteFile(resolvedMedia.filePath).catch(() => {});
        }
        prObject.hinhAnh = [];
        if (threadType === "GroupMessage" && prObject.customContent[threadId]) {
          prObject.customContent[threadId].hinhAnh = [];
        }
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: "Đã xóa tất cả hình ảnh khỏi PR" },
          30000
        );
      } else {
        const resolvedMedia = resolveSafePrMediaPath(imagePrDir, args[2]);
        if (!resolvedMedia) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Tên hình ảnh "${args[2]}" không hợp lệ` },
            30000
          );
          return;
        }
        const { fileName, filePath } = resolvedMedia;
        const index = prObject.hinhAnh.indexOf(fileName);
        if (index === -1) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Hình ảnh "${fileName}" không tồn tại trong PR` },
            30000
          );
          return;
        }
        await deleteFile(filePath).catch(() => {});
        prObject.hinhAnh.splice(index, 1);
        if (threadType === "GroupMessage" && prObject.customContent[threadId]?.hinhAnh) {
          const groupIndex = prObject.customContent[threadId].hinhAnh.indexOf(fileName);
          if (groupIndex !== -1) {
            prObject.customContent[threadId].hinhAnh.splice(groupIndex, 1);
          }
        }
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã xóa hình ảnh "${fileName}" khỏi PR` },
          30000
        );
      }
      return;
    }

    if (removeType === "video") {
      if (args.length === 2) {
        if (
          prObject.video.length === 0 &&
          (!prObject.customContent[threadId] || !prObject.customContent[threadId].video)
        ) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: "Không có video nào để xóa" },
            30000
          );
          return;
        }
        for (const fileName of prObject.video) {
          const resolvedMedia = resolveSafePrMediaPath(videoPrDir, fileName);
          if (!resolvedMedia) continue;
          await deleteFile(resolvedMedia.filePath).catch(() => {});
        }
        prObject.video = [];
        if (threadType === "GroupMessage" && prObject.customContent[threadId]) {
          prObject.customContent[threadId].video = [];
        }
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: "Đã xóa tất cả video khỏi PR" },
          30000
        );
      } else {
        const resolvedMedia = resolveSafePrMediaPath(videoPrDir, args[2]);
        if (!resolvedMedia) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Tên video "${args[2]}" không hợp lệ` },
            30000
          );
          return;
        }
        const { fileName, filePath } = resolvedMedia;
        const index = prObject.video.indexOf(fileName);
        if (index === -1) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Video "${fileName}" không tồn tại trong PR` },
            30000
          );
          return;
        }
        await deleteFile(filePath).catch(() => {});
        prObject.video.splice(index, 1);
        if (threadType === "GroupMessage" && prObject.customContent[threadId]?.video) {
          const groupIndex = prObject.customContent[threadId].video.indexOf(fileName);
          if (groupIndex !== -1) {
            prObject.customContent[threadId].video.splice(groupIndex, 1);
          }
        }
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã xóa video "${fileName}" khỏi PR` },
          30000
        );
      }
      return;
    }

    if (removeType === "time") {
      if (args.length === 2) {
        if (prObject.thoiGianGui.length === 0) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: "Không có thời gian nào để xóa" },
            30000
          );
          return;
        }
        prObject.thoiGianGui = [];
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: "Đã xóa tất cả thời gian khỏi PR" },
          30000
        );
      } else {
        const time = args[2];
        if (!isValidTimeFormat(time)) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Thời gian "${time}" không hợp lệ! Vui lòng dùng định dạng HH:MM` },
            30000
          );
          return;
        }
        const index = prObject.thoiGianGui.indexOf(time);
        if (index === -1) {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Thời gian "${time}" không tồn tại trong PR` },
            30000
          );
          return;
        }
        prObject.thoiGianGui.splice(index, 1);
        await writeWebConfig(config);
        await sendMessageCompleteRequest(
          api,
          message,
          { caption: `Đã xóa thời gian "${time}" khỏi PR` },
          30000
        );
      }
      return;
    }

    if (removeType === "card") {
      if (prObject.idZalo === "-1") {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: "Không có ID Zalo để xóa" },
          30000
        );
        return;
      }
      prObject.idZalo = "-1";
      await writeWebConfig(config);
      await sendMessageCompleteRequest(api, message, { caption: "Đã xóa ID Zalo khỏi PR" }, 30000);
      return;
    }

    if (removeType === "all") {
      for (const fileName of prObject.hinhAnh) {
        const resolvedMedia = resolveSafePrMediaPath(imagePrDir, fileName);
        if (resolvedMedia) await deleteFile(resolvedMedia.filePath).catch(() => {});
      }
      for (const fileName of prObject.video) {
        const resolvedMedia = resolveSafePrMediaPath(videoPrDir, fileName);
        if (resolvedMedia) await deleteFile(resolvedMedia.filePath).catch(() => {});
      }
      prObject.noiDung = "";
      prObject.hinhAnh = [];
      prObject.video = [];
      prObject.idZalo = "-1";
      prObject.thoiGianGui = [];
      prObject.customContent = {};
      prObject.isContentActive = true;
      prObject.isImageActive = true;
      prObject.isVideoActive = true;
      prObject.isCardActive = true;
      await writeWebConfig(config);
      await sendMessageCompleteRequest(
        api,
        message,
        { caption: "Đã reset toàn bộ dữ liệu PR" },
        30000
      );
      return;
    }

    await sendMessageWarningRequest(
      api,
      message,
      { caption: `Loại dữ liệu "${removeType}" không hợp lệ!` },
      30000
    );
    return;
  }

  await sendMessageWarningRequest(
    api,
    message,
    { caption: `Lệnh không hợp lệ! Dùng "${prefix}${cmdName} help" để xem hướng dẫn.` },
    30000
  );
}
