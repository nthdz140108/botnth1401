import { MultiMsgStyle, MessageStyle } from "../../api-zalo/models/index.js";
import { getCommandConfig, reloadCommandConfig, isMainBotAdmin } from "../../utils/io-json.js";
import { enrichCommandList, enrichCommandMetadata } from "../../utils/release-command-catalog.js";
import { formatPermissionDenied, getRoleLabel, isAdmin } from "../../utils/role-policy.js";
import { getBotName } from "../../utils/env.js";
import { deleteFile } from "../../utils/util.js";
import { renderCommandListImage, CMD_LIST_PAGE_SIZE } from "../../utils/canvas/cmd-list-canvas.js";
import { createInstructionsImage } from "../../utils/canvas/help.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { invalidateRuntimePolicyCache } from "../command.js";
import {
  COLOR_GREEN,
  SIZE_18,
  IS_BOLD,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";

const COMMANDS_PER_PAGE = CMD_LIST_PAGE_SIZE;

function buildDisabledCommandKeySet(commands = []) {
  const disabled = new Set();
  for (const rawCmd of commands) {
    const cmd = enrichCommandMetadata(rawCmd);
    if (cmd && cmd.active === false) {
      if (cmd.name) disabled.add(String(cmd.name).trim().toLowerCase());
      if (Array.isArray(cmd.alias)) {
        for (const al of cmd.alias) {
          disabled.add(String(al).trim().toLowerCase());
        }
      }
    }
  }
  return disabled;
}

export async function helpCommand(api, message, groupAdmins) {
  const prefix = getGlobalPrefix();
  const senderId = message.data.uidFrom;
  const threadId = message.threadId;
  const senderName = message.data.dName;
  const isAdminBox = isAdmin(senderId, threadId, groupAdmins);

  const catalogCommands = enrichCommandList(getCommandConfig()?.commands || []);
  const disabledKeys = buildDisabledCommandKeySet(catalogCommands);
  const isEntryActive = (canonicalOrAlias) => !disabledKeys.has(String(canonicalOrAlias).toLowerCase());

  const rawAllMembers = {
    gpt: { command: `${prefix}gpt [câu hỏi]`, description: "Hỏi AI", icon: "🤖", lookup: "gpt" },
    gemini: { command: `${prefix}gemini [nội dung]`, description: "Trò chuyện & phân tích ảnh AI", icon: "💬", lookup: "gemini" },
    info: { command: `${prefix}info`, description: "Xem thông tin tài khoản Zalo", icon: "📰", lookup: "info" },
    nhacnho: { command: `${prefix}nhacnho [giờ] [nội dung]`, description: "Đặt lịch nhắc nhở tự động", icon: "⏰", lookup: "nhacnho" },
    thoitiet: { command: `${prefix}thoitiet [thành phố]`, description: "Xem thời tiết", icon: "🌤️", lookup: "thoitiet" },
    dich: { command: `${prefix}dich [nội dung]&&(ngôn ngữ dịch)`, description: "Dịch văn bản", icon: "🌐", lookup: "dich" },
    group: { command: `${prefix}group`, description: "Xem thông tin nhóm", icon: "📋", lookup: "group" },
    topchat: { command: `${prefix}topchat`, description: "Xem BXH tương tác nhóm", icon: "🏆", lookup: "topchat" },
    girl: { command: `${prefix}girl`, description: "Gửi ảnh girl", icon: "👧", lookup: "girl" },
    boy: { command: `${prefix}boy`, description: "Gửi ảnh boy", icon: "👦", lookup: "boy" },
    youtube: { command: `${prefix}youtube [từ khóa]`, description: "Tìm & tải video YouTube", icon: "🎬", lookup: "youtube" },
    image: { command: `${prefix}image [tên ảnh]`, description: "Tìm ảnh ngẫu nhiên", icon: "🖼️", lookup: "image" },
    music: { command: `${prefix}music [tên bài hát]`, description: "Tìm bài hát", icon: "🎧", lookup: "soundcloud" },
    tiktok: { command: `${prefix}tiktok [nội dung]`, description: "Tìm video tiktok", icon: "🎥", lookup: "tiktok" },
    command: { command: `${prefix}command`, description: "Xem danh sách lệnh", icon: "🔖", lookup: "command" },
  };

  const rawAdminEntries = {
    manager: { command: `${prefix}manager`, description: "Xem danh sách lệnh quản lý", icon: "🔧", lookup: "manager" },
    detail: { command: `${prefix}detail`, description: "Xem thông tin bot", icon: "🔧", lookup: "detail" },
    commandAdmin: { command: `${prefix}command admin`, description: "Danh sách toàn bộ lệnh Admin", icon: "👮", lookup: "command" },
  };

  const filteredAllMembers = {};
  for (const [key, item] of Object.entries(rawAllMembers)) {
    if (isEntryActive(item.lookup || key)) {
      filteredAllMembers[key] = { command: item.command, description: item.description, icon: item.icon };
    }
  }

  const filteredAdmin = {};
  for (const [key, item] of Object.entries(rawAdminEntries)) {
    if (isEntryActive(item.lookup || key)) {
      filteredAdmin[key] = { command: item.command, description: item.description, icon: item.icon };
    }
  }

  let helpMessage = "🌟DANH SÁCH LỆNH🌟\n\n";
  helpMessage += "📌 Lệnh cho tất cả thành viên:\n";
  helpMessage += "╔═════════════\n";
  for (const item of Object.values(filteredAllMembers)) {
    helpMessage += `║ ${item.icon} ${item.command} - ${item.description}\n`;
  }
  helpMessage += "╚═════════════\n\n";

  if (isAdminBox && Object.keys(filteredAdmin).length > 0) {
    helpMessage += "👮 Lệnh dành cho Admin:\n";
    helpMessage += "╔═══════════\n";
    for (const item of Object.values(filteredAdmin)) {
      helpMessage += `║ ${item.icon} ${item.command} - ${item.description}\n`;
    }
    helpMessage += "╚═══════════\n";
  }

  const helpCommandPayload = {
    title: "🌟 DANH SÁCH LỆNH 🌟",
    allMembers: filteredAllMembers,
    titleAdmin: "👮 Lệnh dành cho Admin 👮",
    admin: filteredAdmin,
  };

  let imagePath = null;
  try {
    imagePath = await createInstructionsImage(
      helpCommandPayload,
      isAdminBox,
      699
    );
    await api.sendMessage(
      {
        msg: `🌟 ${senderName} - Danh sách lệnh của tôi 🌟`,
        attachments: imagePath ? [imagePath] : [],
        mentions: [{ pos: 3, uid: senderId, len: senderName.length }],
        ttl: 500000,
      },
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi gửi tin nhắn trợ giúp:", error);
    try {
      await api.sendMessage(
        {
          msg: helpMessage,
          ttl: 300000,
        },
        threadId,
        message.type
      );
    } catch (fallbackError) {
      console.error("Lỗi khi gửi tin nhắn fallback trợ giúp:", fallbackError);
      throw fallbackError;
    }
  } finally {
    if (imagePath) {
      await deleteFile(imagePath);
    }
  }
}

export async function adminCommand(api, message) {
  const senderId = message.data.uidFrom;
  const threadId = message.threadId;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  let commandMessage = "👮Danh sách lệnh Admin:\n";
  commandMessage += "╔═══════════\n";
  commandMessage += `║ 🤖 ${prefix}bot on/off - bật tương tác với bot\n`;
  commandMessage += `║ 📋 ${prefix}listmute - Xem danh sách mute\n`;
  commandMessage += `║ 🔖 ${prefix}listadmin - xem danh sách admin bot nhóm\n`;
  commandMessage += `║ 📥 ${prefix}admin add/remove [box|qtv] - thêm/xóa admin bot nhóm\n`;
  commandMessage += `║ 🚫 ${prefix}antibadword on/off - Lọc từ thô tục\n`;
  commandMessage += `║ 🔗 ${prefix}antilink on/off - Chặn liên kết\n`;
  commandMessage += `║ ⛔ ${prefix}antispam on/off - Chống spam\n`;
  commandMessage += `║ ⛔ ${prefix}antitag on/off - Chặn tag thành viên\n`;
  commandMessage += `║ ⛔ ${prefix}antisetup on/off - Chặn hành vi bất thường\n`;
  commandMessage += `║ ⛔ ${prefix}antisticker on/off - Chống sticker gây lag\n`;
  commandMessage += `║ ⛔ ${prefix}antigif on/off - Chống gửi GIF\n`;
  commandMessage += `║ 🅰 ${prefix}onlytext on/off - Chỉ nhắn tin văn bản\n`;
  commandMessage += `║ 👢 ${prefix}kick @mention - Kick thành viên\n`;
  commandMessage += `║ 🔇 ${prefix}mute @mention - Mute thành viên\n`;
  commandMessage += `║ 🔊 ${prefix}unmute @mention - Unmute thành viên\n`;
  commandMessage += `║ 👋 ${prefix}welcome on/off - Chào mừng thành viên mới\n`;
  commandMessage += `║ 👋 ${prefix}bye on/off - Tạm biệt thành viên rời nhóm\n`;
  commandMessage += `║ 📢 ${prefix}all [Cụm từ cần tag all] - Chat với tất cả thành viên\n`;
  commandMessage += "╚═════════\n";

  let commandAdmin = {
    title: "👮 DANH SÁCH LỆNH ADMIN 👮",
    allMembers: {
      bot: {
        command: `${prefix}bot on/off`,
        description: "Bật/tắt tương tác với bot",
        icon: "🤖",
      },
      addremove: {
        command: `${prefix}admin add/remove [box|qtv]`,
        description: "Thêm/xóa admin bot nhóm",
        icon: "🔖",
      },
      mute: {
        command: `${prefix}mute/unmute [@người dùng]`,
        description: "Mute/Unmute thành viên",
        icon: "🔇",
      },
      antibadword: {
        command: `${prefix}antibadword on/off`,
        description: "Lọc từ thô tục",
        icon: "🅰",
      },
      antilink: {
        command: `${prefix}antilink on/off`,
        description: "Chặn gửi liên kết",
        icon: "🔗",
      },
      antitag: {
        command: `${prefix}antitag on/off`,
        description: "Chặn tag thành viên",
        icon: "🔗",
      },
      antisetup: {
        command: `${prefix}antisetup on/off`,
        description: "Chặn hành vi bất thường",
        icon: "⛔",
      },
      antispam: {
        command: `${prefix}antispam on/off`,
        description: "Chống spam tin nhắn",
        icon: "⛔",
      },
      antisticker: {
        command: `${prefix}antisticker on/off`,
        description: "Chống sticker gây lag",
        icon: "⛔",
      },
      antigif: {
        command: `${prefix}antigif on/off`,
        description: "Chống gửi ảnh động GIF",
        icon: "⛔",
      },
      onlytext: {
        command: `${prefix}onlytext on/off`,
        description: "Chỉ nhắn tin văn bản",
        icon: "🅰",
      },
      antinude: {
        command: `${prefix}antinude on/off`,
        description: "Chống gửi ảnh nhạy cảm",
        icon: "🅰",
      },
      antiundo: {
        command: `${prefix}antiundo on/off`,
        description: "Chống thu hồi tin nhắn",
        icon: "🅰",
      },
      kick: {
        command: `${prefix}kick [@người dùng]`,
        description: "Kick thành viên",
        icon: "👢",
      },
      block: {
        command: `${prefix}block [@người dùng]`,
        description: "Chặn thành viên",
        icon: "👢",
      },
      welcome: {
        command: `${prefix}welcome on/off`,
        description: "Chào mừng thành viên mới",
        icon: "👋",
      },
      bye: {
        command: `${prefix}bye on/off`,
        description: "Tạm biệt thành viên rời nhóm",
        icon: "👋",
      },
      approve: {
        command: `${prefix}approve on/off`,
        description: "Tự động phê duyệt thành viên vào nhóm",
        icon: "🔖",
      },
      all: {
        command: `${prefix}all [Cụm từ cần tag all]`,
        description: "Chat với tất cả thành viên",
        icon: "📢",
      },
      keygold: {
        command: `${prefix}keygold [@người dùng]`,
        description: "Nhường trưởng nhóm cho người đề cập",
        icon: "🔖",
      },
      keysilver: {
        command: `${prefix}keysilver [@người dùng]`,
        description: "Phong phó nhóm cho thành viên đề cập",
        icon: "🔖",
      },
      unkey: {
        command: `${prefix}unkey [@người dùng]`,
        description: "Gỡ quyền phó nhóm",
        icon: "🔖",
      },
    },
  };

  let imagePath = null;
  try {
    imagePath = await createInstructionsImage(
      commandAdmin,
      false,
      960
    );
    await api.sendMessage(
      {
        msg: `🌟 ${senderName} - Danh sách lệnh quản trị 🌟`,
        attachments: imagePath ? [imagePath] : [],
        mentions: [{ pos: 3, uid: senderId, len: senderName.length }],
        ttl: 500000,
      },
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi gửi tin nhắn danh sách lệnh admin:", error);
    try {
      await api.sendMessage(
        {
          msg: commandMessage,
          ttl: 300000,
        },
        threadId,
        message.type
      );
    } catch (fallbackError) {
      console.error("Lỗi khi gửi tin nhắn fallback admin:", fallbackError);
      throw fallbackError;
    }
  } finally {
    if (imagePath) {
      await deleteFile(imagePath);
    }
  }
}

// Thêm hàm helper để chia nhỏ tin nhắn
function splitMessage(message, maxLength = 2000) {
  if (message.length <= maxLength) {
    return [message];
  }

  const parts = [];
  let currentPart = "";
  const lines = message.split("\n");

  for (const line of lines) {
    if ((currentPart + line + "\n").length > maxLength) {
      if (currentPart) {
        parts.push(currentPart.trim());
        currentPart = "";
      }
      // Nếu một dòng quá dài, chia nhỏ nó
      if (line.length > maxLength) {
        const chunks = line.match(new RegExp(`.{1,${maxLength}}`, "g")) || [];
        parts.push(...chunks);
        continue;
      }
    }
    currentPart += line + "\n";
  }

  if (currentPart) {
    parts.push(currentPart.trim());
  }

  return parts;
}

export async function listCommands(api, message, args = [], options = {}) {
  const senderId = message.data.uidFrom;
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const commandConfig = getCommandConfig();
  const catalogCommands = enrichCommandList(commandConfig?.commands || []);

  const command = args[0]?.toLowerCase();
  const subCommand = args[1]?.toLowerCase();

  const commandHandlers = {
    async find() {
      const searchTerm = args.slice(1).join(" ").toLowerCase();
      if (!searchTerm) {
        return {
          msg: `⚠️ Vui lòng nhập từ khóa để tìm kiếm!\nVí dụ: ${prefix}cmd find thời tiết`,
          ttl: 30000,
        };
      }

      const searchResults = catalogCommands.filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(searchTerm) ||
          cmd.description.toLowerCase().includes(searchTerm) ||
          (cmd.alias &&
            cmd.alias.some((alias) => alias.toLowerCase().includes(searchTerm)))
      );

      if (searchResults.length === 0) {
        return {
          msg: `❌ Không tìm thấy lệnh nào liên quan đến từ khóa "${searchTerm}"`,
          ttl: 30000,
        };
      }

      let responseMsg = `🔍 Kết quả tìm kiếm cho "${searchTerm}":\n\n`;
      let positions = [];

      searchResults.forEach((rawCmd, index) => {
        const cmd = enrichCommandMetadata(rawCmd);
        const startPos = responseMsg.length;
        responseMsg += `${index + 1}. ⭐ Lệnh: ${cmd.name}\n`;
        positions.push({ pos: startPos, len: cmd.name.length + 11 });

        responseMsg += `   📝 Mô tả: ${cmd.description}\n`;
        responseMsg += `   💡 Cú pháp: ${String(cmd.syntax || `{p}${cmd.name}`).replaceAll("{p}", prefix)}\n`;
        if (cmd.alias?.length) {
          responseMsg += `   🔖 Tên gọi khác: ${cmd.alias.join(", ")}\n`;
        }
        responseMsg += `   🔒 Quyền hạn: ${getPermissionName(
          cmd.permission
        )}\n`;
        responseMsg += `   ⏱️ Countdown: ${cmd.countdown} giây\n\n`;
      });

      let style = null;
      if (searchResults.length < 5) {
        style = MultiMsgStyle(
          positions.map(({ pos, len }) =>
            MessageStyle(pos, len, COLOR_GREEN, SIZE_18, IS_BOLD)
          )
        );
      }
      return {
        msg: responseMsg,
        style: style,
        ttl: 60000,
      };
    },

    // Tải lại cấu hình lệnh (chỉ dành cho Admin cấp cao)
    async load() {
      if (!options?.isAdminLevelHighest && !isMainBotAdmin(senderId)) {
        return {
          msg: `❌ ${formatPermissionDenied("adminLevelHigh")}`,
          ttl: 30000,
        };
      }

      const commandConfigNew = reloadCommandConfig();
      invalidateRuntimePolicyCache();
      const reloadedCatalog = enrichCommandList(commandConfigNew?.commands || []);
      const allCommands = reloadedCatalog.filter(
        (cmd) => cmd.permission === "all"
      );
      const adminCommands = reloadedCatalog.filter((cmd) =>
        ["adminBox", "adminBot", "adminLevelHigh"].includes(cmd.permission)
      );

      const statsMessage = [
        "📊 Reload Thành Công Lệnh Bot:\n",
        `👥 Lệnh cho thành viên: ${allCommands.length} lệnh`,
        `👑 Lệnh cho admin: ${adminCommands.length} lệnh`,
        `📝 Tổng số lệnh: ${reloadedCatalog.length} lệnh`,
      ].join("\n");

      return { msg: statsMessage, ttl: 300000 };
    },

    async map() {
      const isAdminMap = subCommand === "admin";
      const filteredCommands = catalogCommands
        .filter((cmd) =>
          isAdminMap
            ? ["adminBox", "adminBot", "adminLevelHigh"].includes(
              cmd.permission
            )
            : cmd.permission === "all"
        )
        .map((cmd) => ({
          name: cmd.name,
          description: cmd.description,
          permission: cmd.permission,
        }));

      const title = isAdminMap ? "Admin" : "Thành Viên";
      let responseMsg = `🔍 Liệt Kê Toàn Bộ Lệnh ${title}:\n\n`;

      filteredCommands.forEach((cmd, index) => {
        responseMsg += `${index + 1}. ${cmd.name}: ${cmd.description}\n`;
      });

      return {
        msg: responseMsg,
        ttl: 300000,
      };
    },

    async default() {
      const isAdminRequest = command === "admin";
      const pageNumber = parseInt(args[isAdminRequest ? 1 : 0]) || 1;

      const filteredCommands = catalogCommands.filter((cmd) =>
        isAdminRequest
          ? ["adminBox", "adminBot", "adminLevelHigh"].includes(cmd.permission)
          : cmd.permission === "all"
      );

      const totalPages = Math.max(1, Math.ceil(filteredCommands.length / COMMANDS_PER_PAGE));
      const safePage = Math.min(Math.max(pageNumber, 1), totalPages);
      const startIndex = (safePage - 1) * COMMANDS_PER_PAGE;
      const endIndex = startIndex + COMMANDS_PER_PAGE;
      const commandsToShow = filteredCommands.slice(startIndex, endIndex);

      const buildTextFallback = () => {
        let msgText = isAdminRequest
          ? "👑 Danh sách lệnh Admin:\n\n"
          : "📜 Danh sách lệnh:\n\n";
        const positions = [];

        commandsToShow.forEach((cmd, index) => {
          const startPos = msgText.length + 11;
          msgText += `${index + 1 + startIndex}. ⭐ Lệnh: ${cmd.name}\n`;
          positions.push({ pos: startPos, len: cmd.name.length + 1 });

          msgText += `   📝 Mô Tả: ${cmd.description}\n`;
          if (cmd.permission !== "all") {
            msgText += `   🔒 Quyền Hạn: ${getPermissionName(cmd.permission)}\n`;
          }
          msgText += `   ⏱️ Countdown: ${cmd.countdown} Giây\n\n`;
        });

        msgText += [
          `📄 Trang ${safePage}/${totalPages}`,
          `💡 Dùng ${prefix}cmd ${isAdminRequest ? "admin " : ""}[số trang] để xem các trang khác.`,
          `ℹ️ Dùng ${prefix}cmd map ${isAdminRequest ? "admin " : ""}để xem toàn bộ lệnh dành cho ${isAdminRequest ? "admin" : "thành viên"}.`,
        ].join("\n");

        const style = MultiMsgStyle(
          positions.map(({ pos, len }) =>
            MessageStyle(pos, len, COLOR_GREEN, SIZE_18, IS_BOLD)
          )
        );

        return { msg: msgText, style };
      };

      let imagePath = null;
      let imageRenderFailed = false;
      try {
        imagePath = await renderCommandListImage({
          pageCommands: commandsToShow,
          page: safePage,
          totalPages,
          totalCommands: filteredCommands.length,
          isAdminList: isAdminRequest,
          botName: safeGetBotName(),
          prefix,
        });
      } catch (renderError) {
        console.error("[!cmd] render image failed, fallback to text:", renderError);
        imageRenderFailed = true;
      }

      if (imagePath && !imageRenderFailed) {
        return {
          kind: "image",
          imagePath,
          caption: `📄 Trang ${safePage}/${totalPages}`,
          ttl: 180000,
          fallback: buildTextFallback(),
        };
      }

      const text = buildTextFallback();
      return { kind: "text", msg: text.msg, style: text.style, ttl: 180000 };
    },
  };

  const handler = commandHandlers[command] || commandHandlers.default;
  let response;
  let imagePath = null;
  try {
    response = await handler();
  } catch (handlerError) {
    console.error("Lỗi khi xử lý danh sách lệnh:", handlerError);
    try {
      await api.sendMessage(
        {
          msg: "⚠️ Không thể hiển thị danh sách lệnh do lỗi xử lý. Vui lòng thử lại sau.",
          ttl: 30000,
        },
        threadId,
        message.type
      );
    } catch (fallbackError) {
      console.error("Lỗi khi gửi tin nhắn fallback danh sách lệnh:", fallbackError);
    }
    return;
  }

  if (response?.kind === "image" && response.imagePath) {
    imagePath = response.imagePath;
    try {
      await api.sendMessage(
        {
          msg: response.caption || "",
          attachments: [response.imagePath],
          quote: message,
          ttl: response.ttl,
        },
        threadId,
        message.type
      );
      return;
    } catch (imageError) {
      console.error("Lỗi khi gửi ảnh danh sách lệnh, fallback text:", imageError);
      const fallback = response.fallback || { msg: "", style: null };
      const parts = splitMessage(fallback.msg || "");
      for (let i = 0; i < parts.length; i++) {
        await api.sendMessage(
          {
            msg: parts[i],
            style: i === 0 ? fallback.style || null : null,
            quote: i === 0 ? message : null,
            ttl: response.ttl,
          },
          threadId,
          message.type
        );
      }
      return;
    } finally {
      if (imagePath) {
        await deleteFile(imagePath);
      }
    }
  }

  try {
    const messageParts = splitMessage(response.msg);

    for (let i = 0; i < messageParts.length; i++) {
      const part = messageParts[i];
      const messageStyle = i === 0 ? response.style : null;

      await api.sendMessage(
        {
          msg: part,
          style: messageStyle,
          quote: i === 0 ? message : null,
          ttl: response.ttl,
        },
        threadId,
        message.type
      );
    }
  } catch (error) {
    console.error("Lỗi khi gửi tin nhắn danh sách lệnh:", error);
    try {
      await api.sendMessage(
        {
          msg: "⚠️ Không thể gửi danh sách lệnh do lỗi kết nối. Vui lòng thử lại sau.",
          ttl: 30000,
        },
        threadId,
        message.type
      );
    } catch (fallbackError) {
      console.error("Lỗi khi gửi tin nhắn fallback danh sách lệnh:", fallbackError);
    }
  }
}

function getPermissionName(permission) {
  return getRoleLabel(permission);
}

function safeGetBotName() {
  try {
    return getBotName() || "";
  } catch {
    return "";
  }
}

