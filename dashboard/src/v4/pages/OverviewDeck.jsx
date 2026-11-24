import React, { useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { formatBytesVi, formatDurationVi, formatExpiryVi, formatRelativeTimeVi } from "../http.js";

function renderStatusBadge(bot) {
  const status = bot.status;
  if (status === "cookie_expired" || bot.cookieDead) {
    return (
      <span className="v4-badge danger" title="Cookie Zalo đã hết hạn hoặc bị hủy phiên">
        <span className="v4-status-dot-pulse danger" /> Cookie Hết Hạn
      </span>
    );
  }
  if (status === "online" || status === "running" || bot.connected || bot.wsConnected) {
    return (
      <span className="v4-badge success" title="WebSocket kết nối ổn định 24/7">
        <span className="v4-status-dot-pulse success" /> Đang Online
      </span>
    );
  }
  if (status === "hot_standby" || status === "standby") {
    return (
      <span className="v4-badge accent" title="Chế độ chờ nóng: tiến trình sẵn sàng nhận lệnh lập tức">
        <span className="v4-status-dot-pulse accent" /> Chờ Nóng (Standby)
      </span>
    );
  }
  if (status === "connecting" || status === "starting" || status === "recovering") {
    return (
      <span className="v4-badge warning" title="Đang bắt tay WebSocket và tải nhóm">
        <span className="v4-status-dot-pulse warning" /> Đang Kết Nối
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="v4-badge danger" title="Tiến trình gặp lỗi hoặc dừng đột ngột">
        <span className="v4-status-dot-pulse danger" /> Lỗi Tiến Trình
      </span>
    );
  }
  return (
    <span className="v4-badge neutral" title="Bot đang ở trạng thái dừng">
      <span className="v4-dot" /> Đã Dừng ({status || "stopped"})
    </span>
  );
}

export default function OverviewDeck() {
  const {
    bots,
    adminBot,
    adminNeedsRecovery,
    metrics,
    telemetry,
    socketConnected,
    isStale,
    isActionRunning,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    setDetailBotId,
    setSelectedBotId,
    setPage,
    runBotAction,
    runBulkBotAction,
  } = useControlCenter();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [checkedIds, setCheckedIds] = useState([]);

  // Counts by real status
  const counts = useMemo(() => {
    let online = 0;
    let hotStandby = 0;
    let connecting = 0;
    let cookieExpired = 0;
    let error = 0;
    let stopped = 0;

    for (const b of bots) {
      if (b.status === "cookie_expired" || b.cookieDead) cookieExpired += 1;
      else if (b.status === "online" || b.status === "running" || b.connected || b.wsConnected) online += 1;
      else if (b.status === "hot_standby" || b.status === "standby") hotStandby += 1;
      else if (b.status === "connecting" || b.status === "starting" || b.status === "recovering") connecting += 1;
      else if (b.status === "error") error += 1;
      else stopped += 1;
    }
    return { online, hotStandby, connecting, cookieExpired, error, stopped, total: bots.length };
  }, [bots]);

  const filteredBots = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bots.filter((b) => {
      const isOnline = (b.status === "online" || b.status === "running" || b.connected || b.wsConnected) && !b.cookieDead;
      const isStandby = b.status === "hot_standby" || b.status === "standby";
      if (filter === "online" && !isOnline) return false;
      if (filter === "hot_standby" && !isStandby) return false;
      if (filter === "connecting" && b.status !== "connecting" && b.status !== "starting") return false;
      if (filter === "cookie_expired" && b.status !== "cookie_expired" && !b.cookieDead) return false;
      if (filter === "error" && b.status !== "error") return false;
      if (filter === "stopped" && (isOnline || isStandby || b.status === "cookie_expired" || b.cookieDead)) return false;

      if (!q) return true;
      return (
        b.displayName?.toLowerCase().includes(q) ||
        b.id?.toLowerCase().includes(q) ||
        b.uid?.toLowerCase().includes(q) ||
        (b.ownerUid || "").toLowerCase().includes(q)
      );
    });
  }, [bots, search, filter]);

  const toggleSelect = (id) => {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    if (checkedIds.length === filteredBots.length) {
      setCheckedIds([]);
    } else {
      setCheckedIds(filteredBots.map((b) => b.id));
    }
  };

  const rssBytes =
    metrics?.process?.rssBytes ??
    metrics?.memory?.rss ??
    metrics?.rssBytes ??
    (telemetry?.resources?.rssMb ? telemetry.resources.rssMb * 1024 * 1024 : 0);

  const uptimeSecs =
    metrics?.process?.uptimeSecs ??
    metrics?.uptimeSecs ??
    metrics?.uptime ??
    telemetry?.resources?.processUptimeSec ??
    adminBot?.uptimeSecs ??
    0;

  return (
    <div className="v4-fleet-container">
      {/* Liferaft Admin Bot Hero Card */}
      <div className={`v4-card ${adminNeedsRecovery ? "highlight-danger" : "highlight-admin"}`}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              className={`v4-avatar ${adminNeedsRecovery ? "dead" : "online"}`}
              style={{ width: 54, height: 54, fontSize: 22 }}
            >
              {adminBot?.avatar ? <img src={adminBot.avatar} alt="" /> : "A"}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>
                  {adminBot ? adminBot.displayName : "Bot Admin Chính (Chưa Đăng Nhập)"}
                </h2>
                <span className="v4-badge info">TRẠM CHỈ HUY ADMIN</span>
                {adminBot ? renderStatusBadge(adminBot) : <span className="v4-badge danger">● Chưa có Cookie</span>}
              </div>
              <div className="v4-muted" style={{ marginTop: 4 }}>
                {adminNeedsRecovery
                  ? `⚠️ Cookie Bot Admin đang hết hạn hoặc chưa cấu hình${adminBot?.deadReason ? ` (${adminBot.deadReason})` : ""}. Dashboard vẫn hoạt động Always-On 24/7 — Bấm nút bên phải để quét mã QR khôi phục ngay!`
                  : `UID: ${adminBot?.uid} • Prefix: "${adminBot?.prefix}" • Uptime: ${formatDurationVi(adminBot?.uptimeSecs || uptimeSecs)} • Quản trị trực tiếp toàn bộ bot`}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`v4-btn ${adminNeedsRecovery ? "danger" : "primary"}`}
              onClick={() => setShowAdminRecovery(true)}
            >
              ⚡ {adminNeedsRecovery ? "Quét Mã QR Khôi Phục Admin Ngay" : "Đổi / Quét Lại QR Admin"}
            </button>
            {adminBot && (
              <>
                <button
                  type="button"
                  className="v4-btn"
                  onClick={() => {
                    setSelectedBotId(adminBot.id);
                    setPage("remote");
                  }}
                >
                  🎮 Điều Khiển
                </button>
                <button
                  type="button"
                  className="v4-btn"
                  disabled={isActionRunning(adminBot.id, "restart")}
                  onClick={() => runBotAction(adminBot.id, "restart")}
                >
                  {isActionRunning(adminBot.id, "restart") ? (
                    <span className="v4-spinner-icon" />
                  ) : (
                    "↻ Khởi động lại"
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 4 KPI Cards */}
      <div className="v4-grid-4">
        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Đội Hình Bot (Fleet Online)</div>
          <div className="v4-kpi-value" style={{ color: "var(--success)" }}>
            {counts.online} <span style={{ fontSize: 15, color: "var(--text-muted)" }}>/ {counts.total} Bot</span>
          </div>
          <div className="v4-muted v4-stat-sub">
            {counts.hotStandby > 0 && <span style={{ color: "var(--accent)", marginRight: 8 }}>⚡ {counts.hotStandby} Chờ Nóng</span>}
            {counts.cookieExpired > 0 ? (
              <span style={{ color: "var(--danger)" }}>🚨 {counts.cookieExpired} Bot Hết Cookie</span>
            ) : (
              "Mọi cookie đều hợp lệ"
            )}
          </div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Trạng Thái Kết Nối Trực Tiếp</div>
          <div className="v4-kpi-value" style={{ color: isStale ? "var(--warning)" : "var(--primary)" }}>
            {socketConnected ? "Realtime Socket" : "HTTP Polling"}
          </div>
          <div className="v4-muted v4-stat-sub">
            {isStale ? "🟡 Đang kết nối lại (Dữ liệu đệm)" : "🟢 Socket đồng bộ 0ms layout shift"}
          </div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Tài Nguyên RAM & Tiến Trình</div>
          <div className="v4-kpi-value">{rssBytes ? formatBytesVi(rssBytes) : "Siêu nhẹ"}</div>
          <div className="v4-muted v4-stat-sub">Uptime hệ thống: {formatDurationVi(uptimeSecs)}</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Tiến Độ & Thao Tác Hệ Thống</div>
          <div className="v4-kpi-value" style={{ cursor: "pointer" }} onClick={() => setPage("operations")}>
            Operations
          </div>
          <div className="v4-muted v4-stat-sub">
            <button
              type="button"
              className="v4-link-btn"
              onClick={() => setPage("operations")}
              style={{ fontSize: 12, padding: 0 }}
            >
              Xem Timeline các thao tác →
            </button>
          </div>
        </div>
      </div>

      {/* Fleet Management Table */}
      <div className="v4-card v4-fleet-card">
        <div className="v4-card-header">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span>Đội Hình Quản Trị Bot ({filteredBots.length})</span>
              <span className="v4-badge neutral">
                Phím tắt: Nhấn <kbd className="v4-kbd">/</kbd> để tìm kiếm
              </span>
            </h2>
            <div className="v4-muted">
              Kiểm soát trạng thái thời gian thực: Online, Chờ nóng (Standby), Kết nối, Hết hạn Cookie, và Lỗi.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="v4-btn"
              onClick={() => setPage("operations")}
            >
              📋 Quản lý Tiến trình (Operations)
            </button>
            <button
              type="button"
              className="v4-btn success"
              onClick={() => setCreateQrTargetBot({ mode: "create" })}
            >
              ➕ Tạo Bot Phụ Bằng QR
            </button>
          </div>
        </div>

        {/* Toolbar & Filters */}
        <div className="v4-toolbar">
          <div style={{ position: "relative", flex: "1 1 280px", maxWidth: 360 }}>
            <input
              data-shortcut-search="true"
              className="v4-input"
              style={{ width: "100%", paddingRight: 32 }}
              placeholder="Tìm theo tên Bot, UID, chủ thuê... (Phím /)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="v4-input-clear-btn"
                onClick={() => setSearch("")}
                title="Xóa tìm kiếm"
              >
                ✕
              </button>
            )}
          </div>

          <div className="v4-fleet-filter-chips">
            <button
              type="button"
              className={`v4-chip ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              Tất cả ({bots.length})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "online" ? "active" : ""}`}
              onClick={() => setFilter("online")}
            >
              🟢 Online ({counts.online})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "hot_standby" ? "active" : ""}`}
              onClick={() => setFilter("hot_standby")}
            >
              ⚡ Chờ Nóng ({counts.hotStandby})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "connecting" ? "active" : ""}`}
              onClick={() => setFilter("connecting")}
            >
              🟡 Đang Kết Nối ({counts.connecting})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "cookie_expired" ? "active" : ""}`}
              onClick={() => setFilter("cookie_expired")}
            >
              🔴 Hết Cookie ({counts.cookieExpired})
            </button>
            {counts.error > 0 && (
              <button
                type="button"
                className={`v4-chip ${filter === "error" ? "active" : ""}`}
                onClick={() => setFilter("error")}
              >
                ❌ Báo Lỗi ({counts.error})
              </button>
            )}
          </div>

          {checkedIds.length > 0 && (
            <div className="v4-bulk-actions-bar">
              <span className="v4-badge info">Đã chọn {checkedIds.length} bot</span>
              <button
                type="button"
                className="v4-btn sm success"
                onClick={() => runBulkBotAction("start", checkedIds)}
              >
                ▶ Bật hàng loạt
              </button>
              <button
                type="button"
                className="v4-btn sm accent"
                onClick={() => runBulkBotAction("hot_standby", checkedIds)}
              >
                ⚡ Chờ nóng hàng loạt
              </button>
              <button
                type="button"
                className="v4-btn sm"
                onClick={() => runBulkBotAction("restart", checkedIds)}
              >
                ↻ Khởi động lại
              </button>
              <button
                type="button"
                className="v4-btn sm danger"
                onClick={() => runBulkBotAction("stop", checkedIds)}
              >
                ⏹ Dừng hàng loạt
              </button>
            </div>
          )}
        </div>

        {/* Fleet Table */}
        <div className="v4-table-wrap">
          <table className="v4-table">
            <thead>
              <tr>
                <th style={{ width: 38 }}>
                  <input
                    type="checkbox"
                    checked={filteredBots.length > 0 && checkedIds.length === filteredBots.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th>Tài Khoản Bot</th>
                <th>Trạng Thái</th>
                <th>Cập Nhật Lần Cuối</th>
                <th>Prefix</th>
                <th>Hạn Thuê / Chủ Bot</th>
                <th style={{ textAlign: "right" }}>Thao Tác Nhanh (Realtime Action)</th>
              </tr>
            </thead>
            <tbody>
              {filteredBots.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 32 }} className="v4-muted">
                    Không có bot nào khớp bộ lọc <strong>"{filter}"</strong>. Hãy bấm{" "}
                    <strong>“➕ Tạo Bot Phụ Bằng QR”</strong> hoặc chọn <strong>“Tất cả”</strong>.
                  </td>
                </tr>
              ) : (
                filteredBots.map((bot) => {
                  const relTime = formatRelativeTimeVi(bot.updatedAt);
                  const isRunningStart = isActionRunning(bot.id, "start");
                  const isRunningStop = isActionRunning(bot.id, "stop");
                  const isRunningStandby = isActionRunning(bot.id, "hot_standby") || isActionRunning(bot.id, "standby");

                  return (
                    <tr key={bot.id} className="v4-fleet-row">
                      <td>
                        <input
                          type="checkbox"
                          checked={checkedIds.includes(bot.id)}
                          onChange={() => toggleSelect(bot.id)}
                        />
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div
                            className={`v4-avatar ${
                              bot.status === "cookie_expired" || bot.cookieDead
                                ? "dead"
                                : bot.status === "online" || bot.wsConnected
                                  ? "online"
                                  : bot.status === "hot_standby"
                                    ? "accent"
                                    : ""
                            }`}
                          >
                            {bot.avatar ? <img src={bot.avatar} alt="" /> : (bot.displayName || "B").slice(0, 1)}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                              <span
                                style={{ cursor: "pointer", textDecoration: "underline" }}
                                onClick={() => setDetailBotId(bot.id)}
                              >
                                {bot.displayName}
                              </span>
                              {bot.isMain && <span className="v4-badge info">ADMIN</span>}
                            </div>
                            <div className="v4-muted v4-mono" style={{ fontSize: 11.5 }}>
                              UID: {bot.uid}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {renderStatusBadge(bot)}
                        {bot.deadReason && (
                          <div className="v4-muted" style={{ fontSize: 11, color: "var(--danger)", marginTop: 2 }}>
                            {bot.deadReason}
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          className="v4-relative-time"
                          title={`Thời điểm cập nhật chính xác (ISO):\n${relTime.exactIso}`}
                        >
                          🕒 {relTime.relative}
                        </span>
                      </td>
                      <td className="v4-mono">{bot.prefix}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{formatExpiryVi(bot.expiryAt)}</div>
                        {bot.ownerUid && (
                          <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                            Chủ: {bot.ownerUid}
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                          {/* 1. Bật / Tắt Button */}
                          {(() => {
                            const isOnline = (bot.status === "online" || bot.status === "running" || bot.connected || bot.wsConnected) && !bot.cookieDead && bot.status !== "standby" && bot.status !== "hot_standby";
                            const isStandby = bot.status === "hot_standby" || bot.status === "standby";

                            if (isOnline) {
                              return (
                                <button
                                  type="button"
                                  className="v4-btn sm"
                                  title="Đặt bot ở trạng thái Chờ Nóng (Hot Standby — Giữ session trong RAM, tắt WebSocket)"
                                  disabled={isRunningStop}
                                  onClick={() => runBotAction(bot.id, "standby")}
                                >
                                  {isRunningStop ? <span className="v4-spinner-icon" /> : "⏹ Tắt"}
                                </button>
                              );
                            }

                            return (
                              <button
                                type="button"
                                className="v4-btn sm success"
                                title={isStandby ? "Khôi phục bot từ Chờ Nóng tức thì" : "Bật Bot hoạt động"}
                                disabled={isRunningStart}
                                onClick={() => runBotAction(bot.id, isStandby ? "resume" : "start")}
                              >
                                {isRunningStart ? <span className="v4-spinner-icon" /> : (isStandby ? "▶ Khôi Phục" : "▶ Bật")}
                              </button>
                            );
                          })()}

                          {/* 2. Chờ Nóng Button (Hot Standby) */}
                          <button
                            type="button"
                            className={`v4-btn sm ${(bot.status === "hot_standby" || bot.status === "standby") ? "accent active" : ""}`}
                            title="Đặt bot ở trạng thái Chờ Nóng: duy trì tiến trình để kích hoạt tức thì không trễ"
                            disabled={isRunningStandby}
                            onClick={() => runBotAction(bot.id, "hot_standby")}
                          >
                            {isRunningStandby ? <span className="v4-spinner-icon" /> : "⚡ Chờ Nóng"}
                          </button>

                          {/* 3. Quét QR Button */}
                          <button
                            type="button"
                            className={`v4-btn sm ${bot.status === "cookie_expired" || bot.cookieDead ? "danger pulse-btn" : ""}`}
                            title="Quét lại mã QR đăng nhập Zalo"
                            onClick={() => {
                              if (bot.isMain) {
                                setShowAdminRecovery(true);
                              } else {
                                setCreateQrTargetBot({ mode: "relogin", botId: bot.id });
                              }
                            }}
                          >
                            {bot.status === "cookie_expired" || bot.cookieDead ? "⚡ Quét QR Ngay" : "Quét QR"}
                          </button>

                          {/* 4. Điều Khiển Remote */}
                          <button
                            type="button"
                            className="v4-btn sm primary"
                            title="Mở giao diện gửi tin & chạy lệnh từ xa"
                            onClick={() => {
                              setSelectedBotId(bot.id);
                              setPage("remote");
                            }}
                          >
                            🎮 Điều Khiển
                          </button>

                          {/* 5. Chi Tiết Bot Modal */}
                          <button
                            type="button"
                            className="v4-btn sm"
                            title="Mở chi tiết Bot: Nhóm, Khiên, Cấu hình Studio, Lịch SendTask, Vitals"
                            onClick={() => setDetailBotId(bot.id)}
                          >
                            ⚙ Chi Tiết
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
