import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';
import path from 'path';
import { sendMessageCompleteRequest, sendMessageWarningRequest } from '../chat-zalo/chat-style/chat-style.js';
import { tempDir } from '../../utils/io-json.js';
import { getGlobalPrefix } from '../service.js';
import { extractCommandBody } from '../../commands/shared/command-input-utils.js';
import { deleteFile } from '../../utils/util.js';

function selectErrorCorrectionLevel(text) {
  const str = String(text || '');
  const byteLength = Buffer.byteLength(str, 'utf8');
  if (str.length > 1600 || byteLength > 1800) {
    return 'L';
  }
  if (str.length > 800 || byteLength > 900) {
    return 'M';
  }
  return 'H';
}

function writeQRCodeToFile(qrPath, text, errorCorrectionLevel) {
  const options = {
    errorCorrectionLevel,
    type: 'image/png',
    quality: 0.92,
    margin: 1,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  };

  return new Promise((resolve, reject) => {
    QRCode.toFile(qrPath, text, options, (err) => {
      if (err) reject(err);
      else resolve(qrPath);
    });
  });
}

/**
 * Tạo QR code từ text
 * @param {string} text Nội dung cần tạo QR
 * @returns {Promise<string>} Đường dẫn đến file QR được tạo
 */
export async function generateQRCode(text) {
  fs.mkdirSync(tempDir, { recursive: true });
  const qrPath = path.join(tempDir, `qr_${crypto.randomUUID()}.png`);
  const preferredLevel = selectErrorCorrectionLevel(text);

  try {
    return await writeQRCodeToFile(qrPath, text, preferredLevel);
  } catch (err) {
    if (preferredLevel !== 'L') {
      return await writeQRCodeToFile(qrPath, text, 'L');
    }
    throw err;
  }
}

/**
 * Xử lý lệnh tạo QR code
 */
export async function handleCreateQRCommand(api, message, aliasCommand) {
  const prefix = getGlobalPrefix();
  let text = extractCommandBody(message, prefix, aliasCommand);
  let qrPath = null;

  try {
    const quote = message.data?.quote;
    if (quote) {
      if (!text) {
        try {
          const parseMessage = JSON.parse(quote.attach);
          text = parseMessage.href || parseMessage.title || quote.msg || null;
        } catch (error) {
          text = quote.msg || null;
        }
      }
    }

    if (!text) {
      const object = {
        caption: `Vui lòng nhập nội dung cần tạo QR code hoặc reply tin nhắn chứa nội dung hợp lệ hoặc link.\nVí dụ: ${prefix}${aliasCommand} Nội dung cần tạo QR`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    qrPath = await generateQRCode(text);

    const object = {
      caption: `Đây là mã QR được tạo từ nội dung bạn yêu cầu!`,
      imagePath: qrPath,
    };

    await sendMessageCompleteRequest(api, message, object, 600000);

  } catch (error) {
    console.error("Lỗi khi tạo QR code:", error);
    const object = {
      caption: "Đã xảy ra lỗi khi tạo mã QR, vui lòng thử lại sau.",
    };
    await sendMessageWarningRequest(api, message, object, 30000);
  } finally {
    if (qrPath) await deleteFile(qrPath);
  }
}
