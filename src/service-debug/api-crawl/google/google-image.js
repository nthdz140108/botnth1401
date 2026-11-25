import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { MessageMention } from "../../../api-zalo/models/index.js";
import { getGlobalPrefix } from "../../service.js";
import { tempDir } from "../../../utils/io-json.js";
import { deleteFile, downloadFile } from "../../../utils/util.js";
import {
	extractCommandBody,
	safeThreadType,
} from "../../../commands/shared/command-input-utils.js";

const CONFIG = {
	paths: {
		saveDir: tempDir,
	},
	download: {
		maxAttempts: 6,
		timeout: 8000,
		minSize: 1024,
	},
	messages: {
		noQuery: (name, prefix, command) =>
			`${name} Vui lòng nhập từ khóa tìm kiếm. Ví dụ: ${prefix}${command} phong cảnh thiên nhiên`,
		searchResult: (name, query) => `[${name}] [${query}]`,
		downloadFailed: (name, attempts) =>
			`${name} Không thể tải ảnh sau ${attempts} lần thử. Vui lòng thử lại sau.`,
		noResults: (name) => `${name} Không tìm thấy ảnh phù hợp. Vui lòng thử từ khóa khác.`,
		apiError: (name) => `${name} Đã xảy ra lỗi khi tìm kiếm ảnh, vui lòng thử lại sau.`,
		bannedKeyword: (name) => `${name} Từ khóa tìm kiếm này không được phép sử dụng!`,
	},
	headers: {
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	},
	bannedKeywords: [
		// Từ nhạy cảm tiếng Việt (giữ dấu chính xác để không chặn nhầm từ thông dụng như chim, du lịch, vũ trụ, mong ước)
		"lồn", "l0n", "l.on", "l*n", "loz", "l0z", "l.z",
		"ngực trần", "khoe ngực", "lộ ngực", "nguwc",
		"vú", "vếu", "veu", "dú",
		"cặc", "cak", "kak", "cặk", "cứt", "shit",
		"buồi", "b`uoi", "b.uoi",
		"địt", "đụ", "đ!t", "đyt", "dyt", "đéo",
		"nứng", "bím", "b!m", "bịm", "bym",
		"ch1m", "chym",
		"m0ng", "m.ong", "khoe mông", "lộ mông",

		// Từ nhạy cảm tiếng Anh
		"porn", "pornhub", "xxx", "18+",
		"dick", "cock", "penis", "pussy", "vagina", "boob", "boobs", "breast",
		"nude", "naked", "hentai", "nsfw", "erotic",
		"fuck", "fucking", "fck", "fuk", "fuking", "horny",

		// Cụm từ nhạy cảm
		"khiêu dâm", "khieu dam", "làm tình", "lam tinh",
		"gái gọi", "gai goi", "gái ngành", "gai nganh",
		"phim sex", "clip sex", "anh sex", "ảnh sex", "sex",
		"bộ ngực", "vú to", "vu to",
		"show hàng", "show hang", "lộ hàng", "lo hang",
		"không mặc đồ", "khong mac do", "cởi đồ", "coi do",

		// Biến thể và viết tắt
		"đm", "vcl", "vlxx", "vlxxx",
		"đcm", "dcm", "cmm", "đcmm",
		"s3x", "sexx", "sẽx", "sẽxx",
	],
};

function escapeRegExp(str) {
	return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsBannedKeyword(query) {
	const normalized = String(query || "").normalize("NFC").toLowerCase().trim();
	if (!normalized) return false;

	for (const rawKw of CONFIG.bannedKeywords) {
		const kw = String(rawKw || "").normalize("NFC").toLowerCase().trim();
		if (!kw) continue;
		const pattern = kw
			.split(/\s+/)
			.map(escapeRegExp)
			.join("\\s+");
		const regex = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "iu");
		if (regex.test(normalized)) {
			return true;
		}
	}
	return false;
}

function isUsableImageUrl(url) {
	if (typeof url !== "string") return false;
	const trimmed = url.trim();
	if (!/^https?:\/\//i.test(trimmed)) return false;
	if (
		trimmed.startsWith("https://encrypted-tbn0.gstatic.com") ||
		trimmed.includes("gstatic.com/images") ||
		trimmed.includes("google.com/logos")
	) {
		return false;
	}
	return true;
}

async function searchGoogleImages(query) {
	try {
		const params = new URLSearchParams({
			q: query,
			tbm: "isch",
			hl: "vi",
			safe: "active",
		});

		const url = `https://www.google.com/search?${params.toString()}`;
		const response = await axios.get(url, {
			timeout: 10000,
			headers: {
				"User-Agent": CONFIG.headers.userAgent,
				"Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
			},
		});

		const html = String(response.data || "");
		const $ = cheerio.load(html);
		const images = [];
		const seen = new Set();

		const pushUrl = (candidate) => {
			if (isUsableImageUrl(candidate) && !seen.has(candidate)) {
				seen.add(candidate);
				images.push(candidate);
			}
		};

		$("script").each((_, element) => {
			const scriptContent = $(element).html();
			if (!scriptContent) return;
			try {
				const startMatch = scriptContent.indexOf("var m={");
				if (startMatch !== -1) {
					const endMatch = scriptContent.indexOf("var a=m;", startMatch);
					if (endMatch !== -1) {
						const mContent = scriptContent.substring(startMatch + 6, endMatch).trim();
						const matches = mContent.match(/\["(https:\/\/[^"]+)",\s*(\d+),\s*(\d+)\]/g);
						if (matches) {
							for (const match of matches) {
								const [imgUrl, width, height] = JSON.parse(match);
								if (imgUrl && width && height) pushUrl(imgUrl);
							}
						}
					}
				}

				const genericRegex = /\["(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)",\s*\d+,\s*\d+\]/gi;
				let m;
				while ((m = genericRegex.exec(scriptContent)) !== null) {
					pushUrl(m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&"));
				}
			} catch {
				// ignore malformed inline script block
			}
		});

		return images.slice(0, 25);
	} catch (error) {
		console.error("Lỗi khi tìm kiếm ảnh Google:", error?.message || error);
		return [];
	}
}

async function searchBingImages(query) {
	try {
		const params = new URLSearchParams({
			q: query,
			form: "HDRSC2",
			first: "1",
		});
		const response = await axios.get(`https://www.bing.com/images/search?${params.toString()}`, {
			timeout: 10000,
			headers: {
				"User-Agent": CONFIG.headers.userAgent,
				"Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
			},
		});
		const $ = cheerio.load(String(response.data || ""));
		const images = [];
		const seen = new Set();

		$("a.iusc").each((_, el) => {
			const metaRaw = $(el).attr("m");
			if (!metaRaw) return;
			try {
				const parsed = JSON.parse(metaRaw);
				const murl = parsed?.murl;
				if (isUsableImageUrl(murl) && !seen.has(murl)) {
					seen.add(murl);
					images.push(murl);
				}
			} catch {
				// ignore bad metadata attribute
			}
		});

		return images.slice(0, 25);
	} catch (error) {
		console.error("Lỗi khi tìm kiếm ảnh Bing:", error?.message || error);
		return [];
	}
}

async function searchDuckDuckGoImages(query) {
	try {
		const landing = await axios.get("https://duckduckgo.com/", {
			params: { q: query, iax: "images", ia: "images" },
			timeout: 8000,
			headers: { "User-Agent": CONFIG.headers.userAgent },
		});
		const html = String(landing.data || "");
		const vqdMatch =
			html.match(/vqd=['"]([^'"]+)['"]/) ||
			html.match(/vqd=([\d-]+)/);
		if (!vqdMatch?.[1]) return [];

		const apiRes = await axios.get("https://duckduckgo.com/i.js", {
			params: {
				l: "wt-wt",
				o: "json",
				q: query,
				vqd: vqdMatch[1],
				f: ",,,",
				p: "1",
			},
			timeout: 8000,
			headers: {
				"User-Agent": CONFIG.headers.userAgent,
				Referer: "https://duckduckgo.com/",
			},
		});

		const results = Array.isArray(apiRes.data?.results) ? apiRes.data.results : [];
		const seen = new Set();
		const images = [];
		for (const item of results) {
			const candidate = item?.image;
			if (isUsableImageUrl(candidate) && !seen.has(candidate)) {
				seen.add(candidate);
				images.push(candidate);
			}
		}
		return images.slice(0, 25);
	} catch (error) {
		console.error("Lỗi khi tìm kiếm ảnh DuckDuckGo:", error?.message || error);
		return [];
	}
}

async function searchImagesWithFallback(query) {
	const googleResults = await searchGoogleImages(query);
	if (googleResults.length > 0) return googleResults;

	const bingResults = await searchBingImages(query);
	if (bingResults.length > 0) return bingResults;

	return searchDuckDuckGoImages(query);
}

async function sendViaLocalDownloadFallback(api, message, imageUrl, caption) {
	const threadId = message.threadId;
	const threadType = safeThreadType(message);
	const senderId = message.data.uidFrom;
	const senderName = message.data.dName || "";

	await fs.promises.mkdir(CONFIG.paths.saveDir, { recursive: true });
	const tmpPath = path.join(
		CONFIG.paths.saveDir,
		`google-img-${Date.now()}-${crypto.randomUUID()}.jpg`
	);

	try {
		await downloadFile(imageUrl, tmpPath, { timeout: CONFIG.download.timeout });
		const stat = await fs.promises.stat(tmpPath);
		if (!stat || stat.size < CONFIG.download.minSize) {
			throw new Error("Downloaded image too small");
		}
		await api.sendMessage(
			{
				msg: caption,
				attachments: [tmpPath],
				quote: message,
				mentions: senderName ? [MessageMention(senderId, senderName.length, 1)] : [],
				ttl: 300000,
			},
			threadId,
			threadType
		);
	} finally {
		await deleteFile(tmpPath);
	}
}

async function downloadAndSendImage(api, message, imageUrls, query) {
	const threadId = message.threadId;
	const type = safeThreadType(message);
	const senderId = message.data.uidFrom;
	const senderName = message.data.dName || "Bạn";

	let attempts = 0;
	let success = false;
	const pool = Array.isArray(imageUrls) ? [...imageUrls] : [];
	const caption = CONFIG.messages.searchResult(senderName, query);

	while (attempts < CONFIG.download.maxAttempts && !success && pool.length > 0) {
		const randomIndex = Math.floor(Math.random() * pool.length);
		const [imageUrl] = pool.splice(randomIndex, 1);

		try {
			try {
				await api.sendImage(imageUrl, message, caption, 300000);
			} catch {
				await sendViaLocalDownloadFallback(api, message, imageUrl, caption);
			}
			success = true;
		} catch (error) {
			console.error(`Lần thử gửi ảnh ${attempts + 1} thất bại:`, error?.message || error);
			attempts += 1;

			if (attempts === CONFIG.download.maxAttempts || pool.length === 0) {
				await api.sendMessage(
					{
						msg: CONFIG.messages.downloadFailed(senderName, attempts),
						quote: message,
						mentions: [MessageMention(senderId, senderName.length, 0)],
						ttl: 30000,
					},
					threadId,
					type
				);
			}
		}
	}
	return success;
}

export async function searchImageGoogle(api, message, command = "image") {
	const senderId = message.data.uidFrom;
	const senderName = message.data.dName || "Bạn";
	const threadId = message.threadId;
	const threadType = safeThreadType(message);
	const prefix = getGlobalPrefix();

	const query = extractCommandBody(message, prefix, command).trim();

	if (!query) {
		await api.sendMessage(
			{
				msg: CONFIG.messages.noQuery(senderName, prefix, command),
				quote: message,
				mentions: [MessageMention(senderId, senderName.length, 0)],
				ttl: 30000,
			},
			threadId,
			threadType
		);
		return;
	}

	if (containsBannedKeyword(query)) {
		await api.sendMessage(
			{
				msg: CONFIG.messages.bannedKeyword(senderName),
				quote: message,
				mentions: [MessageMention(senderId, senderName.length, 0)],
				ttl: 30000,
			},
			threadId,
			threadType
		);
		return;
	}

	try {
		const imageUrls = await searchImagesWithFallback(query);

		if (imageUrls.length === 0) {
			await api.sendMessage(
				{
					msg: CONFIG.messages.noResults(senderName),
					quote: message,
					mentions: [MessageMention(senderId, senderName.length, 0)],
					ttl: 30000,
				},
				threadId,
				threadType
			);
			return;
		}

		await downloadAndSendImage(api, message, imageUrls, query);
	} catch (error) {
		console.error("Lỗi khi tìm kiếm ảnh:", error);
		await api.sendMessage(
			{
				msg: CONFIG.messages.apiError(senderName),
				quote: message,
				mentions: [MessageMention(senderId, senderName.length, 0)],
				ttl: 30000,
			},
			threadId,
			threadType
		);
	}
}
