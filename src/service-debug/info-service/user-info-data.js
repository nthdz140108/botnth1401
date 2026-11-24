export async function getUserInfoData(api, userId) {
  if (!api || typeof api.getUserInfo !== "function") return null;
  const uid = typeof userId === "string" || typeof userId === "number" ? String(userId).trim() : "";
  if (!uid) return null;

  const userInfoResponse = await api.getUserInfo([uid]);
  if (!userInfoResponse) return null;

  const userInfo = resolveUserProfile(userInfoResponse, uid);
  return userInfo ? getAllInfoUser(userInfo) : null;
}

export function resolveUserProfile(userInfoResponse, uid) {
  if (!userInfoResponse || typeof userInfoResponse !== "object" || !uid) {
    return null;
  }

  const { unchanged_profiles, changed_profiles } = userInfoResponse;
  const profileMaps = [unchanged_profiles, changed_profiles].filter(
    (map) => map && typeof map === "object" && !Array.isArray(map)
  );

  // 1. Exact UID key match
  for (const map of profileMaps) {
    const profile = map[uid];
    if (profile && typeof profile === "object") {
      return profile;
    }
  }

  // 2. Versioned key match: <uid>_* (ví dụ: <uid>_0)
  const versionPrefix = `${uid}_`;
  for (const map of profileMaps) {
    for (const [key, profile] of Object.entries(map)) {
      if (key.startsWith(versionPrefix) && profile && typeof profile === "object") {
        return profile;
      }
    }
  }

  // 3. Fallback: khớp qua trường userId
  for (const map of profileMaps) {
    for (const profile of Object.values(map)) {
      if (profile && typeof profile === "object" && String(profile.userId) === uid) {
        return profile;
      }
    }
  }

  return null;
}

export function getAllInfoUser(userInfo) {
  if (!userInfo) return null;
  const lastActionTime = userInfo.lastActionTime || 0;
  return {
    title: "Thông Tin Người Dùng",
    uid: userInfo.userId || "Không xác định",
    name: formatName(userInfo.zaloName),
    avatar: userInfo.avatar,
    cover: userInfo.cover,
    gender: formatGender(userInfo.gender),
    genderId: userInfo.gender,
    businessAccount: userInfo.bizPkg?.label ? "Có" : "Không",
    businessType: getTextTypeBusiness(userInfo.bizPkg?.pkgId),
    isActive: userInfo.isActive,
    isActivePC: userInfo.isActivePC,
    isActiveWeb: userInfo.isActiveWeb,
    isValid: userInfo.isValid,
    username: userInfo.username,
    bizPkg: userInfo.bizPkg,
    birthday: formatDate(userInfo.dob || userInfo.sdob) || "Ẩn",
    phone: userInfo.phone || "Ẩn",
    lastActive: formatTimestamp(userInfo.lastActionTime),
    createdDate: formatTimestamp(userInfo.createdTs),
    bio: userInfo.status || "Không có thông tin bio",
    isOnline: Date.now() - lastActionTime <= 300000,
    footer: `${randomEmoji()} Chúc bạn một ngày tốt lành!`,
  };
}

function randomEmoji() {
  const emojis = ["😊", "🌟", "🎉", "🌈", "🌺", "🍀", "🌞", "🌸"];
  return emojis[Math.floor(Math.random() * emojis.length)];
}

function formatName(name) {
  const value = typeof name === "string" ? name : "Không xác định";
  return value.length > 30 ? value.slice(0, 27) + "..." : value;
}

function formatGender(gender) {
  return gender === 0 ? "Nam 👨" : gender === 1 ? "Nữ 👩" : "Không xác định 🤖";
}

function getTextTypeBusiness(type) {
  return type === 1
    ? "Basic"
    : type === 3
      ? "Pro"
      : type === 2
        ? "Không xác định"
        : "Chưa Đăng Ký";
}

function formatTimestamp(timestamp) {
  if (typeof timestamp !== "number") return "Ẩn";
  const seconds = timestamp > 1e10 ? timestamp / 1000 : timestamp;
  return new Date(seconds * 1000).toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDate(date) {
  if (typeof date !== "number") return date || "Ẩn";
  return new Date(date * 1000).toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
