export function formatDuration(diffMs) {
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffMonths / 12);

  if (diffYears >= 1) {
    const remainingMonths = diffMonths % 12;
    return remainingMonths > 0 ? `${diffYears} năm ${remainingMonths} tháng` : `${diffYears} năm`;
  } else if (diffMonths >= 1) {
    const remainingDays = diffDays % 30;
    return remainingDays > 0 ? `${diffMonths} tháng ${remainingDays} ngày` : `${diffMonths} tháng`;
  } else if (diffDays >= 1) {
    const remainingHours = diffHours % 24;
    return remainingHours > 0 ? `${diffDays} ngày ${remainingHours} giờ` : `${diffDays} ngày`;
  } else if (diffHours >= 1) {
    const remainingMinutes = diffMinutes % 60;
    return remainingMinutes > 0 ? `${diffHours} giờ ${remainingMinutes} phút` : `${diffHours} giờ`;
  } else if (diffMinutes >= 1) {
    const remainingSeconds = diffSeconds % 60;
    return remainingSeconds > 0 ? `${diffMinutes} phút ${remainingSeconds} giây` : `${diffMinutes} phút`;
  } else {
    return `${diffSeconds} giây`;
  }
}

export function formatBotExpiryDisplay(botInfo = {}, now = Date.now()) {
  if (!botInfo || typeof botInfo !== "object") return "Chưa khởi động";

  const isMain = botInfo.isMain === true || botInfo.key === "admin" || String(botInfo.name || "").toLowerCase() === "admin";
  if (isMain) {
    if (botInfo.status === "running" || botInfo.runtimeState?.running === true) {
      return "Đang hoạt động";
    }
    return "Vĩnh Viễn";
  }

  const isRejected = botInfo.status === "rejected" || botInfo.runtimeState?.status === "rejected";
  if (isRejected) {
    return botInfo.rejecter ? `Vô Hiệu Hóa Bởi ${botInfo.rejecter}` : "Vô Hiệu Hóa";
  }

  const isPermanent = botInfo.expiryAt === "-1";
  if (isPermanent) {
    return "Vĩnh Viễn";
  }

  const isRunning = botInfo.status === "running" || botInfo.runtimeState?.running === true;

  if (isRunning) {
    if (!botInfo.expiryAt) {
      return "Đang hoạt động";
    }
    const expiryDate = new Date(botInfo.expiryAt);
    const diffMs = expiryDate.getTime() - now;
    if (diffMs <= 0) return "Hết Hạn";
    return formatDuration(diffMs);
  }

  const isPending = botInfo.identityPending === true || botInfo.trialStatus === "pending" || (!botInfo.expiryAt && botInfo.trialStatus !== "active");
  if (isPending && !botInfo.expiryAt) {
    return "Chưa khởi động";
  }

  if (!botInfo.expiryAt) {
    return "Chưa khởi động";
  }

  const expiryDate = new Date(botInfo.expiryAt);
  const diffMs = expiryDate.getTime() - now;
  if (diffMs <= 0) return "Hết Hạn";

  return "Tạm dừng";
}

