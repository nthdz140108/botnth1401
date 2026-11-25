import { MessageType } from "../../api-zalo/models/Message.js";

import { readRoster, completeRoster, loadProfileNames } from "./roster-service.js";
const MESSAGE_INTERVAL_MS = 1000;
const MEMBERS_PER_MESSAGE = 20;
const MEMBER_TEXT_BUDGET = 2800;
// Relay requests wrap the same bot API in different Proxies. Use its real UID
// to share locks/pacing with native chat; identity-less adapters remain isolated.
const botGroupRuns = new Map();
const apiGroupRuns = new WeakMap();

function getRunMap(api, context) {
  let ownUid;
  try {
    ownUid = api.getOwnId?.();
  } catch {}
  const botUid = [ownUid, context.authorizationSnapshot?.instanceUid]
    .map((value) => String(value ?? "").trim())
    .find((value) => /^[1-9]\d*$/.test(value));
  const store = botUid ? botGroupRuns : apiGroupRuns;
  const key = botUid || api;
  let runs = store.get(key);
  if (!runs) {
    runs = new Map();
    store.set(key, runs);
  }
  return runs;
}

function memberMessages(roster) {
  const pages = [];
  let entries = [], size = 0, first = 1;
  const flush = () => {
    if (!entries.length) return;
    pages.push({ count: entries.length, msg: `👥 Thành viên ${first}–${first + entries.length - 1}/${roster.members.length}\n\n${entries.join("\n\n")}` });
    first += entries.length;
    entries = []; size = 0;
  };
  for (const [index, member] of roster.members.entries()) {
    const role = member.uid === roster.creatorId ? "Trưởng nhóm" : roster.adminIds.has(member.uid) ? "Phó nhóm" : "Thành viên";
    const name = (member.name || "Chưa có tên hồ sơ").replace(/\s+/g, " ").slice(0, 240);
    const entry = `${index + 1}. ${name}\nUID: ${member.uid} | ${role}`;
    if (entries.length && (entries.length >= MEMBERS_PER_MESSAGE || size + entry.length + 2 > MEMBER_TEXT_BUDGET)) flush();
    entries.push(entry); size += entry.length + 2;
  }
  flush();
  return pages;
}

export async function getUserCommand(api, message, context = {}) {
  if (message?.type !== MessageType.GroupMessage) {
    await api.sendMessage({ msg: "Lệnh !getuser chỉ dùng được trong nhóm.", ttl: 300000 }, message.threadId, message.type);
    return { status: "group_only" };
  }

  const threadId = String(message.threadId);
  const runs = getRunMap(api, context);
  let state = runs.get(threadId);
  if (!state) {
    state = { running: false, lastSentAt: null };
    runs.set(threadId, state);
  }
  // Ignore repeated invocations while sending, so they cannot flood the group.
  if (state.running) return { status: "busy" };
  state.running = true;

  const send = async (msg) => {
    if (state.lastSentAt !== null) {
      const waitMs = MESSAGE_INTERVAL_MS - (Date.now() - state.lastSentAt);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    try {
      return await api.sendMessage({ msg, ttl: 300000 }, threadId, MessageType.GroupMessage);
    } finally {
      state.lastSentAt = Date.now();
    }
  };

  let sent = 0;
  try {
    let roster;
    try {
      // Bypass the display/cache mapper: it may retain only a subset of fields.
      roster = readRoster(await api.getGroupInfo(threadId), threadId);
    } catch {
      await send("Không lấy được danh sách thành viên nhóm. Zalo có thể đã từ chối quyền truy cập; hãy kiểm tra quyền của bot và thử lại.");
      return { status: "unavailable" };
    }
    await completeRoster(api, threadId, roster);
    await loadProfileNames(api, roster.members);
    const count = roster.members.length;
    const countText = roster.total === null ? String(count) : `${count}/${roster.total}`;
    const notice = roster.total === null
      ? "Zalo chưa cung cấp tổng số thành viên để xác nhận danh sách đầy đủ."
      : count !== roster.total || roster.hasMore
        ? "Danh sách chưa đầy đủ hoặc tổng số đã thay đổi: Zalo chỉ trả về một phần sau khi tải chi tiết nhóm."
        : "";
    await send(`📋 Thành viên nhóm: ${roster.name}\nNhận được: ${countText} thành viên.\nGom tối đa ${MEMBERS_PER_MESSAGE} thành viên/tin, cách nhau ít nhất 1 giây.${notice ? `\n⚠️ ${notice}` : ""}`);
    for (const page of memberMessages(roster)) {
      await send(page.msg);
      sent += page.count;
    }
    await send(`Đã gửi ${sent} thành viên do API cung cấp.${notice ? `\n⚠️ ${notice}` : ""}`);
    return { status: "completed", sent, total: roster.total };
  } catch {
    // Stop on send failure instead of retrying a long stream into a denied chat.
    return { status: "send_failed", sent };
  } finally {
    state.running = false;
  }
}
