import React, { useState } from "react";
import { ControlCenterProvider, useControlCenter } from "./store.jsx";
import OverviewDeck from "./pages/OverviewDeck.jsx";
import OperationsTracker from "./pages/OperationsTracker.jsx";
import PerformancePage from "./pages/PerformancePage.jsx";
import RemoteControlPage from "./pages/RemoteControlPage.jsx";
import GroupsShieldPage from "./pages/GroupsShieldPage.jsx";
import StudioAndSchedulePage from "./pages/StudioAndSchedulePage.jsx";
import LiveLogsPage from "./pages/LiveLogsPage.jsx";
import SystemSecurityPage from "./pages/SystemSecurityPage.jsx";
import AdminRecoveryWizard from "./modals/AdminRecoveryWizard.jsx";
import CreateBotQrModal from "./modals/CreateBotQrModal.jsx";
import BotDetailModal from "./modals/BotDetailModal.jsx";

const NAV_ITEMS = [
  { id: "overview", label: "Đội Hình Bot (Fleet)", icon: "📡", keyNum: "1" },
  { id: "operations", label: "Tiến Trình Thao Tác (Ops)", icon: "📋", keyNum: "2" },
  { id: "performance", label: "Hiệu Năng & Đo Lường", icon: "📈", keyNum: "3" },
  { id: "remote", label: "Điều Khiển Bot Từ Xa", icon: "🎮", keyNum: "4" },
  { id: "groups", label: "Nhóm & 17 Khiên Anti", icon: "🛡️", keyNum: "5" },
  { id: "studio", label: "Lịch 24h & Studio Lệnh", icon: "⚙️", keyNum: "6" },
  { id: "logs", label: "Nhật Ký Trực Tiếp (Logs)", icon: "📜", keyNum: "7" },
  { id: "security", label: "Mật Khẩu & Hệ Thống", icon: "🔐", keyNum: "8" },
];

const PAGE_TITLES = {
  overview: {
    title: "Đội Hình Quản Trị Bot (Fleet Command)",
    subtitle: "Giám sát trạng thái Online, Chờ nóng, Kết nối, Hết hạn Cookie và thao tác 1-Click zero layout shift.",
  },
  operations: {
    title: "Theo Dõi Tiến Trình & Hoạt Động (Operations Tracker)",
    subtitle: "Giám sát thời gian thực các thao tác Bật / Tắt / Chờ nóng với operationId, timeline các pha và gợi ý xử lý sự cố.",
  },
  performance: {
    title: "Hiệu Năng & Đo Lường Độ Trễ (Telemetry)",
    subtitle: "Trực quan hóa độ trễ p50/p95/p99, event loop lag, độ sâu hàng đợi và chuỗi 7 pha trễ WebSocket.",
  },
  remote: {
    title: "Điều Khiển Bot & Chạy Lệnh Từ Xa",
    subtitle: "Gửi tin nhắn, ảnh/video, Broadcast giãn cách an toàn và thực thi trực tiếp 218 lệnh.",
  },
  groups: {
    title: "Quản Lý Nhóm Zalo & 17 Khiên Bảo Vệ",
    subtitle: "Bật/tắt công tắc chống Spam, chống Link, chống Thu hồi tin nhắn cho từng nhóm.",
  },
  studio: {
    title: "Lịch Tự Động 24 Giờ & Studio 218 Lệnh",
    subtitle: "Tùy biến lời chúc theo giờ (SendTask) và tinh chỉnh cấu hình chuyên sâu từng lệnh.",
  },
  logs: {
    title: "Nhật Ký Hoạt Động Thời Gian Thực",
    subtitle: "Theo dõi trực tiếp mọi sự kiện hệ thống thay thế hoàn toàn cửa sổ Terminal.",
  },
  security: {
    title: "Bảo Mật Web Admin & Bác Sĩ Hệ Thống",
    subtitle: "Đổi mật khẩu đăng nhập Web, quản lý khóa AI Gemini/OpenAI, dọn rác và sao lưu 1-Click.",
  },
};

function LoginGate() {
  const { login, booting, session, theme, setTheme } = useControlCenter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setPending(true);
    setErrMsg("");
    try {
      await login({ username: username.trim(), password });
    } catch (err) {
      if (err.code === "INVALID_CREDENTIALS") {
        setErrMsg("Sai tên đăng nhập hoặc mật khẩu Web Admin.");
      } else if (err.code === "LOGIN_RATE_LIMITED" || err.status === 429) {
        setErrMsg("Đăng nhập sai quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.");
      } else {
        setErrMsg(err.message || "Không thể đăng nhập vào Trung tâm Điều khiển.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="v4-login-wrap">
      <div className="v4-login-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="v4-brand-badge">
            <span className="v4-brand-logo">M4</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>MYBOT ADMIN DECK</div>
              <div className="v4-muted" style={{ fontSize: 11.5 }}>
                Trạm Cứu Hộ QR & Điều Khiển Từ Xa 24/7
              </div>
            </div>
          </div>
          <button
            type="button"
            className="v4-btn sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀️ Sáng" : "🌙 Tối"}
          </button>
        </div>

        <h2 style={{ margin: "8px 0 4px", fontSize: 21 }}>Đăng Nhập Quản Trị Viên</h2>
        <p className="v4-muted" style={{ marginTop: 0, marginBottom: 18 }}>
          Nhập tài khoản quản trị Web để khôi phục QR Bot Admin và điều khiển toàn bộ hệ thống từ xa.
        </p>

        {(errMsg || (session.error && session.error !== "AUTH_REQUIRED")) && (
          <div
            className="v4-card highlight-danger"
            style={{ padding: "10px 12px", marginBottom: 14, color: "#fca5a5", fontWeight: 600 }}
          >
            {errMsg || session.error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="v4-field">
            <label>Tên đăng nhập Web Admin</label>
            <input
              className="v4-input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              disabled={booting || pending}
            />
          </div>
          <div className="v4-field">
            <label>Mật khẩu Web Admin</label>
            <input
              type="password"
              className="v4-input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Nhập mật khẩu trong .env.local..."
              disabled={booting || pending}
            />
          </div>
          <button
            type="submit"
            className="v4-btn primary"
            style={{ width: "100%", padding: "11px 16px", marginTop: 6 }}
            disabled={booting || pending}
          >
            {booting
              ? "Đang kiểm tra phiên đăng nhập..."
              : pending
                ? "Đang xác thực..."
                : "🔓 Đăng Nhập Trung Tâm Điều Khiển"}
          </button>
        </form>
      </div>
    </div>
  );
}

function ShortcutsGuideModal({ onClose }) {
  return (
    <div className="v4-modal-backdrop" onClick={onClose}>
      <div className="v4-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="v4-card-header">
          <div>
            <h3>Bảng Phím Tắt Điều Hướng Nhanh</h3>
            <div className="v4-muted">Thao tác nhanh trên bàn phím không cần dùng chuột</div>
          </div>
          <button type="button" className="v4-btn sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="v4-shortcuts-table">
          <div className="v4-shortcut-row">
            <span><kbd className="v4-kbd">1</kbd> - <kbd className="v4-kbd">8</kbd></span>
            <span>Chuyển nhanh giữa 8 trang điều khiển</span>
          </div>
          <div className="v4-shortcut-row">
            <span><kbd className="v4-kbd">r</kbd> hoặc <kbd className="v4-kbd">R</kbd></span>
            <span>Đồng bộ & làm mới dữ liệu toàn hệ thống</span>
          </div>
          <div className="v4-shortcut-row">
            <span><kbd className="v4-kbd">/</kbd></span>
            <span>Focus vào ô tìm kiếm Bot ngay lập tức</span>
          </div>
          <div className="v4-shortcut-row">
            <span><kbd className="v4-kbd">?</kbd></span>
            <span>Bật / Tắt bảng phím tắt này</span>
          </div>
          <div className="v4-shortcut-row">
            <span><kbd className="v4-kbd">Esc</kbd></span>
            <span>Đóng cửa sổ modal đang mở</span>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="v4-btn primary" onClick={onClose}>
            Đã Hiểu
          </button>
        </div>
      </div>
    </div>
  );
}

function ControlCenterShell() {
  const {
    session,
    booting,
    theme,
    setTheme,
    page,
    setPage,
    bots,
    adminNeedsRecovery,
    socketConnected,
    isStale,
    operations,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    showShortcutsGuide,
    setShowShortcutsGuide,
    refreshAll,
    logout,
    toasts,
  } = useControlCenter();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (booting || !session.authenticated) {
    return <LoginGate />;
  }

  const meta = PAGE_TITLES[page] || PAGE_TITLES.overview;
  const onlineCount = bots.filter((b) => !b.cookieDead && (b.wsConnected || b.status === "running" || b.status === "online")).length;
  const activeOpsCount = operations.filter((o) => o.status === "in_progress" || o.status === "pending").length;

  return (
    <div className="v4-layout">
      {/* Sidebar */}
      <aside className={`v4-sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="v4-brand-badge" style={{ padding: "4px 6px", marginBottom: 0 }}>
            <span className="v4-brand-logo">M4</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: 15 }}>MYBOT CONTROL</div>
              <div className="v4-muted" style={{ fontSize: 11 }}>
                Always-On Web Admin V4
              </div>
            </div>
          </div>
          {mobileMenuOpen && (
            <button
              type="button"
              className="v4-btn sm"
              onClick={() => setMobileMenuOpen(false)}
            >
              ✕
            </button>
          )}
        </div>

        <button
          type="button"
          className={`v4-nav-btn ${adminNeedsRecovery ? "alert" : ""}`}
          onClick={() => {
            setShowAdminRecovery(true);
            setMobileMenuOpen(false);
          }}
        >
          <span className="v4-nav-left">
            <span>⚡</span>
            <span>{adminNeedsRecovery ? "CỨU HỘ QR ADMIN!" : "Quét QR Bot Admin"}</span>
          </span>
          <span className={`v4-dot ${adminNeedsRecovery ? "dead" : "online"}`} />
        </button>

        <div>
          <div className="v4-nav-group-label">Bảng Điều Khiển Chính</div>
          <div className="v4-nav-list">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`v4-nav-btn ${page === item.id ? "active" : ""}`}
                onClick={() => {
                  setPage(item.id);
                  setMobileMenuOpen(false);
                }}
              >
                <span className="v4-nav-left">
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {item.id === "overview" && (
                    <span className="v4-badge neutral">
                      {onlineCount}/{bots.length}
                    </span>
                  )}
                  {item.id === "operations" && activeOpsCount > 0 && (
                    <span className="v4-badge warning">
                      {activeOpsCount}
                    </span>
                  )}
                  <kbd className="v4-kbd sm">{item.keyNum}</kbd>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div className="v4-muted" style={{ marginBottom: 8, padding: "0 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span className={`v4-dot ${socketConnected ? "online" : ""}`} style={{ marginRight: 6 }} />
              Admin: <strong>{session.username || "admin"}</strong>
            </div>
            <button
              type="button"
              className="v4-icon-btn"
              onClick={() => setShowShortcutsGuide(true)}
              title="Xem bảng phím tắt (?)"
            >
              ⌨
            </button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="v4-btn sm"
              style={{ flex: 1 }}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "☀️ Sáng" : "🌙 Tối"}
            </button>
            <button type="button" className="v4-btn sm" onClick={logout}>
              Đăng xuất
            </button>
          </div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="v4-main-col">
        {/* Persistent Liferaft Emergency Banner */}
        {adminNeedsRecovery && (
          <div className="v4-emergency-banner" role="alert">
            <div>
              <strong>🚨 CẢNH BÁO KHẨN CẤP: Bot Admin chính đang mất kết nối hoặc hết hạn Cookie!</strong>
              <div style={{ fontSize: 12.5, opacity: 0.95 }}>
                Web Dashboard vẫn hoạt động độc lập 100%. Bạn chỉ cần bấm nút bên phải và dùng điện thoại quét mã QR Zalo để khôi phục ngay mà không cần đụng vào Terminal.
              </div>
            </div>
            <button
              type="button"
              className="v4-btn ghost"
              onClick={() => setShowAdminRecovery(true)}
            >
              ⚡ Mở Quét Mã QR Khôi Phục Admin Ngay
            </button>
          </div>
        )}

        <header className="v4-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              className="v4-mobile-hamburger"
              onClick={() => setMobileMenuOpen(true)}
              title="Mở menu"
            >
              ☰
            </button>
            <div className="v4-topbar-title">
              <h1>{meta.title}</h1>
              <p>{meta.subtitle}</p>
            </div>
          </div>

          <div className="v4-topbar-actions">
            {/* Stale Indicator Pill */}
            <div
              className={`v4-stale-pill ${isStale ? "stale" : "live"}`}
              title={isStale ? "Mất kết nối WebSocket. Dữ liệu đang cập nhật qua HTTP polling." : "Kết nối WebSocket ổn định thời gian thực"}
            >
              <span className={`v4-dot ${isStale ? "dead" : "online"}`} />
              <span>{isStale ? "Đang kết nối lại..." : "Realtime Socket"}</span>
            </div>

            <button
              type="button"
              className="v4-btn sm"
              onClick={() => setShowShortcutsGuide(true)}
              title="Phím tắt (?)"
            >
              ⌨ Phím Tắt
            </button>

            <button
              type="button"
              className="v4-btn success"
              onClick={() => setCreateQrTargetBot({ mode: "create" })}
            >
              ➕ Tạo Bot Bằng QR
            </button>

            <button
              type="button"
              className="v4-btn"
              onClick={refreshAll}
              title="Đồng bộ lại dữ liệu (Phím r)"
            >
              ↻ Đồng bộ <kbd className="v4-kbd xs">r</kbd>
            </button>
          </div>
        </header>

        <main className="v4-content">
          {page === "overview" && <OverviewDeck />}
          {page === "operations" && <OperationsTracker />}
          {page === "performance" && <PerformancePage />}
          {page === "remote" && <RemoteControlPage />}
          {page === "groups" && <GroupsShieldPage />}
          {page === "studio" && <StudioAndSchedulePage />}
          {page === "logs" && <LiveLogsPage />}
          {page === "security" && <SystemSecurityPage />}
        </main>
      </div>

      {/* Interactive Modals */}
      <AdminRecoveryWizard />
      <CreateBotQrModal />
      <BotDetailModal />
      {showShortcutsGuide && (
        <ShortcutsGuideModal onClose={() => setShowShortcutsGuide(false)} />
      )}

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="v4-toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`v4-toast ${t.tone}`}>
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ControlCenterApp() {
  return (
    <ControlCenterProvider>
      <ControlCenterShell />
    </ControlCenterProvider>
  );
}
