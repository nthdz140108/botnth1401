import React, { useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatRelativeTimeVi } from "../../v4/http.js";

function renderSeverityBadge(severity) {
  const s = String(severity || "info").toLowerCase();
  if (s === "critical" || s === "error" || s === "urgent") {
    return <span className="v4-badge danger">🚨 Khẩn cấp</span>;
  }
  if (s === "warning" || s === "warn") {
    return <span className="v4-badge warning">⚠️ Cảnh báo</span>;
  }
  if (s === "success") {
    return <span className="v4-badge success">✅ Hoàn tất</span>;
  }
  return <span className="v4-badge info">ℹ️ Hệ thống</span>;
}

export default function NotificationDrawer() {
  const {
    notifDrawerOpen,
    setNotifDrawerOpen,
    notifications,
    unreadNotifCount,
    markNotifRead,
    markAllNotifsRead,
    setPage,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    setDetailBotId,
  } = useV5();

  const [tab, setTab] = useState("all");

  const counts = useMemo(() => {
    let unread = 0;
    let critical = 0;
    for (const n of notifications) {
      if (!n.read) unread += 1;
      const s = String(n.severity || "").toLowerCase();
      if (s === "critical" || s === "error" || s === "urgent") critical += 1;
    }
    return { all: notifications.length, unread, critical };
  }, [notifications]);

  const filtered = useMemo(() => {
    return notifications.filter((n) => {
      if (tab === "unread") return !n.read;
      if (tab === "critical") {
        const s = String(n.severity || "").toLowerCase();
        return s === "critical" || s === "error" || s === "urgent";
      }
      return true;
    });
  }, [notifications, tab]);

  if (!notifDrawerOpen) return null;

  const closeDrawer = () => setNotifDrawerOpen(false);

  const handleQuickAction = (notif) => {
    markNotifRead(notif.id);
    if (notif.actionPage === "admin_qr") {
      closeDrawer();
      setShowAdminRecovery(true);
      return;
    }
    if (notif.actionPage === "bot_qr" && notif.botId) {
      closeDrawer();
      setCreateQrTargetBot({ mode: "relogin", botId: notif.botId });
      return;
    }
    if (notif.actionPage) {
      closeDrawer();
      setPage(notif.actionPage);
      return;
    }
    if (notif.botId) {
      closeDrawer();
      setDetailBotId(notif.botId);
    }
  };

  return (
    <div
      className="v5-drawer-backdrop"
      onClick={closeDrawer}
      role="dialog"
      aria-modal="true"
      aria-label="Ngăn Thông Báo & Cảnh Báo Hệ Thống"
    >
      <aside className="v5-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="v5-drawer-header">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>🔔 Trung Tâm Thông Báo</h3>
              {unreadNotifCount > 0 && (
                <span className="v4-badge danger">{unreadNotifCount} mới</span>
              )}
            </div>
            <div className="v4-muted" style={{ marginTop: 3 }}>
              Cảnh báo Cookie, hạn thuê SaaS, tự phục hồi Auto-Heal & sự kiện vận hành
            </div>
          </div>
          <button type="button" className="v4-btn sm" onClick={closeDrawer} title="Đóng (Esc)">
            ✕
          </button>
        </div>

        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div className="v4-fleet-filter-chips">
            <button
              type="button"
              className={`v4-chip ${tab === "all" ? "active" : ""}`}
              onClick={() => setTab("all")}
            >
              All ({counts.all})
            </button>
            <button
              type="button"
              className={`v4-chip ${tab === "unread" ? "active" : ""}`}
              onClick={() => setTab("unread")}
            >
              Chưa đọc ({counts.unread})
            </button>
            <button
              type="button"
              className={`v4-chip ${tab === "critical" ? "active" : ""}`}
              onClick={() => setTab("critical")}
            >
              🚨 Khẩn cấp ({counts.critical})
            </button>
          </div>

          {unreadNotifCount > 0 && (
            <button type="button" className="v4-btn sm" onClick={markAllNotifsRead}>
              ✓ Đánh dấu đã đọc tất cả
            </button>
          )}
        </div>

        <div className="v5-drawer-body">
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 16px" }} className="v4-muted">
              <div style={{ fontSize: 34, marginBottom: 8 }}>✨</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>
                Không có cảnh báo nào trong mục này
              </div>
              <div style={{ marginTop: 4 }}>
                Toàn bộ đội hình Bot và dịch vụ đang vận hành ổn định.
              </div>
            </div>
          ) : (
            filtered.map((notif) => {
              const rel = formatRelativeTimeVi(notif.createdAt);
              const isCrit =
                notif.severity === "critical" ||
                notif.severity === "error" ||
                notif.severity === "urgent";
              return (
                <div
                  key={notif.id}
                  className={`v5-notif-item ${!notif.read ? "unread" : ""} ${isCrit ? "critical" : ""}`}
                  onClick={() => {
                    if (!notif.read) markNotifRead(notif.id);
                  }}
                >
                  <div className="v5-row-between">
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      {renderSeverityBadge(notif.severity)}
                      {(notif.botName || notif.botId) && (
                        <span className="v4-badge neutral v4-mono">
                          🤖 {notif.botName || notif.botId}
                        </span>
                      )}
                    </div>
                    <span className="v4-relative-time" title={rel.exactIso}>
                      🕒 {rel.relative}
                    </span>
                  </div>

                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{notif.title}</div>
                  {notif.message && (
                    <div className="v4-muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                      {notif.message}
                    </div>
                  )}

                  <div className="v5-row-between" style={{ marginTop: 4 }}>
                    <span className="v4-muted" style={{ fontSize: 11 }}>
                      {notif.read ? "Đã xem" : "● Chưa đọc"}
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!notif.read && (
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            markNotifRead(notif.id);
                          }}
                        >
                          Đã đọc
                        </button>
                      )}
                      {(notif.actionLabel || notif.actionPage || notif.botId) && (
                        <button
                          type="button"
                          className={`v4-btn sm ${isCrit ? "danger" : "primary"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickAction(notif);
                          }}
                        >
                          {notif.actionLabel || "Mở chi tiết"} →
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="v5-drawer-footer">
          <span className="v4-muted">Tự động cập nhật qua Realtime Socket</span>
          <button
            type="button"
            className="v4-btn sm"
            onClick={() => {
              closeDrawer();
              setPage("telemetry");
            }}
          >
            ⚙️ Cấu hình Kênh Cảnh Báo
          </button>
        </div>
      </aside>
    </div>
  );
}
