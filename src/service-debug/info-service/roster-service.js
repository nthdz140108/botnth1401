const PROFILE_BATCH_SIZE = 500;
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

export function readRoster(response, threadId) {
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

export async function completeRoster(api, threadId, roster, { onError } = {}) {
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
    } catch (error) {
      onError?.(error);
      // Preserve known members and show an explicit partial count on failure.
      break;
    }
  }
  roster.members = [...members.values()];
  return roster;
}

export async function loadProfileNames(api, members) {
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

export async function scanRoster(api, threadId) {
 const roster = await completeRoster(api, String(threadId), readRoster(await api.getGroupInfo(String(threadId)), String(threadId)));
 await loadProfileNames(api, roster.members);
 return {group_id:String(threadId),name:roster.name,members:roster.members,total:roster.total,completeness:roster.total===null?'unknown':roster.total===roster.members.length&&!roster.hasMore?'full':'partial',scanned_at:new Date().toISOString()};
}
