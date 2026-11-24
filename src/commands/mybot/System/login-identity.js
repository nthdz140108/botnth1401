export function selectLoginIdentity({ sdkUid = "", userInfo = null, resultData = {}, fallbackName = "", fallbackAvatar = "" } = {}) {
  const uid = String(sdkUid || resultData.uid || "").trim();
  const info = userInfo?.data?.info || userInfo?.info || {};
  const displayName = String(
    info.name ||
    userInfo?.data?.name ||
    resultData.name ||
    fallbackName ||
    ""
  ).trim();
  const avatar = String(
    info.avatar ||
    userInfo?.data?.avatar ||
    resultData.avatar ||
    fallbackAvatar ||
    ""
  ).trim();

  return { uid, displayName, avatar };
}
