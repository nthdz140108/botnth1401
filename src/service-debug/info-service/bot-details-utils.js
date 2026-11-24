export function normalizeBotInfo(botInfo) {
  if (botInfo && typeof botInfo === "object") {
    const name = botInfo.name || botInfo.displayName || botInfo.uid || "Bot";
    const displayName = botInfo.displayName || botInfo.name || botInfo.uid || "Bot";
    const avatar = typeof botInfo.avatar === "string" && botInfo.avatar.trim().length > 0 ? botInfo.avatar.trim() : null;
    const status = botInfo.status || "running";
    const createdAt = botInfo.createdAt ? (botInfo.createdAt instanceof Date ? botInfo.createdAt : new Date(botInfo.createdAt)) : new Date();
    const lastUpdated = botInfo.lastUpdated || null;
    const createdBy = botInfo.createdBy || "Admin";
    const webPort = botInfo.webPort || "Không có";
    const database = botInfo.database || "Không có";
    const expiryAt = botInfo.expiryAt || "-1";
    const rejecter = botInfo.rejecter || null;

    return {
      ...botInfo,
      name,
      displayName,
      uid: botInfo.uid || name,
      avatar,
      status,
      createdAt,
      lastUpdated,
      createdBy,
      webPort,
      database,
      expiryAt,
      rejecter,
    };
  }

  return {
    name: "Bot",
    displayName: "Bot",
    uid: "Bot",
    avatar: null,
    status: "running",
    lastUpdated: null,
    createdAt: new Date(),
    createdBy: "Admin",
    webPort: "Không có",
    database: "Không có",
    expiryAt: "-1",
    rejecter: null,
  };
}
