import cryptojs from "crypto-js";
import crypto from "crypto";
import { appContext } from "./context.js";
import fs from "fs";
let _sharp = null;
async function getSharp() {
  if (!_sharp) {
    const mod = await import("sharp");
    _sharp = mod.default || mod;
  }
  return _sharp;
}
import pako from "pako";
import SparkMD5 from "spark-md5";
import path from "path";
import fetch from "node-fetch";
import axios from "axios";
import ffmpeg from 'fluent-ffmpeg';
import { GroupEventType } from "./models/GroupEvent.js";
import { ZaloApiError } from "./Errors/ZaloApiError.js";
import { getZaloRuntimeConfig } from "./zalo-config.js";
import { getFfprobeExecutableSync } from "../utils/runtime-dependencies.js";

export function getSignKey(type, params) {
  let n = [];
  for (let s in params) {
    if (params.hasOwnProperty(s)) {
      n.push(s);
    }
  }
  n.sort();
  let a = "zsecure" + type;
  for (let s = 0; s < n.length; s++) a += params[n[s]];
  return cryptojs.MD5(a);
}
export function makeURL(baseURL, params) {
  let url;
  try {
    url = new URL(baseURL);
  } catch (error) {
    throw new ZaloApiError("Invalid URL", "INVALID_URL", null, { endpoint: baseURL, cause: error });
  }
  for (let key in params) {
    if (params.hasOwnProperty(key)) {
      url.searchParams.append(key, params[key]);
    }
  }
  return url.toString();
}

function sanitizeUrlForLog(url) {
  try {
    const parsed = new URL(url);
    parsed.search = parsed.search ? "?redacted" : "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export class ParamsEncryptor {
  constructor({ type, imei, firstLaunchTime }) {
    this.zcid = null;
    this.enc_ver = "v2";
    this.zcid = null;
    this.encryptKey = null;
    this.createZcid(type, imei, firstLaunchTime);
    this.zcid_ext = ParamsEncryptor.randomString();
    this.createEncryptKey();
  }
  getEncryptKey() {
    if (!this.encryptKey) throw new Error("getEncryptKey: didn't create encryptKey yet");
    return this.encryptKey;
  }
  createZcid(type, imei, firstLaunchTime) {
    if (!type || !imei || !firstLaunchTime) throw new Error("createZcid: missing params");
    const msg = `${type},${imei},${firstLaunchTime}`;
    const s = ParamsEncryptor.encodeAES("3FC4F0D2AB50057BCE0D90D9187A22B1", msg, "hex", true);
    this.zcid = s;
  }
  createEncryptKey(e = 0) {
    const t = (e, t) => {
      const { even: n } = ParamsEncryptor.processStr(e),
        { even: a, odd: s } = ParamsEncryptor.processStr(t);
      if (!n || !a || !s) return !1;
      const i = n.slice(0, 8).join("") + a.slice(0, 12).join("") + s.reverse().slice(0, 12).join("");
      return (this.encryptKey = i), !0;
    };
    if (!this.zcid || !this.zcid_ext) throw new Error("createEncryptKey: zcid or zcid_ext is null");
    try {
      let n = cryptojs.MD5(this.zcid_ext).toString().toUpperCase();
      if (t(n, this.zcid) || !(e < 3)) return !1;
      this.createEncryptKey(e + 1);
    } catch (n) {
      e < 3 && this.createEncryptKey(e + 1);
    }
    return !0;
  }
  getParams() {
    return this.zcid
      ? {
        zcid: this.zcid,
        zcid_ext: this.zcid_ext,
        enc_ver: this.enc_ver,
      }
      : null;
  }
  static processStr(e) {
    if (!e || "string" != typeof e)
      return {
        even: null,
        odd: null,
      };
    const [t, n] = [...e].reduce((e, t, n) => (e[n % 2].push(t), e), [[], []]);
    return {
      even: t,
      odd: n,
    };
  }
  static randomString(e, t) {
    const n = e || 6,
      a = t && e && t > e ? t : 12;
    let s = Math.floor(Math.random() * (a - n + 1)) + n;
    if (s > 12) {
      let e = "";
      for (; s > 0;)
        (e += Math.random()
          .toString(16)
          .substr(2, s > 12 ? 12 : s)),
          (s -= 12);
      return e;
    }
    return Math.random().toString(16).substr(2, s);
  }
  static encodeAES(e, message, type, uppercase, s = 0) {
    if (!message) return null;
    try {
      {
        const encoder = "hex" == type ? cryptojs.enc.Hex : cryptojs.enc.Base64;
        const key = cryptojs.enc.Utf8.parse(e);
        const cfg = {
          words: [0, 0, 0, 0],
          sigBytes: 16,
        };
        const encrypted = cryptojs.AES.encrypt(message, key, {
          iv: cfg,
          mode: cryptojs.mode.CBC,
          padding: cryptojs.pad.Pkcs7,
        }).ciphertext.toString(encoder);
        return uppercase ? encrypted.toUpperCase() : encrypted;
      }
    } catch (o) {
      return s < 3 ? ParamsEncryptor.encodeAES(e, message, type, uppercase, s + 1) : null;
    }
  }
}
export function decryptResp(key, data) {
  let n = null;
  try {
    n = decodeRespAES(key, data);
    const parsed = JSON.parse(n);
    return parsed;
  } catch (error) {
    return n;
  }
}
function decodeRespAES(key, data) {
  data = decodeURIComponent(data);
  const parsedKey = cryptojs.enc.Utf8.parse(key);
  const n = {
    words: [0, 0, 0, 0],
    sigBytes: 16,
  };
  return cryptojs.AES.decrypt(
    {
      ciphertext: cryptojs.enc.Base64.parse(data),
    },
    parsedKey,
    {
      iv: n,
      mode: cryptojs.mode.CBC,
      padding: cryptojs.pad.Pkcs7,
    }
  ).toString(cryptojs.enc.Utf8);
}
export function decodeBase64ToBuffer(data) {
  return Buffer.from(data, "base64");
}
export function decodeUnit8Array(data) {
  try {
    return new TextDecoder().decode(data);
  } catch (error) {
    return null;
  }
}
export function encodeAES(secretKey, data, t = 0) {
  try {
    const key = cryptojs.enc.Base64.parse(secretKey);
    return cryptojs.AES.encrypt(data, key, {
      iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
      mode: cryptojs.mode.CBC,
      padding: cryptojs.pad.Pkcs7,
    }).ciphertext.toString(cryptojs.enc.Base64);
  } catch (n) {
    return t < 3 ? encodeAES(secretKey, data, t + 1) : null;
  }
}
export function decodeAES(secretKey, data, t = 0) {
  try {
    data = decodeURIComponent(data);
    let key = cryptojs.enc.Base64.parse(secretKey);
    return cryptojs.AES.decrypt(
      {
        ciphertext: cryptojs.enc.Base64.parse(data),
      },
      key,
      {
        iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
        mode: cryptojs.mode.CBC,
        padding: cryptojs.pad.Pkcs7,
      }
    ).toString(cryptojs.enc.Utf8);
  } catch (n) {
    return t < 3 ? decodeAES(secretKey, data, t + 1) : null;
  }
}
function updateCookie(input) {
  if (!appContext.cookie) throw new Error("Cookie is not available");
  if (typeof input !== "string" && !Array.isArray(input)) return null;
  const cookieMap = new Map();
  const cookie = appContext.cookie;
  cookie.split(";").forEach((cookie) => {
    const [key, value] = cookie.split("=");
    if (key) cookieMap.set(key.trim(), (value || "").trim());
  });
  let newCookie;
  if (Array.isArray(input)) newCookie = input.map((cookie) => cookie.split(";")[0]).join("; ");
  else newCookie = input;
  newCookie.split(";").forEach((cookie) => {
    const [key, value] = cookie.split("=");
    if (key) cookieMap.set(key.trim(), (value || "").trim());
  });
  return Array.from(cookieMap.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}
export function getDefaultHeaders() {
  if (!appContext.cookie) throw new Error("Cookie is not available");
  if (!appContext.userAgent) throw new Error("User agent is not available");
  const zaloConfig = getZaloRuntimeConfig();
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "content-type": "application/x-www-form-urlencoded",
    Cookie: appContext.cookie,
    Origin: zaloConfig.origin,
    Referer: zaloConfig.referer,
    "User-Agent": appContext.userAgent,
  };
}
export async function request(url, options) {
  const result = await requestJson(url, {
    ...options,
    rawResponse: true,
  });
  return result.response;
}
function mergeHeaders(headers, defaultHeaders) {
  return Object.assign(Object.assign({}, defaultHeaders), headers);
}
export async function getImageMetaData(filePath) {
  const fileData = await fs.promises.readFile(filePath);
  const sharp = await getSharp();
  const imageData = await sharp(fileData).metadata();
  const fileName = path.basename(filePath);
  return {
    fileName,
    totalSize: imageData.size,
    width: imageData.width,
    height: imageData.height,
  };
}
export async function getFileSize(filePath) {
  return fs.promises.stat(filePath).then((s) => s.size);
}
export async function getGifDimensions(filePath) {
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, "r");
    const fileData = await fileHandle.readFile();
    const sharp = await getSharp();
    const detailData = await sharp(fileData).metadata();
    const fileName = path.basename(filePath);
    return {
      fileName,
      totalSize: detailData.size,
      width: detailData.width,
      height: detailData.height,
    };
  } finally {
    if (fileHandle) await fileHandle.close();
  }
}
export function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const probeBin = getFfprobeExecutableSync();
      if (probeBin) ffmpeg.setFfprobePath(probeBin);
    } catch {}
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }

      const fileName = path.basename(filePath);
      resolve({
        fileName,
        totalSize: metadata.format.size,
        width: videoStream.width,
        height: videoStream.height,
        duration: videoStream.duration * 1000,
      });
    });
  });
}
export async function getFileInfoFromUrl(url) {
  try {
    const response = await axios.head(url);
    let fileName = '';
    const contentDisposition = response.headers['content-disposition'];
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename=["']?([^"']+)["']?/);
      if (filenameMatch && filenameMatch[1]) {
        fileName = filenameMatch[1];
      }
    }
    if (!fileName) {
      fileName = url.split('/').pop().split('?')[0] || 'unknownFile';
    }
    const fileSize = parseInt(response.headers['content-length']) || 0;
    return {
      fileName,
      fileSize
    };
  } catch (error) {
    console.error('Lỗi khi lấy thông tin file:', error.message);
    return {
      fileName: 'unknownFile',
      fileSize: 0
    };
  }
}
let _rustDecoder = null;

export async function decodeEventData(parsed, cipherKey) {
  if (!cipherKey) return;
  const eventData = parsed.data;

  if (process.env.USE_RUST_WS_DECODER === "true") {
    try {
      if (!_rustDecoder) {
        const { getRustWsDecoderClient } = await import("../workers/rust-ws-decoder-client.js");
        _rustDecoder = getRustWsDecoderClient();
      }
      if (_rustDecoder?.isAvailable?.()) {
        const result = await _rustDecoder.decode(eventData, cipherKey);
        if (result) return result;
      }
    } catch {
      // Fall through to standard Node decode path
    }
  }

  const decodedEventDataBuffer = decodeBase64ToBuffer(decodeURIComponent(eventData));
  if (decodedEventDataBuffer.length >= 48) {
    const algorithm = {
      name: "AES-GCM",
      iv: decodedEventDataBuffer.subarray(0, 16),
      tagLength: 128,
      additionalData: decodedEventDataBuffer.subarray(16, 32),
    };
    const dataSource = decodedEventDataBuffer.subarray(32);
    const cryptoKey = await crypto.subtle.importKey("raw", decodeBase64ToBuffer(cipherKey), algorithm, false, [
      "decrypt",
    ]);
    const decryptedData = await crypto.subtle.decrypt(algorithm, cryptoKey, dataSource);
    const decompressedData = pako.inflate(decryptedData);
    const decodedData = decodeUnit8Array(decompressedData);
    if (!decodedData) return;
    return JSON.parse(decodedData);
  }
}
export function getMd5LargeFileObject(filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const chunkSize = 2097152;
    const chunks = Math.max(1, Math.ceil((Number(fileSize) || 0) / chunkSize));
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => {
      resolve({
        currentChunk: chunks,
        data: hash.digest("hex"),
      });
    });
  });
}
export async function getMd5LargeFileFromUrl(url, fileSize) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios({
        url: url,
        method: "GET",
        responseType: "stream",
      });
      const spark = new SparkMD5.ArrayBuffer();
      let currentChunk = 0;
      response.data.on("data", (chunk) => {
        currentChunk++;
        spark.append(chunk);
      });
      response.data.on("end", () => {
        resolve({
          currentChunk,
          data: spark.end(),
        });
      });
      response.data.on("error", (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}
export const logger = {
  verbose: (...args) => {
    console.log("\x1b[2mVERBOSE\x1b[0m", ...args);
  },
  info: (...args) => {
    console.log("\x1b[34mINFO\x1b[0m", ...args);
  },
  warn: (...args) => {
    console.log("\x1b[33mWARN\x1b[0m", ...args);
  },
  error: (...args) => {
    console.log("\x1b[31mERROR\x1b[0m", ...args);
  },
};
export function getClientMessageType(msgType) {
  if (msgType === "webchat") return 1;
  if (msgType === "chat.voice") return 31;
  if (msgType === "chat.photo") return 32;
  if (msgType === "chat.sticker") return 36;
  if (msgType === "chat.doodle") return 37;
  if (msgType === "chat.recommended") return 38;
  if (msgType === "chat.link") return 1; // don't know
  if (msgType === "chat.video.msg") return 44;
  if (msgType === "share.file") return 46;
  if (msgType === "chat.gif") return 49;
  if (msgType === "chat.location.new") return 43;
  return 1;
}
export function strPadLeft(e, t, n) {
  const a = (e = "" + e).length;
  return a === n ? e : a > n ? e.slice(-n) : t.repeat(n - a) + e;
}
export function getFullTimeFromMilisecond(e) {
  let t = new Date(e);
  return (
    strPadLeft(t.getHours(), "0", 2) +
    ":" +
    strPadLeft(t.getMinutes(), "0", 2) +
    " " +
    strPadLeft(t.getDate(), "0", 2) +
    "/" +
    strPadLeft(t.getMonth() + 1, "0", 2) +
    "/" +
    t.getFullYear()
  );
}
export function getFileExtension(e) {
  return path.extname(e).slice(1);
}
export function getFileName(e) {
  return path.basename(e);
}
export function removeUndefinedKeys(e) {
  for (let t in e) e[t] === undefined && delete e[t];
  return e;
}
export function getGroupEventType(act) {
  if (act == "join_request") return GroupEventType.JOIN_REQUEST;
  if (act == "join") return GroupEventType.JOIN;
  if (act == "leave") return GroupEventType.LEAVE;
  if (act == "remove_member") return GroupEventType.REMOVE_MEMBER;
  if (act == "block_member") return GroupEventType.BLOCK_MEMBER;
  if (act == "update_setting") return GroupEventType.UPDATE_SETTING;
  if (act == "update") return GroupEventType.UPDATE;
  if (act == "new_link") return GroupEventType.NEW_LINK;
  if (act == "add_admin") return GroupEventType.ADD_ADMIN;
  if (act == "remove_admin") return GroupEventType.REMOVE_ADMIN;
  if (act == "new_pin_topic") return GroupEventType.NEW_PIN_TOPIC;
  if (act == "update_topic") return GroupEventType.UPDATE_TOPIC;
  if (act == "update_board") return GroupEventType.UPDATE_BOARD;
  if (act == "reorder_pin_topic") return GroupEventType.REORDER_PIN_TOPIC;
  if (act == "unpin_topic") return GroupEventType.UNPIN_TOPIC;
  if (act == "remove_topic") return GroupEventType.REMOVE_TOPIC;
  return GroupEventType.UNKNOWN;
}
export async function handleZaloResponse(response) {
  const result = {
    data: null,
    error: null,
  };
  const contentType = response.headers?.get?.("content-type") || "";
  if (!response.ok) {
    result.error = {
      message: "Request failed with status code " + response.status,
      code: response.status,
      status: response.status,
      retryable: isRetryableStatus(response.status),
    };
    return result;
  }
  try {
    const bodyText = await response.text();
    if (!bodyText || !bodyText.trim()) {
      return { data: null, error: null };
    }
    if (!contentType.includes("json") && !bodyText.trim().startsWith("{")) {
      result.error = {
        message: "Unexpected response content type",
        code: "INVALID_CONTENT_TYPE",
        status: response.status,
      };
      return result;
    }
    const jsonData = JSON.parse(bodyText);
    if (!jsonData.data && jsonData.data !== "") {
      return { data: null, error: null };
    }
    const decodedData = decodeAES(appContext.secretKey, jsonData.data);
    if (decodedData === null) {
      result.error = {
        message: "Failed to decrypt response data",
        code: "DECRYPT_FAILED",
      };
      return result;
    }
    if (!decodedData || !decodedData.trim()) {
      return { data: null, error: null };
    }
    const parsedData = JSON.parse(decodedData);
    if (parsedData.error_code && parsedData.error_code != 0) {
      result.error = {
        message: parsedData.error_message,
        code: parsedData.error_code,
        status: response.status,
      };
      return result;
    }
    result.data = parsedData.data;
  } catch (error) {
    console.error("Failed to parse Zalo response", {
      status: response?.status,
      error: error?.message,
    });
    result.error = {
      message: "Failed to parse response data",
      code: "INVALID_JSON",
      status: response?.status,
    };
  }
  return result;
}

export async function requestJson(url, options = {}) {
  const { response, bodyText } = await requestWithBodyKind(url, options, "json");
  if (options.rawResponse) {
    return { response };
  }
  if (!response.ok) {
    throw new ZaloApiError(`Request failed with status code ${response.status}`, response.status, response.status, {
      endpoint: response.url,
      retryable: isRetryableStatus(response.status),
    });
  }
  if (!bodyText?.trim()) {
    throw new ZaloApiError("Empty JSON response body", "EMPTY_RESPONSE_BODY", response.status, {
      endpoint: response.url,
      retryable: false,
    });
  }
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new ZaloApiError("Failed to parse JSON response", "INVALID_JSON", response.status, {
      endpoint: response.url,
      retryable: false,
      cause: error,
    });
  }
}

export async function requestBuffer(url, options = {}) {
  const { response, body } = await requestWithBodyKind(url, options, "buffer");
  if (!response.ok) {
    throw new ZaloApiError(`Request failed with status code ${response.status}`, response.status, response.status, {
      endpoint: response.url,
      retryable: isRetryableStatus(response.status),
    });
  }
  return Buffer.from(body);
}

async function requestWithBodyKind(url, options, kind) {
  const requestUrl = typeof url === "string" ? url : String(url);
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch (error) {
    throw new ZaloApiError("Invalid URL", "INVALID_URL", null, { endpoint: requestUrl, cause: error });
  }

  const timeout = Number.isFinite(options.timeout) ? options.timeout : 6000;
  const retryLimit = Number.isFinite(options.retry) ? options.retry : 2;
  const method = (options.method || "GET").toUpperCase();
  const baseHeaders = options.headers ? mergeHeaders(options.headers, getDefaultHeaders()) : getDefaultHeaders();
  const fetchOptions = { ...options, method, headers: baseHeaders };
  delete fetchOptions.retry;
  delete fetchOptions.rawResponse;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(parsed.toString(), { ...fetchOptions, signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.headers.has("set-cookie")) {
        const newCookie = updateCookie(response.headers.get("set-cookie"));
        if (newCookie) appContext.cookie = newCookie;
      }
      if (!response.ok && isRetryableStatus(response.status) && attempt < retryLimit) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (options.rawResponse) {
        return { response };
      }
      if (kind === "buffer") {
        return { response, body: await response.arrayBuffer() };
      }
      const bodyText = await response.text();
      return { response, bodyText };
    } catch (error) {
      clearTimeout(timeoutId);
      const retryable = error?.name === "AbortError" || error?.name === "FetchError";
      console.warn("HTTP request failed", {
        url: sanitizeUrlForLog(requestUrl),
        method,
        attempt,
        retryable,
        error: error?.message,
      });
      if (!retryable || attempt >= retryLimit) {
        throw new ZaloApiError("HTTP request failed", "HTTP_REQUEST_FAILED", null, {
          endpoint: requestUrl,
          retryable,
          cause: error,
        });
      }
      await sleep(250 * (attempt + 1));
    }
  }
}
export function analyzeLinks(content) {
  const urlRegex = /(?:@)?(?:https?:\/\/)?(?:www\.)?(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s\n]*)?/gi;

  const matches = content.match(urlRegex) || [];
  const normalizedLinks = matches
    .map((link) => {
      let normalizedLink = link.replace(/^@/, "");
      normalizedLink = normalizedLink.replace(/\/+$/, "");
      if (!normalizedLink.match(/^https?:\/\//i)) {
        return "https://" + normalizedLink;
      }
      return normalizedLink;
    })
    .filter((link) => {
      try {
        new URL(link);
        return true;
      } catch {
        return false;
      }
    });

  return {
    count: normalizedLinks.length,
    links: normalizedLinks,
  };
}
