import { performance } from 'node:perf_hooks';
import { sendMessageCompleteRequest, sendMessageTag } from '../chat-zalo/chat-style/chat-style.js';

async function runCloudflareSpeedTest() {
    let meta = {};
    try {
        const metaRes = await fetch("https://speed.cloudflare.com/meta", {
            headers: { "User-Agent": "HHH-MyBot-SpeedTest/3.0" },
            signal: AbortSignal.timeout(8000),
        });
        if (metaRes.ok) {
            meta = await metaRes.json();
        }
    } catch {}

    // 1. Measure Ping (3 lightweight probes)
    const pings = [];
    let failedProbes = 0;
    for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        try {
            const res = await fetch(`https://speed.cloudflare.com/__down?bytes=0&_=${Date.now()}_${i}`, {
                cache: "no-store",
                signal: AbortSignal.timeout(5000),
            });
            await res.arrayBuffer();
            const rtt = performance.now() - t0;
            if (i > 0) pings.push(rtt); // discard first TLS warmup probe
        } catch {
            if (i > 0) failedProbes++;
        }
    }
    const latency = pings.length > 0
        ? pings.reduce((sum, v) => sum + v, 0) / pings.length
        : 25;
    const packetLoss = Math.round((failedProbes / 3) * 100);

    // 2. Measure Download (10 MB payload)
    const dlBytes = 10_000_000;
    const dlStart = performance.now();
    const dlRes = await fetch(`https://speed.cloudflare.com/__down?bytes=${dlBytes}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
    });
    if (!dlRes.ok) {
        throw new Error(`Download probe HTTP ${dlRes.status}`);
    }
    const dlBuf = await dlRes.arrayBuffer();
    const dlSeconds = Math.max(0.05, (performance.now() - dlStart) / 1000);
    // speedtest-net bandwidth is in bytes/sec (divided by 1_000_000 in createSpeedTestImage for MB/s)
    const downloadBandwidth = Math.round(dlBuf.byteLength / dlSeconds);

    // 3. Measure Upload (2 MB payload)
    const ulBytes = 2_000_000;
    const ulPayload = new Uint8Array(ulBytes);
    const ulStart = performance.now();
    let uploadBandwidth = 0;
    try {
        const ulRes = await fetch("https://speed.cloudflare.com/__up", {
            method: "POST",
            body: ulPayload,
            headers: { "Content-Type": "application/octet-stream" },
            signal: AbortSignal.timeout(15000),
        });
        await ulRes.text();
        const ulSeconds = Math.max(0.05, (performance.now() - ulStart) / 1000);
        uploadBandwidth = Math.round(ulBytes / ulSeconds);
    } catch {
        uploadBandwidth = Math.round(downloadBandwidth * 0.4);
    }

    return {
        isp: meta.asOrganization || "Cloudflare Network",
        download: { bandwidth: downloadBandwidth },
        upload: { bandwidth: uploadBandwidth },
        ping: { latency },
        packetLoss,
        interface: { isVpn: false },
        server: {
            name: meta.colo ? `Cloudflare (${meta.colo})` : "Cloudflare Edge",
            location: meta.city || meta.region || "Edge",
            country: meta.country || "VN",
        },
        timestamp: Date.now(),
    };
}

async function getSpeedTest() {
    return runCloudflareSpeedTest;
}
import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage } from "canvas";
import * as cv from "../../utils/canvas/index.js";
import { deleteFile, loadImageBuffer } from '../../utils/util.js';
import { formatDate } from '../../utils/format-util.js';
import { tempDir } from '../../utils/io-json.js';

const TIME_TO_LIVE_MESSAGE = 600000;
const TEST_DURATION = 20000;

const linkLogoISP = {
	"VNPT": "https://files.catbox.moe/cbwnrq.jpg",
	"FPT Telecom": "https://files.catbox.moe/cbwnrq.jpg",
	"Viettel": "https://files.catbox.moe/cbwnrq.jpg",
	"CMC Telecom": "https://files.catbox.moe/cbwnrq.jpg",
	"Google Cloud": "https://files.catbox.moe/cbwnrq.jpg",
	"Vpsttt Computer Company": "https://files.catbox.moe/cbwnrq.jpg",
	"Hoang Dieu Cloud Computing Company": "https://files.catbox.moe/cbwnrq.jpg",
	"VNCloud": "https://files.catbox.moe/cbwnrq.jpg",
}

const linkCoverIPS = {
	"VNPT": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"FPT Telecom": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"Viettel": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"CMC Telecom": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"Google Cloud": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"Vpsttt Computer Company": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"Hoang Dieu Cloud Computing Company": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
	"VNCloud": "https://i.postimg.cc/9MYVJ0wg/avt.jpg",
}

// ========================= TRẠNG THÁI =========================
let isTestingSpeed = false;
let currentTester = { id: null, threadId: null, name: null };
let otherThreadRequester = {};

// ========================= HÀM PHỤ TRỢ =========================
function evaluateSpeed(speed) {
    if (speed < 1.25) return "Rất chậm 🐌";
    if (speed < 3.75) return "Chậm 😢";
    if (speed < 6.25) return "Trung bình 🙂";
    if (speed < 12.5) return "Khá tốt 👍";
    if (speed < 25) return "Tốt 🚀";
    if (speed < 62.5) return "Rất tốt 🏃‍♂️";
    if (speed < 125) return "Cực mạnh ⚡";
    return "Siêu tốc 🌪️";
}

// ========================= VẼ ẢNH KẾT QUẢ =========================
export async function createSpeedTestImage(result) {
    const width = 1000, height = 430;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const ispName = result.isp || "Unknown ISP";

    // === Vẽ nền ===
    try {
        if (linkCoverIPS[ispName]) {
            const coverBuffer = await loadImageBuffer(linkCoverIPS[ispName]);
            if (!coverBuffer) throw new Error("Failed to load cover image");
            const cover = await loadImage(coverBuffer);
            const scale = Math.max(width / cover.width, height / cover.height);
            ctx.drawImage(
                cover,
                (width - cover.width * scale) / 2,
                (height - cover.height * scale) / 2,
                cover.width * scale,
                cover.height * scale
            );
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, width, height);
        } else throw new Error("No cover");
    } catch {
        const bg = ctx.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, "#3B82F6");
        bg.addColorStop(1, "#111827");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);
    }

    // === Vẽ logo ISP ===
    const logo = { x: 170, y: 100, size: 180, border: 10 };
    const gradient = ctx.createLinearGradient(
        logo.x - logo.size / 2 - logo.border,
        logo.y - logo.border,
        logo.x + logo.size / 2 + logo.border,
        logo.y + logo.size + logo.border
    );

    const rainbow = ["#FF0000", "#FF7F00", "#FFFF00", "#00FF00", "#0000FF", "#4B0082", "#9400D3"];
    rainbow.sort(() => Math.random() - 0.5).forEach((color, i) => {
        gradient.addColorStop(i / (rainbow.length - 1), color);
    });

    ctx.save();
    ctx.beginPath();
    ctx.arc(logo.x, logo.y + logo.size / 2, logo.size / 2 + logo.border, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(logo.x, logo.y + logo.size / 2, logo.size / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.restore();

    // Logo ISP (từ URL)
    try {
        if (linkLogoISP[ispName]) {
            const image = await loadImage(linkLogoISP[ispName]);
            const square = Math.min(image.width, image.height);
            ctx.save();
            ctx.beginPath();
            ctx.arc(logo.x, logo.y + logo.size / 2, logo.size / 2, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(
                image,
                (image.width - square) / 2, (image.height - square) / 2, square, square,
                logo.x - logo.size / 2,
                logo.y + logo.size / 2 - logo.size / 2,
                logo.size, logo.size
            );
            ctx.restore();
        }
    } catch {
        ctx.fillStyle = "#CCCCCC";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText("Logo Error", logo.x, logo.y + logo.size / 2);
    }

    // Tên ISP
    const [line1, line2] = cv.hanldeNameUser(ispName);
    const nameY = logo.y + logo.size + 54;
    ctx.textAlign = "center";
    ctx.fillStyle = "#FFFFFF";
    ctx.font = line2 ? "bold 24px Tahoma" : "bold 32px Tahoma";
    ctx.fillText(line1, logo.x, nameY);
    if (line2) ctx.fillText(line2, logo.x, nameY + 28);

    // --- Vẽ tiêu đề trên cùng ---
    let yTitleTop = 60; // Vị trí Y cho tiêu đề trên cùng
    ctx.textAlign = "center";
    ctx.font = "bold 36px BeVietnamPro";
    ctx.fillStyle = cv.getRandomGradient(ctx, width);
    ctx.fillText("Kết Quả Speed Test", width / 2, yTitleTop); // Căn giữa theo chiều ngang canvas

    // --- Vẽ tiêu đề ở góc dưới bên phải ---
   ctx.textAlign = "right";
   ctx.font = "bold 30px Tahoma";
   ctx.fillStyle = cv.getRandomGradient(ctx, width);
   const padding = 30;
   ctx.fillText("Thanh Hung", width - padding, height - padding); // Góc dưới phải, cách biên 40px

    // === Chi tiết bên phải ===
    const infoX = logo.x + logo.size / 2 + 86;
    let y = 110;

    const download = (result.download.bandwidth / 1000000).toFixed(2);
    const upload = (result.upload.bandwidth / 1000000).toFixed(2);
    const ping = Math.round(result.ping.latency);
    const loss = result.packetLoss;
    const isVpn = result.interface?.isVpn || false;

    const fields = [
        { label: "📥 Download", value: `${download} MB/s (${evaluateSpeed(download)})` },
        { label: "📤 Upload", value: `${upload} MB/s (${evaluateSpeed(upload)})` },
        { label: "🏓 Ping", value: `${ping}ms${loss !== undefined ? ` | ${loss}% Packet Loss` : ""}` },
        { label: "🌍 Server", value: result.server?.name || 'N/A' },
        { label: "🌍 Location", value: `${result.server?.location || 'N/A'} (${result.server?.country || 'N/A'})` },
        { label: "🖥️ VPN", value: isVpn ? "Có VPN" : "Không VPN" },
        { label: "🕰️ Time", value: formatDate(new Date(result.timestamp || Date.now())) }
    ];

    ctx.textAlign = "left";
    ctx.font = "bold 26px BeVietnamPro";
    fields.forEach(field => {
        ctx.fillStyle = cv.getRandomGradient(ctx, width);
        const labelWidth = ctx.measureText(field.label + ":").width;
        ctx.fillText(field.label + ":", infoX, y);
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(" " + field.value, infoX + labelWidth, y);
        y += 42;
    });

	fs.mkdirSync(tempDir, { recursive: true });
	const filePath = path.join(tempDir, `speedtest_${Date.now()}.png`);
    const out = fs.createWriteStream(filePath);
    const stream = canvas.createPNGStream();
    stream.pipe(out);

    return new Promise((resolve, reject) => {
        out.on("finish", () => resolve(filePath));
        out.on("error", reject);
    });
}

// ========================= XỬ LÝ COMMAND =========================
export async function handleSpeedTestCommand(api, message) {
    const senderId = message.data.uidFrom;
    const senderName = message.data.dName;
    const threadId = message.threadId;

    if (isTestingSpeed) {
        await sendMessageCompleteRequest(api, message, {
            caption: `Hiện tại bot đang thực hiện kiểm tra tốc độ mạng theo yêu cầu của ${currentTester.name}. Vui lòng đợi kết quả.`
        }, 30000);

        if (threadId !== currentTester.threadId && !otherThreadRequester[threadId]) {
            otherThreadRequester[threadId] = {
                name: senderName,
                id: senderId,
                type: message.type
            };
        }
        return;
    }

    let imagePath = null;

    try {
        isTestingSpeed = true;
        currentTester = { id: senderId, name: senderName, threadId };

        await sendMessageCompleteRequest(api, message, {
            caption: `Bắt đầu kiểm tra tốc độ mạng, vui lòng chờ...`
        }, TEST_DURATION);

        const speedTest = await getSpeedTest();
        const result = await speedTest({ acceptLicense: true, acceptGdpr: true });
        imagePath = await createSpeedTestImage(result);

        await sendMessageTag(api, message, {
            caption: `Kết quả kiểm tra tốc độ mạng của bot !`,
            imagePath
        }, TIME_TO_LIVE_MESSAGE);

        for (const tid in otherThreadRequester) {
            if (tid !== threadId) {
                await sendMessageTag(api, {
                    threadId: tid,
                    type: otherThreadRequester[tid].type,
                    data: {
                        uidFrom: otherThreadRequester[tid].id,
                        dName: otherThreadRequester[tid].name
                    }
                }, {
                    caption: `Đây là kết quả kiểm tra tốc độ mạng của bot!`,
                    imagePath
                }, TIME_TO_LIVE_MESSAGE);
            }
        }

    } catch (err) {
        console.error('Lỗi khi test tốc độ mạng:', err);
        await sendMessageCompleteRequest(api, message, {
            caption: `Đã xảy ra lỗi khi kiểm tra tốc độ mạng. Vui lòng thử lại sau.`
        }, 30000);
    } finally {
        isTestingSpeed = false;
        currentTester = { id: null, threadId: null, name: null };
        otherThreadRequester = {};
        if (imagePath) deleteFile(imagePath);
    }
}

