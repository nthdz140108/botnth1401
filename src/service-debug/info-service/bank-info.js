import crypto from "node:crypto";
import { extractCommandBody } from "../../commands/shared/command-input-utils.js";
import { sendMessageFromSQL } from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import { deleteFile } from "../../utils/util.js";
import { tempDir } from "../../utils/io-json.js";
import { ensureCanvasFontsRegistered } from "../../utils/canvas/register-fonts.js";
import { MessageMention } from "../../api-zalo/index.js";
import { getUserInfoData } from "./user-info.js";

const BANK_CODES = {
    "vcb": { bin: "970436", name: "VIETCOMBANK" },
    "vietcombank": { bin: "970436", name: "VIETCOMBANK" },
    "tcb": { bin: "970407", name: "TECHCOMBANK" },
    "techcombank": { bin: "970407", name: "TECHCOMBANK" },
    "mb": { bin: "970422", name: "MB BANK" },
    "mbbank": { bin: "970422", name: "MB BANK" },
    "mb bank": { bin: "970422", name: "MB BANK" },
    "acb": { bin: "970416", name: "ACB" },
    "vib": { bin: "970441", name: "VIB" },
    "bidv": { bin: "970418", name: "BIDV" },
    "vietinbank": { bin: "970415", name: "VIETINBANK" },
    "vtb": { bin: "970415", name: "VIETINBANK" },
    "tpbank": { bin: "970423", name: "TPBANK" },
    "vpbank": { bin: "970432", name: "VPBANK" },
    "agribank": { bin: "970405", name: "AGRIBANK" },
    "sacombank": { bin: "970403", name: "SACOMBANK" },
    "scb": { bin: "970429", name: "SCB" },
    "hdbank": { bin: "970437", name: "HDBANK" },
    "ocb": { bin: "970448", name: "OCB" },
    "msb": { bin: "970426", name: "MSB" },
    "maritimebank": { bin: "970426", name: "MSB" },
    "shb": { bin: "970443", name: "SHB" },
    "eximbank": { bin: "970431", name: "EXIMBANK" },
    "exim": { bin: "970431", name: "EXIMBANK" },
    "dongabank": { bin: "970406", name: "DONGABANK" },
    "dab": { bin: "970406", name: "DONGABANK" },
    "pvcombank": { bin: "970412", name: "PVCOMBANK" },
    "gpbank": { bin: "970408", name: "GPBANK" },
    "oceanbank": { bin: "970414", name: "OCEANBANK" },
    "namabank": { bin: "970428", name: "NAMABANK" },
    "ncb": { bin: "970419", name: "NCB" },
    "vietabank": { bin: "970427", name: "VIETABANK" },
    "vietbank": { bin: "970433", name: "VIETBANK" },
    "vrb": { bin: "970421", name: "VRB" },
    "wooribank": { bin: "970457", name: "WOORIBANK" },
    "uob": { bin: "970458", name: "UOB" },
    "standardchartered": { bin: "970410", name: "STANDARD CHARTERED" },
    "publicbank": { bin: "970439", name: "PUBLIC BANK" },
    "shinhanbank": { bin: "970424", name: "SHINHAN BANK" },
    "hsbc": { bin: "458761", name: "HSBC" },
    "coop": { bin: "970446", name: "COOPBANK" },
    "coopbank": { bin: "970446", name: "COOPBANK" },
    "lienvietpostbank": { bin: "970449", name: "LIENVIETPOSTBANK" },
    "lvb": { bin: "970449", name: "LIENVIETPOSTBANK" },
    "baovietbank": { bin: "970438", name: "BAOVIETBANK" },
    "bvb": { bin: "970438", name: "BAOVIETBANK" }
};

function findAccountNumber(text) {
    const numbers = text.match(/\d+/g);
    if (!numbers) return null;

    return numbers[0];
}

function findBankCode(text) {
    const words = text.toLowerCase().split(/[\s,.-]+/);

    for (const word of words) {
        if (BANK_CODES[word]) {
            return {
                bin: BANK_CODES[word].bin,
                name: BANK_CODES[word].name,
                word
            };
        }
    }
    return null;
}

function normalizeAccountName(name) {
    const vietnameseMap = {
        'Đ': 'D',
        'đ': 'd'
    };

    return name
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[ĐĐ]/g, m => vietnameseMap[m] || m)
}

function normalizeDescription(name) {
    const vietnameseMap = {
        'Đ': 'D',
        'đ': 'd'
    };

    return name
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[ĐĐ]/g, m => vietnameseMap[m] || m)
        .replace(/[^A-Z0-9\s]/g, "");
}
function normalizeString(name) {
    const vietnameseMap = {
        'Đ': 'D',
        'đ': 'd'
    };

    return name
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[ĐĐ]/g, m => vietnameseMap[m] || m);
}

export function generateVietQRLink(bankInfo, accountNumber, accountName, amount = 0, addInfo = "") {
    const baseUrl = "https://img.vietqr.io/image";
    const template = "qr_only";
    const numericAmount = Number(amount) > 0 ? Math.floor(Number(amount)) : 0;
    const encodedAccountName = encodeURIComponent(accountName && accountName !== "---" ? accountName : "");
    const encodedAddInfo = encodeURIComponent(addInfo || "");
    return `${baseUrl}/${bankInfo.bin}-${encodeURIComponent(accountNumber)}-${template}.jpg?accountName=${encodedAccountName}&amount=${numericAmount}&addInfo=${encodedAddInfo}`;
}

function matchBankPrefix(tokens, startIndex = 0) {
    if (startIndex + 1 < tokens.length) {
        const twoWord = `${tokens[startIndex]} ${tokens[startIndex + 1]}`.toLowerCase();
        if (BANK_CODES[twoWord]) {
            return { bankInfo: { ...BANK_CODES[twoWord], word: twoWord }, consumed: 2 };
        }
    }
    if (startIndex < tokens.length) {
        const oneWord = tokens[startIndex].toLowerCase().replace(/^[,.-]+|[,.-]+$/g, "");
        if (BANK_CODES[oneWord]) {
            return { bankInfo: { ...BANK_CODES[oneWord], word: oneWord }, consumed: 1 };
        }
    }
    return null;
}

export function parseBankTransferInput(rawInput) {
    const pipeIndex = rawInput.indexOf("|");
    const mainSegment = (pipeIndex >= 0 ? rawInput.slice(0, pipeIndex) : rawInput).trim();
    const rawAccountName = pipeIndex >= 0 ? rawInput.slice(pipeIndex + 1).trim() : "";
    const accountName = rawAccountName ? normalizeAccountName(rawAccountName) : "---";

    const tokens = mainSegment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return { bankInfo: null, accountNumber: null, amount: 0, description: "", accountName };
    }

    let bankInfo = null;
    let accountNumber = null;
    let restStartIndex = 0;

    // 1. Positional <bank> <account> [amount] [addInfo]
    const bankFirst = matchBankPrefix(tokens, 0);
    if (bankFirst) {
        bankInfo = bankFirst.bankInfo;
        const candidateAccount = tokens[bankFirst.consumed] || "";
        if (/^\d{4,25}$/.test(candidateAccount)) {
            accountNumber = candidateAccount;
            restStartIndex = bankFirst.consumed + 1;
        } else {
            return { bankInfo, accountNumber: null, amount: 0, description: "", accountName };
        }
    } else if (/^\d{4,25}$/.test(tokens[0])) {
        // 2. Fallback <account> <bank> [amount] [addInfo]
        accountNumber = tokens[0];
        const bankSecond = matchBankPrefix(tokens, 1);
        if (bankSecond) {
            bankInfo = bankSecond.bankInfo;
            restStartIndex = 1 + bankSecond.consumed;
        } else {
            return { bankInfo: null, accountNumber, amount: 0, description: "", accountName };
        }
    } else {
        const fallbackAcc = findAccountNumber(mainSegment);
        const fallbackBank = findBankCode(mainSegment);
        return { bankInfo: fallbackBank, accountNumber: fallbackAcc, amount: 0, description: "", accountName };
    }

    let amount = 0;
    let descStartIndex = restStartIndex;
    const maybeAmountToken = tokens[restStartIndex];
    if (maybeAmountToken !== undefined && /^\d+$/.test(maybeAmountToken)) {
        amount = Number(maybeAmountToken);
        descStartIndex = restStartIndex + 1;
    }

    const rawDescription = tokens.slice(descStartIndex).join(" ").trim();
    const description = rawDescription ? normalizeDescription(rawDescription) : "";

    return {
        bankInfo,
        accountNumber,
        amount: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0,
        description,
        accountName,
    };
}

async function loadImageWithRetry(url, maxRetries = 3, timeout = 10000) {
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                timeout: timeout
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const buffer = await response.arrayBuffer();
            clearTimeout(timeoutId);

            return await loadImage(Buffer.from(buffer));
        } catch (error) {
            lastError = error;
            console.error(`Lần thử ${i + 1} thất bại:`, error);
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
        }
    }
    throw lastError;
}

async function createBankCardImage(bankInfo, accountNumber, accountName, amount, description, qrCodeUrl, userInfo) {
    ensureCanvasFontsRegistered();
    const width = 1000;
    const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    try {
        // Vẽ avatar làm background
        let backgroundImage;
        try {
            backgroundImage = await loadImageWithRetry(userInfo.avatar);
            ctx.filter = 'blur(8px)';
            ctx.drawImage(backgroundImage, 0, 0, width, height);
            ctx.filter = 'none';
        } catch (error) {
            console.error("Lỗi khi load avatar:", error);
            const gradient = ctx.createLinearGradient(0, 0, width, height);
            gradient.addColorStop(0, "#1a237e");
            gradient.addColorStop(1, "#0d47a1");
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);
        }

        const overlay = ctx.createLinearGradient(0, 0, width, height);
        overlay.addColorStop(0, "rgba(26, 35, 126, 0.3)");
        overlay.addColorStop(1, "rgba(13, 71, 161, 0.3)");
        ctx.fillStyle = overlay;
        ctx.fillRect(0, 0, width, height);

        const qrImage = await loadImageWithRetry(qrCodeUrl);

        const qrSize = 300;
        const qrPadding = 50;

        // Vẽ khung cho QR code
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 15;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 5;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(qrPadding - 10, (height - qrSize) / 2 - 10, qrSize + 20, qrSize + 20);
        ctx.restore();

        // Vẽ QR code
        ctx.drawImage(qrImage, qrPadding, (height - qrSize) / 2, qrSize, qrSize);

        // Vẽ đường phân cách
        ctx.beginPath();
        ctx.moveTo(qrSize + qrPadding * 2, 50);
        ctx.lineTo(qrSize + qrPadding * 2, height - 50);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Vẽ thông tin ngân hàng
        ctx.textAlign = "left";
        const infoX = qrSize + qrPadding * 3;
        let infoY = 82;
        const lineHeight = 50;

        // Tạo gradient cho text
        const textGradient = ctx.createLinearGradient(infoX, 0, width - 50, 0);
        textGradient.addColorStop(0, "#ffd700");
        textGradient.addColorStop(1, "#ffeb3b");

        // Vẽ tiêu đề
        ctx.font = "bold 32px BeVietnamPro";
        ctx.fillStyle = textGradient;
        ctx.fillText("THÔNG TIN CHUYỂN KHOẢN", infoX, infoY);
        infoY += lineHeight;

        // Vẽ thông tin chi tiết
        ctx.font = "bold 28px BeVietnamPro";
        ctx.fillStyle = "#ffffff";

        const numericAmount = Number(amount);
        const formattedAmount = Number.isFinite(numericAmount) && numericAmount > 0
            ? `${numericAmount.toLocaleString("vi-VN")} VNĐ`
            : "Không có";

        const fields = [
            { label: "Ngân hàng:", value: bankInfo.name },
            { label: "Số tài khoản:", value: accountNumber },
            { label: "Chủ tài khoản:", value: accountName },
            { label: "Số tiền:", value: formattedAmount },
            { label: "Nội dung:", value: description ? (description.length > 24 ? description.substring(0, 24) + "..." : description) : "Không có" }
        ];

        fields.forEach(field => {
            ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
            ctx.fillText(field.label, infoX, infoY);

            const labelWidth = ctx.measureText(field.label).width;
            ctx.fillStyle = "#ffffff";
            ctx.fillText(field.value, infoX + labelWidth + 15, infoY);

            infoY += lineHeight;
        });

        // Lưu canvas thành file ảnh
        const filePath = path.join(tempDir, `bank_card_${crypto.randomUUID()}.png`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const out = fs.createWriteStream(filePath);
        const stream = canvas.createPNGStream();
        stream.pipe(out);

        return new Promise((resolve, reject) => {
            out.on("finish", () => resolve(filePath));
            out.on("error", reject);
        });
    } catch (error) {
        console.error("Lỗi khi tạo ảnh bank card:", error);
        return null;
    }
}

export async function handleBankInfoCommand(api, message, aliasCommand) {
    const prefixGlobal = getGlobalPrefix();
    const senderName = message.data.dName;
    const senderId = message.data.uidFrom;
    const stringCommand = extractCommandBody(message, prefixGlobal, aliasCommand || "qrbank");
    let imagePath = "";
    try {

        if (!stringCommand) {
            const result = {
                success: false,
                message: `Vui lòng nhập thông tin ngân hàng theo định dạng:\n${prefixGlobal}qrbank <Tên ngân hàng> <Số tài khoản> [Số tiền] [Nội dung chuyển khoản | Chủ TK]`
            };
            await sendMessageFromSQL(api, message, result, false, 15000);
            return;
        }

        const parsed = parseBankTransferInput(stringCommand);
        if (!parsed.accountNumber) {
            const result = {
                success: false,
                message: `Không tìm thấy số tài khoản hợp lệ. Cú pháp: ${prefixGlobal}qrbank <Tên ngân hàng> <Số tài khoản> [Số tiền] [Nội dung]`
            };
            await sendMessageFromSQL(api, message, result, false, 15000);
            return;
        }

        if (!parsed.bankInfo) {
            const words = stringCommand.toLowerCase().split(/\s+/);
            const suggestions = Object.entries(BANK_CODES)
                .filter(([key]) => {
                    const bankName = key.toLowerCase();
                    return words.some(word =>
                        word && !/^\d+$/.test(word) && (bankName.includes(word) || word.includes(bankName))
                    );
                })
                .map(([_, info]) => info.name)
                .slice(0, 5);

            const uniqueSuggestions = [...new Set(suggestions)];
            const suggestionText = uniqueSuggestions.length > 0
                ? `\nCác ngân hàng gần giống:\n${uniqueSuggestions.join('\n')}`
                : '';

            const result = {
                success: false,
                message: `Không tìm thấy tên ngân hàng hợp lệ trong nội dung.${suggestionText}\nVí dụ: ${prefixGlobal}qrbank mb 0123456789 500000 thanh toan don 2026`
            };
            await sendMessageFromSQL(api, message, result, false, 15000);
            return;
        }

        const { bankInfo, accountNumber, amount, description, accountName } = parsed;
        const vietQRLink = generateVietQRLink(bankInfo, accountNumber, accountName, amount, description);
        const userInfo = (await getUserInfoData(api, senderId)) || { name: senderName, avatar: "" };

        imagePath = await createBankCardImage(bankInfo, accountNumber, accountName, amount, description, vietQRLink, userInfo);

        if (!imagePath) {
            const result = {
                success: false,
                message: "Đã xảy ra lỗi khi tạo ảnh thông tin ngân hàng."
            };
            await sendMessageFromSQL(api, message, result, true, 15000);
            return;
        }

        await api.sendMessage({
            msg: `${senderName} đây là QR chuyển khoản mà bạn cần!!!`,
            attachments: [imagePath],
            mentions: [MessageMention(senderId, senderName.length, 0)]
        }, message.threadId, message.type);

    } catch (error) {
        console.error("Lỗi khi xử lý lệnh bankinfo:", error);
        const result = {
            success: false,
            message: `Đã xảy ra lỗi khi xử lý thông tin ngân hàng.`
        };
        await sendMessageFromSQL(api, message, result, true, 15000);
    } finally {
        if (imagePath) {
            await deleteFile(imagePath);
        }
    }
}
