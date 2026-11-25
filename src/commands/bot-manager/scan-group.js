import { LRUCache } from 'lru-cache';
import { getBotId } from "../../utils/env.js";
import { isAdmin } from "../../utils/role-policy.js";
import { sendMessageComplete, sendMessageCompleteRequest, sendMessageFailed, sendMessageQuery, sendMessageTag, sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGroupAdmins, getGroupInfoData } from "../../service-debug/info-service/group-info.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { removeMention } from "../../utils/format-util.js";
import { extractCommandBody, safeThreadType } from "../shared/command-input-utils.js";
import {
	startInteractionCountdown,
	completeInteractionCountdown,
	cancelInteractionCountdown,
} from "../../utils/interaction-countdown.js";

const TIME_WAIT_SELECTION = 60000;
const scanResultsMap = new LRUCache({
	max: 500,
	ttl: TIME_WAIT_SELECTION
});

function getMemberDisplayName(member) {
	return String(member?.zaloName || member?.displayName || member?.dName || member?.name || "").trim();
}

// Thêm hàm helper để chia mảng
function chunkArray(array, chunkSize) {
	const chunks = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize));
	}
	return chunks;
}

// Thêm hàm helper để lấy members
async function getMembersInfo(api, memberIds) {
	try {
		if (!Array.isArray(memberIds) || memberIds.length === 0) return [];
		if (memberIds.length <= 500) {
			const result = await api.getGroupMembers(memberIds);
			return Object.values(result?.profiles || {});
		}

		// Chia thành các chunks nhỏ hơn 500
		const chunks = chunkArray(memberIds, 500);
		let allMembers = [];

		// Request từng chunk và gộp kết quả
		for (const chunk of chunks) {
			const result = await api.getGroupMembers(chunk);
			allMembers = [...allMembers, ...Object.values(result?.profiles || {})];
		}

		return allMembers;
	} catch (error) {
		console.error("Error getting members info:", error);
		throw error;
	}
}

export async function scanGroupsWithAction(api, message, groupInfo, aliasCommand = "scangroups") {
	const prefixCommand = getGlobalPrefix();
	const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "scangroups";
	const content = extractCommandBody(message, prefixCommand, safeAlias);
	const resolvedGroupInfo = groupInfo || (await getGroupInfoData(api, message.threadId));
	const idBot = String(getBotId() || "");
	const groupAdmins = await getGroupAdmins(resolvedGroupInfo);
	const botIsAdminBox = Array.isArray(groupAdmins) && groupAdmins.map(String).includes(idBot);

	const args = content.split(/\s+/).filter(Boolean);
	const action = args[0]?.toLowerCase();
	const searchTerm = args.slice(1).join(" ").trim();

	const VALID_ACTIONS = {
		find: "kết quả khớp hoàn toàn",
		findmatch: "kết quả khớp một phần",
		tìm: "kết quả khớp hoàn toàn",
		findtag: "kết quả khớp hoàn toàn và tag",
		findmatchtag: "kết quả khớp một phần và tag",
	};

	if (!action || !VALID_ACTIONS[action]) {
		return sendMessageQuery(
			api,
			message,
			`⚠️ Hướng dẫn quét thành viên nhóm:\n` +
			`• Cú pháp: ${prefixCommand}${safeAlias} <hành_động> <từ_khóa>\n` +
			`• Hành động hỗ trợ: ${Object.keys(VALID_ACTIONS).join(", ")}\n` +
			`• Ví dụ: ${prefixCommand}${safeAlias} findmatch Nguyễn Văn A`,
			true
		);
	}

	if (!searchTerm) {
		return sendMessageQuery(
			api,
			message,
			`⚠️ Vui lòng nhập từ khóa tên thành viên cần tìm!\nVí dụ: ${prefixCommand}${safeAlias} ${action} Nguyễn Văn A`,
			true
		);
	}
	try {
		const members = await getMembersInfo(api, resolvedGroupInfo?.memVerList || []);
		const searchLower = searchTerm.toLowerCase();

		const searchFunction = action === "findmatch" || action === "findmatchtag"
			? member => {
				const memberName = getMemberDisplayName(member).toLowerCase();
				return Boolean(memberName) && memberName.includes(searchLower) && idBot !== String(member?.id);
			}
			: member => {
				const memberName = getMemberDisplayName(member).toLowerCase();
				return Boolean(memberName) && memberName === searchLower && idBot !== String(member?.id);
			};

		const searchResults = members.filter(searchFunction);
		const groupTitle = resolvedGroupInfo?.name || "nhóm hiện tại";

		let msg;
		let mentions = [];
		let mentionPos = 0;

		if (searchResults.length) {
			if (action === "findmatchtag" || action === "findtag") {
				msg = `🔍 Kết quả tìm kiếm cho "${searchTerm}" trong nhóm ${groupTitle}:\n\n`;
				mentionPos = msg.length;

				msg += searchResults.map((member, index) => {
					const dispName = getMemberDisplayName(member) || String(member.id);
					const indexString = `${index + 1}. `;
					const memberText = `${indexString}@${dispName}\n  - ID: ${member.id}`;

					const currentPos = mentionPos + indexString.length;

					mentions.push({
						uid: member.id,
						len: dispName.length + 1,
						pos: currentPos
					});

					mentionPos += memberText.length + 2;
					return memberText;
				}).join("\n\n");

				if (botIsAdminBox) {
					msg += `\n\nReply tin nhắn với từ khóa kick/block để thực hiện hành động với các tài khoản này!`;
				}
			} else {
				msg = `🔍 Kết quả tìm kiếm cho "${searchTerm}" trong nhóm ${groupTitle}:\n` +
					`${searchResults.map((member, index) => `${index + 1}. ${getMemberDisplayName(member) || member.id}\n  - ID: ${member.id}`).join("\n")}\n` +
					`${botIsAdminBox ? `\nReply tin nhắn với từ khóa kick/block để thực hiện hành động với các tài khoản này!` : ""}`;
			}
		} else {
			msg = `🔍 Không tìm thấy thành viên nào trong nhóm ${groupTitle} có ${VALID_ACTIONS[action]} với "${searchTerm}"!`;
		}

		let sentMessage;
		if (action === "findmatchtag" || action === "findtag") {
			sentMessage = await sendMessageTag(api, message, {
				caption: msg,
				mentions: mentions
			}, TIME_WAIT_SELECTION);
		} else {
			sentMessage = await sendMessageCompleteRequest(api, message, {
				caption: msg,
			}, TIME_WAIT_SELECTION);
		}

		if (searchResults.length > 0 && sentMessage) {
			const quotedMsgIdStr = sentMessage?.message?.msgId?.toString() || sentMessage?.msgId?.toString() || "";
			if (quotedMsgIdStr) {
				scanResultsMap.set(quotedMsgIdStr, {
					results: searchResults,
					groupInfo: resolvedGroupInfo,
					timestamp: Date.now(),
					userRequest: message.data.uidFrom,
					botIsAdminBox
				});

				startInteractionCountdown({
					key: `scan_group_${quotedMsgIdStr}`,
					api,
					message: sentMessage,
					messageContext: message,
					seconds: Math.floor(TIME_WAIT_SELECTION / 1000) || 60,
					deleteOnExpire: true,
					onExpire: async () => {
						scanResultsMap.delete(quotedMsgIdStr);
					},
				});
			}
		}

		return;
	} catch (error) {
		console.error(`Lỗi khi thực hiện lệnh scanGroupsWithAction:`, error);
		await sendMessageFailed(
			api,
			message,
			"❌ Đã xảy ra lỗi khi quét thành viên nhóm, vui lòng thử lại hoặc nhập thông tin cụ thể hơn!",
			true
		);
		return;
	}
}

export async function handleScanGroupsReply(api, message) {
	const idBot = String(getBotId() || "");
	const threadId = message.threadId;

	try {
		if (!message.data?.quote || !message.data.quote.globalMsgId) return false;

		const quotedMsgId = message.data.quote.globalMsgId.toString();
		if (!scanResultsMap.has(quotedMsgId)) return false;

		const scanData = scanResultsMap.get(quotedMsgId);
		if (scanData.userRequest !== message.data.uidFrom) {
			await sendMessageWarning(
				api,
				message,
				"Bạn Không phải người yêu cầu hành động này!",
				true
			);
			return true;
		}

		const content = String(removeMention(message) || "").trim().toLowerCase();
		const action = content === "kick" ? "kick" : content === "block" ? "block" : null;

		if (!action) {
			await sendMessageQuery(
				api,
				message,
				"⚠️ Vui lòng sử dụng một trong các từ khóa 'kick' hoặc 'block'!",
				true
			);
			return true;
		}

		if (!scanData.botIsAdminBox) {
			await sendMessageQuery(
				api,
				message,
				"Tôi Không đủ quyền để thực hiện hành động này!",
				true
			);
			return true;
		}

		const groupAdmins = (await getGroupAdmins(scanData.groupInfo)) || [];
		const adminIdSet = new Set(groupAdmins.map(String));
		const uidFinal = [];
		const results = [];

		for (const member of scanData.results) {
			const dispName = getMemberDisplayName(member) || String(member.id);
			if (String(member.id) === idBot || isAdmin(member.id, threadId) || adminIdSet.has(String(member.id))) {
				results.push(`${dispName} -> Không thể ${action === "kick" ? "Kick" : "Block"} quản trị nhóm!`);
			} else {
				uidFinal.push(member);
			}
		}

		if (action === "kick") {
			for (const member of uidFinal) {
				const dispName = getMemberDisplayName(member) || String(member.id);
				try {
					const res = await api.removeUserFromGroup(threadId, [member.id]);
					const rejected = Array.isArray(res?.errorMembers) && res.errorMembers.map(String).includes(String(member.id));
					if (rejected) {
						results.push(`${dispName} -> Không thể Kick (Zalo từ chối thao tác)!`);
					} else {
						results.push(`${dispName} -> Đã Kick!`);
					}
				} catch (error) {
					results.push(`${dispName} -> Không thể Kick do ${error?.message || error}!`);
				}
			}
		} else {
			for (const member of uidFinal) {
				const dispName = getMemberDisplayName(member) || String(member.id);
				try {
					const res = await api.blockUsers(threadId, [member.id]);
					const rejected = Array.isArray(res?.errorMembers) && res.errorMembers.map(String).includes(String(member.id));
					if (rejected) {
						results.push(`${dispName} -> Không thể Block (Zalo từ chối thao tác)!`);
					} else {
						results.push(`${dispName} -> Đã Block!`);
					}
				} catch (error) {
					results.push(`${dispName} -> Không thể Block do ${error?.message || error}!`);
				}
			}
		}

		const msgDel = {
			type: safeThreadType(message),
			threadId: message.threadId,
			data: {
				cliMsgId: message.data.quote.cliMsgId,
				msgId: message.data.quote.globalMsgId,
				uidFrom: idBot,
			},
		};
		completeInteractionCountdown(`scan_group_${quotedMsgId}`);
		try {
			await api.deleteMessage(msgDel, false);
		} catch {}
		scanResultsMap.delete(quotedMsgId);

		await sendMessageComplete(
			api,
			message,
			`Kết quả thực hiện ${action}:\n${results.join("\n")}`,
			false
		);

		return true;
	} catch (error) {
		console.error(`Lỗi khi xử lý reply scan:`, error);
		await sendMessageQuery(
			api,
			message,
			"❌ Đã xảy ra lỗi khi thực hiện hành động. Vui lòng thử lại sau!",
			true
		);
		return true;
	}
}