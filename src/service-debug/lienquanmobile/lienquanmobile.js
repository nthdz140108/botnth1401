import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import { sendMessageFactory } from "../../api-zalo/apis/sendMessage.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { nameServer } from "../../utils/server-config.js";
import { tempDir } from "../../utils/io-json.js";
import { getGlobalPrefix } from "../service.js";

const cacheFile = path.resolve(
  "./src/service-debug/lienquanmobile/cache.json",
);
const userSkinSessions = new Map();

const getCleanNameServer = () => {
  const lines = nameServer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line);
  const tagLine = lines.find((line) => line.startsWith("@"));
  const boldLine = lines.find(
    (line) => /\*\*(.*?)\*\*/.test(line) || /__(.*?)__/.test(line),
  );
  return [tagLine, boldLine].filter(Boolean).join(" ") + "\n";
};

export const des = {
  name: "lienquanmobile",
  type: 1,
  permission: "all",
  countdown: 3,
  active: true,
};

export async function handlerLienquanmobileCommand(api, message) {
  const sendMessage = sendMessageFactory(api);
  const threadId = message.threadId;
  const threadType = message.type ?? MessageType.DirectMessage;
  const uid = message.data.uidFrom;
  const content = message.data.content.trim();
  const prefix = getGlobalPrefix();
  const command = `${prefix}lienquanmobile`;

  if (!content.toLowerCase().startsWith(command.toLowerCase())) {
    return await checkSkinReply(api, message);
  }

  const args = content.slice(command.length).trim().split(/\s+/).filter(Boolean);
  const keyword = args.join(" ").toLowerCase();

  if (!keyword) {
    return sendMessage(
      {
        msg: `${getCleanNameServer()}❌ Vui lòng nhập tên tướng. Ví dụ: ${prefix}lienquanmobile yue`,
      },
      threadId,
      threadType,
    );
  }

  try {
    const raw = await fs.readFile(cacheFile, "utf-8");
    const cache = JSON.parse(raw);
    const data = cache[keyword];

    if (!data || !data.data?.hero) {
      return sendMessage(
        {
          msg: `${getCleanNameServer()}❌ Không tìm thấy tướng "${keyword}" trong dữ liệu cache.`,
        },
        threadId,
        threadType,
      );
    }

    const { hero, skins } = data.data;
    let msg = `${getCleanNameServer()}🎮 Tướng: ${hero.name}\n\n🎨 Danh sách skin:\n`;
    skins.forEach((skin, i) => {
      msg += `  ${i + 1}. ${skin.name}\n`;
    });
    msg += `\n📌 Hãy trả lời bằng số thứ tự để xem ảnh skin.`;

    userSkinSessions.set(uid, { skins, hero });

    return sendMessage({ msg }, threadId, threadType);
  } catch (e) {
    console.error("[LQM] Cache read error:", e);
    return sendMessage(
      {
        msg: `${getCleanNameServer()}❌ Lỗi khi đọc dữ liệu cache.`,
      },
      threadId,
      threadType,
    );
  }
}

export async function checkSkinReply(api, message) {
  const sendMessage = sendMessageFactory(api);
  const uid = message.data.uidFrom;
  const threadId = message.threadId;
  const threadType = message.type ?? MessageType.DirectMessage;
  const content = message.data.content.trim();

  const session = userSkinSessions.get(uid);
  if (!session) return false;

  const number = parseInt(content, 10);
  if (isNaN(number)) return false;

  const skin = session.skins[number - 1];
  if (!skin) {
    return sendMessage(
      {
        msg: `${getCleanNameServer()}❌ Số không hợp lệ!`,
      },
      threadId,
      threadType,
    );
  }

  let tmpPath = null;
  try {
    const res = await fetch(skin.cover);
    const buffer = await res.buffer();
    await fs.mkdir(tempDir, { recursive: true });
    tmpPath = path.join(tempDir, `lqm_skin_${uid}_${Date.now()}.jpg`);
    await fs.writeFile(tmpPath, buffer);

    userSkinSessions.delete(uid);

    return await sendMessage(
      {
        msg: `🖼️ Skin: ${skin.name}`,
        attachments: [tmpPath],
      },
      threadId,
      threadType,
    );
  } catch (err) {
    console.error("[LQM] Error fetching image:", err);
    return sendMessage(
      {
        msg: `${getCleanNameServer()}❌ Lỗi khi tải ảnh skin.`,
      },
      threadId,
      threadType,
    );
  } finally {
    if (tmpPath) {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}
