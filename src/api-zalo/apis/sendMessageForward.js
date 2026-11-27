import { appContext } from "../context.js";
import { rememberOutboundMessage, rememberOutboundReceipt } from "../outbound-message-registry.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { MessageType } from "../models/Message.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";
import { Zalo } from "../zalo.js";
import { API_TYPE, API_VERSION } from "../constants.js";

export function sendMessageForwardFactory(api) {
	if (!api?.zpwServiceMap?.file?.[0]) throw new ZaloApiError("Missing file endpoint (zpwServiceMap.file[0])");
	const directMessageServiceURL = makeURL(`${api.zpwServiceMap.file[0]}/api/message/mforward`, {
		zpw_ver: API_VERSION,
		zpw_type: API_TYPE,
	});
	const groupMessageServiceURL = makeURL(`${api.zpwServiceMap.file[0]}/api/group/mforward`, {
		zpw_ver: API_VERSION,
		zpw_type: API_TYPE,
	});
	/**
	   * Gửi tin nhắn chuyển tiếp
	   *
	   * @param {Message} message Nội Dung Tin Nhắn
	   * @param {string|number} threadId ID Cuộc Trò Chuyện Sẽ Được Chuyển Tiếp
	   * @param {number} [ttl=0] Thời gian tồn tại của tin nhắn (tùy chọn)
	   * @throws {ZaloApiError}
	   */
	return async function sendMessageForward(message, threadId, type, ttl = 0) {
		if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
			throw new ZaloApiError("Missing required app context fields");
		if (!message) throw new ZaloApiError("Missing message");
		if (!threadId) throw new ZaloApiError("Missing threadId");
		if (type === undefined || type === null) throw new ZaloApiError("Missing type");

		let params;
		if (message.link) {
			const linkData = message.strict === true ? null : typeof api.parseLink === "function" ? await api.parseLink(message.link) : null;
			const linkInfo = linkData?.data || (linkData && typeof linkData === "object" && !("data" in linkData) ? linkData : {});
			const mediaInfo = (message.strict === true ? message.media : linkInfo.media) || {};
			const resolvedHref = linkInfo.href || message.link;
			let src = "";
			try {
				src = linkInfo.src || message.src || new URL(resolvedHref).hostname;
			} catch {
				src = "";
			}
			params = {
				grids: [{
					clientId: Date.now()*600,
					ttl: ttl
				}],
				ttl: ttl,
				msgType: '3',
				totalIds: 1,
				msgInfo: JSON.stringify({
					link: resolvedHref,
					linkTitle: message.title || linkInfo.title || "",
					linkDesc: message.desc || linkInfo.desc || "",
					linkThumb: message.thumb || linkInfo.thumb || "",
					linkType: "",
					message: message.msg || "",
					extData: JSON.stringify({
						redirect_url: "",
						src,
						mediaTitle: mediaInfo.mediaTitle || "",
						streamUrl: mediaInfo.streamUrl || "",
						type: mediaInfo.type || 0,
						linkType: 0,
						artist: mediaInfo.artist || "",
						count: mediaInfo.count || "",
						stream_icon: mediaInfo.stream_icon || "",
						mediaId: mediaInfo.mediaId || "",
						video_duration: 0,
						arid: 0,
						href: message.link,
						tType: 1,
						tWidth: 0,
						tHeight: 0,
						brand_name: "Zalo Video",
						local_path_thumb_link: "",
						thumb_renew: message.thumb || linkInfo.thumb || "",
						thumb_src_type: 1,
						width: 250,
						height: 250
					}),
				})
			};
		} else {
			params = {
				grids: [{
					clientId: Date.now()*600,
					ttl: ttl
				}],
				ttl: ttl,
				msgType: '1',
				totalIds: 1,
				msgInfo: JSON.stringify({
					message: message.msg,
					...(message.style && { rtfProps: message.style })
				})
			};
		}

		let url;
		if (type === MessageType.DirectMessage) {
			url = directMessageServiceURL;
			params.toIds = params.grids;
			delete params.grids;
			params.toIds[0].toUid = threadId.toString();
			params.toIds[0].imei = appContext.imei;
			params.imei = appContext.imei;
		} else if (type === MessageType.GroupMessage) {
			url = groupMessageServiceURL;
			params.visibility = 0;
			params.grids[0].grid = threadId.toString();
			params.grids[0].imei = appContext.imei;
		} else {
			throw new Error("Invalid thread type");
		}

		const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
		if (!encryptedParams) throw new ZaloApiError("Failed to encrypt params");

		const botId = appContext.uid;
		const destination = (params.toIds ?? params.grids)[0];
		rememberOutboundMessage(botId, threadId, { clientId: destination.clientId });
		const response = await request(url, {
			method: "POST",
			body: new URLSearchParams({
				params: encryptedParams,
			}),
		});

		const result = await handleZaloResponse(response);
		if (result.error) throw new ZaloApiError(result.error.message, result.error.code);

		rememberOutboundReceipt(botId, threadId, result.data);
		return result.data;
	};
}
