import { mkdtemp, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MessageType } from "../../api-zalo/models/Message.js";
import { withSingleAttemptRequests } from "../../api-zalo/request-policy.js";
import { getMd5LargeFileObject } from "../../api-zalo/utils.js";
import { deleteFile, downloadFile } from "../../utils/util.js";

const DM = MessageType.DirectMessage;
const mediaTypes = new Set([
  "chat.photo", "chat.gif", "chat.video.msg", "chat.voice", "chat.sticker",
  "chat.link", "chat.recommended", "share.file", "chat.file", "file", "chat.attachment",
]);

function record(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function remoteUrl(label, ...candidates) {
  for (const value of candidates) {
    if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/i.test(value.trim())) continue;
    try {
      const address = new URL(value.trim());
      if (!address.username && !address.password) return value.trim();
    } catch {
      // Continue looking for another field containing the original media URL.
    }
  }
  throw new Error(`Thiếu ${label} hợp lệ.`);
}

function captionOf(content, params, ...fields) {
  for (const entry of [content, params]) {
    for (const key of fields) {
      if (typeof entry[key] === "string" && entry[key].length) return entry[key];
    }
  }
  return "";
}

function numberField(...values) {
  for (const value of values) {
    if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function requireSend(api, method) {
  if (typeof api?.[method] !== "function") throw new Error(`SDK thiếu phương thức ${method}.`);
  return api[method].bind(api);
}

async function prepareMedia(api, method, source) {
  const prepare = api[method]?.prepare;
  if (typeof prepare !== "function") throw new Error(`SDK thiếu bước chuẩn bị nội dung cho ${method}.`);
  try {
    return await withSingleAttemptRequests(() => prepare.call(api, source));
  } catch (cause) {
    throw new Error("Không thể chuẩn bị nội dung gốc để gửi QC.", { cause });
  }
}

function prepared(kind, send) {
  return Object.freeze({
    kind,
    async send(uid) {
      const threadId = String(uid ?? "").trim();
      if (!threadId || threadId === "0") throw new Error("Thiếu UID người nhận hợp lệ.");
      return withSingleAttemptRequests(() => send(threadId));
    },
    cleanup() {},
  });
}

function ensureSingleAttachment(...records) {
  for (const entry of records) {
    if (Array.isArray(entry) || ["attachments", "items", "photos", "photoList", "files", "videos", "album"]
      .some(key => Array.isArray(entry?.[key]) && entry[key].length > 1)) {
      throw new Error("QC không hỗ trợ album hoặc tin có nhiều tệp đính kèm.");
    }
  }
}

async function readFileMetadata(url) {
  const directory = await mkdtemp(path.join(tmpdir(), "mybot-qc-"));
  const target = path.join(directory, "attachment.bin");
  try {
    await downloadFile(url, target);
    const { size } = await stat(target);
    if (!size) throw new Error("Tệp rỗng.");
    const { data: checksum } = await getMd5LargeFileObject(target, size);
    return { size, checksum };
  } catch {
    throw new Error("Không đọc được tệp gốc để gửi lại.");
  } finally {
    await deleteFile(target);
    await rmdir(directory);
  }
}

async function prepareFile(api, content, params) {
  const send = requireSend(api, "sendFile");
  const url = remoteUrl("URL tệp gốc", content.href, content.url, params.href, params.url);
  const filename = captionOf(content, params, "fileName", "filename", "title");
  const extension = (captionOf(content, params, "fileExt", "extension") || path.extname(filename)).replace(/^\./, "");
  if (!filename.trim() || /[\\/\p{Cc}]/u.test(filename) || !/^[a-z0-9]+$/i.test(extension)) {
    throw new Error("Thiếu tên hoặc đuôi tệp gốc hợp lệ.");
  }
  const caption = captionOf(content, params, "caption", "msg");
  let size = numberField(params.fileSize, content.fileSize);
  let checksum = captionOf(content, params, "checksum");
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{32}$/i.test(checksum)) {
    ({ size, checksum } = await readFileMetadata(url));
  }
  return prepared("file", threadId => send(
    { threadId, type: DM, ...(caption && { data: { content: caption } }) }, url, 0, filename, size, extension, checksum,
  ));
}

function prepareLink(api, content, params) {
  const send = requireSend(api, "sendMessageForward");
  const link = remoteUrl("URL liên kết", content.href, content.url, params.href);
  const msg = captionOf(content, params, "caption", "msg", "title");
  const title = captionOf(params, content, "mediaTitle", "linkTitle");
  const desc = captionOf(content, params, "description", "desc");
  const preview = captionOf(content, params, "thumb", "thumbUrl");
  const thumb = preview ? remoteUrl("ảnh xem trước", preview) : "";
  const src = captionOf(params, content, "src") || new URL(link).hostname;
  const fields = ["mediaTitle", "streamUrl", "type", "artist", "count", "stream_icon", "mediaId"];
  const media = Object.fromEntries(fields.filter(field => ["number", "string"].includes(typeof params[field]))
    .map(field => [field, params[field]]));
  return prepared("link", uid => send({ msg, link, title, desc, thumb, src, media: { ...media }, strict: true }, uid, DM));
}

async function prepareCard(api, content, params) {
  const send = requireSend(api, "sendBusinessCard");
  if (captionOf(content, params, "caption", "msg")) throw new Error("SDK không hỗ trợ giữ chú thích kèm danh thiếp.");
  const rawUid = params.contactUid ?? params.uid ?? content.contactUid ?? content.params;
  const contactUid = typeof rawUid === "string" || Number.isSafeInteger(rawUid) ? String(rawUid).trim() : "";
  if (!/^[1-9]\d*$/.test(contactUid)) throw new Error("Thiếu UID danh thiếp hợp lệ.");
  const phone = record(content.description).phone ?? params.phone ?? content.phone;
  if (phone != null && typeof phone !== "string" && !Number.isSafeInteger(phone)) {
    throw new Error("Số điện thoại trên danh thiếp không hợp lệ.");
  }
  const qrCode = await prepareMedia(api, "sendBusinessCard", contactUid);
  return prepared("card", uid => send(null, contactUid, phone, DM, uid, 0, qrCode));
}

export async function prepareQcContent(api, message) {
  const data = message?.data ?? {};
  const { msgType, content: raw, attachments } = data;
  if (msgType === "webchat" || msgType === "chat.text") {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Thiếu nội dung văn bản hợp lệ.");
    ensureSingleAttachment(data);
    if (attachments && (!Array.isArray(attachments) || attachments.length)) {
      throw new Error("QC không xác định được định dạng tệp đính kèm của văn bản này.");
    }
    const send = requireSend(api, "sendMessage");
    return prepared("text", uid => send({ msg: raw, linkOn: false, strict: true }, uid, DM));
  }
  if (!mediaTypes.has(msgType)) throw new Error("QC không hỗ trợ loại tin nhắn này.");

  const decoded = typeof raw === "string" && raw.trim().startsWith("[") ? [] : raw;
  const content = record(decoded);
  const params = record(content.params);
  ensureSingleAttachment(data, decoded, content, params);
  const caption = captionOf(content, params, "caption", "title", "msg");

  switch (msgType) {
    case "chat.photo":
    case "chat.gif": {
      const gif = msgType === "chat.gif";
      const method = gif ? "sendGif" : "sendImage";
      const send = requireSend(api, method);
      const url = remoteUrl("URL ảnh gốc", content.href, content.hdUrl, content.oriUrl, content.rawUrl,
        content.url, content.normalUrl, params.href, params.hdUrl, params.url, raw);
      const metadata = { ...await prepareMedia(api, method, url) };
      return prepared(gif ? "gif" : "photo", threadId => send(url, { threadId, type: DM }, caption, 0, { ...metadata }));
    }
    case "chat.video.msg": {
      const send = requireSend(api, "sendVideo");
      const videoUrl = remoteUrl("URL video gốc", content.href, content.url, content.videoUrl, params.videoUrl);
      const thumbnail = remoteUrl("ảnh bìa video", content.thumb, content.thumbUrl, params.thumb, params.thumbUrl);
      const duration = numberField(params.duration, content.duration);
      const width = numberField(params.width, content.width);
      const height = numberField(params.height, content.height);
      const fileSize = numberField(params.fileSize, content.fileSize);
      if (duration === undefined || !width || !height || !fileSize) throw new Error("Thiếu metadata video gốc hợp lệ.");
      return prepared("video", threadId => send({ videoUrl, thumbnail, duration, width, height, fileSize,
        threadId, threadType: DM, message: { text: caption }, videoAlreadyUploaded: true }));
    }
    case "chat.voice": {
      const send = requireSend(api, "sendVoice");
      if (caption) throw new Error("SDK không hỗ trợ giữ chú thích kèm tin thoại.");
      const url = remoteUrl("URL tin thoại gốc", content.href, content.url, content.voiceUrl, params.voiceUrl);
      return prepared("voice", threadId => send({ threadId, type: DM }, url));
    }
    case "chat.sticker": {
      const send = requireSend(api, "sendSticker");
      if (caption) throw new Error("SDK không hỗ trợ giữ chú thích kèm sticker.");
      const id = numberField(content.id);
      const cateId = numberField(content.catId, content.cateId);
      const type = numberField(content.type);
      if (!id || ![id, cateId, type].every(Number.isSafeInteger)) throw new Error("Thiếu metadata sticker gốc hợp lệ.");
      return prepared("sticker", uid => send({ id, cateId, type }, uid, DM));
    }
    case "chat.link":
      return prepareLink(api, content, params);
    case "chat.recommended":
      if (content.action === "recommened.link") return prepareLink(api, content, params);
      if (content.action === "recommened.user") return prepareCard(api, content, params);
      throw new Error("QC không hỗ trợ loại thẻ đính kèm này.");
    default:
      return prepareFile(api, content, params);
  }
}
