import { MessageType } from "../../api-zalo/models/Message.js";

const PROFILE_BATCH_SIZE = 500;
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

function memberUid(value) {
  const raw = value && typeof value === "object"
    ? value.id ?? value.uid ?? value.userId
    : value;
  if (raw == null) return "";
  const uid = String(raw).trim().replace(/_\d+$/, "");
  return /^\d+$/.test(uid) && uid !== "0" ? uid : "";
}

function profileName(profile) {
  return String(profile?.displayName || profile?.dName || profile?.zaloName || profile?.name || "").trim();
}

function readRoster(response, threadId) {
  // Keep real creator/admin metadata separate from member enumeration.
  const info = response?.gridInfoMap ? response.gridInfoMap[threadId] : response;
  if (!info || typeof info !== "object" || (info.groupId && String(info.groupId) !== threadId)) {
    throw new Error("Group information is unavailable");
  }
  for (const key of ["memVerList", "memberIds", "currentMems", "adminIds", "admins"]) {
    if (info[key] != null && !Array.isArray(info[key])) throw new Error("Invalid group member list");
  }
  const members = new Map();
  const add = (entry, versioned = false) => {
    const uid = memberUid(entry);
    if (!uid) return;
    const member = members.get(uid) || { uid, reference: `${uid}_0`, name: "" };
    if (versioned && typeof entry === "string") member.reference = entry;
    member.name ||= profileName(entry);
    members.set(uid, member);
  };
  for (const entry of info.memVerList || []) add(entry, true);
  for (const entry of info.memberIds || []) add(entry);
  for (const entry of info.currentMems || []) add(entry);
  add(info.creatorId);
  for (const entry of info.adminIds || []) add(entry);
  for (const entry of info.admins || []) add(entry);
  const total = info.totalMember == null || info.totalMember === "" ? NaN : Number(info.totalMember);
  return {
    name: String(info.name || threadId),
    members: [...members.values()],
    total: Number.isSafeInteger(total) && total >= 0 ? total : null,
    hasMore: Number(info.hasMoreMember) === 1,
    creatorId: memberUid(info.creatorId),
    adminIds: new Set([...(info.adminIds || []), ...(info.admins || [])].map(memberUid).filter(Boolean)),
  };
}

async function completeRoster(api, threadId, roster) {
  if (typeof api.getGroupInfoV2 !== "function" || (!roster.hasMore && roster.total !== null && roster.members.length === roster.total)) return roster;
  const members = new Map(roster.members.map((member) => [member.uid, member]));
  const seenPages = new Set();
  for (let mpage = 1; mpage <= 1000; mpage++) {
    try {
      // getmg-v2 can return only owner/deputies/self for hidden communities,
      // while getgi/v2 supplies the full memberIds independently of currentMems.
      const page = readRoster(await api.getGroupInfoV2(threadId, { mpage, mcount: 100 }), threadId);
      const pageKey = page.members.map((member) => member.uid).sort().join(",");
      if (seenPages.has(pageKey)) break;
      seenPages.add(pageKey);
      for (const member of page.members) {
        const existing = members.get(member.uid);
        if (existing) existing.name ||= member.name;
        else members.set(member.uid, member);
      }
      roster.total = page.total ?? roster.total;
      roster.hasMore = page.hasMore;
      if (!page.hasMore || page.members.length === 0) break;
    } catch {
      // Preserve known members and show an explicit partial count on failure.
      break;
    }
  }
  roster.members = [...members.values()];
  return roster;
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

async function loadProfileNames(api, members) {
  if (typeof api.getGroupMembers !== "function") return;
  for (let offset = 0; offset < members.length; offset += PROFILE_BATCH_SIZE) {
    const batch = members.slice(offset, offset + PROFILE_BATCH_SIZE);
    try {
      const result = await api.getGroupMembers(batch.map((member) => member.reference));
      const profiles = new Map(Object.entries(result?.profiles || {}).map(([key, profile]) => [
        memberUid(profile) || memberUid(key), profile,
      ]));
      for (const member of batch) {
        member.name = profileName(profiles.get(member.uid)) || member.name;
      }
    } catch {
      // A denied/missing profile must not remove an otherwise known member UID.
    }
  }
}

export async function getUserCommand(api, message, context = {}) {
  if (message?.type !== MessageType.GroupMessage) {
    await api.sendMessage({ msg: "Lệnh !getuser chỉ dùng được trong nhóm." }, message.threadId, message.type);
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
      return await api.sendMessage({ msg }, threadId, MessageType.GroupMessage);
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
