import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import fetch from "node-fetch";
import { getInternalSecret } from "../../commands/mybot/System/mybot-command-relay.js";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB

const ALLOWED_MEDIA_FORMATS = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
});

const DEFAULT_VIETNAMESE_TEMPLATES = Object.freeze([
  {
    id: "tpl_morning_greeting",
    name: "Chào buổi sáng & Chúc ngày mới năng lượng",
    category: "community",
    mediaAssetId: "",
    text: "{Chào buổi sáng|Chúc ngày mới tốt lành|Hello đại gia đình} {groupName}! ☀️\nHôm nay ngày {date}, {botName} chúc toàn thể {memberCount} thành viên một ngày {bùng nổ năng lượng|làm việc hiệu quả|vạn sự hanh thông}! 🚀",
  },
  {
    id: "tpl_group_rules_remind",
    name: "Nhắc nhở nội quy & Văn hóa nhóm",
    category: "moderation",
    mediaAssetId: "",
    text: "📢 [THÔNG BÁO BQT - {groupName}]\n{Anh chị em|Cả nhà|Mọi người} lưu ý {giữ gìn văn minh chung|tuân thủ nội quy nhóm}: không rải link lạ, không spam nhãn dán và hạn chế tag @All khi chưa thật sự cần thiết. Cảm ơn {cả nhà|tất cả thành viên} đã đồng hành! 🤝",
  },
  {
    id: "tpl_flash_promo",
    name: "Thông báo Sự kiện / Ưu đãi Khung Giờ Vàng",
    category: "commerce",
    mediaAssetId: "",
    text: "🔥 {ƯU ĐÃI ĐẶC BIỆT|SỰ KIỆN HOT|QUÀ TẶNG ĐỘC QUYỀN} DÀNH CHO {groupName}!\n⏰ Khung giờ vàng lúc {time} ngày {date} đã chính thức mở — {nhanh tay kiểm tra ngay|đừng bỏ lỡ cơ hội hôm nay|liên hệ Quản trị viên để được hỗ trợ ưu tiên} nhé! 🎁",
  },
  {
    id: "tpl_system_status",
    name: "Thông báo Bảo trì / Nâng cấp Hệ thống",
    category: "system",
    mediaAssetId: "",
    text: "🛠️ [BẢN TIN VẬN HÀNH - {botName}]\nHệ thống trợ lý tại nhóm {groupName} ({threadId}) {vừa hoàn tất tối ưu tốc độ|đã nâng cấp bộ khiên bảo vệ mới|đang hoạt động ổn định 100%} vào lúc {time}. Chúc mọi người trò chuyện vui vẻ!",
  },
]);

function splitTopLevelPipes(inner) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "{") {
      depth += 1;
      current += ch;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Calculates total combinations of `{opt1|opt2|opt3}` blocks (supports nested and sequential blocks).
 * Variable placeholders without `|` (such as `{groupName}`) count as 1 variant.
 */
export function countSpintaxVariants(template) {
  const str = String(template ?? "");
  if (!str) return 1;

  let product = 1;
  let i = 0;
  while (i < str.length) {
    if (str[i] === "{") {
      let depth = 1;
      let j = i + 1;
      while (j < str.length && depth > 0) {
        if (str[j] === "{") depth += 1;
        else if (str[j] === "}") depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        const inner = str.slice(i + 1, j - 1);
        const options = splitTopLevelPipes(inner);
        if (options.length > 1) {
          let blockSum = 0;
          for (const opt of options) {
            blockSum += countSpintaxVariants(opt);
            if (blockSum >= Number.MAX_SAFE_INTEGER) {
              return Number.MAX_SAFE_INTEGER;
            }
          }
          product *= Math.max(1, blockSum);
          if (product >= Number.MAX_SAFE_INTEGER) {
            return Number.MAX_SAFE_INTEGER;
          }
        }
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, product));
}

function formatVietnamNow() {
  const now = new Date();
  try {
    const date = new Intl.DateTimeFormat("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(now);
    const time = new Intl.DateTimeFormat("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
    return { date, time };
  } catch {
    return {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 16),
    };
  }
}

/**
 * Picks random choices per `{a|b}` spintax block (supporting nested blocks)
 * and interpolates `{groupName}`, `{threadId}`, `{memberCount}`, `{date}`, `{time}`, `{botName}`.
 */
export function parseSpintax(template, vars = {}) {
  let out = String(template ?? "");
  if (!out) return "";

  const innermostSpintaxRe = /\{([^{}]*\|[^{}]*)\}/g;
  let guard = 0;
  while (innermostSpintaxRe.test(out) && guard < 32) {
    guard += 1;
    out = out.replace(innermostSpintaxRe, (_full, inner) => {
      const choices = inner.split("|");
      return choices[Math.floor(Math.random() * choices.length)] ?? "";
    });
  }

  const vnNow = formatVietnamNow();
  const replacements = {
    groupName: vars.groupName ?? vars.name ?? "Nhóm Zalo",
    threadId: vars.threadId ?? "",
    memberCount: vars.memberCount !== undefined && vars.memberCount !== null ? String(vars.memberCount) : "0",
    date: vars.date ?? vnNow.date,
    time: vars.time ?? vnNow.time,
    botName: vars.botName ?? "MYBOT",
  };

  return out.replace(/\{(groupName|threadId|memberCount|date|time|botName)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(replacements, key) ? String(replacements[key]) : match;
  });
}

function verifyMediaMagicBytes(ext, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  switch (ext) {
    case ".png":
      return (
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );
    case ".jpg":
    case ".jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case ".gif":
      return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
    case ".webp":
      return (
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
      );
    case ".wav":
      return (
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WAVE"
      );
    case ".mp4": {
      const box = buf.subarray(4, 8).toString("ascii");
      return ["ftyp", "moov", "mdat", "free", "wide"].includes(box);
    }
    case ".mp3":
      if (buf.subarray(0, 3).toString("ascii") === "ID3") return true;
      return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    default:
      return false;
  }
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

function sleepInterruptible(ms, checkStop) {
  return new Promise((resolve) => {
    const step = 250;
    let elapsed = 0;
    const tick = () => {
      if (elapsed >= ms || checkStop()) {
        resolve();
        return;
      }
      const wait = Math.min(step, ms - elapsed);
      elapsed += wait;
      const t = setTimeout(tick, wait);
      t.unref?.();
    };
    tick();
  });
}

export class CampaignMediaService {
  constructor({
    root = process.cwd(),
    store,
    registry = null,
    auditStore = null,
    getIo = () => null,
    startBackgroundScheduler = true,
  } = {}) {
    this.root = path.resolve(root);
    this.store = store;
    this.registry = registry;
    this.auditStore = auditStore;
    this.getIo = getIo;
    this.mediaDir = path.join(this.root, ".runtime", "dashboard-media");
    this.activeRunners = new Map();
    this.schedulerTimer = null;
    this.templatesSeeded = false;

    if (startBackgroundScheduler && process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
      this.startScheduler();
    }
  }

  startScheduler(intervalMs = 15_000) {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      void this.tickScheduledCampaigns().catch(() => {});
    }, intervalMs);
    this.schedulerTimer.unref?.();
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Spintax Preview
  // ---------------------------------------------------------------------------
  previewSpintax(
    text,
    sampleGroup = { name: "Nhóm VIP Zalo", threadId: "88990011", memberCount: 256 },
    extraVars = {}
  ) {
    const template = String(text ?? "");
    const variantCount = countSpintaxVariants(template);
    const vars = {
      groupName: sampleGroup?.name || sampleGroup?.groupName || "Nhóm VIP Zalo",
      threadId: sampleGroup?.threadId || "88990011",
      memberCount: sampleGroup?.memberCount ?? 256,
      botName: extraVars?.botName || "MYBOT",
      ...extraVars,
    };

    const previews = [];
    const seen = new Set();
    const targetCount = Math.min(3, Math.max(1, variantCount));
    let attempts = 0;

    while (previews.length < 3 && attempts < 15) {
      attempts += 1;
      const sample = parseSpintax(template, vars);
      if (!seen.has(sample) || seen.size >= targetCount) {
        seen.add(sample);
        previews.push(sample);
      }
    }

    while (previews.length < 3) {
      previews.push(parseSpintax(template, vars));
    }

    return {
      variantCount,
      previews: previews.slice(0, 3),
    };
  }

  // ---------------------------------------------------------------------------
  // Saved Campaign Templates
  // ---------------------------------------------------------------------------
  async #ensureDefaultTemplatesSeeded() {
    if (this.templatesSeeded || !this.store) return;
    this.templatesSeeded = true;
    const marker = await Promise.resolve(this.store.getDoc?.("meta", "campaign_templates_seeded", null));
    if (marker) return;

    const existing = unwrapStoreDocs(await Promise.resolve(this.store.listDocs?.("campaign_templates")));
    if (existing.length === 0) {
      const nowIso = new Date().toISOString();
      for (const tpl of DEFAULT_VIETNAMESE_TEMPLATES) {
        await Promise.resolve(
          this.store.setDoc?.("campaign_templates", tpl.id, {
            ...tpl,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
        );
      }
    }
    await Promise.resolve(this.store.setDoc?.("meta", "campaign_templates_seeded", { seededAt: new Date().toISOString() }));
  }

  async listTemplates() {
    await this.#ensureDefaultTemplatesSeeded();
    const docs = unwrapStoreDocs(await Promise.resolve(this.store?.listDocs?.("campaign_templates")));
    if (docs.length === 0 && !this.store) {
      return [...DEFAULT_VIETNAMESE_TEMPLATES];
    }
    return docs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  async saveTemplate({ id, name, text, mediaAssetId = "", category = "general" } = {}) {
    await this.#ensureDefaultTemplatesSeeded();
    const cleanName = String(name || "").trim();
    const cleanText = String(text || "").trim();
    if (!cleanName || !cleanText) {
      const err = new Error("Vui lòng nhập đầy đủ Tên mẫu và Nội dung chiến dịch.");
      err.status = 400;
      err.code = "INVALID_TEMPLATE";
      throw err;
    }

    const resolvedId = id
      ? String(id).trim()
      : `tpl_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 5)}`;
    assertSafeId(resolvedId, "templateId");

    const prev = await Promise.resolve(this.store?.getDoc?.("campaign_templates", resolvedId, null));
    const nowIso = new Date().toISOString();
    const record = {
      id: resolvedId,
      name: cleanName.slice(0, 160),
      text: cleanText.slice(0, 8000),
      mediaAssetId: String(mediaAssetId || "").trim(),
      category: String(category || "general").trim().slice(0, 48),
      variantCount: countSpintaxVariants(cleanText),
      createdAt: prev?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    await Promise.resolve(this.store?.setDoc?.("campaign_templates", resolvedId, record));
    return record;
  }

  async deleteTemplate(id) {
    assertSafeId(String(id || ""), "templateId");
    await this.#ensureDefaultTemplatesSeeded();
    await Promise.resolve(this.store?.deleteDoc?.("campaign_templates", id));
    return { id, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // Local Media Asset Library (.runtime/dashboard-media)
  // ---------------------------------------------------------------------------
  async uploadMedia({ filename, mimeType = "", dataBase64, category = "general", ttlHours = 0 } = {}) {
    const rawFilename = path.basename(String(filename || "").trim());
    if (!rawFilename) {
      const err = new Error("Thiếu tên tệp tải lên.");
      err.status = 400;
      err.code = "FILENAME_REQUIRED";
      throw err;
    }

    const ext = path.extname(rawFilename).toLowerCase();
    const canonicalMime = ALLOWED_MEDIA_FORMATS[ext];
    if (!canonicalMime) {
      const err = new Error(
        `Định dạng tệp '${ext || "không rõ"}' không được hỗ trợ. Chỉ chấp nhận: ${Object.keys(ALLOWED_MEDIA_FORMATS).join(", ")}`
      );
      err.status = 400;
      err.code = "UNSUPPORTED_MEDIA_FORMAT";
      throw err;
    }

    const rawB64 = String(dataBase64 || "").trim();
    if (!rawB64) {
      const err = new Error("Dữ liệu tệp Base64 trống.");
      err.status = 400;
      err.code = "EMPTY_MEDIA_DATA";
      throw err;
    }

    const cleanB64 = rawB64.includes(",") && rawB64.startsWith("data:")
      ? rawB64.slice(rawB64.indexOf(",") + 1)
      : rawB64;

    const buffer = Buffer.from(cleanB64, "base64");
    if (!buffer.length) {
      const err = new Error("Không giải mã được dữ liệu Base64 của tệp.");
      err.status = 400;
      err.code = "INVALID_BASE64";
      throw err;
    }

    if (buffer.length > MAX_MEDIA_BYTES) {
      const err = new Error("Dung lượng tệp vượt quá giới hạn tối đa 25 MB.");
      err.status = 413;
      err.code = "MEDIA_TOO_LARGE";
      throw err;
    }

    if (!verifyMediaMagicBytes(ext, buffer)) {
      const err = new Error(`Chữ ký nhị phân (magic bytes) của tệp không khớp định dạng ${ext}.`);
      err.status = 400;
      err.code = "INVALID_MEDIA_MAGIC_BYTES";
      throw err;
    }

    await fs.mkdir(this.mediaDir, { recursive: true });
    const id = `med_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const storedFilename = `${id}${ext}`;
    const filePath = path.join(this.mediaDir, storedFilename);
    await fs.writeFile(filePath, buffer);

    const parsedTtl = Math.max(0, Number(ttlHours || 0));
    const createdAt = new Date().toISOString();
    const expiresAt = parsedTtl > 0 ? new Date(Date.now() + parsedTtl * 3600_000).toISOString() : null;
    const safeDisplayName = rawFilename.replace(/[^\w.\- ()[\]\u00C0-\u1EF9]/g, "_").slice(0, 180);

    const asset = {
      id,
      filename: safeDisplayName,
      storedFilename,
      ext,
      mimeType: mimeType && mimeType.includes("/") ? canonicalMime : canonicalMime,
      sizeBytes: buffer.length,
      category: String(category || "general").trim().slice(0, 48),
      ttlHours: parsedTtl,
      expiresAt,
      url: `/api/v5/media/${id}/raw`,
      createdAt,
    };

    await Promise.resolve(this.store?.setDoc?.("media_assets", id, asset));
    await this.auditStore?.append?.({
      action: "media.upload",
      assetId: id,
      filename: safeDisplayName,
      sizeBytes: buffer.length,
    });

    return asset;
  }

  async listMedia() {
    const docs = unwrapStoreDocs(await Promise.resolve(this.store?.listDocs?.("media_assets")));
    const now = Date.now();
    const valid = [];

    for (const item of docs) {
      if (!item?.id) continue;
      if (item.expiresAt && Date.parse(item.expiresAt) <= now) {
        await this.deleteMedia(item.id).catch(() => {});
        continue;
      }
      valid.push(item);
    }

    return valid.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  async getMediaFile(id) {
    assertSafeId(String(id || ""), "mediaId");
    const meta = await Promise.resolve(this.store?.getDoc?.("media_assets", id, null));
    if (!meta || !meta.storedFilename) {
      const err = new Error("Không tìm thấy tệp phương tiện yêu cầu.");
      err.status = 404;
      err.code = "MEDIA_NOT_FOUND";
      throw err;
    }

    if (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) {
      await this.deleteMedia(id).catch(() => {});
      const err = new Error("Tệp phương tiện đã hết hạn lưu trữ (TTL).");
      err.status = 404;
      err.code = "MEDIA_EXPIRED";
      throw err;
    }

    const safeStored = path.basename(meta.storedFilename);
    const filePath = path.join(this.mediaDir, safeStored);
    if (!fsSync.existsSync(filePath)) {
      const err = new Error("Tệp vật lý không còn tồn tại trong kho lưu trữ.");
      err.status = 404;
      err.code = "MEDIA_FILE_MISSING";
      throw err;
    }

    return { meta, filePath };
  }

  async deleteMedia(id) {
    assertSafeId(String(id || ""), "mediaId");
    const meta = await Promise.resolve(this.store?.getDoc?.("media_assets", id, null));
    if (meta?.storedFilename) {
      const filePath = path.join(this.mediaDir, path.basename(meta.storedFilename));
      await fs.unlink(filePath).catch(() => {});
    }
    await Promise.resolve(this.store?.deleteDoc?.("media_assets", id));
    return { id, deleted: true };
  }

  // ---------------------------------------------------------------------------
  // Persistent Campaign Engine
  // ---------------------------------------------------------------------------
  async listCampaigns() {
    const list = await Promise.resolve(this.store?.listCampaigns?.());
    return Array.isArray(list) ? list : [];
  }

  async getCampaign(id) {
    assertSafeId(String(id || ""), "campaignId");
    const campaign = await Promise.resolve(this.store?.getCampaign?.(id));
    if (!campaign) {
      const err = new Error(`Không tìm thấy chiến dịch '${id}'.`);
      err.status = 404;
      err.code = "CAMPAIGN_NOT_FOUND";
      throw err;
    }
    return campaign;
  }

  async deleteCampaign(id) {
    assertSafeId(String(id || ""), "campaignId");
    const ctl = this.activeRunners.get(id);
    if (ctl) {
      ctl.cancelled = true;
      this.activeRunners.delete(id);
    }
    await Promise.resolve(this.store?.deleteCampaign?.(id));
    return { id, deleted: true };
  }

  async createCampaign({
    botId = "admin",
    name = "",
    textSpintax = "",
    mediaUrl = "",
    mediaAssetId = "",
    threadIds = [],
    groupNamesMap = {},
    minDelayMs = 3500,
    maxDelayMs = 8000,
    restEveryNGroups = 15,
    restDurationMs = 20000,
    scheduledAt = null,
    dryRun = false,
    startImmediately = true,
    actor = "admin",
  } = {}) {
    assertSafeId(String(botId || ""), "botId");

    const uniqueThreads = Array.isArray(threadIds)
      ? [...new Set(threadIds.map((t) => String(t || "").trim()).filter(Boolean))]
      : [];
    if (uniqueThreads.length === 0) {
      const err = new Error("Vui lòng chọn ít nhất 1 nhóm mục tiêu cho chiến dịch.");
      err.status = 400;
      err.code = "EMPTY_CAMPAIGN_TARGETS";
      throw err;
    }

    const cleanSpintax = String(textSpintax || "").trim();
    const cleanMediaUrl = String(mediaUrl || "").trim();
    const cleanAssetId = String(mediaAssetId || "").trim();
    if (!cleanSpintax && !cleanMediaUrl && !cleanAssetId) {
      const err = new Error("Chiến dịch cần có nội dung văn bản hoặc tệp đính kèm.");
      err.status = 400;
      err.code = "EMPTY_CAMPAIGN_CONTENT";
      throw err;
    }

    const safeMinDelay = Math.max(500, Math.min(120_000, Number(minDelayMs || 3500)));
    const safeMaxDelay = Math.max(safeMinDelay, Math.min(180_000, Number(maxDelayMs || 8000)));
    const safeRestEvery = Math.max(1, Math.min(200, Number(restEveryNGroups || 15)));
    const safeRestMs = Math.max(0, Math.min(300_000, Number(restDurationMs || 20000)));

    let parsedSchedule = null;
    if (scheduledAt) {
      const ms = Date.parse(String(scheduledAt));
      if (!Number.isNaN(ms)) {
        parsedSchedule = new Date(ms).toISOString();
      }
    }

    const isFutureSchedule = Boolean(parsedSchedule && Date.parse(parsedSchedule) > Date.now() + 2000);
    const nowIso = new Date().toISOString();
    const id = `cmp_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;

    const targets = uniqueThreads.map((tid) => ({
      threadId: tid,
      groupName: String(groupNamesMap?.[tid] || `Nhóm ${tid}`),
      status: "pending",
      error: null,
      sentAt: null,
    }));

    const campaign = {
      id,
      botId,
      name: String(name || "").trim() || `Chiến dịch ${new Date().toLocaleString("vi-VN")}`,
      textSpintax: cleanSpintax,
      variantCount: countSpintaxVariants(cleanSpintax),
      mediaUrl: cleanMediaUrl,
      mediaAssetId: cleanAssetId,
      minDelayMs: safeMinDelay,
      maxDelayMs: safeMaxDelay,
      restEveryNGroups: safeRestEvery,
      restDurationMs: safeRestMs,
      scheduledAt: parsedSchedule,
      dryRun: Boolean(dryRun),
      status: isFutureSchedule ? "scheduled" : "queued",
      actor: String(actor || "admin"),
      targets,
      stats: {
        total: targets.length,
        sent: 0,
        failed: 0,
        pending: targets.length,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      startedAt: null,
      completedAt: null,
    };

    await this.#saveAndSyncOperation(campaign);

    await this.auditStore?.append?.({
      action: "campaign.create",
      campaignId: id,
      botId,
      totalTargets: targets.length,
      scheduledAt: parsedSchedule,
      dryRun: Boolean(dryRun),
      actor,
    });

    if (!isFutureSchedule && startImmediately !== false) {
      void this.startCampaign(id, { dryRun: Boolean(dryRun) }).catch(() => {});
    }

    return campaign;
  }

  #recomputeStats(campaign) {
    const targets = Array.isArray(campaign.targets) ? campaign.targets : [];
    let sent = 0;
    let failed = 0;
    let pending = 0;
    for (const t of targets) {
      if (t.status === "sent" || t.status === "simulated") sent += 1;
      else if (t.status === "failed") failed += 1;
      else pending += 1;
    }
    campaign.stats = {
      total: targets.length,
      sent,
      failed,
      pending,
    };
    return campaign.stats;
  }

  async #saveAndSyncOperation(campaign) {
    const stats = this.#recomputeStats(campaign);
    campaign.updatedAt = new Date().toISOString();
    await Promise.resolve(this.store?.upsertCampaign?.(campaign));

    const progress = stats.total > 0 ? Math.round(((stats.sent + stats.failed) / stats.total) * 100) : 100;
    const opStatusMap = {
      running: "running",
      paused: "paused",
      scheduled: "queued",
      queued: "queued",
      completed: "completed",
      cancelled: "cancelled",
      failed: "failed",
    };

    await Promise.resolve(
      this.store?.upsertOperation?.({
        id: `op_${campaign.id}`,
        type: "campaign.broadcast",
        refId: campaign.id,
        title: `${campaign.name} (${stats.sent}/${stats.total} nhóm)`,
        botId: campaign.botId,
        status: opStatusMap[campaign.status] || "running",
        progress,
        meta: {
          campaignId: campaign.id,
          sent: stats.sent,
          failed: stats.failed,
          pending: stats.pending,
          total: stats.total,
        },
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      })
    ).catch(() => {});

    try {
      const io = this.getIo?.();
      io?.emit?.("dashboard:v5:campaign", {
        id: campaign.id,
        botId: campaign.botId,
        name: campaign.name,
        status: campaign.status,
        stats,
        restingUntil: campaign.restingUntil || null,
        updatedAt: campaign.updatedAt,
      });
      io?.emit?.("dashboard:broadcast_progress", {
        campaignId: campaign.id,
        botId: campaign.botId,
        total: stats.total,
        sent: stats.sent,
        failed: stats.failed,
        completed: ["completed", "cancelled", "failed"].includes(campaign.status),
      });
    } catch {}
  }

  async #resolveBotPort(botId) {
    const bot = this.registry ? await this.registry.describe(botId).catch(() => null) : null;
    if (!bot || bot.cookieDead) return { bot, livePort: null };
    const fallbackAdminPort = botId === "admin" ? Number(process.env.WEB_PORT || 2000) : 0;
    const candidatePort = Number(bot.port || bot.webPort || fallbackAdminPort || 0);
    if (!Number.isFinite(candidatePort) || candidatePort <= 0) return { bot, livePort: null };
    if (bot.connected) return { bot, livePort: candidatePort };
    const open = await probeLoopbackPort(candidatePort);
    return { bot, livePort: open ? candidatePort : null };
  }

  async #resolveOutboundMediaUrl(campaign) {
    if (campaign.mediaUrl) return campaign.mediaUrl;
    if (campaign.mediaAssetId) {
      const asset = await this.getMediaFile(campaign.mediaAssetId).catch(() => null);
      if (asset?.filePath) {
        const dashPort = Number(process.env.DASHBOARD_PORT || 4173);
        return `http://127.0.0.1:${dashPort}/api/v5/media/${encodeURIComponent(campaign.mediaAssetId)}/raw`;
      }
    }
    return "";
  }

  async startCampaign(id, opts = {}) {
    const campaign = await this.getCampaign(id);
    if (this.activeRunners.has(id)) {
      const existingCtl = this.activeRunners.get(id);
      existingCtl.paused = false;
      campaign.status = "running";
      await this.#saveAndSyncOperation(campaign);
      return campaign;
    }

    if (opts.dryRun !== undefined) {
      campaign.dryRun = Boolean(opts.dryRun);
    }

    const hasPending = (campaign.targets || []).some((t) => t.status === "pending");
    if (!hasPending) {
      campaign.status = "completed";
      campaign.completedAt = campaign.completedAt || new Date().toISOString();
      await this.#saveAndSyncOperation(campaign);
      return campaign;
    }

    campaign.status = "running";
    campaign.startedAt = campaign.startedAt || new Date().toISOString();
    campaign.completedAt = null;
    await this.#saveAndSyncOperation(campaign);

    const ctl = { paused: false, cancelled: false };
    this.activeRunners.set(id, ctl);

    void this.#runCampaignLoop(id, ctl).catch(() => {
      this.activeRunners.delete(id);
    });

    return campaign;
  }

  async #runCampaignLoop(id, ctl) {
    try {
      let campaign = await this.getCampaign(id);
      const secret = getInternalSecret({ projectRoot: this.root });
      const resolvedMediaUrl = await this.#resolveOutboundMediaUrl(campaign);
      let processedInRun = 0;

      for (let idx = 0; idx < (campaign.targets || []).length; idx += 1) {
        if (ctl.cancelled) {
          campaign.status = "cancelled";
          campaign.restingUntil = null;
          await this.#saveAndSyncOperation(campaign);
          return;
        }
        if (ctl.paused) {
          campaign.status = "paused";
          campaign.restingUntil = null;
          await this.#saveAndSyncOperation(campaign);
          return;
        }

        const target = campaign.targets[idx];
        if (!target || target.status !== "pending") continue;

        if (processedInRun > 0) {
          const isBatchRest =
            campaign.restEveryNGroups > 0 &&
            processedInRun % campaign.restEveryNGroups === 0 &&
            campaign.restDurationMs > 0;
          const waitMs = isBatchRest
            ? campaign.restDurationMs
            : campaign.dryRun
              ? Math.min(80, campaign.minDelayMs)
              : campaign.minDelayMs +
                Math.floor(Math.random() * Math.max(1, campaign.maxDelayMs - campaign.minDelayMs + 1));

          if (isBatchRest && !campaign.dryRun) {
            campaign.restingUntil = new Date(Date.now() + waitMs).toISOString();
            await this.#saveAndSyncOperation(campaign);
          }

          await sleepInterruptible(waitMs, () => ctl.cancelled || ctl.paused);
          campaign.restingUntil = null;

          if (ctl.cancelled) {
            campaign.status = "cancelled";
            await this.#saveAndSyncOperation(campaign);
            return;
          }
          if (ctl.paused) {
            campaign.status = "paused";
            await this.#saveAndSyncOperation(campaign);
            return;
          }
        }

        const { bot, livePort } = await this.#resolveBotPort(campaign.botId);
        const renderedText = parseSpintax(campaign.textSpintax, {
          groupName: target.groupName,
          threadId: target.threadId,
          memberCount: target.memberCount ?? 0,
          botName: bot?.displayName || campaign.botId,
        });

        if (campaign.dryRun) {
          target.status = "simulated";
          target.error = null;
          target.renderedText = renderedText;
          target.sentAt = new Date().toISOString();
        } else if (!livePort) {
          target.status = "failed";
          target.error = `BOT_OFFLINE: Bot '${campaign.botId}' đang ngoại tuyến hoặc chưa kết nối Zalo.`;
          target.renderedText = renderedText;
        } else {
          try {
            const resp = await fetch(`http://127.0.0.1:${livePort}/internal/runtime/send-message`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-internal-secret": secret,
              },
              body: JSON.stringify({
                threadId: target.threadId,
                threadType: "group",
                text: renderedText,
                mediaUrl: resolvedMediaUrl,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            const payload = await resp.json().catch(() => ({}));
            if (resp.ok) {
              target.status = "sent";
              target.error = null;
              target.sentAt = new Date().toISOString();
            } else {
              target.status = "failed";
              target.error = String(payload?.error || payload?.message || `HTTP ${resp.status}`);
            }
          } catch (sendErr) {
            target.status = "failed";
            target.error = String(sendErr?.message || "Lỗi kết nối tới tiến trình Bot.");
          }
        }

        processedInRun += 1;
        await this.#saveAndSyncOperation(campaign);
      }

      const stats = this.#recomputeStats(campaign);
      campaign.status = stats.sent === 0 && stats.failed > 0 ? "failed" : "completed";
      campaign.completedAt = new Date().toISOString();
      campaign.restingUntil = null;
      await this.#saveAndSyncOperation(campaign);

      await Promise.resolve(
        this.store?.addNotification?.({
          id: `ntf_cmp_${campaign.id}_${Date.now().toString(36)}`,
          level: stats.failed > 0 ? "warning" : "success",
          category: "campaign",
          title: `Chiến dịch '${campaign.name}' hoàn tất`,
          message: `Đã xử lý ${stats.sent}/${stats.total} nhóm thành công${stats.failed > 0 ? `, ${stats.failed} nhóm lỗi` : ""}.`,
          botId: campaign.botId,
          createdAt: new Date().toISOString(),
        })
      ).catch(() => {});
    } finally {
      this.activeRunners.delete(id);
    }
  }

  async pauseCampaign(id) {
    const campaign = await this.getCampaign(id);
    const ctl = this.activeRunners.get(id);
    if (ctl) {
      ctl.paused = true;
    }
    campaign.status = "paused";
    campaign.restingUntil = null;
    await this.#saveAndSyncOperation(campaign);
    return campaign;
  }

  async resumeCampaign(id) {
    const campaign = await this.getCampaign(id);
    if (campaign.status === "completed" || campaign.status === "cancelled") {
      const err = new Error(`Không thể tiếp tục chiến dịch ở trạng thái '${campaign.status}'.`);
      err.status = 409;
      err.code = "INVALID_CAMPAIGN_STATE";
      throw err;
    }
    return this.startCampaign(id);
  }

  async cancelCampaign(id) {
    const campaign = await this.getCampaign(id);
    const ctl = this.activeRunners.get(id);
    if (ctl) {
      ctl.cancelled = true;
      this.activeRunners.delete(id);
    }
    campaign.status = "cancelled";
    campaign.restingUntil = null;
    campaign.completedAt = new Date().toISOString();
    await this.#saveAndSyncOperation(campaign);
    return campaign;
  }

  async retryFailedTargets(id) {
    const campaign = await this.getCampaign(id);
    let resetCount = 0;
    for (const target of campaign.targets || []) {
      if (target.status === "failed") {
        target.status = "pending";
        target.error = null;
        resetCount += 1;
      }
    }
    if (resetCount === 0) {
      return { campaign, retriedCount: 0 };
    }
    campaign.status = "queued";
    campaign.completedAt = null;
    await this.#saveAndSyncOperation(campaign);
    const started = await this.startCampaign(id);
    return { campaign: started, retriedCount: resetCount };
  }

  async tickScheduledCampaigns() {
    const all = await this.listCampaigns();
    const now = Date.now();
    const triggered = [];
    for (const cmp of all) {
      if (cmp?.status === "scheduled" && cmp.scheduledAt) {
        const dueMs = Date.parse(cmp.scheduledAt);
        if (!Number.isNaN(dueMs) && dueMs <= now && !this.activeRunners.has(cmp.id)) {
          triggered.push(cmp.id);
          void this.startCampaign(cmp.id).catch(() => {});
        }
      }
    }
    return { checked: all.length, triggered };
  }
}
