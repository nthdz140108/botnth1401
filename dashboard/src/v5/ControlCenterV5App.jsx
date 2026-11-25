import React, { useEffect, useState } from "react";
import "./v5-styles.css";
import { ControlCenterProvider } from "../v4/store.jsx";
import { V5Provider, useV5 } from "./v5-store.jsx";
import CommandPalette from "./shell/CommandPalette.jsx";
import NotificationDrawer from "./shell/NotificationDrawer.jsx";
import FleetDeckV5 from "./pages/FleetDeckV5.jsx";
import SaasCrmPage from "./pages/SaasCrmPage.jsx";
import CampaignOmnichannelPage from "./pages/CampaignOmnichannelPage.jsx";
import GroupsShieldProPage from "./pages/GroupsShieldProPage.jsx";
import CommandStudioV25Page from "./pages/CommandStudioV25Page.jsx";
import OperationsCenterV5 from "./pages/OperationsCenterV5.jsx";
import TelemetrySrePage from "./pages/TelemetrySrePage.jsx";
import UnifiedLogsAuditPage from "./pages/UnifiedLogsAuditPage.jsx";
import GovernanceVaultPage from "./pages/GovernanceVaultPage.jsx";
import TenantOwnerPortal from "./portal/TenantOwnerPortal.jsx";
import AdminRecoveryWizard from "../v4/modals/AdminRecoveryWizard.jsx";
import CreateBotQrModal from "../v4/modals/CreateBotQrModal.jsx";
import BotDetailModal from "../v4/modals/BotDetailModal.jsx";

const V5_NAV_ITEMS = [
  { id: "overview", label: "Đội Hình Bot & HA (Fleet)", icon: "📡", keyNum: "1" },
  { id: "crm", label: "Khách Thuê & Giftcode (SaaS)", icon: "💎", keyNum: "2" },
  { id: "campaigns", label: "Chiến Dịch & Điều Khiển", icon: "📢", keyNum: "3" },
  { id: "groups", label: "Nhóm & 17 Khiên Pro", icon: "🛡️", keyNum: "4" },
  { id: "studio", label: "Studio 218 Lệnh & Lịch 24h", icon: "⚙️", keyNum: "5" },
  { id: "operations", label: "Tiến Trình Thao Tác (Ops)", icon: "📋", keyNum: "6" },
  { id: "telemetry", label: "Biểu Đồ SRE & Tự Chữa Lành", icon: "📈", keyNum: "7" },
  { id: "logs", label: "Live Logs & Kiểm Toán", icon: "📜", keyNum: "8" },
  { id: "governance", label: "Phân Quyền, AI Pool & Sao Lưu", icon: "🔐", keyNum: "9" },
];

const V5_PAGE_TITLES = {
  overview: {
    title: "Đội Hình Bot & Dự Phòng Tự Động (Fleet & HA Deck)",
    subtitle: "Giám sát toàn cảnh đội hình Zalo Bot, điểm sức khỏe, cảnh báo hết hạn và thao tác hàng loạt 1-Click.",
  },
  crm: {
    title: "Quản Trị Khách Thuê & Phát Hành Giftcode (SaaS CRM)",
    subtitle: "Theo dõi doanh thu thuê Bot, quản lý khách hàng, sinh mã Voucher hàng loạt và gia hạn tự động.",
  },
  campaigns: {
    title: "Trung Tâm Chiến Dịch Đa Kênh & Điều Khiển Từ Xa",
    subtitle: "Broadcast Spintax chống khóa acc, Kho Media nội bộ, tính cách AI và bảng thực thi 218 lệnh trực tiếp.",
  },
  groups: {
    title: "Quản Lý Nhóm Zalo & Ma Trận 17+ Khiên Bảo Vệ Pro",
    subtitle: "Áp dụng Preset an ninh 1-Click, luật kiểm duyệt chuyên sâu, kho lưu vết thu hồi Anti-Undo và Blacklist toàn cục.",
  },
  studio: {
    title: "Command Studio V2.5 & Lịch Tự Động 24 Giờ",
    subtitle: "Cấu hình Schema 218 lệnh đa tầng (Global/Bot/Group), bắn thử SendTask 24h và hộp cát giả lập lệnh.",
  },
  operations: {
    title: "Trung Tâm Theo Dõi Tiến Trình & Tác Vụ (Operations Center)",
    subtitle: "Theo dõi thời gian thực từng pha khởi chạy, dừng, chờ nóng và gợi ý xử lý sự cố thông minh.",
  },
  telemetry: {
    title: "Biểu Đồ Hiệu Năng SRE & Động Cơ Tự Chữa Lành",
    subtitle: "Phân tích độ trễ p50/p95/p99, RAM/Event-Loop theo thời gian thực và quy tắc tự phục hồi sự cố.",
  },
  logs: {
    title: "Nhật Ký Hệ Thống Trực Tiếp & Kiểm Toán Quản Trị",
    subtitle: "Luồng Live Logs tốc độ cao có ghim dòng, lọc Regex và truy vết chi tiết lịch sử kiểm toán (CSV/JSON).",
  },
  governance: {
    title: "Phân Quyền IAM, Kho Khóa AI Xoay Vòng & Két Sắt Sao Lưu",
    subtitle: "Quản trị tài khoản RBAC, bảo mật 2FA TOTP, xoay vòng API Key chống Rate-Limit và Snapshot AES-256.",
  },
};

function DualModeLoginScreen() {
  const {
    login,
    portalLogin,
    v5Fetch,
    booting,
    session,
    theme,
    setTheme,
    notify,
  } = useV5();

  const [loginTab, setLoginTab] = useState("admin"); // 'admin' | 'portal'
  const [portalSubMode, setPortalSubMode] = useState("credentials"); // 'credentials' | 'access_code'

  // Tab 1: Primary Super Admin (.env.local)
  const [adminUser, setAdminUser] = useState("admin");
  const [adminPass, setAdminPass] = useState("");

  // Tab 2: Operator / Reseller / Bot Owner
  const [iamUsername, setIamUsername] = useState("");
  const [iamPassword, setIamPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [quickVoucher, setQuickVoucher] = useState("");
  const [voucherStatus, setVoucherStatus] = useState(null);

  const [pending, setPending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const handleAdminSubmit = async (e) => {
    e.preventDefault();
    setPending(true);
    setErrMsg("");
    try {
      await login({ username: adminUser.trim(), password: adminPass });
    } catch (err) {
      if (err.code === "INVALID_CREDENTIALS") {
        setErrMsg("Sai tên đăng nhập hoặc mật khẩu Quản trị viên (.env.local).");
      } else if (err.code === "LOGIN_RATE_LIMITED" || err.status === 429) {
        setErrMsg("Thử sai quá nhiều lần. Vui lòng đợi ít phút trước khi đăng nhập lại.");
      } else {
        setErrMsg(err.message || "Không thể đăng nhập vào Trung tâm Điều khiển V5.");
      }
    } finally {
      setPending(false);
    }
  };

  const handlePortalSubmit = async (e) => {
    e.preventDefault();
    if (typeof portalLogin !== "function") {
      setErrMsg("Mô-đun đăng nhập Cổng Đại Lý / Chủ Bot chưa sẵn sàng.");
      return;
    }
    setPending(true);
    setErrMsg("");
    try {
      if (portalSubMode === "access_code") {
        if (!accessCode.trim()) {
          setErrMsg("Vui lòng nhập Mã Truy Cập Nhanh (OWN-XXXX).");
          setPending(false);
          return;
        }
        await portalLogin({
          ownerAccessCode: accessCode.trim(),
          accessCode: accessCode.trim(),
        });
      } else {
        if (!iamUsername.trim() || !iamPassword) {
          setErrMsg("Vui lòng nhập đầy đủ tài khoản và mật khẩu.");
          setPending(false);
          return;
        }
        const res = await portalLogin({
          username: iamUsername.trim(),
          password: iamPassword,
          totpCode: totpCode.trim() || undefined,
        });
        if (res?.requires2fa) {
          setErrMsg("Tài khoản này bật bảo mật 2FA — Vui lòng nhập mã 6 chữ số TOTP rồi bấm đăng nhập lại.");
        }
      }
    } catch (err) {
      setErrMsg(err.message || "Xác thực tài khoản Đại lý / Chủ thuê Bot thất bại.");
    } finally {
      setPending(false);
    }
  };

  const handleInstantVoucherCheck = async () => {
    const code = quickVoucher.trim().toUpperCase();
    if (!code) return;
    setVoucherStatus({ loading: true });
    try {
      let res = null;
      if (typeof v5Fetch === "function") {
        res = await v5Fetch(`/crm/vouchers/check?code=${encodeURIComponent(code)}`).catch(() => null);
      }
      if (!res) {
        const r = await fetch(`/v5-auth/check-voucher?code=${encodeURIComponent(code)}`, {
          credentials: "include",
        });
        res = await r.json().catch(() => null);
      }
      const info = res?.data || res;
      if (info && info.valid !== false && !info.error) {
        setVoucherStatus({
          ok: true,
          text: `Mã hợp lệ (${info.days || info.durationDays || 30} ngày) — Đăng nhập bên trên để nạp vào Bot!`,
        });
      } else {
        setVoucherStatus({
          ok: false,
          text: info?.message || "Không tìm thấy mã Giftcode hoặc mã đã được sử dụng.",
        });
      }
    } catch (err) {
      setVoucherStatus({ ok: false, text: err.message || "Không thể kiểm tra mã Giftcode." });
      notify?.("Kiểm tra Giftcode không thành công", "warning");
    }
  };

  return (
    <div className="v4-login-wrap">
      <div className="v4-login-card" style={{ maxWidth: 490 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div className="v4-brand-badge" style={{ marginBottom: 0 }}>
            <span className="v4-brand-logo">M5</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>MYBOT ENTERPRISE V5</div>
              <div className="v4-muted" style={{ fontSize: 11.5 }}>
                Nền Tảng Điều Hành Đa Bot, SaaS CRM & AI Omnichannel
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

        {/* Dual-Mode Tabs */}
        <div className="v4-tabs" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={`v4-tab ${loginTab === "admin" ? "active" : ""}`}
            style={{ flex: 1, textAlign: "center" }}
            onClick={() => {
              setLoginTab("admin");
              setErrMsg("");
            }}
          >
            🔐 Quản Trị Viên (Super Admin)
          </button>
          <button
            type="button"
            className={`v4-tab ${loginTab === "portal" ? "active" : ""}`}
            style={{ flex: 1, textAlign: "center" }}
            onClick={() => {
              setLoginTab("portal");
              setErrMsg("");
            }}
          >
            🎫 Cộng Tác Viên / Đại Lý / Chủ Bot
          </button>
        </div>

        {(errMsg || (loginTab === "admin" && session?.error && session.error !== "AUTH_REQUIRED")) && (
          <div
            className="v4-card highlight-danger"
            style={{ padding: "10px 12px", marginBottom: 14, color: "#fca5a5", fontWeight: 600 }}
          >
            {errMsg || session.error}
          </div>
        )}

        {loginTab === "admin" ? (
          <form onSubmit={handleAdminSubmit}>
            <p className="v4-muted" style={{ marginTop: 0, marginBottom: 14 }}>
              Đăng nhập bằng tài khoản Quản trị viên gốc trong <code>.env.local</code> để quản lý toàn bộ hệ thống & khôi phục QR Admin.
            </p>
            <div className="v4-field">
              <label>Tên đăng nhập Super Admin</label>
              <input
                className="v4-input"
                autoComplete="username"
                value={adminUser}
                onChange={(e) => setAdminUser(e.target.value)}
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
                value={adminPass}
                onChange={(e) => setAdminPass(e.target.value)}
                placeholder="Nhập mật khẩu quản trị..."
                disabled={booting || pending}
              />
            </div>
            <button
              type="submit"
              className="v4-btn primary"
              style={{ width: "100%", padding: "11px 16px", marginTop: 4 }}
              disabled={booting || pending}
            >
              {booting
                ? "Đang kiểm tra phiên..."
                : pending
                  ? "Đang xác thực..."
                  : "🔓 Đăng Nhập Trung Tâm Điều Khiển V5"}
            </button>
          </form>
        ) : (
          <div>
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              <button
                type="button"
                className={`v4-chip ${portalSubMode === "credentials" ? "active" : ""}`}
                style={{ flex: 1 }}
                onClick={() => setPortalSubMode("credentials")}
              >
                👤 Tài khoản CTV / Đại lý (+2FA)
              </button>
              <button
                type="button"
                className={`v4-chip ${portalSubMode === "access_code" ? "active" : ""}`}
                style={{ flex: 1 }}
                onClick={() => setPortalSubMode("access_code")}
              >
                🔑 Mã Truy Cập Nhanh (OWN-XXXX)
              </button>
            </div>

            <form onSubmit={handlePortalSubmit}>
              {portalSubMode === "access_code" ? (
                <div className="v4-field">
                  <label>Mã Truy Cập Nhanh Dành Cho Chủ Thuê Bot</label>
                  <input
                    className="v4-input v4-mono"
                    style={{ fontSize: 15, fontWeight: 700 }}
                    placeholder="OWN-XXXX-XXXX"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    disabled={pending}
                  />
                </div>
              ) : (
                <>
                  <div className="v4-field">
                    <label>Tên đăng nhập IAM (Operator / Đại Lý / Chủ Bot)</label>
                    <input
                      className="v4-input"
                      value={iamUsername}
                      onChange={(e) => setIamUsername(e.target.value)}
                      placeholder="Nhập username được cấp..."
                      disabled={pending}
                    />
                  </div>
                  <div className="v4-grid-2">
                    <div className="v4-field">
                      <label>Mật khẩu</label>
                      <input
                        type="password"
                        className="v4-input"
                        value={iamPassword}
                        onChange={(e) => setIamPassword(e.target.value)}
                        placeholder="••••••••"
                        disabled={pending}
                      />
                    </div>
                    <div className="v4-field">
                      <label>Mã 2FA TOTP (Nếu bật)</label>
                      <input
                        className="v4-input v4-mono"
                        maxLength={8}
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value)}
                        placeholder="6 chữ số"
                        disabled={pending}
                      />
                    </div>
                  </div>
                </>
              )}

              <button
                type="submit"
                className="v4-btn success"
                style={{ width: "100%", padding: "11px 16px" }}
                disabled={pending}
              >
                {pending ? "Đang đăng nhập..." : "🎫 Vào Không Gian Làm Việc Của Tôi"}
              </button>
            </form>

            {/* Instant Giftcode Checker */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                marginTop: 16,
                paddingTop: 12,
              }}
            >
              <div className="v4-muted" style={{ fontSize: 12, marginBottom: 6, fontWeight: 600 }}>
                🎁 Tra cứu nhanh thời hạn Mã Giftcode:
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="v4-input v4-mono"
                  placeholder="Nhập mã VIP30D-XXXX..."
                  value={quickVoucher}
                  onChange={(e) => setQuickVoucher(e.target.value.toUpperCase())}
                />
                <button type="button" className="v4-btn sm" onClick={handleInstantVoucherCheck}>
                  Kiểm tra
                </button>
              </div>
              {voucherStatus && !voucherStatus.loading && (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: voucherStatus.ok ? "var(--success)" : "var(--warning)",
                    fontWeight: 600,
                  }}
                >
                  {voucherStatus.text}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function V5ShortcutsModal({ onClose }) {
  return (
    <div className="v4-modal-backdrop" onClick={onClose}>
      <div className="v4-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="v4-card-header">
          <div>
            <h3>⌨ Bảng Phím Tắt Điều Khiển Nhanh V5</h3>
            <div className="v4-muted">Tăng tốc thao tác quản trị không cần rời bàn phím</div>
          </div>
          <button type="button" className="v4-btn sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="v4-shortcuts-table">
          <div className="v4-shortcut-row">
            <span>
              <kbd className="v4-kbd">Ctrl</kbd> + <kbd className="v4-kbd">K</kbd>
            </span>
            <span>Mở thanh Tìm kiếm & Ra lệnh nhanh (Command Palette)</span>
          </div>
          <div className="v4-shortcut-row">
            <span>
              <kbd className="v4-kbd">1</kbd> – <kbd className="v4-kbd">9</kbd>
            </span>
            <span>Chuyển tức thì giữa 9 Không gian làm việc V5</span>
          </div>
          <div className="v4-shortcut-row">
            <span>
              <kbd className="v4-kbd">r</kbd> hoặc <kbd className="v4-kbd">R</kbd>
            </span>
            <span>Đồng bộ & làm mới dữ liệu toàn hệ thống</span>
          </div>
          <div className="v4-shortcut-row">
            <span>
              <kbd className="v4-kbd">/</kbd>
            </span>
            <span>Đặt con trỏ vào ô tìm kiếm Bot nhanh</span>
          </div>
          <div className="v4-shortcut-row">
            <span>
              <kbd className="v4-kbd">?</kbd>
            </span>
            <span>Bật / Tắt bảng hướng dẫn phím tắt này</span>
          </div>
          <div className="v4-shortcut-row">
            <span>
              <kbd className="v4-kbd">Esc</kbd>
            </span>
            <span>Đóng cửa sổ Modal / Ngăn kéo đang mở</span>
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

function V5Shell() {
  const {
    session,
    portalSession,
    booting,
    theme,
    setTheme,
    page,
    setPage,
    bots = [],
    enrichedFleet = [],
    adminNeedsRecovery,
    socketConnected,
    isStale,
    operations = [],
    setShowAdminRecovery,
    setCreateQrTargetBot,
    showShortcutsGuide,
    setShowShortcutsGuide,
    commandPaletteOpen,
    setCommandPaletteOpen,
    notifDrawerOpen,
    setNotifDrawerOpen,
    unreadNotifCount = 0,
    refreshAll,
    refreshV5,
    logout,
    portalLogout,
    toasts = [],
  } = useV5();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("mybot_v5_sidebar_collapsed") === "1"
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [resellerForceConsole, setResellerForceConsole] = useState(false);

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("mybot_v5_sidebar_collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const isAdminAuthenticated = Boolean(session?.authenticated);
  const isPortalAuthenticated = Boolean(portalSession?.authenticated);
  const portalRole = portalSession?.user?.role || portalSession?.role || "";

  // Capture-phase keyboard handler for V5 1-9 navigation (overrides V4's 1-8 map cleanly) & Ctrl+K fallback
  useEffect(() => {
    if (!isAdminAuthenticated && !isPortalAuthenticated) return undefined;

    const onCaptureKeyDown = (e) => {
      const tag = e.target?.tagName?.toLowerCase();
      const isInput =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        Boolean(e.target?.isContentEditable);

      if (
        !isInput &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !commandPaletteOpen &&
        !notifDrawerOpen &&
        e.key >= "1" &&
        e.key <= "9"
      ) {
        const target = V5_NAV_ITEMS[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setPage(target.id);
        }
      }
    };

    const onBubbleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        if (!e.defaultPrevented) {
          e.preventDefault();
          setCommandPaletteOpen?.((prev) => !prev);
        }
      } else if (e.key === "Escape") {
        if (commandPaletteOpen) setCommandPaletteOpen?.(false);
        else if (notifDrawerOpen) setNotifDrawerOpen?.(false);
      }
    };

    window.addEventListener("keydown", onCaptureKeyDown, true);
    window.addEventListener("keydown", onBubbleKeyDown);
    return () => {
      window.removeEventListener("keydown", onCaptureKeyDown, true);
      window.removeEventListener("keydown", onBubbleKeyDown);
    };
  }, [
    isAdminAuthenticated,
    isPortalAuthenticated,
    commandPaletteOpen,
    notifDrawerOpen,
    setPage,
    setCommandPaletteOpen,
    setNotifDrawerOpen,
  ]);

  // Login Gate
  if (booting && !isAdminAuthenticated && !isPortalAuthenticated) {
    return <DualModeLoginScreen />;
  }
  if (!isAdminAuthenticated && !isPortalAuthenticated) {
    return <DualModeLoginScreen />;
  }

  // Self-Service Portal routing for bot_owner (and reseller when Primary Admin is not logged in)
  if (
    !isAdminAuthenticated &&
    isPortalAuthenticated &&
    (portalRole === "bot_owner" || (portalRole === "reseller" && !resellerForceConsole))
  ) {
    return (
      <>
        <TenantOwnerPortal
          onEnterWorkspace={
            portalRole === "reseller" ? () => setResellerForceConsole(true) : undefined
          }
        />
        {toasts.length > 0 && (
          <div className="v4-toast-stack">
            {toasts.map((t) => (
              <div key={t.id} className={`v4-toast ${t.tone}`}>
                {t.message}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  const fleetList = enrichedFleet?.length ? enrichedFleet : bots;
  const onlineCount = fleetList.filter(
    (b) => !b.cookieDead && (b.wsConnected || b.status === "running" || b.status === "online")
  ).length;
  const activeOpsCount = operations.filter(
    (o) => o.status === "in_progress" || o.status === "pending"
  ).length;

  const activePageKey = V5_PAGE_TITLES[page] ? page : "overview";
  const meta = V5_PAGE_TITLES[activePageKey];

  const handleGlobalSync = () => {
    refreshAll?.();
    refreshV5?.();
  };

  const handleSignOut = async () => {
    if (isPortalAuthenticated && typeof portalLogout === "function") {
      await portalLogout();
    }
    if (isAdminAuthenticated && typeof logout === "function") {
      await logout();
    }
  };

  const activeActorName = isAdminAuthenticated
    ? session?.username || "admin"
    : portalSession?.user?.displayName || portalSession?.user?.username || "operator";

  return (
    <div
      className={`v4-layout v5-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={
        sidebarCollapsed
          ? { gridTemplateColumns: "78px minmax(0, 1fr)" }
          : undefined
      }
    >
      {/* Collapsible Enterprise Sidebar */}
      <aside
        className={`v4-sidebar v5-sidebar ${mobileMenuOpen ? "mobile-open" : ""}`}
        style={sidebarCollapsed ? { padding: "18px 10px", alignItems: "center" } : undefined}
      >
        <div
          style={{
            display: "flex",
            justifyContent: sidebarCollapsed ? "center" : "space-between",
            alignItems: "center",
            width: "100%",
          }}
        >
          <div className="v4-brand-badge" style={{ padding: "2px 4px", marginBottom: 0 }}>
            <span className="v4-brand-logo" title="MYBOT CONTROL CENTER V5">
              M5
            </span>
            {!sidebarCollapsed && (
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>MYBOT V5 PRO</div>
                <div className="v4-muted" style={{ fontSize: 11 }}>
                  Enterprise Control Deck
                </div>
              </div>
            )}
          </div>

          {!sidebarCollapsed && !mobileMenuOpen && (
            <button
              type="button"
              className="v4-btn sm"
              onClick={toggleSidebarCollapsed}
              title="Thu gọn thanh bên"
              style={{ padding: "4px 8px" }}
            >
              «
            </button>
          )}

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

        {sidebarCollapsed && (
          <button
            type="button"
            className="v4-btn sm"
            onClick={toggleSidebarCollapsed}
            title="Mở rộng thanh bên"
            style={{ width: "100%" }}
          >
            »
          </button>
        )}

        {/* Liferaft Emergency QR Admin Button */}
        <button
          type="button"
          className={`v4-nav-btn ${adminNeedsRecovery ? "alert" : ""}`}
          style={sidebarCollapsed ? { justifyContent: "center", padding: "10px 6px" } : undefined}
          title={adminNeedsRecovery ? "CỨU HỘ QR ADMIN KHẨN CẤP" : "Quét QR Bot Admin"}
          onClick={() => {
            setShowAdminRecovery(true);
            setMobileMenuOpen(false);
          }}
        >
          <span className="v4-nav-left">
            <span>⚡</span>
            {!sidebarCollapsed && (
              <span>{adminNeedsRecovery ? "CỨU HỘ QR ADMIN!" : "Quét QR Bot Admin"}</span>
            )}
          </span>
          {!sidebarCollapsed && (
            <span className={`v4-dot ${adminNeedsRecovery ? "dead" : "online"}`} />
          )}
        </button>

        {/* 9 Navigation Workspaces */}
        <div style={{ width: "100%" }}>
          {!sidebarCollapsed && (
            <div className="v4-nav-group-label">9 Không Gian Quản Trị</div>
          )}
          <div className="v4-nav-list">
            {V5_NAV_ITEMS.map((item) => {
              const isActive = activePageKey === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`v4-nav-btn ${isActive ? "active" : ""}`}
                  style={
                    sidebarCollapsed
                      ? { justifyContent: "center", padding: "10px 6px" }
                      : undefined
                  }
                  title={`${item.label} (Phím ${item.keyNum})`}
                  onClick={() => {
                    setPage(item.id);
                    setMobileMenuOpen(false);
                  }}
                >
                  <span className="v4-nav-left">
                    <span style={{ fontSize: 16 }}>{item.icon}</span>
                    {!sidebarCollapsed && <span>{item.label}</span>}
                  </span>

                  {!sidebarCollapsed && (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {item.id === "overview" && (
                        <span className="v4-badge neutral">
                          {onlineCount}/{fleetList.length}
                        </span>
                      )}
                      {item.id === "operations" && activeOpsCount > 0 && (
                        <span className="v4-badge warning">{activeOpsCount}</span>
                      )}
                      <kbd className="v4-kbd sm">{item.keyNum}</kbd>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sidebar Footer */}
        <div
          style={{
            marginTop: "auto",
            borderTop: "1px solid var(--border)",
            paddingTop: 12,
            width: "100%",
          }}
        >
          {!sidebarCollapsed && (
            <div
              className="v4-muted"
              style={{
                marginBottom: 8,
                padding: "0 6px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span
                  className={`v4-dot ${socketConnected ? "online" : ""}`}
                  style={{ marginRight: 6 }}
                />
                <span>
                  User: <strong>{activeActorName}</strong>
                </span>
              </div>
              <button
                type="button"
                className="v4-btn sm"
                style={{ padding: "2px 7px" }}
                onClick={() => setShowShortcutsGuide(true)}
                title="Bảng phím tắt (?)"
              >
                ⌨
              </button>
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: sidebarCollapsed ? "column" : "row",
              gap: 6,
            }}
          >
            <button
              type="button"
              className="v4-btn sm"
              style={{ flex: 1 }}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title="Đổi giao diện Sáng / Tối"
            >
              {sidebarCollapsed
                ? theme === "dark"
                  ? "☀️"
                  : "🌙"
                : theme === "dark"
                  ? "☀️ Sáng"
                  : "🌙 Tối"}
            </button>
            <button
              type="button"
              className="v4-btn sm"
              onClick={handleSignOut}
              title="Đăng xuất"
            >
              {sidebarCollapsed ? "⏻" : "Đăng xuất"}
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
              <strong>
                🚨 CẢNH BÁO KHẨN CẤP: Bot Admin chính đang mất kết nối hoặc hết hạn Cookie!
              </strong>
              <div style={{ fontSize: 12.5, opacity: 0.95 }}>
                Trung tâm Điều khiển V5 vẫn hoạt động độc lập 100%. Hãy bấm nút bên phải để quét mã QR Zalo khôi phục ngay lập tức trên Web.
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

        {/* V5 Topbar */}
        <header className="v4-topbar v5-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              className="v4-mobile-hamburger"
              onClick={() => setMobileMenuOpen(true)}
              title="Mở menu điều hướng"
            >
              ☰
            </button>
            <div className="v4-topbar-title">
              <h1>{meta.title}</h1>
              <p>{meta.subtitle}</p>
            </div>
          </div>

          <div className="v4-topbar-actions">
            {!isAdminAuthenticated && portalRole === "reseller" && (
              <button
                type="button"
                className="v4-btn sm"
                onClick={() => setResellerForceConsole(false)}
              >
                🎫 Cổng Tự Phục Vụ
              </button>
            )}

            {/* Spotlight Command Palette Trigger */}
            <button
              type="button"
              className="v4-btn sm"
              onClick={() => setCommandPaletteOpen?.(true)}
              style={{
                background: "var(--bg-input)",
                borderColor: "var(--border-strong)",
              }}
            >
              🔍 Tìm Nhanh / Ra Lệnh <kbd className="v4-kbd xs">Ctrl+K</kbd>
            </button>

            {/* Realtime Socket Status Pill */}
            <div
              className={`v4-stale-pill ${isStale ? "stale" : "live"}`}
              title={
                isStale
                  ? "Kết nối Socket gián đoạn — đang dùng đồng bộ HTTP"
                  : "Kết nối thời gian thực ổn định"
              }
            >
              <span className={`v4-dot ${isStale ? "dead" : "online"}`} />
              <span>{isStale ? "Đang kết nối lại..." : "Realtime Socket"}</span>
            </div>

            {/* Notification Bell with Unread Badge */}
            <button
              type="button"
              className="v4-btn sm"
              style={{ position: "relative" }}
              onClick={() => setNotifDrawerOpen?.(true)}
              title="Trung tâm thông báo hệ thống"
            >
              🔔
              {unreadNotifCount > 0 && (
                <span
                  className="v4-badge danger"
                  style={{
                    padding: "1px 6px",
                    fontSize: 10,
                    marginLeft: 2,
                  }}
                >
                  {unreadNotifCount > 99 ? "99+" : unreadNotifCount}
                </span>
              )}
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
              onClick={handleGlobalSync}
              title="Đồng bộ toàn hệ thống (Phím r)"
            >
              ↻ Đồng bộ <kbd className="v4-kbd xs">r</kbd>
            </button>
          </div>
        </header>

        {/* Active Workspace Content */}
        <main className="v4-content v5-content">
          {activePageKey === "overview" && <FleetDeckV5 />}
          {activePageKey === "crm" && <SaasCrmPage />}
          {activePageKey === "campaigns" && <CampaignOmnichannelPage />}
          {activePageKey === "groups" && <GroupsShieldProPage />}
          {activePageKey === "studio" && <CommandStudioV25Page />}
          {activePageKey === "operations" && <OperationsCenterV5 />}
          {activePageKey === "telemetry" && <TelemetrySrePage />}
          {activePageKey === "logs" && <UnifiedLogsAuditPage />}
          {activePageKey === "governance" && <GovernanceVaultPage />}
        </main>
      </div>

      {/* Global Overlays, Drawers & Modals */}
      <CommandPalette
        open={commandPaletteOpen}
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen?.(false)}
      />
      <NotificationDrawer
        open={notifDrawerOpen}
        isOpen={notifDrawerOpen}
        onClose={() => setNotifDrawerOpen?.(false)}
      />
      <AdminRecoveryWizard />
      <CreateBotQrModal />
      <BotDetailModal />
      {showShortcutsGuide && (
        <V5ShortcutsModal onClose={() => setShowShortcutsGuide(false)} />
      )}

      {/* Toast Notifications Stack */}
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

export default function ControlCenterV5App() {
  return (
    <ControlCenterProvider>
      <V5Provider>
        <V5Shell />
      </V5Provider>
    </ControlCenterProvider>
  );
}
