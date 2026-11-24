import { MessageMention } from "../../../api-zalo/models/index.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import { getGlobalPrefix } from "../../service.js";
import { tempDir } from "../../../utils/io-json.js";
import { removeMention } from "../../../utils/format-util.js";
import { deleteFile, downloadFile } from "../../../utils/util.js";

const CONFIG = {
	paths: {
		saveDir: tempDir,
	},
	download: {
		maxAttempts: 10,
		timeout: 5000,
		minSize: 1024,
	},
	messages: {
		noQuery: (name, prefix, command) => `${name} Vui lòng nhập từ khóa tìm kiếm. Ví dụ: ${prefix}${command} anime girl`,
		searchResult: (name, query) => `[${name}] [${query}]`,
		downloadFailed: (name, attempts) => `${name} Không thể tải ảnh sau ${attempts} lần thử. Vui lòng thử lại sau.`,
		noResults: (name) => `${name} Không tìm thấy ảnh. Vui lòng thử lại sau.`,
		apiError: (name) => `${name} Lỗi khi tìm kiếm ảnh :(((.`,
		bannedKeyword: (name) => `${name} Từ khóa tìm kiếm này bị cấm!`,
	},
	headers: {
		userAgent: 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36'
	},
	bannedKeywords: [
		// Từ nhạy cảm tiếng Việt
		"lồn", "l0n", "lon", "l.on", "l*n", "loz", "l0z", "l.z",
		"ngực", "nguc", "nguwc", "ngưc",
		"vú", "vu", "vếu", "veu", "du", "dú",
		"cặc", "cac", "cak", "kak", "cặk", "cứt", "cut", "shit",
		"buồi", "buoi", "b`uoi", "b.uoi",
		"địt", "dit", "đụ", "du", "đ!t", "đyt", "dyt",
		"deo", "đít", "dit", "đ!t", "đụ", "du",
		"nứng", "nung", "nug", "nung",
		"bím", "bim", "b!m", "bịm", "bym",
		"chim", "ch1m", "chym",
		"mông", "mong", "m0ng", "m.ong",

		// Từ nhạy cảm tiếng Anh
		"porn", "pornhub", "xxx", "18+",
		"dick", "cock", "penis", "pussy", "vagina", "boob", "breast",
		"nude", "naked", "hentai", "nsfw", "adult", "strip",
		"fuck", "fucking", "fck", "fuk", "fuking",
		"horny", "erotic", "ero",

		// Cụm từ
		"khiêu dâm", "khieu dam", "làm tình", "lam tinh",
		"gái gọi", "gai goi", "cave", "gái ngành", "gai nganh",
		"phim sex", "clip sex", "anh sex", "ảnh sex",
		"bộ ngực", "bo nguc", "vú to", "vu to",
		"show hàng", "show hang", "lộ hàng", "lo hang",
		"không mặc đồ", "khong mac do", "cởi đồ", "coi do",

		// Biến thể và viết tắt
		"ml", "đm", "dm", "vl", "vcl", "vlxx", "vlxxx",
		"cc", "cl", "đcm", "dcm", "cmm", "cdm", "đcmm",
		"s3x", "sexx", "sẽx", "sẽxx"
	]
};

function containsBannedKeyword(query) {
	const normalized = String(query || "").toLowerCase().trim();
	if (!normalized) return false;
	const tokens = normalized.split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=|\\/<>-]+/).filter(Boolean);
	const tokenSet = new Set(tokens);
	for (const rawKw of CONFIG.bannedKeywords) {
		const kw = rawKw.toLowerCase().trim();
		if (!kw) continue;
		if (kw.includes(" ")) {
			const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(normalized)) {
				return true;
			}
		} else if (tokenSet.has(kw)) {
			return true;
		}
	}
	return false;
}

async function searchGoogleImages(query) {
	try {
		const params = new URLSearchParams({
			q: query,
			tbm: 'isch',
			hl: 'vi'
		});

		const url = `https://www.google.com/search?${params.toString()}`;

		const response = await axios.get(url, {
			timeout: 10000,
			headers: {
				'User-Agent': CONFIG.headers.userAgent
			}
		});

		const $ = cheerio.load(response.data);
		const images = [];

		$('script').each((i, element) => {
			const scriptContent = $(element).html();
			if (scriptContent) {
				try {
					// Tìm chuỗi base64 và mảng ii trong script
					//   const base64Match = scriptContent.match(/var\s+s\s*=\s*'(data:image\/[^']+)'/);
					//   const iiMatch = scriptContent.match(/var\s+ii\s*=\s*(\[[^\]]+\])/);

					//   if (base64Match && base64Match[1] && iiMatch && iiMatch[1]) {
					//     const base64Data = base64Match[1];
					//     // Parse mảng ii và kiểm tra số phần tử
					//     const ii = JSON.parse(iiMatch[1].replace(/'/g, '"'));

					//     // Chỉ lấy ảnh nếu mảng ii có đúng 1 phần tử và kích thước > 100KB
					//     if (Array.isArray(ii) && ii.length === 1) {
					//       images.push(base64Data);
					//     }
					//   }

					const startMatch = scriptContent.indexOf('var m={');
					if (startMatch !== -1) {
						const endMatch = scriptContent.indexOf('var a=m;', startMatch);
						if (endMatch !== -1) {
							const mContent = scriptContent.substring(startMatch + 6, endMatch).trim();

							const matches = mContent.match(/\["(https:\/\/[^"]+)",\s*(\d+),\s*(\d+)\]/g);
							if (matches) {
								matches.forEach(match => {
									const [url, width, height] = JSON.parse(match);
									if (url && width && height && !url.startsWith('https://encrypted-tbn0.gst')) {
										images.push(url);
									}
								});
							}
						}
					}
				} catch (error) {
				}
			}
		});

		return images.slice(0, 20);
	} catch (error) {
		console.error('Lỗi khi tìm kiếm ảnh Google:', error);
		return [];
	}
}

async function downloadAndSendImage(api, message, imageUrls, query) {
	const { threadId, type } = message;
	const senderId = message.data.uidFrom;
	const senderName = message.data.dName;

	let attempts = 0;
	let success = false;
	const pool = Array.isArray(imageUrls) ? [...imageUrls] : [];

	while (attempts < CONFIG.download.maxAttempts && !success && pool.length > 0) {
		const randomIndex = Math.floor(Math.random() * pool.length);
		const [imageUrl] = pool.splice(randomIndex, 1);

		try {
			await api.sendImage(imageUrl,
				message,
				CONFIG.messages.searchResult(senderName, query),
				300000
			);

			success = true;
		} catch (error) {
			console.error(`Lần thử ${attempts + 1} thất bại:`, error.message);
			attempts++;

			if (attempts === CONFIG.download.maxAttempts || pool.length === 0) {
				await api.sendMessage(
					{
						msg: CONFIG.messages.downloadFailed(senderName, attempts),
						quote: message,
						mentions: [MessageMention(senderId, senderName.length, 0)],
						ttl: 30000
					},
					threadId,
					type
				);
			}
		}
	}
	return success;
}

export async function searchImageGoogle(api, message, command) {
	const content = removeMention(message);
	const senderId = message.data.uidFrom;
	const senderName = message.data.dName;
	const threadId = message.threadId;
	const prefix = getGlobalPrefix();

	const query = content.replace(`${prefix}${command}`, "").trim().toLowerCase();

	if (!query) {
		await api.sendMessage(
			{
				msg: CONFIG.messages.noQuery(senderName, prefix, command),
				quote: message,
				mentions: [MessageMention(senderId, senderName.length, 0)],
				ttl: 30000
			},
			threadId,
			message.type
		);
		return;
	}

	const hasBannedKeyword = containsBannedKeyword(query);

	if (hasBannedKeyword) {
		await api.sendMessage(
			{
				msg: CONFIG.messages.bannedKeyword(senderName),
				quote: message,
				mentions: [MessageMention(senderId, senderName.length, 0)],
				ttl: 30000
			},
			threadId,
			message.type
		);
		return;
	}

	try {
		const imageUrls = await searchGoogleImages(query);

		if (imageUrls.length === 0) {
			await api.sendMessage(
				{
					msg: CONFIG.messages.noResults(senderName),
					quote: message,
					mentions: [MessageMention(senderId, senderName.length, 0)],
					ttl: 30000
				},
				threadId,
				message.type
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
			},
			threadId,
			message.type
		);
	}
}
