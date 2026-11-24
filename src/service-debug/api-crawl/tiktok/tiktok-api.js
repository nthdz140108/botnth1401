import { tryDownloadProviders } from "../download/download-job.js";
import axios from "axios";
import HttpsProxyAgent from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import retry from "async-retry";

const headersSearch = {
	"User-Agent": "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
	"cookie": '_ttp=2p0lHkLPkuuzPy4n9kNCgaqVBFM; tt_chain_token=tioPB+Lui7TvHuzUPNaOHg==; passport_csrf_token=3dfb5a52d5a68f4d5c9bba4538577dfe; passport_csrf_token_default=3dfb5a52d5a68f4d5c9bba4538577dfe; odin_tt=0a5b7e2bc3c60961f0e9463f055e859c8ca0059ae611097cd3dd3f4f259a70c0ec1343ec5dfb12f6361658cbac0ad226f69c1b6cba2089e7f174c7f9388708e449330d0c262c38701c9381fc9a679cae; ttwid=1%7CaIhJLRa4fvQV5lLYGHleEtravH48pseLFrAf8dwU0ik%7C1736404109%7Ce5b777f06b45e5add32991c13b233b1867fa01f50ba08d37f095ee96b81648c4; msToken=ruVh1eb2RQfH8sIdNQMUgirrpsBRM7lyjGt_nJbm8DVQXSxVKiz4L73PlHcZ_AVXhZu5qRBI5DoAuagqgXmZohLuz7vtDEF-g4EQwW8aB9tcv1q1nZhPwnEcwtFHCTN2SIlrRdJREgK_9OqqxttLqrPLpw==',
	"Accept-Language": "vi-VN,vi;q=0.9"
}
const clientABVersions = "70508271,72923696,73022009,73038832,73060926,73067877,73119041,73149840,73158100,73167672,73174521,73184446,73184714,73197619,73198009,73204427,73216053,73234258,73242625,73242627,73242629,70405643,71057832,71200802,72258247,73004916,73171280,73208420";

const tiktokApi = "https://m.tiktok.com/api";
const tiktokvApi = `https://api16-normal-useast5.tiktokv.us`;
const tiktokvFeed = (params) => `${tiktokvApi}/aweme/v1/feed/?${tiktokApiParams(params)}`;
const linkTiktokSearch = (keywords) => `${tiktokApi}/search/general/full/?keyword=${encodeURIComponent(keywords)}`;
const linkTiktokRelated = (idVideo) => `${tiktokApi}/related/item_list/?${tiktokRelatedParams(idVideo)}`;
const linkTiktokPreload = () => `${tiktokApi}/preload/item_list/?${tiktokPreloadParams()}`;
const linkTiktokRecommend = () => `${tiktokApi}/recommend/item_list/?${tiktokRecommendParams()}`;
const linkSubHatDe = "https://subhatde.id.vn";
const linkSearchTiktokSubHatDe = (keywords) => `${linkSubHatDe}/tiktok/searchvideo?keywords=${encodeURIComponent(keywords)}`;
const linkDownloadTiktokSubHatDe = (url) => `${linkSubHatDe}/tiktok/downloadvideo?url=${encodeURIComponent(url)}`;
const DOWNLOAD_SUBHATDE_TIMEOUT = 10000;

export class TikTokSearchError extends Error {
	constructor(code, message, cause) {
		super(message);
		this.name = "TikTokSearchError";
		this.code = code;
		this.cause = cause;
	}
}

export function normalizeTikTokSearchResult(payload) {
	const rapidVideos = Array.isArray(payload?.videos) ? payload.videos.map((item) => ({
		id: item.video_id,
		desc: item.description,
		author: { uniqueId: item.author, nickname: item.author_name || item.author },
		video: {
			url: item.unwatermarked_download_url || item.download_url,
			cover: item.cover,
			quality: item.video_definition || "540p",
			duration: item.duration,
		},
		stat: {
			playCount: item.statistics?.number_of_plays,
			diggCount: item.statistics?.number_of_hearts,
			commentCount: item.statistics?.number_of_comments,
			shareCount: item.statistics?.number_of_reposts,
			collectCount: item.statistics?.number_of_saves,
		},
	})) : null;
	const items = Array.isArray(payload?.data) ? payload.data : rapidVideos;
	if (!items) {
		throw new TikTokSearchError("INVALID_RESPONSE", "TikTok search response must contain a data array");
	}
	return items.filter((item) => {
		const videoUrl = item?.video?.url;
		const cover = item?.video?.cover;
		return item?.id != null && typeof videoUrl === "string" && videoUrl.trim() && typeof cover === "string" && cover.trim();
	}).map((item) => ({
		id: String(item.id),
		kind: "video",
		desc: item.desc || "",
		author: {
			uniqueId: item.author?.uniqueId || item.author?.unique_id || "",
			nickname: item.author?.nickname || item.author?.name || "",
		},
		video: {
			url: item.video.url,
			cover: item.video.cover,
			quality: item.video.quality || item.video.ratio || "540p",
			type: item.video.type || "mp4",
			duration: item.video.duration || 0,
		},
		images: [],
		music: {
			title: item.music?.title || item.desc || "TikTok",
			url: item.music?.url || "",
			cover: item.music?.cover || item.video.cover,
			author: item.music?.author || item.author?.nickname || "",
			quality: item.music?.quality || "",
			type: item.music?.type || "audio",
		},
		stat: {
			playCount: item.stat?.playCount || item.stat?.play_count || 0,
			diggCount: item.stat?.diggCount || item.stat?.digg_count || 0,
			commentCount: item.stat?.commentCount || item.stat?.comment_count || 0,
			downloadCount: item.stat?.downloadCount || item.stat?.download_count || 0,
			shareCount: item.stat?.shareCount || item.stat?.share_count || 0,
			collectCount: item.stat?.collectCount || item.stat?.collect_count || 0,
		},
	}));
}

export function normalizeTikTokRawData(content) {
	if (!content) return null;
	if (content.kind && (content.video !== undefined || content.images !== undefined)) {
		return content;
	}

	const rawImages = content.image_post_info?.images || (Array.isArray(content.images) ? content.images : []);
	const validImages = [];
	for (const img of rawImages) {
		const rawUrl = img?.display_image?.url_list?.slice(-1)[0]
			|| img?.thumbnail?.url_list?.slice(-1)[0]
			|| img?.url_list?.slice(-1)[0]
			|| img?.download_url_list?.slice(-1)[0]
			|| (typeof img === "string" ? img : img?.url);
		if (typeof rawUrl === "string" && rawUrl.trim()) {
			const cleanUrl = rawUrl.trim();
			const extMatch = cleanUrl.split("?")[0].split(".").pop();
			const ext = (extMatch && extMatch.length <= 4) ? extMatch.toLowerCase() : "jpg";
			validImages.push({
				url: cleanUrl,
				extension: (img && typeof img === "object" && img.extension) ? img.extension : ext,
			});
		}
	}

	const isSlideshow = validImages.length > 0;
	const videoUrl = content.video?.play_addr?.url_list?.slice(-1)[0]
		|| content.video?.download_addr?.url_list?.slice(-1)[0]
		|| content.video?.url
		|| "";
	const videoCover = content.video?.cover?.url_list?.slice(-1)[0]
		|| content.video?.origin_cover?.url_list?.slice(-1)[0]
		|| content.video?.cover
		|| "";

	return {
		id: String(content.aweme_id || content.id || content.uid || ""),
		kind: isSlideshow ? "slideshow" : "video",
		desc: content.desc || content.title || "",
		author: {
			uniqueId: content.author?.unique_id || content.author?.uniqueId || (typeof content.author === "string" ? content.author : ""),
			nickname: content.author?.nickname || content.author?.name || (typeof content.author === "string" ? content.author : ""),
		},
		video: isSlideshow ? null : {
			url: videoUrl,
			cover: videoCover,
			quality: content.video?.ratio || content.video?.quality || "540p",
			duration: content.video?.duration || 0,
			type: content.video?.type || "mp4",
		},
		images: validImages,
		music: {
			title: content.music?.title || content.desc || "TikTok",
			url: content.music?.play_url?.url_list?.slice(-1)[0] || content.music?.play_url || content.music?.url || "",
			cover: content.music?.cover_hd?.url_list?.slice(-1)[0]
				|| content.music?.cover_large?.url_list?.slice(-1)[0]
				|| content.music?.cover_medium?.url_list?.slice(-1)[0]
				|| content.music?.cover_thumb?.url_list?.slice(-1)[0]
				|| content.music?.cover
				|| videoCover
				|| (validImages[0]?.url || ""),
			author: content.music?.author || content.music?.author_name || content.author?.nickname || "",
			type: content.music?.type || "mp3",
		},
		stat: {
			playCount: content.statistics?.play_count || content.stat?.playCount || 0,
			diggCount: content.statistics?.digg_count || content.stat?.diggCount || 0,
			commentCount: content.statistics?.comment_count || content.stat?.commentCount || 0,
			downloadCount: content.statistics?.download_count || content.stat?.downloadCount || 0,
			shareCount: content.statistics?.share_count || content.stat?.shareCount || 0,
			collectCount: content.statistics?.collect_count || content.stat?.collectCount || 0,
		},
	};
}

export function normalizeSubHatDeData(data) {
	if (!data) return null;
	if (data.kind && (data.video !== undefined || data.images !== undefined)) {
		return data;
	}

	const rawImages = Array.isArray(data.images)
		? data.images
		: (Array.isArray(data.image_urls) ? data.image_urls : (Array.isArray(data.image_post_info?.images) ? data.image_post_info.images : []));
	const validImages = [];
	for (const img of rawImages) {
		const rawUrl = typeof img === "string" ? img : (img?.url || img?.display_image?.url_list?.slice(-1)[0]);
		if (typeof rawUrl === "string" && rawUrl.trim()) {
			const cleanUrl = rawUrl.trim();
			const extMatch = cleanUrl.split("?")[0].split(".").pop();
			const ext = (extMatch && extMatch.length <= 4) ? extMatch.toLowerCase() : "jpg";
			validImages.push({
				url: cleanUrl,
				extension: (img && typeof img === "object" && img.extension) ? img.extension : ext,
			});
		}
	}

	const isSlideshow = validImages.length > 0;
	const videoUrl = data.play || data.video?.url || "";
	const videoCover = data.cover || data.video?.cover || "";
	const rawDuration = data.duration || data.video?.duration || 0;
	const duration = rawDuration > 0 && rawDuration < 1000 ? rawDuration * 1000 : rawDuration;

	return {
		id: String(data.id || data.video_id || data.uid || ""),
		kind: isSlideshow ? "slideshow" : "video",
		desc: data.title || data.desc || "",
		author: {
			uniqueId: data.author?.unique_id || data.author?.uniqueId || (typeof data.author === "string" ? data.author : ""),
			nickname: data.author?.nickname || data.author?.name || (typeof data.author === "string" ? data.author : ""),
		},
		video: isSlideshow ? null : {
			url: videoUrl,
			cover: videoCover,
			duration: duration || 1000,
			quality: data.quality || data.video?.quality || "540p",
			type: data.type || data.video?.type || "mp4",
		},
		images: validImages,
		music: {
			title: data.music_info?.title || data.music?.title || data.title || "TikTok",
			url: data.music_info?.play || data.music_info?.url || data.music?.url || "",
			cover: data.music_info?.cover || data.music?.cover || videoCover || (validImages[0]?.url || ""),
			author: data.music_info?.author || data.music?.author || "",
			type: data.music_info?.type || data.music?.type || "mp3",
		},
		stat: {
			playCount: data.play_count || data.stat?.playCount || 0,
			diggCount: data.digg_count || data.stat?.diggCount || 0,
			commentCount: data.comment_count || data.stat?.commentCount || 0,
			downloadCount: data.download_count || data.stat?.downloadCount || 0,
			shareCount: data.share_count || data.stat?.shareCount || 0,
			collectCount: data.collect_count || data.stat?.collectCount || 0,
		},
	};
}

export function normalizeHoangDevAIOData(data) {
	if (!data) return null;
	if (data.kind && (data.video !== undefined || data.images !== undefined)) {
		return data;
	}

	const medias = Array.isArray(data.medias) ? data.medias : [];
	const imageMedias = medias.filter((m) => {
		if (!m || !m.url) return false;
		const type = String(m.type || "").toLowerCase();
		if (type === "image") return true;
		if (!type && m.extension && ["jpg", "jpeg", "png", "webp"].includes(String(m.extension).toLowerCase())) return true;
		return false;
	});
	const videoMedias = medias.filter((m) => {
		if (!m || !m.url) return false;
		const type = String(m.type || "").toLowerCase();
		return type === "video" || (!type && m.extension && ["mp4", "mov", "avi"].includes(String(m.extension).toLowerCase()));
	});

	const validImages = [];
	for (const img of imageMedias) {
		if (typeof img.url === "string" && img.url.trim()) {
			const cleanUrl = img.url.trim();
			const extMatch = cleanUrl.split("?")[0].split(".").pop();
			const ext = (extMatch && extMatch.length <= 4) ? extMatch.toLowerCase() : "jpg";
			validImages.push({
				url: cleanUrl,
				extension: img.extension || ext,
			});
		}
	}

	const isSlideshow = validImages.length > 0;
	const bestVideo = videoMedias.find((m) => {
		const q = String(m.quality || "").toLowerCase();
		return q.includes("no watermark") || q.includes("hd");
	}) || videoMedias[0] || (data.url ? { url: data.url, thumbnail: data.thumbnail, quality: "540p", extension: "mp4" } : null);

	const audioMedia = medias.find((m) => String(m?.type || "").toLowerCase() === "audio");
	const musicUrl = data.music?.url || data.voice?.url || audioMedia?.url || "";

	return {
		id: String(data.id || (data.url && data.url.split("/").pop()) || data.title || ""),
		kind: isSlideshow ? "slideshow" : "video",
		desc: data.title || data.desc || "",
		author: {
			uniqueId: typeof data.author === "object" ? (data.author.uniqueId || data.author.unique_id || "") : String(data.author || ""),
			nickname: typeof data.author === "object" ? (data.author.nickname || data.author.name || "") : String(data.author || ""),
		},
		video: isSlideshow ? null : (bestVideo ? {
			url: bestVideo.url || "",
			cover: bestVideo.thumbnail || data.thumbnail || "",
			quality: bestVideo.quality || "540p",
			duration: data.duration || 0,
			type: bestVideo.extension || "mp4",
		} : null),
		images: validImages,
		music: {
			title: data.music?.title || data.voice?.title || data.title || "TikTok",
			url: musicUrl,
			cover: data.music?.cover || data.thumbnail || (validImages[0]?.url || ""),
			author: data.music?.author || (typeof data.author === "string" ? data.author : (data.author?.nickname || "")),
			type: "mp3",
		},
		stat: {
			playCount: data.play_count || data.stat?.playCount || 0,
			diggCount: data.digg_count || data.stat?.diggCount || 0,
			commentCount: data.comment_count || data.stat?.commentCount || 0,
			downloadCount: data.download_count || data.stat?.downloadCount || 0,
			shareCount: data.share_count || data.stat?.shareCount || 0,
			collectCount: data.collect_count || data.stat?.collectCount || 0,
		},
	};
}

export function normalizeTikTokMedia(payload, providerHint) {
	if (!payload) return null;
	if (payload.kind && (payload.video !== undefined || payload.images !== undefined)) {
		return payload;
	}
	if (providerHint === "subhatde") return normalizeSubHatDeData(payload);
	if (providerHint === "hoangdev") return normalizeHoangDevAIOData(payload);
	if (providerHint === "raw") return normalizeTikTokRawData(payload);

	if (Array.isArray(payload.medias)) {
		return normalizeHoangDevAIOData(payload);
	}
	if (payload.aweme_id || payload.aweme_list || payload.image_post_info) {
		return normalizeTikTokRawData(payload);
	}
	if (payload.music_info || payload.play || payload.image_urls) {
		return normalizeSubHatDeData(payload);
	}
	return normalizeTikTokRawData(payload);
}

export async function searchTikTokByKeyword(query, limit = 10, client = axios) {
	const url = String(process.env.TIKTOK_SEARCH_API_URL || "").trim();
	const key = String(process.env.TIKTOK_SEARCH_API_KEY || "").trim();
	if (!url || !key) throw new TikTokSearchError("MISSING_DEPENDENCY", "TIKTOK_SEARCH_API_URL and TIKTOK_SEARCH_API_KEY are required");
	const boundedLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || 10));
	try {
		const requestUrl = new URL(url);
		const isRapidApi = requestUrl.hostname.endsWith(".p.rapidapi.com");
		const requestConfig = {
			timeout: 30000,
			...(isRapidApi ? {
				headers: {
					"Content-Type": "application/json",
					"x-rapidapi-host": requestUrl.hostname,
					"x-rapidapi-key": key,
				},
			} : {}),
		};
		const response = await retry(async (bail) => {
			try {
				return isRapidApi
					? await client.post(requestUrl.toString(), { query: String(query || ""), cursor: 0, sort_type: "0" }, requestConfig)
					: await client.get(requestUrl.toString(), {
						...requestConfig,
						params: { keyword: String(query || ""), limit: boundedLimit, apikey: key },
					});
			} catch (error) {
				const retryableNetworkError = error instanceof AggregateError
					|| error?.cause instanceof AggregateError
					|| ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(error?.code);
				if (!retryableNetworkError || error?.response?.status) bail(error);
				throw error;
			}
		}, { retries: 2, minTimeout: 200, maxTimeout: 800, randomize: false });
		const videos = normalizeTikTokSearchResult(response?.data);
		return videos.slice(0, boundedLimit);
	} catch (error) {
		if (error instanceof TikTokSearchError) throw error;
		const status = error?.response?.status;
		const code = error?.code === "ECONNABORTED"
			? "TIMEOUT"
			: status === 401 || status === 403
				? "SUBSCRIPTION"
				: "PROVIDER";
		throw new TikTokSearchError(code, "TikTok search provider failed", error);
	}
}

const randomChar = (chars, length) => {
	let result = '';
	for (let i = 0; i < length; i++) {
		result += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return result;
};

const tiktokApiParams = (args) => {
	return new URLSearchParams({
		...args,
		version_name: "1.1.9",
		version_code: "2018111632",
		build_number: "1.1.9",
		device_id: "7238642534011110914",
		iid: "7318518857994389254",
		manifest_version_code: "2018111632",
		update_version_code: "2018111632",
		openudid: randomChar("0123456789abcdef", 16),
		uuid: randomChar("1234567890", 16),
		_rticket: Date.now() * 1000,
		ts: Date.now(),
		device_brand: "Google",
		device_type: "Pixel 4",
		device_platform: "android",
		resolution: "1080*1920",
		dpi: 420,
		os_version: "10",
		os_api: "29",
		carrier_region: "US",
		sys_region: "US",
		region: "US",
		timezone_name: "America/New_York",
		timezone_offset: "-14400",
		channel: "googleplay",
		ac: "wifi",
		mcc_mnc: "310260",
		is_my_cn: 0,
		ssmix: "a",
		as: "a1qwert123",
		cp: "cbfhckdckkde1"
	}).toString();
};

const tiktokRelatedParams = (idVideo) => {
	return new URLSearchParams({
		WebIdLastTime: Date.now(),
		aid: 1988,
		app_language: "en",
		app_name: "tiktok_web",
		browser_language: "en-US",
		browser_name: "Mozilla",
		browser_online: true,
		browser_platform: "Win32",
		browser_version: "5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
		channel: "tiktok_web",
		clientABVersions: clientABVersions,
		cookie_enabled: true,
		count: 16,
		coverFormat: 2,
		cursor: 0,
		data_collection_enabled: true,
		device_id: "7439236374672705044",
		device_platform: "web_pc",
		focus_state: true,
		from_page: "video",
		history_len: 5,
		isNonPersonalized: false,
		is_fullscreen: false,
		is_page_visible: true,
		itemID: idVideo,
		language: "en",
		odinId: "7439236084913718289",
		os: "windows",
		priority_region: "",
		referer: "",
		region: "VN",
		screen_height: 900,
		screen_width: 1600,
		tz_name: "Asia/Bangkok",
		user_is_login: false,
		verifyFp: "verify_m5acgd9w_JQLaQCy0_pzpQ_43RZ_BC6o_vhFGHinP4BkJ",
		webcast_language: "en"
	}).toString();
};

const tiktokRecommendParams = (idVideo) => {
	return new URLSearchParams({
		WebIdLastTime: Date.now(),
		aid: 1988,
		app_language: "vi-VN",
		app_name: "tiktok_web",
		browser_language: "vi-VN",
		browser_name: "Mozilla",
		browser_online: true,
		browser_platform: "Win32",
		browser_version: "5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
		channel: "tiktok_web",
		clientABVersions: clientABVersions,
		cookie_enabled: true,
		count: 16,
		coverFormat: 2,
		data_collection_enabled: true,
		device_id: "7439236374672705044",
		device_platform: "web_pc",
		device_type: "web_h264",
		focus_state: true,
		from_page: "fyp",
		history_len: 5,
		isNonPersonalized: false,
		is_fullscreen: false,
		is_page_visible: true,
		itemID: idVideo || "",
		language: "vi",
		odinId: "7439236084913718289",
		os: "windows",
		priority_region: "",
		pullType: 1,
		referer: "",
		region: "VN",
		screen_height: 900,
		screen_width: 1600,
		showAboutThisAd: true,
		showAds: false,
		tz_name: "Asia/Bangkok",
		user_is_login: false,
		vv_count_fyp: 5,
		watchLiveLastTime: "",
		webcast_language: "vi-VN"
	}).toString();
};

const tiktokPreloadParams = () => {
	return new URLSearchParams({
		WebIdLastTime: Date.now(),
		aid: 1988,
		app_language: "en",
		app_name: "tiktok_web",
		browser_language: "en-US",
		browser_name: "Mozilla",
		browser_online: true,
		browser_platform: "Win32",
		browser_version: "5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
		channel: "tiktok_web",
		clientABVersions: clientABVersions,
		cookie_enabled: true,
		count: 3,
		coverFormat: 2,
		data_collection_enabled: true,
		device_id: "7439236374672705044",
		device_platform: "web_pc",
		focus_state: false,
		from_page: "fyp",
		history_len: 3,
		isNonPersonalized: false,
		is_fullscreen: false,
		is_page_visible: true,
		language: "en",
		odinId: "7439236084913718289",
		os: "windows",
		priority_region: "",
		referer: "",
		region: "VN",
		screen_height: 900,
		screen_width: 1600,
		tz_name: "Asia/Bangkok",
		user_is_login: false,
		verifyFp: "verify_m5brcczp_UIuDK5W3_I1Bj_4iHu_BciG_yX5azOxfNFJ9",
		vv_count_fyp: 16,
		webcast_language: "en"
	}).toString();
};

const parseVideoData = (content) => {
	return normalizeTikTokRawData(content);
};

export async function searchTiktokSubHatDe(keywords) {
	try {
		const response = await axios.get(linkSearchTiktokSubHatDe(keywords), {
			timeout: 12000,
		});
		const videos = response.data?.data?.videos;
		if (!videos) return [];
		return videos.map((data) => normalizeSubHatDeData(data)).filter(Boolean);
	} catch (error) {
		console.error("Error while fetching data:", error.message);
		return [];
	}
};

export async function searchTiktokGeneral(keywords, limit = 10) {
	try {
		const response = await axios.get(linkTiktokSearch(keywords), {
			headers: headersSearch,
			timeout: 12000,
		});
		const getData = response.data.data;
		if (!getData) return [];
		const result = getData.filter(data => data.type === 1).slice(0, limit).map(data => ({
			id: data.item.id,
			kind: "video",
			desc: data.item.desc,
			createTime: data.item.createTime,
			stat: {
				playCount: data.item.stats?.playCount || 0,
				diggCount: data.item.stats?.diggCount || 0,
				commentCount: data.item.stats?.commentCount || 0,
				downloadCount: data.item.stats?.downloadCount || 0,
				shareCount: data.item.stats?.shareCount || 0
			},
			video: {
				url: data.item.video.playAddr,
				cover: data.item.video.cover,
				duration: data.item.video.duration * 1000 || 1000,
				type: data.item.video.format,
				quality: data.item.video.ratio
			},
			images: [],
			author: data.item.author,
			music: {
				title: data.item.music.title,
				url: data.item.music.playUrl,
				cover: data.item.music.coverLarge,
				author: data.item.music.authorName,
				quality: "audio",
				type: "mp3"
			}
		}));
		return result;
	} catch (error) {
		console.error("Error while fetching data:", error);
		return [];
	}
};

export const searchTiktok = async (keywords, limit = 10) => {
	let result = [];
	result = await searchTiktokSubHatDe(keywords, limit);
	result = result.length === 0 ? await searchTiktokGeneral(keywords, limit) : result;
	return result;
};

export const reqIdVideoTiktok = async (url, proxy) => {
	url = url.replace("https://vm", "https://vt");

	try {
		const { request } = await axios({
			method: "HEAD",
			url,
			timeout: 10000,
			httpsAgent: proxy && (
				proxy.startsWith("http") || proxy.startsWith("https")
					? new HttpsProxyAgent(proxy)
					: proxy.startsWith("socks")
						? new SocksProxyAgent(proxy)
						: undefined
			) || undefined
		});

		const { responseUrl } = request.res;
		const ID = responseUrl.match(/\d{17,21}/g)?.[0];

		if (!ID) {
			return {
				status: "error",
				message: "Failed to fetch tiktok url. Make sure your tiktok url is correct!"
			};
		}

		return ID;
	} catch (error) {
		return {
			status: "error",
			message: `Error fetching TikTok URL: ${error.message}`
		};
	}
};

export const fetchTiktokData = async (ID, proxy) => {
	try {
		const response = await retry(async () => {
			const url = tiktokvFeed({
				aweme_id: ID
			});
			const res = await axios(url, {
				method: "OPTIONS",
				timeout: 10000,
				headers: {
					"User-Agent": "com.zhiliaoapp.musically/300904 (2018111632; U; Android 10; en_US; Pixel 4; Build/QQ3A.200805.001; Cronet/58.0.2991.0)"
				},
				httpsAgent: proxy &&
					(proxy.startsWith("http") || proxy.startsWith("https")
						? new HttpsProxyAgent(proxy)
						: proxy.startsWith("socks")
							? new SocksProxyAgent(proxy)
							: undefined)
			});
			if (res.data !== "" && res.data.status_code === 0) {
				return res.data;
			}
			throw new Error("Failed to fetch tiktok data");
		}, {
			retries: 3,
			minTimeout: 200,
			maxTimeout: 1000
		});
		return await response;
	} catch (error) {
		return null;
	}
};

export const getTiktokVideoByID = (data, ID) => {
	let content = data?.aweme_list;
	if (!content) return null;

	content = content.find((v) => v.aweme_id === ID);
	if (!content) return null;

	return parseVideoData(content);
};

export const getRandomVideoTiktok = (data, currentId) => {
	const videos = data?.aweme_list;
	if (!videos || videos.length === 0) return null;

	const filteredVideos = videos.filter(video => video.aweme_id !== currentId);
	if (filteredVideos.length === 0) return null;

	const randomIndex = Math.floor(Math.random() * filteredVideos.length);
	const randomVideo = filteredVideos[randomIndex];

	return parseVideoData(randomVideo);
};

export const getDataDownloadSubHatDe = async (url) => {
	try {
		const response = await retry(async () => {
			return await axios.get(linkDownloadTiktokSubHatDe(url), {
				timeout: DOWNLOAD_SUBHATDE_TIMEOUT
			});
		}, {
			retries: 2,
			minTimeout: 400,
			maxTimeout: 1200
		});

		if (response.data && (response.data.msg === "success" || response.data.data)) {
			const data = response.data.data || response.data;
			return normalizeSubHatDeData(data);
		}
		return null;
	} catch (error) {
		throw error;
	}
};

export const getDataDownloadHoangDev = async (url) => {
	const apiKey = process.env.HOANGDEV_API_KEY || "";
	if (!apiKey) throw Object.assign(new Error("HoangDev key missing"), { code: "MISSING_DEPENDENCY" });
	const apiUrl = "https://hoangdev.io.vn/Aio/aio-download";
	try {
		const response = await retry(async () => {
			return await axios.get(`${apiUrl}?apikey=${apiKey}&url=${encodeURIComponent(url)}`, {
				timeout: 15000,
				headers: {
					"Content-Type": "application/json",
				},
			});
		}, {
			retries: 2,
			minTimeout: 400,
			maxTimeout: 1200,
		});

		if (response.data && response.data.success && response.data.data) {
			return normalizeHoangDevAIOData(response.data.data);
		}
		return null;
	} catch (error) {
		throw error;
	}
};

export const getDataDownloadOriginal = async (url, id = null) => {
	const idVideo = id ? id : await reqIdVideoTiktok(url);
	if (!idVideo || typeof idVideo !== "string") return null;

	const data = await fetchTiktokData(idVideo);
	if (!data) return null;

	return getTiktokVideoByID(data, idVideo);
};

export const getTikTokMedia = async (url, options = {}) => {
	if (!url || typeof url !== "string") return null;
	return tryDownloadProviders(url, options.providers || [
		["subhatde", getDataDownloadSubHatDe],
		["hoangdev", getDataDownloadHoangDev],
		["original", getDataDownloadOriginal],
	], options.log);
};

export const getDataDownloadVideo = async (url) => {
	return await getTikTokMedia(url);
};

export const getTiktokRelated = async (idVideo) => {
	try {
		const response = await axios.get(linkTiktokRelated(idVideo), {
			timeout: 10000,
		});
		const data = response.data.itemList;
		let result = [];
		if (!data) return [];
		data.map(item => {
			const statObj = {
				playCount: item.stats?.playCount || 0,
				diggCount: item.stats?.diggCount || 0,
				commentCount: item.stats?.commentCount || 0,
				shareCount: item.stats?.shareCount || 0,
				collectCount: item.stats?.collectCount || 0,
			};
			result.push({
				id: item.id,
				kind: "video",
				desc: item.desc,
				createTime: item.createTime,
				stats: statObj,
				stat: statObj,
				video: {
					url: item.video?.playAddr || "",
					cover: item.video?.originCover || "",
					duration: item.video?.duration * 1000 || 1000,
					type: item.video?.format || "mp4",
					quality: item.video?.ratio || "540p"
				},
				images: [],
				author: item.author,
				music: item.music
			});
		});
		return result;
	} catch (error) {
		return [];
	}
};

export const getTiktokPreload = async () => {
	try {
		const response = await axios.get(linkTiktokPreload(), {
			timeout: 10000,
		});
		const data = response.data.itemList;
		let result = [];
		if (!data) return [];
		data.map(item => {
			result.push({
				id: item.id,
				kind: "video",
				desc: item.desc,
				createTime: item.createTime,
				stats: {
					playCount: item.stats?.playCount || 0,
					diggCount: item.stats?.diggCount || 0,
					commentCount: item.stats?.commentCount || 0,
					shareCount: item.stats?.shareCount || 0,
					collectCount: item.stats?.collectCount || 0,
				},
				video: {
					url: item.video?.playAddr || "",
					cover: item.video?.originCover || "",
					duration: item.video?.duration * 1000 || 1000,
					type: item.video?.format || "mp4",
					quality: item.video?.ratio || "540p"
				},
				images: [],
				author: item.author,
				music: item.music
			});
		});
		return result;
	} catch (error) {
		return [];
	}
};
