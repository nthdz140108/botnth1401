import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import fetch from "node-fetch";
import { getInternalSecret } from "../../commands/mybot/System/mybot-command-relay.js";
import { writeReloadRequest } from "../../commands/mybot/System/reload-request.js";

export const CANONICAL_SHIELDS = Object.freeze([
  // Core operational switches
  {
    key: "activeBot",
    aliases: ["enableBot"],
    category: "core",
    label: "Bật Bot hoạt động trong nhóm",
    description: "Cho phép Bot lắng nghe và phản hồi lệnh trong Box này (đồng bộ activeBot ⇄ enableBot).",
    icon: "power",
  },
  {
    key: "onlyAdminBox",
    aliases: [],
    category: "core",
    label: "Chỉ Quản trị viên nhóm dùng Bot",
    description: "Giới hạn thành viên thường gọi lệnh giải trí gây loãng hội thoại nhóm.",
    icon: "shield-user",
  },
  {
    key: "sendTask",
    aliases: [],
    category: "core",
    label: "Lịch tự động mỗi giờ (SendTask)",
    description: "Tự động phát tin nhắn chúc, nhạc, ảnh/video theo khung giờ cài đặt.",
    icon: "clock",
  },
  {
    key: "enableSetup",
    aliases: [],
    category: "core",
    label: "Thẻ Chào mừng & Tạm biệt",
    description: "Tự động gửi thiệp chào đón thành viên mới và thông báo khi có người rời nhóm.",
    icon: "sparkles",
  },
  {
    key: "learnEnabled",
    aliases: [],
    category: "core",
    label: "Cho phép Bot học câu trả lời",
    description: "Học từ điển hội thoại hỏi - đáp riêng theo ngữ cảnh của từng nhóm.",
    icon: "book-open",
  },
  {
    key: "replyEnabled",
    aliases: [],
    category: "core",
    label: "Tự động trả lời từ khóa thông minh",
    description: "Phản hồi tự động khi tin nhắn thành viên khớp từ khóa đã dạy cho Bot.",
    icon: "message-circle",
  },

  // Anti-Moderation Shields
  {
    key: "antiSpam",
    aliases: [],
    category: "anti",
    label: "Chống Spam tin nhắn liên tục",
    description: "Phát hiện xả tin tốc độ cao và tự động nhắc nhở, cấm chat hoặc mời ra khỏi nhóm.",
    icon: "zap-off",
  },
  {
    key: "filterBadWords",
    aliases: [],
    category: "anti",
    label: "Lọc & thu hồi từ ngữ thô tục",
    description: "Tự động xóa câu chửi thề, ngôn từ vi phạm theo bộ từ khóa của nhóm.",
    icon: "message-square-off",
  },
  {
    key: "removeLinks",
    aliases: ["antiLink"],
    category: "anti",
    label: "Chặn & xóa liên kết lạ (Anti-Link)",
    description: "Tự động thu hồi đường dẫn ngoài danh sách tên miền trắng (đồng bộ removeLinks ⇄ antiLink).",
    icon: "link-2-off",
  },
  {
    key: "antiUndo",
    aliases: [],
    category: "anti",
    label: "Chống thu hồi tin nhắn (Anti-Undo)",
    description: "Ghi nhận và hiển thị lại nội dung tin nhắn vừa bị thành viên thu hồi.",
    icon: "rotate-ccw",
  },
  {
    key: "antiMedia",
    aliases: [],
    category: "anti",
    label: "Kiểm soát xả Ảnh / Video rác",
    description: "Ngăn hành vi gửi ảnh, video liên hoàn gây trôi tin và giật lag nhóm.",
    icon: "image-off",
  },
  {
    key: "antiSticker",
    aliases: [],
    category: "anti",
    label: "Chống xả Sticker liên tục",
    description: "Giới hạn tần suất gửi nhãn dán hàng loạt trong thời gian ngắn.",
    icon: "smile-plus",
  },
  {
    key: "antiMention",
    aliases: [],
    category: "anti",
    label: "Chống Tag tất cả (@All)",
    description: "Chặn thành viên thường lạm dụng @All làm phiền toàn bộ thành viên nhóm.",
    icon: "at-sign",
  },
  {
    key: "antiNude",
    aliases: [],
    category: "anti",
    label: "Chặn hình ảnh nhạy cảm (Anti-NSFW)",
    description: "Quét và thu hồi hình ảnh đồi trụy, nhạy cảm vi phạm tiêu chuẩn cộng đồng.",
    icon: "eye-off",
  },
  {
    key: "antiForward",
    aliases: [],
    category: "anti",
    label: "Chặn chuyển tiếp tin nhắn hàng loạt",
    description: "Ngăn tin nhắn quảng cáo forward dây chuyền từ các hội nhóm khác.",
    icon: "forward",
  },
  {
    key: "antiVoice",
    aliases: [],
    category: "anti",
    label: "Hạn chế tin nhắn thoại (Anti-Voice)",
    description: "Kiểm soát việc gửi ghi âm spam gây ồn hoặc gián đoạn thảo luận.",
    icon: "mic-off",
  },
  {
    key: "antiText",
    aliases: [],
    category: "anti",
    label: "Chống văn bản dội bom (Flood Text)",
    description: "Ngăn văn bản quá dài, ký tự đặc biệt gây đứng khung chat Zalo.",
    icon: "file-text",
  },
  {
    key: "antiFile",
    aliases: [],
    category: "anti",
    label: "Chặn tệp đính kèm độc hại",
    description: "Chặn phát tán tệp lạ (.apk, .exe, .bat, .scr, .zip) có nguy cơ chứa mã độc.",
    icon: "file-warning",
  },
  {
    key: "antiCard",
    aliases: [],
    category: "anti",
    label: "Chặn gửi danh thiếp quảng cáo",
    description: "Ngăn rải danh thiếp Zalo cá nhân/OA để lôi kéo khách hàng trái phép.",
    icon: "contact",
  },
  {
    key: "antiBot",
    aliases: [],
    category: "anti",
    label: "Chống Bot lạ trà trộn (Anti-Bot)",
    description: "Phát hiện tài khoản tự động trái phép hoạt động chồng chéo trong nhóm.",
    icon: "bot-off",
  },
  {
    key: "antiJoinLeave",
    aliases: [],
    category: "anti",
    label: "Kiểm soát ra / vào nhóm liên tục",
    description: "Chặn tài khoản ảo vào rồi thoát nhóm lặp lại để quấy rối thông báo.",
    icon: "user-x",
  },
  {
    key: "antiKickBlock",
    aliases: [],
    category: "anti",
    label: "Bảo vệ chống Kick phá hoại",
    description: "Giám sát và ngăn chặn hành vi Phó nhóm kick thành viên hàng loạt bất thường.",
    icon: "shield-alert",
  },
  {
    key: "antiPoll",
    aliases: [],
    category: "anti",
    label: "Chặn tạo bình chọn rác (Anti-Poll)",
    description: "Ngăn thành viên tự ý ghim hoặc tạo khảo sát gây nhiễu thông báo nhóm.",
    icon: "bar-chart-2",
  },
  {
    key: "onlyText",
    aliases: [],
    category: "anti",
    label: "Chế độ Chỉ Văn Bản (Only-Text)",
    description: "Chỉ cho phép trao đổi bằng chữ thuần túy, tạm khóa đa phương tiện.",
    icon: "align-left",
  },
]);

const SHIELD_KEY_SET = new Set(CANONICAL_SHIELDS.map((item) => item.key));

export const DEFAULT_GROUP_RULES = Object.freeze({
  badWords: [],
  whitelistedDomains: [],
  spamPolicy: Object.freeze({
    maxMessages: 6,
    windowSec: 4,
    action: "warn_then_mute",
  }),
  welcomeTemplate: "",
  goodbyeTemplate: "",
  nightMode: Object.freeze({
    enabled: false,
    startHour: 23,
    endHour: 6,
  }),
});

export const BUILTIN_SHIELD_PRESETS = Object.freeze([
  {
    id: "strict_security",
    name: "An Ninh Tối Đa (Chống Phá Hoại)",
    description: "Bật toàn diện các khiên chống spam, link lạ, tệp độc hại, @All, danh thiếp và chống kick phá hoại.",
    builtin: true,
    badge: "strict",
    settings: normalizeUnifiedGroupSettings({
      activeBot: true,
      onlyAdminBox: true,
      sendTask: false,
      enableSetup: true,
      learnEnabled: false,
      replyEnabled: false,
      antiSpam: true,
      filterBadWords: true,
      removeLinks: true,
      antiUndo: true,
      antiMedia: false,
      antiSticker: true,
      antiMention: true,
      antiNude: true,
      antiForward: true,
      antiVoice: false,
      antiText: true,
      antiFile: true,
      antiCard: true,
      antiBot: true,
      antiJoinLeave: true,
      antiKickBlock: true,
      antiPoll: true,
      onlyText: false,
    }),
  },
  {
    id: "community_fun",
    name: "Cộng Đồng Sôi Nổi & Giải Trí",
    description: "Mở tương tác tự do cho thành viên, bật SendTask, lời chào mừng, học & trả lời tự động kèm lọc cơ bản.",
    builtin: true,
    badge: "community",
    settings: normalizeUnifiedGroupSettings({
      activeBot: true,
      onlyAdminBox: false,
      sendTask: true,
      enableSetup: true,
      learnEnabled: true,
      replyEnabled: true,
      antiSpam: true,
      filterBadWords: true,
      removeLinks: false,
      antiUndo: false,
      antiMedia: false,
      antiSticker: false,
      antiMention: false,
      antiNude: true,
      antiForward: false,
      antiVoice: false,
      antiText: false,
      antiFile: true,
      antiCard: false,
      antiBot: false,
      antiJoinLeave: false,
      antiKickBlock: true,
      antiPoll: false,
      onlyText: false,
    }),
  },
  {
    id: "commerce_shop",
    name: "Nhóm Bán Hàng / CSKH VIP",
    description: "Chống cướp khách: chặn rải link, danh thiếp, chuyển tiếp, @All và chỉ cho phép Admin dùng lệnh Bot.",
    builtin: true,
    badge: "commerce",
    settings: normalizeUnifiedGroupSettings({
      activeBot: true,
      onlyAdminBox: true,
      sendTask: false,
      enableSetup: true,
      learnEnabled: false,
      replyEnabled: true,
      antiSpam: true,
      filterBadWords: true,
      removeLinks: true,
      antiUndo: false,
      antiMedia: false,
      antiSticker: true,
      antiMention: true,
      antiNude: true,
      antiForward: true,
      antiVoice: true,
      antiText: true,
      antiFile: true,
      antiCard: true,
      antiBot: true,
      antiJoinLeave: true,
      antiKickBlock: true,
      antiPoll: true,
      onlyText: false,
    }),
  },
  {
    id: "night_lockdown",
    name: "Khóa Đêm Yên Tĩnh (Lockdown)",
    description: "Chế độ giới nghiêm ban đêm: chỉ nhận văn bản cần thiết, khóa media/sticker/voice/link và tắt SendTask.",
    builtin: true,
    badge: "lockdown",
    settings: normalizeUnifiedGroupSettings({
      activeBot: true,
      onlyAdminBox: true,
      sendTask: false,
      enableSetup: false,
      learnEnabled: false,
      replyEnabled: false,
      antiSpam: true,
      filterBadWords: true,
      removeLinks: true,
      antiUndo: false,
      antiMedia: true,
      antiSticker: true,
      antiMention: true,
      antiNude: true,
      antiForward: true,
      antiVoice: true,
      antiText: true,
      antiFile: true,
      antiCard: true,
      antiBot: true,
      antiJoinLeave: true,
      antiKickBlock: true,
      antiPoll: true,
      onlyText: true,
    }),
  },
]);

/**
 * Keeps V3 runtime (`activeBot`, `removeLinks`), V4 UI (`enableBot`, `antiLink`),
 * and V5 Shield Intelligence 100% synchronized in every group entry.
 */
export function normalizeUnifiedGroupSettings(raw = {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};

  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== "function") {
      out[k] = v;
    }
  }

  for (const item of CANONICAL_SHIELDS) {
    if (item.key === "activeBot" || item.key === "removeLinks") continue;
    out[item.key] = Boolean(src[item.key]);
  }

  const active = src.activeBot !== undefined ? Boolean(src.activeBot) : Boolean(src.enableBot);
  out.activeBot = active;
  out.enableBot = active;

  const blockLinks = src.removeLinks !== undefined ? Boolean(src.removeLinks) : Boolean(src.antiLink);
  out.removeLinks = blockLinks;
  out.antiLink = blockLinks;

  return out;
}

function mergeUnifiedGroupSettings(prev = {}, patch = {}) {
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  const incoming = patch && typeof patch === "object" ? { ...patch } : {};

  if (incoming.activeBot === undefined && incoming.enableBot !== undefined) {
    incoming.activeBot = Boolean(incoming.enableBot);
  } else if (incoming.enableBot === undefined && incoming.activeBot !== undefined) {
    incoming.enableBot = Boolean(incoming.activeBot);
  }

  if (incoming.removeLinks === undefined && incoming.antiLink !== undefined) {
    incoming.removeLinks = Boolean(incoming.antiLink);
  } else if (incoming.antiLink === undefined && incoming.removeLinks !== undefined) {
    incoming.antiLink = Boolean(incoming.removeLinks);
  }

  return normalizeUnifiedGroupSettings({ ...base, ...incoming });
}

function normalizeRulesObject(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const badWords = Array.isArray(src.badWords)
    ? [...new Set(src.badWords.map((w) => String(w || "").trim()).filter(Boolean))].slice(0, 500)
    : [];
  const whitelistedDomains = Array.isArray(src.whitelistedDomains)
    ? [
        ...new Set(
          src.whitelistedDomains
            .map((d) => String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
            .filter(Boolean)
        ),
      ].slice(0, 300)
    : [];

  const validActions = new Set(["warn", "mute", "warn_then_mute", "kick"]);
  const rawSpam = src.spamPolicy && typeof src.spamPolicy === "object" ? src.spamPolicy : {};
  const maxMessages = Math.max(2, Math.min(100, Number(rawSpam.maxMessages ?? DEFAULT_GROUP_RULES.spamPolicy.maxMessages) || 6));
  const windowSec = Math.max(1, Math.min(120, Number(rawSpam.windowSec ?? DEFAULT_GROUP_RULES.spamPolicy.windowSec) || 4));
  const action = validActions.has(String(rawSpam.action || ""))
    ? String(rawSpam.action)
    : DEFAULT_GROUP_RULES.spamPolicy.action;

  const rawNight = src.nightMode && typeof src.nightMode === "object" ? src.nightMode : {};
  const startHour = Math.max(0, Math.min(23, Math.floor(Number(rawNight.startHour ?? 23) || 0)));
  const endHour = Math.max(0, Math.min(23, Math.floor(Number(rawNight.endHour ?? 6) || 0)));

  return {
    badWords,
    whitelistedDomains,
    spamPolicy: {
      maxMessages,
      windowSec,
      action,
    },
    welcomeTemplate: String(src.welcomeTemplate ?? "").slice(0, 2000),
    goodbyeTemplate: String(src.goodbyeTemplate ?? "").slice(0, 2000),
    nightMode: {
      enabled: Boolean(rawNight.enabled),
      startHour,
      endHour,
    },
  };
}

function assertSafeId(value, label = "id") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("..") ||
    /[\\/\0]/.test(value) ||
    !/^[a-zA-Z0-9._-]+$/.test(value)
  ) {
    const err = new Error(`Mã ${label} không hợp lệ.`);
    err.status = 400;
    err.code = `INVALID_${label.toUpperCase()}`;
    throw err;
  }
}

async function readJsonSafe(filePath, fallback = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
}

function unwrapStoreDocs(rawList) {
  if (!rawList) return [];
  if (Array.isArray(rawList)) {
    return rawList
      .map((item) => {
        if (item && typeof item === "object" && "value" in item && ("key" in item || "namespace" in item)) {
          return item.value;
        }
        return item;
      })
      .filter(Boolean);
  }
  if (typeof rawList === "object") {
    return Object.values(rawList).filter(Boolean);
  }
  return [];
}

function probeLoopbackPort(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const numericPort = Number(port);
    if (!Number.isFinite(numericPort) || numericPort <= 0) {
      resolve(false);
      return;
    }
    const sock = net.createConnection({ host: "127.0.0.1", port: numericPort });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

export class ShieldIntelligenceService {
  constructor({
    root = process.cwd(),
    store,
    registry = null,
    configStore = null,
    auditStore = null,
    getIo = () => null,
  } = {}) {
    this.root = path.resolve(root);
    this.store = store;
    this.registry = registry;
    this.configStore = configStore;
    this.auditStore = auditStore;
    this.getIo = getIo;
  }

  getCatalog() {
    return {
      total: CANONICAL_SHIELDS.length,
      coreCount: CANONICAL_SHIELDS.filter((s) => s.category === "core").length,
      antiCount: CANONICAL_SHIELDS.filter((s) => s.category === "anti").length,
      shields: CANONICAL_SHIELDS,
      defaultRules: DEFAULT_GROUP_RULES,
    };
  }

  async #resolveBotAndSettingsPath(botId) {
    assertSafeId(botId, "botId");
    const bot = this.registry ? await this.registry.describe(botId).catch(() => null) : null;
    if (this.registry && !bot && botId !== "admin") {
      const err = new Error(`Không tìm thấy Bot '${botId}'.`);
      err.status = 404;
      err.code = "BOT_NOT_FOUND";
      throw err;
    }

    if (bot?.paths?.groupSettingsPath) {
      return { bot, gsPath: path.resolve(this.root, bot.paths.groupSettingsPath) };
    }
    if (botId === "admin") {
      return { bot, gsPath: path.join(this.root, "assets", "data", "group_settings.json") };
    }

    const botMetaPath = path.join(this.root, "mybot", "bots", `${botId}.json`);
    if (fsSync.existsSync(botMetaPath)) {
      const meta = await readJsonSafe(botMetaPath, {});
      if (meta?.groupSettingsPath) {
        return { bot, gsPath: path.resolve(this.root, meta.groupSettingsPath) };
      }
    }
    return { bot, gsPath: path.join(this.root, "mybot", "bots", `group_settings_${botId}.json`) };
  }

  async #writeGroupSettings(gsPath, nextData) {
    if (this.configStore?.writeJson) {
      await this.configStore.writeJson(gsPath, nextData);
    } else {
      await writeJsonAtomic(gsPath, nextData);
    }
  }

  async #fetchLiveGroups(bot, botId) {
    const liveGroups = new Map();
    if (!bot || bot.cookieDead) return { online: false, liveGroups };
    const fallbackAdminPort = botId === "admin" ? Number(process.env.WEB_PORT || 2000) : 0;
    const candidatePort = Number(bot.port || bot.webPort || fallbackAdminPort || 0);
    if (!Number.isFinite(candidatePort) || candidatePort <= 0) {
      return { online: false, liveGroups };
    }

    const reachable = bot.connected ? true : await probeLoopbackPort(candidatePort);
    if (!reachable) return { online: false, liveGroups };

    try {
      const secret = getInternalSecret({ projectRoot: this.root });
      const resp = await fetch(`http://127.0.0.1:${candidatePort}/internal/runtime/groups`, {
        headers: { "x-internal-secret": secret },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const payload = await resp.json().catch(() => ({}));
        for (const g of payload?.groups || []) {
          if (g?.threadId) liveGroups.set(String(g.threadId), g);
        }
        return { online: Boolean(payload?.online ?? true), liveGroups };
      }
    } catch {}
    return { online: false, liveGroups };
  }

  // ---------------------------------------------------------------------------
  // Shield Presets (Built-in + Custom)
  // ---------------------------------------------------------------------------
  async listPresets() {
    const rawCustom = await Promise.resolve(this.store?.listDocs?.("shield_presets"));
    const customList = unwrapStoreDocs(rawCustom).filter(
      (p) => p && typeof p === "object" && p.id && !BUILTIN_SHIELD_PRESETS.some((b) => b.id === p.id)
    );
    return [
      ...BUILTIN_SHIELD_PRESETS.map((p) => ({ ...p, settings: { ...p.settings } })),
      ...customList.map((p) => ({
        ...p,
        builtin: false,
        settings: normalizeUnifiedGroupSettings(p.settings || {}),
      })),
    ];
  }

  async savePreset(preset = {}) {
    if (!preset || typeof preset !== "object") {
      const err = new Error("Dữ liệu cấu hình Preset không hợp lệ.");
      err.status = 400;
      err.code = "INVALID_PRESET";
      throw err;
    }

    const name = String(preset.name || "").trim();
    if (!name) {
      const err = new Error("Vui lòng nhập tên cho Preset Khiên.");
      err.status = 400;
      err.code = "PRESET_NAME_REQUIRED";
      throw err;
    }

    const rawId = String(preset.id || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    const id = rawId || `preset_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 4)}`;
    assertSafeId(id, "presetId");

    if (BUILTIN_SHIELD_PRESETS.some((b) => b.id === id)) {
      const err = new Error("Không thể ghi đè Preset mặc định của hệ thống. Hãy tạo với mã mới.");
      err.status = 400;
      err.code = "BUILTIN_PRESET_IMMUTABLE";
      throw err;
    }

    const record = {
      id,
      name: name.slice(0, 120),
      description: String(preset.description || "").trim().slice(0, 500),
      badge: String(preset.badge || "custom").trim().slice(0, 32),
      builtin: false,
      settings: normalizeUnifiedGroupSettings(preset.settings || {}),
      updatedAt: new Date().toISOString(),
    };

    await Promise.resolve(this.store?.setDoc?.("shield_presets", id, record));
    return record;
  }

  async deletePreset(id) {
    assertSafeId(id, "presetId");
    if (BUILTIN_SHIELD_PRESETS.some((b) => b.id === id)) {
      const err = new Error("Không thể xóa Preset mặc định của hệ thống.");
      err.status = 400;
      err.code = "BUILTIN_PRESET_IMMUTABLE";
      throw err;
    }
    await Promise.resolve(this.store?.deleteDoc?.("shield_presets", id));
    return { id, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // Bulk Group Operations (Enable-All & Apply-Preset)
  // ---------------------------------------------------------------------------
  async enableAllGroups(botId, enabled = true) {
    const flag = Boolean(enabled);
    const { bot, gsPath } = await this.#resolveBotAndSettingsPath(botId);
    const savedMap = await readJsonSafe(gsPath, {});
    const nextMap = savedMap && typeof savedMap === "object" && !Array.isArray(savedMap) ? { ...savedMap } : {};
    const { online, liveGroups } = await this.#fetchLiveGroups(bot, botId);

    const allThreadIds = new Set([...Object.keys(nextMap), ...liveGroups.keys()]);
    const groups = [];

    for (const tid of allThreadIds) {
      if (!tid) continue;
      const live = liveGroups.get(tid);
      const prev = nextMap[tid] && typeof nextMap[tid] === "object" ? nextMap[tid] : {};
      const merged = mergeUnifiedGroupSettings(prev, {
        activeBot: flag,
        enableBot: flag,
      });
      if (live?.name && !merged.nameGroup) {
        merged.nameGroup = String(live.name);
      }
      if (live?.memberCount && !merged.memberCount) {
        merged.memberCount = Number(live.memberCount);
      }
      nextMap[tid] = merged;

      groups.push({
        threadId: tid,
        name: live?.name || merged.nameGroup || merged.name || `Nhóm ${tid}`,
        memberCount: Number(live?.memberCount || merged.memberCount || 0),
        avatar: live?.avatar || "",
        activeBot: merged.activeBot,
        enableBot: merged.enableBot,
        settings: merged,
      });
    }

    await this.#writeGroupSettings(gsPath, nextMap);

    try {
      writeReloadRequest(botId, { reloadType: "command-config" });
    } catch {}

    await this.auditStore?.append?.({
      action: "groups.enable_all",
      botId,
      enabled: flag,
      updatedCount: groups.length,
    });

    try {
      this.getIo?.()?.emit?.("dashboard:v5:shields", {
        type: "enable_all",
        botId,
        enabled: flag,
        updatedCount: groups.length,
      });
    } catch {}

    return {
      botId,
      enabled: flag,
      online,
      updatedCount: groups.length,
      groups,
    };
  }

  async applyPresetToGroups(botId, { presetId = "", customSettings = null, threadIds = [] } = {}) {
    const { bot, gsPath } = await this.#resolveBotAndSettingsPath(botId);

    let basePresetSettings = null;
    let resolvedPresetName = "Tùy chỉnh";
    if (presetId) {
      const presets = await this.listPresets();
      const found = presets.find((p) => p.id === presetId);
      if (!found) {
        const err = new Error(`Không tìm thấy Preset '${presetId}'.`);
        err.status = 404;
        err.code = "PRESET_NOT_FOUND";
        throw err;
      }
      basePresetSettings = found.settings;
      resolvedPresetName = found.name;
    }

    if (!basePresetSettings && (!customSettings || typeof customSettings !== "object")) {
      const err = new Error("Cần cung cấp presetId hoặc customSettings để áp dụng.");
      err.status = 400;
      err.code = "MISSING_PRESET_PAYLOAD";
      throw err;
    }

    const patchToApply = {};
    const combined = { ...(basePresetSettings || {}), ...(customSettings || {}) };
    for (const key of SHIELD_KEY_SET) {
      if (combined[key] !== undefined) {
        patchToApply[key] = Boolean(combined[key]);
      }
    }
    if (combined.enableBot !== undefined && patchToApply.activeBot === undefined) {
      patchToApply.activeBot = Boolean(combined.enableBot);
    }
    if (combined.antiLink !== undefined && patchToApply.removeLinks === undefined) {
      patchToApply.removeLinks = Boolean(combined.antiLink);
    }

    const savedMap = await readJsonSafe(gsPath, {});
    const nextMap = savedMap && typeof savedMap === "object" && !Array.isArray(savedMap) ? { ...savedMap } : {};
    const { online, liveGroups } = await this.#fetchLiveGroups(bot, botId);

    const requestedIds = Array.isArray(threadIds)
      ? [...new Set(threadIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];

    const targetIds =
      requestedIds.length > 0 && !requestedIds.includes("*")
        ? requestedIds
        : [...new Set([...Object.keys(nextMap), ...liveGroups.keys()])];

    for (const tid of targetIds) {
      assertSafeId(tid, "threadId");
      const live = liveGroups.get(tid);
      const prev = nextMap[tid] && typeof nextMap[tid] === "object" ? nextMap[tid] : {};
      const merged = mergeUnifiedGroupSettings(prev, patchToApply);
      if (live?.name && !merged.nameGroup) {
        merged.nameGroup = String(live.name);
      }
      nextMap[tid] = merged;
    }

    await this.#writeGroupSettings(gsPath, nextMap);

    try {
      writeReloadRequest(botId, { reloadType: "command-config" });
    } catch {}

    const opId = `op_shield_${Date.now().toString(36)}`;
    await Promise.resolve(
      this.store?.upsertOperation?.({
        id: opId,
        type: "shield.apply_preset",
        title: `Áp dụng khiên '${resolvedPresetName}' (${targetIds.length} nhóm)`,
        botId,
        status: "completed",
        progress: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).catch(() => {});

    await this.auditStore?.append?.({
      action: "groups.apply_preset",
      botId,
      presetId: presetId || "custom",
      updatedCount: targetIds.length,
    });

    return {
      botId,
      online,
      presetId: presetId || "custom",
      presetName: resolvedPresetName,
      updatedCount: targetIds.length,
      threadIds: targetIds,
      appliedSettings: normalizeUnifiedGroupSettings(patchToApply),
    };
  }

  // ---------------------------------------------------------------------------
  // Per-Group Deep Rules (Bad Words, Whitelisted Domains, Spam Policy, Templates, Night Mode)
  // ---------------------------------------------------------------------------
  async getGroupRules(botId, threadId) {
    const { gsPath } = await this.#resolveBotAndSettingsPath(botId);
    assertSafeId(String(threadId || ""), "threadId");
    const docKey = `${botId}:${threadId}`;

    const fromStore = await Promise.resolve(this.store?.getDoc?.("group_rules", docKey, null));
    if (fromStore && typeof fromStore === "object") {
      return {
        botId,
        threadId,
        rules: normalizeRulesObject(fromStore.rules || fromStore),
        updatedAt: fromStore.updatedAt || null,
      };
    }

    const allSettings = await readJsonSafe(gsPath, {});
    const savedRules = allSettings?.[threadId]?._v5Rules || {};
    return {
      botId,
      threadId,
      rules: normalizeRulesObject(savedRules),
      updatedAt: savedRules?.updatedAt || null,
    };
  }

  async updateGroupRules(botId, threadId, rules = {}) {
    const { gsPath } = await this.#resolveBotAndSettingsPath(botId);
    assertSafeId(String(threadId || ""), "threadId");

    const normalized = normalizeRulesObject(rules);
    const updatedAt = new Date().toISOString();
    const docKey = `${botId}:${threadId}`;

    await Promise.resolve(
      this.store?.setDoc?.("group_rules", docKey, {
        botId,
        threadId,
        rules: normalized,
        updatedAt,
      })
    );

    const allSettings = await readJsonSafe(gsPath, {});
    const nextMap = allSettings && typeof allSettings === "object" && !Array.isArray(allSettings) ? { ...allSettings } : {};
    const prevEntry = nextMap[threadId] && typeof nextMap[threadId] === "object" ? nextMap[threadId] : {};
    nextMap[threadId] = normalizeUnifiedGroupSettings({
      ...prevEntry,
      _v5Rules: {
        ...normalized,
        updatedAt,
      },
    });

    await this.#writeGroupSettings(gsPath, nextMap);

    try {
      writeReloadRequest(botId, { reloadType: "command-config" });
    } catch {}

    await this.auditStore?.append?.({
      action: "groups.rules.update",
      botId,
      threadId,
    });

    return {
      botId,
      threadId,
      rules: normalized,
      updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Violations & Global Blacklist Wrappers
  // ---------------------------------------------------------------------------
  async recordViolation(violation = {}) {
    const record = {
      id: violation.id || `vio_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`,
      botId: String(violation.botId || "admin").trim(),
      threadId: String(violation.threadId || "").trim(),
      groupName: String(violation.groupName || "").trim(),
      senderUid: String(violation.senderUid || violation.uid || "").trim(),
      senderName: String(violation.senderName || "Thành viên").trim(),
      ruleKey: String(violation.ruleKey || "antiSpam").trim(),
      severity: String(violation.severity || "medium").trim(),
      actionTaken: String(violation.actionTaken || "warned").trim(),
      snippet: String(violation.snippet || "").slice(0, 300),
      createdAt: violation.createdAt || new Date().toISOString(),
    };
    const saved = await Promise.resolve(this.store?.addViolation?.(record));
    return saved || record;
  }

  async listViolations(opts = {}) {
    const rows = await Promise.resolve(this.store?.listViolations?.(opts));
    return Array.isArray(rows) ? rows : [];
  }

  async clearViolations(botId = null) {
    const res = await Promise.resolve(this.store?.clearViolations?.(botId || undefined));
    return res ?? { cleared: true, botId: botId || "all" };
  }

  async listBlacklist() {
    const rows = await Promise.resolve(this.store?.listBlacklist?.());
    return Array.isArray(rows) ? rows : [];
  }

  async addBlacklist(entry = {}) {
    const uid = String(entry.uid || entry.senderUid || "").trim();
    if (!uid || !/^[a-zA-Z0-9._-]+$/.test(uid)) {
      const err = new Error("Vui lòng nhập Zalo UID hợp lệ để đưa vào Danh sách đen.");
      err.status = 400;
      err.code = "INVALID_BLACKLIST_UID";
      throw err;
    }
    const targetBotId = entry.botId || (entry.scopeBotId && entry.scopeBotId !== "all" ? entry.scopeBotId : null);
    const payload = {
      uid,
      displayName: String(entry.displayName || entry.name || "").trim().slice(0, 120),
      reason: String(entry.reason || "Vi phạm nội quy hệ thống").trim().slice(0, 500),
      scope: String(entry.scope || (targetBotId ? "bot" : "global")).trim(),
      botId: targetBotId ? String(targetBotId).trim() : null,
      actor: String(entry.actor || entry.addedBy || "admin").trim(),
      addedBy: String(entry.addedBy || entry.actor || "admin").trim(),
      scopeBotId: targetBotId ? String(targetBotId).trim() : "all",
      autoKick: entry.autoKick !== false,
      createdAt: entry.createdAt || new Date().toISOString(),
    };
    const saved = await Promise.resolve(this.store?.upsertBlacklist?.(payload));
    await this.auditStore?.append?.({
      action: "moderation.blacklist.add",
      uid,
      reason: payload.reason,
    });
    return saved || payload;
  }

  async removeBlacklist(uid) {
    const cleanUid = String(uid || "").trim();
    if (!cleanUid) {
      const err = new Error("Thiếu Zalo UID cần gỡ khỏi Danh sách đen.");
      err.status = 400;
      err.code = "INVALID_BLACKLIST_UID";
      throw err;
    }
    await Promise.resolve(this.store?.removeBlacklist?.(cleanUid));
    await this.auditStore?.append?.({
      action: "moderation.blacklist.remove",
      uid: cleanUid,
    });
    return { uid: cleanUid, removed: true };
  }
}
