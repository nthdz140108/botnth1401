import axios from "axios";
import fetch from "node-fetch";
import sharp from "sharp";
import * as cheerio from "cheerio";
import Tesseract from "tesseract.js";
import { sendMessageFromSQL } from "../../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import { safeThreadType, extractCommandBody } from "../../../commands/shared/command-input-utils.js";

const CSGT_CONFIG = {
  baseUrl: "https://www.csgt.vn",
  urlCaptcha: "https://www.csgt.vn/lib/captcha/captcha.class.php",
  timeoutMs: 10000,
  maxRetries: 8,
  baseHeaders: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "vi,vi-VN;q=0.9,en-US;q=0.8,en;q=0.7",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  },
};

export function detectVehicleType(rawBienSo) {
  const raw = String(rawBienSo ?? "").trim().toUpperCase();
  const normalizedPlate = raw.replace(/[-./\s]/g, "");

  if (/^\d{2}[A-Z][0-9A-Z][-./\s]+\d{4,5}$/.test(raw)) {
    return 2;
  }
  if (/^\d{2}[A-Z][-./\s]+\d{4,5}$/.test(raw)) {
    return 1;
  }

  const motorbikePatterns = [
    /^\d{2}[A-Z]\d\d{5}$/, // 9 chars: 5-digit motorbike (29B112345)
    /^\d{2}[A-Z][A-Z]\d{4,5}$/, // 2-letter series motorbike/moped (29BB1234, 29BB12345)
    /^\d{2}[B-Z][1-9]\d{4}$/, // 8 chars: 4-digit motorbike (29B12345 -> 29-B1 2345)
  ];

  for (const pattern of motorbikePatterns) {
    if (pattern.test(normalizedPlate)) {
      return 2;
    }
  }

  return 1;
}

export function isValidLicensePlate(bienSo) {
  const normalizedPlate = String(bienSo ?? "").replace(/[-./\s]/g, "").toUpperCase();
  if (normalizedPlate.length < 6 || normalizedPlate.length > 10) {
    return false;
  }
  return /^\d{2}[A-Z][A-Z0-9]\d{3,6}$/.test(normalizedPlate);
}

function extractCookieHeader(setCookieHeaders, prevCookie = "") {
  const jar = new Map();
  for (const part of String(prevCookie || "").split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq > 0) jar.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const item of list) {
    const firstPair = String(item || "").split(";")[0]?.trim() || "";
    const eq = firstPair.indexOf("=");
    if (eq > 0) jar.set(firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1).trim());
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function normalizeJsonViolation(item, fallbackPlate) {
  if (!item || typeof item !== "object") return null;
  const bienSo = String(
    item.bienSo ?? item["Biển kiểm soát"] ?? item.bienso ?? item.licensePlate ?? fallbackPlate
  ).trim();
  const mauBien = String(
    item.mauBien ?? item["Màu biển"] ?? item.maubien ?? "Không rõ"
  ).trim();
  const loaiXe = String(
    item.loaiXe ?? item["Loại phương tiện"] ?? item.loaixe ?? ""
  ).trim();
  const thoiGian = String(
    item.thoiGian ?? item["Thời gian vi phạm"] ?? item.thoigian ?? ""
  ).trim();
  const diaDiem = String(
    item.diaDiem ?? item["Địa điểm vi phạm"] ?? item.diadiem ?? ""
  ).trim();
  const hanhViViPham = String(
    item.hanhViViPham ?? item["Hành vi vi phạm"] ?? item.hanhvi ?? ""
  ).trim();
  const trangThai = String(
    item.trangThai ?? item["Trạng thái"] ?? item.trangthai ?? "Chưa xác định"
  ).trim();
  const donViPhatHien = String(
    item.donViPhatHien ?? item["Đơn vị phát hiện vi phạm"] ?? item.donvi ?? ""
  ).trim();

  const rawContact =
    item.thongTinLienHe ??
    item["Nơi giải quyết vụ việc"] ??
    item.noigiaiquyet ??
    [];
  const thongTinLienHe = Array.isArray(rawContact)
    ? rawContact.map((s) => String(s).trim()).filter(Boolean)
    : typeof rawContact === "string" && rawContact.trim()
      ? [rawContact.trim()]
      : [];

  if (!thoiGian && !hanhViViPham) return null;
  return {
    bienSo,
    mauBien,
    loaiXe,
    thoiGian: thoiGian || "Không rõ",
    diaDiem: diaDiem || "Không rõ",
    hanhViViPham: hanhViViPham || "Không rõ",
    trangThai,
    donViPhatHien: donViPhatHien || "Không rõ",
    noiGiaiQuyet: "",
    thongTinLienHe,
  };
}

async function queryPhatNguoiJsonApi(bienSo, loaiXe) {
  const customUrl = String(process.env.PHATNGUOI_API_URL || "").trim();
  const endpoints = [];
  if (customUrl) {
    endpoints.push({ url: customUrl, isCustom: true });
  }
  endpoints.push({ url: "https://api.checkphatnguoi.vn/phatnguoi", isCustom: false });

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": CSGT_CONFIG.baseHeaders["User-Agent"],
        },
        body: JSON.stringify({ bienso: bienSo, loaixe: loaiXe }),
        signal: AbortSignal.timeout(CSGT_CONFIG.timeoutMs),
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (!json || typeof json !== "object") continue;

      if (Array.isArray(json.data)) {
        return {
          source: ep.isCustom ? "Hệ thống tra cứu phạt nguội" : "Cổng dữ liệu tra cứu phạt nguội CSGT",
          violations: json.data
            .map((v) => normalizeJsonViolation(v, bienSo))
            .filter(Boolean),
        };
      }
      if (json.status === 2 || json.data === null || (json.status === 1 && !json.data)) {
        return {
          source: ep.isCustom ? "Hệ thống tra cứu phạt nguội" : "Cổng dữ liệu tra cứu phạt nguội CSGT",
          violations: [],
        };
      }
    } catch {
      // Fall through to next endpoint or CSGT crawler
    }
  }
  return null;
}

async function solveCsgtCaptchaWithFreshSession() {
  const initRes = await axios.get(CSGT_CONFIG.baseUrl, {
    headers: CSGT_CONFIG.baseHeaders,
    timeout: CSGT_CONFIG.timeoutMs,
  }).catch(() => null);

  let sessionCookie = extractCookieHeader(initRes?.headers?.["set-cookie"]);

  const captchaResponse = await axios.get(CSGT_CONFIG.urlCaptcha, {
    headers: {
      ...CSGT_CONFIG.baseHeaders,
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    responseType: "arraybuffer",
    timeout: CSGT_CONFIG.timeoutMs,
  });

  sessionCookie = extractCookieHeader(
    captchaResponse.headers?.["set-cookie"],
    sessionCookie
  );

  const processedBuffer = await sharp(captchaResponse.data)
    .resize({ width: 800 })
    .grayscale()
    .threshold(128)
    .negate()
    .linear(1.5, 0)
    .toBuffer();

  const {
    data: { text },
  } = await Tesseract.recognize(processedBuffer, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    tessedit_pageseg_mode: 7,
  });

  const captchaText = String(text || "").trim().replace(/\s+/g, "");
  return { captchaText, sessionCookie };
}

async function crawlCsgtViolations(bienSo, loaiXe = 1) {
  let attempt = 0;

  while (attempt < CSGT_CONFIG.maxRetries) {
    try {
      const { captchaText, sessionCookie } = await solveCsgtCaptchaWithFreshSession();
      if (!captchaText) {
        throw new Error("Captcha empty");
      }

      const checkUrl = `${CSGT_CONFIG.baseUrl}/?mod=contact&task=tracuu_post&ajax`;
      const formData = new URLSearchParams();
      formData.append("BienKS", bienSo);
      formData.append("Xe", String(loaiXe));
      formData.append("captcha", captchaText);
      formData.append("ipClient", "9.9.9.91");
      formData.append("cUrl", "1");

      const checkResponse = await axios.post(checkUrl, formData.toString(), {
        headers: {
          ...CSGT_CONFIG.baseHeaders,
          ...(sessionCookie ? { Cookie: sessionCookie } : {}),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: CSGT_CONFIG.timeoutMs,
      });

      const checkResult = checkResponse.data;
      if (!checkResult || !checkResult.success || !checkResult.href) {
        throw new Error("Captcha verification failed");
      }

      const finalCookie = extractCookieHeader(
        checkResponse.headers?.["set-cookie"],
        sessionCookie
      );

      const response = await axios.get(checkResult.href, {
        headers: {
          ...CSGT_CONFIG.baseHeaders,
          ...(finalCookie ? { Cookie: finalCookie } : {}),
        },
        timeout: CSGT_CONFIG.timeoutMs,
      });

      const $ = cheerio.load(response.data);
      const violations = [];
      let currentViolation = null;

      $("#bodyPrint123 .form-group").each((_, element) => {
        const label = $(element).find(".control-label span").text().trim();
        const value = $(element).find(".col-md-9").text().trim();

        if (label === "Biển kiểm soát:") {
          if (currentViolation && currentViolation.bienSo) {
            violations.push(currentViolation);
          }
          currentViolation = {
            bienSo: value,
            mauBien: "",
            loaiXe: "",
            thoiGian: "",
            diaDiem: "",
            hanhViViPham: "",
            trangThai: "",
            donViPhatHien: "",
            noiGiaiQuyet: "",
            thongTinLienHe: [],
          };
          return;
        }

        if (!currentViolation) return;

        switch (label) {
          case "Màu biển:":
            currentViolation.mauBien = value;
            break;
          case "Loại phương tiện:":
            currentViolation.loaiXe = value;
            break;
          case "Thời gian vi phạm:":
            currentViolation.thoiGian = value;
            break;
          case "Địa điểm vi phạm:":
            currentViolation.diaDiem = value;
            break;
          case "Hành vi vi phạm:":
            currentViolation.hanhViViPham = value;
            break;
          case "Trạng thái:":
            currentViolation.trangThai =
              $(element).find(".badge").text().trim() || value;
            break;
          case "Đơn vị phát hiện vi phạm:":
            currentViolation.donViPhatHien = value;
            break;
          case "Nơi giải quyết vụ việc:":
            currentViolation.noiGiaiQuyet = value;
            if (value) currentViolation.thongTinLienHe.push(value);
            break;
          default: {
            const text = $(element).text().trim();
            if (text && !text.includes("Biển kiểm soát:")) {
              currentViolation.thongTinLienHe.push(text);
            }
          }
        }
      });

      if (currentViolation && currentViolation.bienSo) {
        violations.push(currentViolation);
      }

      return {
        source: "Cổng thông tin điện tử Cục Cảnh sát giao thông",
        violations: violations.filter((v) => v.bienSo && v.thoiGian),
      };
    } catch (error) {
      attempt += 1;
      const errMsg = String(error?.message || "");
      if (attempt >= CSGT_CONFIG.maxRetries || !/captcha/i.test(errMsg)) {
        throw error;
      }
    }
  }

  throw new Error("Không thể xác thực captcha trên cổng CSGT sau nhiều lần thử");
}

async function getPhatNguoiInfo(bienSo, loaiXe = 1) {
  const jsonResult = await queryPhatNguoiJsonApi(bienSo, loaiXe);
  if (jsonResult) {
    return jsonResult;
  }
  return crawlCsgtViolations(bienSo, loaiXe);
}

function formatViolation(violation, index) {
  let violationMessage = `\n❗ Vi phạm ${index + 1}:\n`;
  violationMessage += `⏰ Thời gian: ${violation.thoiGian}\n`;
  violationMessage += `📍 Địa điểm: ${violation.diaDiem}\n`;
  violationMessage += `❌ Hành vi: ${violation.hanhViViPham}\n`;
  violationMessage += `⚠️ Trạng thái: ${violation.trangThai}\n`;
  violationMessage += `👮 Đơn vị phát hiện: ${violation.donViPhatHien}\n`;

  if (Array.isArray(violation.thongTinLienHe) && violation.thongTinLienHe.length > 0) {
    violationMessage += `📞 Nơi giải quyết / Liên hệ:\n`;
    for (const info of violation.thongTinLienHe) {
      violationMessage += `   • ${info}\n`;
    }
  }

  return violationMessage;
}

export async function handlePhatNguoiCommand(api, message, aliasCommand = "phatnguoi") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "phatnguoi";
  const threadType = safeThreadType(
    message,
    message?.threadId &&
      message?.data?.uidFrom &&
      String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );
  const msgCtx = message?.type === threadType ? message : { ...message, type: threadType };

  const keyword = extractCommandBody(msgCtx, prefix, effectiveAlias);
  if (!keyword) {
    await sendMessageFromSQL(
      api,
      msgCtx,
      {
        success: false,
        message:
          `Vui lòng nhập biển số xe cần tra cứu!\n` +
          `Cú pháp: ${prefix}${effectiveAlias} <biển số> [loại xe]\n` +
          `• Loại xe: 1 = Ô tô, 2 = Xe máy (để trống sẽ tự nhận diện)\n` +
          `Ví dụ: ${prefix}${effectiveAlias} 30A-123.45 hoặc ${prefix}${effectiveAlias} 29B1-2345 2`,
      },
      true,
      60000
    );
    return;
  }

  const tokens = keyword.trim().split(/\s+/);
  const lastToken = tokens[tokens.length - 1];
  const explicitType = tokens.length > 1 && ["1", "2", "3"].includes(lastToken);

  let rawPlateText;
  let loaiXe;
  if (explicitType) {
    rawPlateText = tokens.slice(0, -1).join(" ");
    loaiXe = Number(lastToken) === 3 ? 2 : Number(lastToken);
  } else {
    rawPlateText = tokens.join(" ");
    loaiXe = detectVehicleType(rawPlateText);
  }

  const bienSo = rawPlateText.replace(/[-./\s]/g, "").toUpperCase();

  if (!isValidLicensePlate(bienSo)) {
    await sendMessageFromSQL(
      api,
      msgCtx,
      {
        success: false,
        message: `Biển số "${rawPlateText}" không hợp lệ! Vui lòng kiểm tra lại.`,
      },
      true,
      30000
    );
    return;
  }

  try {
    const { violations, source } = await getPhatNguoiInfo(bienSo, loaiXe);
    const vehicleLabel = `${loaiXe === 1 ? "Ô tô" : "Xe máy"} (${explicitType ? "Chỉ định" : "Tự động nhận diện"})`;

    if (violations.length === 0) {
      await sendMessageFromSQL(
        api,
        msgCtx,
        {
          success: true,
          message:
            `✅ Biển số ${bienSo} hiện KHÔNG có vi phạm phạt nguội nào!\n` +
            `🚗 Loại xe: ${vehicleLabel}\n` +
            `🌐 Nguồn: ${source}`,
        },
        true,
        300000
      );
      return;
    }

    const headerMessage =
      `🚔 THÔNG TIN PHẠT NGUỘI (${violations.length} vi phạm)\n` +
      `📝 Biển số: ${violations[0].bienSo || bienSo}\n` +
      `🚗 Loại xe: ${violations[0].loaiXe || vehicleLabel}\n` +
      (violations[0].mauBien ? `🎨 Màu biển: ${violations[0].mauBien}\n` : "");

    const BATCH_SIZE = 2;
    const totalBatches = Math.ceil(violations.length / BATCH_SIZE);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const start = batchIdx * BATCH_SIZE;
      const slice = violations.slice(start, start + BATCH_SIZE);
      let chunk = batchIdx === 0 ? headerMessage : `📄 Tiếp theo (${batchIdx + 1}/${totalBatches}):\n`;

      slice.forEach((v, offset) => {
        chunk += formatViolation(v, start + offset);
      });

      if (batchIdx === totalBatches - 1) {
        chunk += `\n🌐 Nguồn: ${source}`;
      } else {
        chunk += `\n⏳ Còn tiếp...`;
      }

      await sendMessageFromSQL(
        api,
        msgCtx,
        { success: true, message: chunk },
        true,
        1800000
      );
    }
  } catch (error) {
    await sendMessageFromSQL(
      api,
      msgCtx,
      {
        success: false,
        message: `Không thể tra cứu phạt nguội lúc này (${error?.message || "Lỗi kết nối"}). Vui lòng thử lại sau!`,
      },
      true,
      30000
    );
  }
}
