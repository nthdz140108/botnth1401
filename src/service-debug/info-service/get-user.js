import { MessageType } from "../../api-zalo/models/Message.js";

const PROFILE_BATCH_SIZE = 500;
const MESSAGE_INTERVAL_MS = 1000;
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
  // Read the original server payload, including members hidden by a client UI.
  // FakeOwner only alters presentation; never change trusted group roles here.
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
    await loadProfileNames(api, roster.members);
    const count = roster.members.length;
    const countText = roster.total === null ? String(count) : `${count}/${roster.total}`;
    const notice = roster.total === null
      ? "Zalo chưa cung cấp tổng số thành viên để xác nhận danh sách đầy đủ."
      : count !== roster.total || roster.hasMore
        ? "Danh sách chưa đầy đủ hoặc tổng số đã thay đổi: chỉ hiển thị thành viên API trả về. Nếu nhóm ẩn thành viên, bot cần quyền truy cập thật; giả vai trò cục bộ không lấy thêm dữ liệu từ máy chủ."
        : "";
    await send(`📋 Thành viên nhóm: ${roster.name}\nNhận được: ${countText} thành viên.\nMỗi thành viên một tin nhắn, cách nhau ít nhất 1 giây.${notice ? `\n⚠️ ${notice}` : ""}`);
    for (const [index, member] of roster.members.entries()) {
      const role = member.uid === roster.creatorId ? "Trưởng nhóm"
        : roster.adminIds.has(member.uid) ? "Phó nhóm" : "Thành viên";
      await send(`[${index + 1}/${count}] ${member.name || "Chưa có tên hồ sơ"}\nUID: ${member.uid}\nVai trò: ${role}`);
      sent++;
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
