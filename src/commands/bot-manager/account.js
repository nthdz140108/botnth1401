import path from "node:path";
import { isAdmin } from "../../utils/role-policy.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { sendMessageComplete, sendMessageFailed, sendMessageQuery, sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getContent } from "../../utils/format-util.js";
import { tempDir } from "../../utils/io-json.js";
import { downloadFile, deleteFile } from "../../utils/util.js";

const AVATAR_COMMAND_ALIASES = new Set([
  "setavatar-account",
  "setavataraccount",
  "setavtacc",
  "setavt",
  "changeavatar",
]);

function extractAvatarSourceFromQuote(rawAttach) {
  if (!rawAttach) return { url: "", localPath: "" };
  if (typeof rawAttach === "object") {
    const url = String(rawAttach.hdUrl || rawAttach.href || rawAttach.normalUrl || rawAttach.thumbUrl || "").trim();
    return { url, localPath: "" };
  }
  const str = String(rawAttach).trim();
  if (!str) return { url: "", localPath: "" };
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === "object") {
      const url = String(parsed.hdUrl || parsed.href || parsed.normalUrl || parsed.thumbUrl || "").trim();
      return { url, localPath: "" };
    }
  } catch {
    // Not a JSON string; fall through to URL / local path handling
  }
  if (/^https?:\/\//i.test(str)) {
    return { url: str, localPath: "" };
  }
  return { url: "", localPath: str };
}

export async function handleRenameCommand(api, message, aliasCommand = "name") {
  const senderId = message.data?.uidFrom || message.senderID;
  if (!isAdmin(senderId)) {
    await sendMessageFailed(api, message, "Tuổi cặc đổi tên tao!", false, 10000);
    return true;
  }

  if (aliasCommand === "myaccount" || aliasCommand === "myacc") {
    try {
      const botId = await api.getBotId?.();
      const userInfo = botId ? await getUserInfoData(api, botId) : null;
      const caption = userInfo
        ? `Thông tin tài khoản bot:\n- Tên: ${userInfo.name || "Không xác định"}\n- UID: ${botId}`
        : `Không lấy được thông tin tài khoản bot, nhưng lệnh đã được nhận diện đúng.`;
      await sendMessageComplete(api, message, caption);
    } catch (error) {
      await sendMessageWarning(api, message, `Không thể đọc thông tin tài khoản: ${error.message}`, false, 10000);
    }
    return true;
  }

  if (aliasCommand === "mysetting") {
    await sendMessageComplete(api, message, "HHH đang dùng cấu hình tài khoản từ dashboard và provider service. Dùng !setaccount để đổi tên bot, hoặc !setavatar-account để đổi avatar nếu API hỗ trợ.");
    return true;
  }

  if (AVATAR_COMMAND_ALIASES.has(aliasCommand)) {
    if (typeof api.changeAccountAvatar !== "function") {
      await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ đổi avatar tài khoản.", false, 10000);
      return true;
    }
    const quote = message.data?.quote;
    const attachment = quote?.attach ? quote.attach : null;
    if (!attachment) {
      await sendMessageQuery(api, message, "Vui lòng reply một ảnh để đặt avatar tài khoản.");
      return true;
    }
    const { url, localPath } = extractAvatarSourceFromQuote(attachment);
    if (!url && !localPath) {
      await sendMessageQuery(api, message, "Không tìm thấy đường dẫn ảnh hợp lệ trong tin nhắn được reply.");
      return true;
    }
    let downloadedTempPath = null;
    try {
      let avatarFilePath = localPath;
      if (url) {
        const destPath = path.join(tempDir, `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
        downloadedTempPath = await downloadFile(url, destPath, { timeout: 30000 });
        avatarFilePath = downloadedTempPath;
      }
      await api.changeAccountAvatar(avatarFilePath);
      await sendMessageComplete(api, message, "Đã cập nhật avatar tài khoản bot.");
    } catch (error) {
      await sendMessageFailed(api, message, `Đổi avatar thất bại: ${error.message}`);
    } finally {
      if (downloadedTempPath) {
        await deleteFile(downloadedTempPath);
      }
    }
    return true;
  }

  const content = getContent(message);
  const args = content.split(" ");
  args.shift();
  const newName = args.join(" ").trim();
  if (!newName) {
    await sendMessageQuery(api, message, "Vui lòng nhập tên mới để đổi!");
    return true;
  }
  const defaultDob = "2002-12-06";
  const defaultGender = 0;
  try {
    const transformedName = newName.toUpperCase();
    await api.changeAccountSetting(transformedName, defaultDob, defaultGender);
    await sendMessageComplete(api, message, `Đã đổi tên bot thành: ${transformedName}`);
  } catch (err) {
    console.error(err);
    await sendMessageFailed(api, message, `Đổi tên thất bại: ${err.message}`);
  }
  return true;
}
