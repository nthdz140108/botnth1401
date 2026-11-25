import React, { useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import {
  formatBytesVi,
  formatDurationVi,
  formatExpiryVi,
  formatRelativeTimeVi,
} from "../../v4/http.js";

const PRESET_TAGS = ["VIP", "Dùng thử", "Nội bộ", "Đại lý"];

function getTagClass(tag) {
  const lower = String(tag || "").toLowerCase();
  if (lower === "vip") return "vip";
  if (lower.includes("thử") || lower.includes("trial")) return "trial";
  if (lower.includes("nội bộ") || lower.includes("internal")) return "internal";
  if (lower.includes("đại lý") || lower.includes("reseller")) return "reseller";
  return "neutral";
}

function getHealthColor(score) {
  const s = Number(score) || 0;
  if (s >= 80) return "var(--success)";
  if (s >= 50) return "var(--warning)";
  return "var(--danger)";
}

function HealthScoreBadge({ score = 0 }) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const color = getHealthColor(clamped);

  return (
    <div className="v5-health-widget" title={`Chỉ số sức khỏe tổng hợp: ${clamped}/100`}>
      <div className="v5-health-ring">
        <svg viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            stroke="var(--v5-ring-track)"
            strokeWidth="3.2"
          />
          <circle
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="3.2"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </svg>
        <span className="v5-health-ring-label" style={{ color }}>
          {clamped}
        </span>
      </div>
    </div>
  );
}

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
      <span className="v4-badge accent" title="Chế độ chờ nóng: tiến trình sẵn sàng kích hoạt tức thì">
        <span className="v4-status-dot-pulse accent" /> Chờ Nóng
      </span>
    );
  }
  if (status === "connecting" || status === "starting" || status === "recovering") {
    return (
      <span className="v4-badge warning" title="Đang bắt tay WebSocket">
        <span className="v4-status-dot-pulse warning" /> Đang Kết Nối
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="v4-badge danger" title="Tiến trình gặp lỗi">
        <span className="v4-status-dot-pulse danger" /> Lỗi Tiến Trình
      </span>
    );
  }
  return (
    <span className="v4-badge neutral">
      <span className="v4-dot" /> Đã Dừng
    </span>
  );
}

function maskProxyDisplay(proxyUrl) {
  if (!proxyUrl) return "";
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol.replace(":", "").toUpperCase()} • ${parsed.hostname}:${parsed.port || "80"}`;
  } catch {
    return String(proxyUrl).replace(/\/\/[^@]+@/, "//***@").slice(0, 28);
  }
}

export default function FleetDeckV5() {
  const {
    enrichedFleet,
    adminBot,
    adminNeedsRecovery,
    primaryState,
    crmSummary,
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
    updateBotV5Meta,
    v5Fetch,
    refreshAll,
    refreshV5,
    recordServerOp,
    notify,
  } = useV5();

  const [viewMode, setViewMode] = useState("table"); // 'table' | 'cards' | 'topology'
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [checkedIds, setCheckedIds] = useState([]);

  // Primary Failover Swap Modal state
  const [swapTargetId, setSwapTargetId] = useState("");
  const [swapConfirmOpen, setSwapConfirmOpen] = useState(false);
  const [swapping, setSwapping] = useState(false);

  // Per-Bot Meta & Proxy Popover Modal state
  const [editingBot, setEditingBot] = useState(null);
  const [editTags, setEditTags] = useState([]);
  const [customTagInput, setCustomTagInput] = useState("");
  const [editProxyUrl, setEditProxyUrl] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStandbyCandidate, setEditStandbyCandidate] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState(null);

  const primaryBot = useMemo(() => {
    const primaryId = primaryState?.adminBotId || primaryState?.primaryBotId || adminBot?.id || "admin";
    return enrichedFleet.find((b) => b.id === primaryId) || adminBot || enrichedFleet[0] || null;
  }, [enrichedFleet, primaryState, adminBot]);

  const standbyCandidates = useMemo(
    () => enrichedFleet.filter((b) => b.id !== primaryBot?.id),
    [enrichedFleet, primaryBot]
  );

  const designatedStandbyBot = useMemo(() => {
    if (swapTargetId) {
      const picked = standbyCandidates.find((b) => b.id === swapTargetId);
      if (picked) return picked;
    }
    return (
      standbyCandidates.find((b) => b.autoFailoverCandidate) ||
      standbyCandidates.find((b) => !b.cookieDead && (b.wsConnected || b.status === "hot_standby")) ||
      standbyCandidates[0] ||
      null
    );
  }, [standbyCandidates, swapTargetId]);

  const stats = useMemo(() => {
    let online = 0;
    let hotStandby = 0;
    let connecting = 0;
    let cookieExpired = 0;
    let error = 0;
    let stopped = 0;
    let expiring72h = 0;
    let healthSum = 0;

    for (const b of enrichedFleet) {
      healthSum += Number(b.healthScore || 0);
      if (b.expiringSoon72h) expiring72h += 1;
      if (b.status === "cookie_expired" || b.cookieDead) cookieExpired += 1;
      else if (b.status === "online" || b.status === "running" || b.connected || b.wsConnected) online += 1;
      else if (b.status === "hot_standby" || b.status === "standby") hotStandby += 1;
      else if (b.status === "connecting" || b.status === "starting" || b.status === "recovering") connecting += 1;
      else if (b.status === "error") error += 1;
      else stopped += 1;
    }

    const total = enrichedFleet.length;
    const avgHealth = total > 0 ? Math.round(healthSum / total) : 100;
    const crmExpiring = Number(crmSummary?.expiringWithin72h ?? crmSummary?.expiringCount ?? expiring72h);

    return {
      online,
      hotStandby,
      connecting,
      cookieExpired,
      error,
      stopped,
      total,
      avgHealth,
      expiring72h: Math.max(expiring72h, crmExpiring),
    };
  }, [enrichedFleet, crmSummary]);

  const filteredBots = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enrichedFleet.filter((b) => {
      const isOnline =
        (b.status === "online" || b.status === "running" || b.connected || b.wsConnected) && !b.cookieDead;
      const isStandby = b.status === "hot_standby" || b.status === "standby";

      if (statusFilter === "online" && !isOnline) return false;
      if (statusFilter === "hot_standby" && !isStandby) return false;
      if (statusFilter === "connecting" && b.status !== "connecting" && b.status !== "starting") return false;
      if (statusFilter === "cookie_expired" && b.status !== "cookie_expired" && !b.cookieDead) return false;
      if (statusFilter === "error" && b.status !== "error") return false;
      if (statusFilter === "stopped" && (isOnline || isStandby || b.status === "cookie_expired" || b.cookieDead)) {
        return false;
      }

      if (tagFilter !== "all") {
        const hasTag = (b.tags || []).some((t) => String(t).toLowerCase() === tagFilter.toLowerCase());
        if (!hasTag) return false;
      }

      if (!q) return true;
      return (
        b.displayName?.toLowerCase().includes(q) ||
        b.id?.toLowerCase().includes(q) ||
        b.uid?.toLowerCase().includes(q) ||
        (b.ownerUid || "").toLowerCase().includes(q) ||
        (b.notes || "").toLowerCase().includes(q) ||
        (b.tags || []).some((t) => String(t).toLowerCase().includes(q))
      );
    });
  }, [enrichedFleet, search, statusFilter, tagFilter]);

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
    primaryBot?.uptimeSecs ??
    0;

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

  const openBotMetaEditor = (bot) => {
    setEditingBot(bot);
    setEditTags(Array.isArray(bot.tags) ? [...bot.tags] : []);
    setCustomTagInput("");
    setEditProxyUrl(bot.proxyUrl || "");
    setEditNotes(bot.notes || "");
    setEditStandbyCandidate(Boolean(bot.autoFailoverCandidate));
    setProxyTestResult(null);
  };

  const togglePresetTag = (tag) => {
    setEditTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const addCustomTag = () => {
    const clean = customTagInput.trim();
    if (!clean) return;
    if (!editTags.includes(clean)) {
      setEditTags((prev) => [...prev, clean]);
    }
    setCustomTagInput("");
  };

  const handleSaveBotMeta = async (e) => {
    e.preventDefault();
    if (!editingBot) return;
    setSavingMeta(true);
    try {
      await updateBotV5Meta(editingBot.id, {
        tags: editTags,
        proxyUrl: editProxyUrl.trim(),
        notes: editNotes.trim(),
        autoFailoverCandidate: editStandbyCandidate,
      });
      notify(`Đã cập nhật Tag, Ghi chú & Proxy cho ${editingBot.displayName}!`, "success");
      setEditingBot(null);
    } catch (err) {
      notify(err.message || "Lưu thông tin mở rộng thất bại", "error");
    } finally {
      setSavingMeta(false);
    }
  };

  const handleTestProxy = async () => {
    if (!editingBot) return;
    setTestingProxy(true);
    setProxyTestResult(null);
    try {
      const res = await v5Fetch(`/api/v5/bots/${encodeURIComponent(editingBot.id)}/proxy-test`, {
        method: "POST",
        body: { proxyUrl: editProxyUrl.trim() },
      });
      setProxyTestResult({
        ok: res?.ok !== false,
        latencyMs: res?.latencyMs ?? res?.durationMs ?? 0,
        ip: res?.ip || res?.exitIp || "",
        message: res?.message || "Kết nối Proxy hoạt động tốt!",
      });
      notify("Kiểm tra độ trễ Proxy hoàn tất!", "success");
    } catch (err) {
      setProxyTestResult({
        ok: false,
        latencyMs: null,
        message: err.message || "Không thể kết nối qua Proxy này.",
      });
      notify(err.message || "Kiểm tra Proxy thất bại", "error");
    } finally {
      setTestingProxy(false);
    }
  };

  const handleExecuteAdminSwap = async () => {
    const target = designatedStandbyBot;
    if (!target) return;
    setSwapping(true);
    const started = Date.now();
    try {
      const res = await v5Fetch("/api/system/admin-bot/swap", {
        method: "POST",
        body: {
          targetBotId: target.id,
          confirm: true,
          actor: "dashboard-v5",
        },
      });
      await recordServerOp({
        botId: target.id,
        botName: target.displayName,
        action: "admin_hot_swap",
        status: "completed",
        phase: "ws_ready",
        durationMs: Date.now() - started,
      });
      notify(
        `Đã chuyển quyền Primary Admin sang "${target.displayName}" (${res?.transactionId || "OK"})!`,
        "success"
      );
      setSwapConfirmOpen(false);
      await Promise.all([refreshAll(), refreshV5()]);
    } catch (err) {
      notify(err.message || "Hoán đổi Primary Admin thất bại", "error");
    } finally {
      setSwapping(false);
    }
  };

  const renderQuickActions = (bot) => {
    const isOnline =
      (bot.status === "online" || bot.status === "running" || bot.connected || bot.wsConnected) &&
      !bot.cookieDead &&
      bot.status !== "standby" &&
      bot.status !== "hot_standby";
    const isStandby = bot.status === "hot_standby" || bot.status === "standby";
    const isRunningStart = isActionRunning(bot.id, "start") || isActionRunning(bot.id, "resume");
    const isRunningStop = isActionRunning(bot.id, "standby") || isActionRunning(bot.id, "stop");
    const isRunningStandby = isActionRunning(bot.id, "hot_standby");

    return (
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
        {isOnline ? (
          <button
            type="button"
            className="v4-btn sm"
            title="Tạm tắt bot sang chế độ Chờ Nóng"
            disabled={isRunningStop}
            onClick={() => runBotAction(bot.id, "standby")}
          >
            {isRunningStop ? <span className="v4-spinner-icon" /> : "⏹ Tắt"}
          </button>
        ) : (
          <button
            type="button"
            className="v4-btn sm success"
            title={isStandby ? "Khôi phục tức thì từ Chờ Nóng" : "Bật Bot hoạt động"}
            disabled={isRunningStart}
            onClick={() => runBotAction(bot.id, isStandby ? "resume" : "start")}
          >
            {isRunningStart ? <span className="v4-spinner-icon" /> : isStandby ? "▶ Khôi Phục" : "▶ Bật"}
          </button>
        )}

        <button
          type="button"
          className={`v4-btn sm ${isStandby ? "accent active" : ""}`}
          title="Đưa Bot vào chế độ Chờ Nóng (Hot Standby)"
          disabled={isRunningStandby}
          onClick={() => runBotAction(bot.id, "hot_standby")}
        >
          {isRunningStandby ? <span className="v4-spinner-icon" /> : "⚡ Chờ Nóng"}
        </button>

        <button
          type="button"
          className={`v4-btn sm ${bot.status === "cookie_expired" || bot.cookieDead ? "danger" : ""}`}
          title="Quét lại mã QR đăng nhập Zalo"
          onClick={() => {
            if (bot.isPrimaryAdmin || bot.isMain) setShowAdminRecovery(true);
            else setCreateQrTargetBot({ mode: "relogin", botId: bot.id });
          }}
        >
          {bot.status === "cookie_expired" || bot.cookieDead ? "⚡ Quét QR" : "Quét QR"}
        </button>

        <button
          type="button"
          className="v4-btn sm primary"
          title="Mở Điều Khiển Từ Xa & Chiến Dịch"
          onClick={() => {
            setSelectedBotId(bot.id);
            setPage("campaigns");
          }}
        >
          🎮 Điều Khiển
        </button>

        <button
          type="button"
          className="v4-btn sm"
          title="Mở Chi Tiết Bot"
          onClick={() => setDetailBotId(bot.id)}
        >
          ⚙ Chi Tiết
        </button>
      </div>
    );
  };

  return (
    <div className="v5-stack">
      {/* 1. Liferaft Admin Hero Card */}
      <div className={`v4-card ${adminNeedsRecovery ? "highlight-danger" : "highlight-admin"}`}>
        <div className="v5-row-between">
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              className={`v4-avatar ${adminNeedsRecovery ? "dead" : "online"}`}
              style={{ width: 56, height: 56, fontSize: 22 }}
            >
              {primaryBot?.avatar ? <img src={primaryBot.avatar} alt="" /> : "A"}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>
                  {primaryBot ? primaryBot.displayName : "Bot Admin Chính (Chưa Đăng Nhập)"}
                </h2>
                <span className="v4-badge info">👑 PRIMARY ADMIN</span>
                {primaryBot ? renderStatusBadge(primaryBot) : <span className="v4-badge danger">● Chưa có Cookie</span>}
                {primaryBot && <HealthScoreBadge score={primaryBot.healthScore} />}
              </div>
              <div className="v4-muted" style={{ marginTop: 4 }}>
                {adminNeedsRecovery
                  ? `⚠️ Cookie Bot Admin đang hết hạn${primaryBot?.deadReason ? ` (${primaryBot.deadReason})` : ""}. Bạn có thể quét QR khôi phục ngay hoặc bấm Hoán Đổi Hot-Swap bên dưới sang Bot Dự Phòng!`
                  : `UID: ${primaryBot?.uid} • Prefix: "${primaryBot?.prefix}" • Uptime: ${formatDurationVi(primaryBot?.uptimeSecs || uptimeSecs)} • Trung tâm điều phối HA 24/7`}
              </div>
            </div>
          </div>

          <div className="v5-inline-actions">
            <button
              type="button"
              className={`v4-btn ${adminNeedsRecovery ? "danger" : "primary"}`}
              onClick={() => setShowAdminRecovery(true)}
            >
              ⚡ {adminNeedsRecovery ? "Quét Mã QR Khôi Phục Admin Ngay" : "Đổi / Quét Lại QR Admin"}
            </button>
            {primaryBot && (
              <>
                <button
                  type="button"
                  className="v4-btn"
                  onClick={() => {
                    setSelectedBotId(primaryBot.id);
                    setPage("campaigns");
                  }}
                >
                  🎮 Điều Khiển
                </button>
                <button
                  type="button"
                  className="v4-btn"
                  disabled={isActionRunning(primaryBot.id, "restart")}
                  onClick={() => runBotAction(primaryBot.id, "restart")}
                >
                  {isActionRunning(primaryBot.id, "restart") ? <span className="v4-spinner-icon" /> : "↻ Khởi động lại"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Primary Admin Hot-Swap / Failover Bar */}
        <div className="v5-failover-bar" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="v4-badge info">🛡️ CỤM DỰ PHÒNG NÓNG (HA FAILOVER)</span>
            <span style={{ fontSize: 13 }}>
              Admin hiện tại: <strong>{primaryBot?.displayName || "admin"}</strong>
            </span>
            <span className="v4-muted">⇄</span>
            <span style={{ fontSize: 13 }}>Bot Dự Phòng Chỉ Định:</span>
            {standbyCandidates.length > 0 ? (
              <select
                className="v4-select"
                style={{ width: 220, padding: "5px 10px" }}
                value={designatedStandbyBot?.id || ""}
                onChange={(e) => setSwapTargetId(e.target.value)}
              >
                {standbyCandidates.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.displayName} ({b.healthScore}đ • {b.status})
                  </option>
                ))}
              </select>
            ) : (
              <span className="v4-muted">Chưa có Bot phụ dự phòng (Bấm Tạo Bot Phụ bằng QR)</span>
            )}
          </div>

          <div className="v5-inline-actions">
            <button
              type="button"
              className="v4-btn warning sm"
              disabled={!designatedStandbyBot}
              onClick={() => setSwapConfirmOpen(true)}
            >
              🔄 Hoán Đổi Primary Admin (1-Click Swap)
            </button>
          </div>
        </div>
      </div>

      {/* 2. 4 Executive KPI Cards */}
      <div className="v4-grid-4">
        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Đội Hình Online & Sức Khỏe TB</div>
          <div className="v4-kpi-value v5-tabular" style={{ color: "var(--success)" }}>
            {stats.online}/{stats.total}{" "}
            <span style={{ fontSize: 14, color: getHealthColor(stats.avgHealth) }}>
              • {stats.avgHealth}đ Health
            </span>
          </div>
          <div className="v4-muted v4-stat-sub">
            {stats.hotStandby > 0 && <span style={{ color: "var(--accent)", marginRight: 8 }}>⚡ {stats.hotStandby} Chờ Nóng</span>}
            {stats.cookieExpired > 0 ? (
              <span style={{ color: "var(--danger)" }}>🚨 {stats.cookieExpired} Hết Cookie</span>
            ) : (
              "Toàn bộ phiên Zalo ổn định"
            )}
          </div>
        </div>

        <div
          className="v4-card v4-stat-card"
          style={{ cursor: "pointer" }}
          onClick={() => {
            try {
              sessionStorage.setItem("mybot_v5_crm_tab", "expiring");
              window.dispatchEvent(new CustomEvent("v5:crm-tab", { detail: { tab: "expiring" } }));
            } catch {}
            setPage("crm");
          }}
        >
          <div className="v4-muted">Thuê Bao Sắp Hết Hạn (&lt;72h)</div>
          <div
            className="v4-kpi-value v5-tabular"
            style={{ color: stats.expiring72h > 0 ? "var(--warning)" : "var(--success)" }}
          >
            {stats.expiring72h} <span style={{ fontSize: 14, color: "var(--text-muted)" }}>Bot thuê</span>
          </div>
          <div className="v4-muted v4-stat-sub" style={{ color: "var(--primary)" }}>
            Mở hàng đợi gia hạn & nhắc tự động →
          </div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Trạng Thái Cầu Nối Realtime</div>
          <div className="v4-kpi-value" style={{ color: isStale ? "var(--warning)" : "var(--primary)" }}>
            {socketConnected ? "Socket Bridge" : "HTTP Polling"}
          </div>
          <div className="v4-muted v4-stat-sub">
            {isStale ? "🟡 Đang tự động đồng bộ lại..." : "🟢 Độ trễ 0ms • Zero Layout Shift"}
          </div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Tài Nguyên RAM & Uptime</div>
          <div className="v4-kpi-value v5-tabular">{rssBytes ? formatBytesVi(rssBytes) : "108.0 MB"}</div>
          <div className="v4-muted v4-stat-sub">Uptime liên tục: {formatDurationVi(uptimeSecs)}</div>
        </div>
      </div>

      {/* 3. Main Fleet Orchestrator Card */}
      <div className="v4-card">
        <div className="v4-card-header">
          <div>
            <h2 style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>Điều Phối Đội Hình Bot V5 ({filteredBots.length})</span>
              <span className="v4-badge neutral">
                Nhấn <kbd className="v4-kbd">/</kbd> tìm nhanh • <kbd className="v4-kbd">Ctrl+K</kbd> Spotlight
              </span>
            </h2>
            <div className="v4-muted">
              Quản trị tập trung Health Score, phân loại Tag khách hàng, Proxy riêng từng Bot và sơ đồ cụm HA.
            </div>
          </div>

          <div className="v5-inline-actions">
            <div className="v5-view-switcher" role="tablist" aria-label="Chế độ hiển thị đội hình">
              <button
                type="button"
                className={`v5-view-btn ${viewMode === "table" ? "active" : ""}`}
                onClick={() => setViewMode("table")}
              >
                📋 Bảng Chi Tiết
              </button>
              <button
                type="button"
                className={`v5-view-btn ${viewMode === "cards" ? "active" : ""}`}
                onClick={() => setViewMode("cards")}
              >
                🗂️ Lưới Thẻ (Cards)
              </button>
              <button
                type="button"
                className={`v5-view-btn ${viewMode === "topology" ? "active" : ""}`}
                onClick={() => setViewMode("topology")}
              >
                🕸️ Sơ Đồ Cụm HA (Topology)
              </button>
            </div>

            <button
              type="button"
              className="v4-btn success"
              onClick={() => setCreateQrTargetBot({ mode: "create" })}
            >
              ➕ Tạo Bot Phụ QR
            </button>
          </div>
        </div>

        {/* Status + Tag Filters + Search + Bulk Bar */}
        <div className="v4-toolbar" style={{ justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
            <div style={{ position: "relative", minWidth: 250, maxWidth: 340, flex: "1 1 250px" }}>
              <input
                data-shortcut-search="true"
                className="v4-input"
                style={{ paddingRight: 30 }}
                placeholder="Tìm tên Bot, UID, chủ thuê, Tag, ghi chú... (/)"
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
              {[
                { id: "all", label: `Tất cả (${enrichedFleet.length})` },
                { id: "online", label: `🟢 Online (${stats.online})` },
                { id: "hot_standby", label: `⚡ Chờ Nóng (${stats.hotStandby})` },
                { id: "connecting", label: `🟡 Kết Nối (${stats.connecting})` },
                { id: "cookie_expired", label: `🔴 Hết Cookie (${stats.cookieExpired})` },
              ].map((st) => (
                <button
                  key={st.id}
                  type="button"
                  className={`v4-chip ${statusFilter === st.id ? "active" : ""}`}
                  onClick={() => setStatusFilter(st.id)}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          <div className="v4-fleet-filter-chips">
            <span className="v4-muted" style={{ fontSize: 11.5, marginRight: 2 }}>
              Nhãn Tag:
            </span>
            {["all", ...PRESET_TAGS].map((tag) => (
              <button
                key={tag}
                type="button"
                className={`v4-chip ${tagFilter === tag ? "active" : ""}`}
                onClick={() => setTagFilter(tag)}
              >
                {tag === "all" ? "Mọi Tag" : `🏷️ ${tag}`}
              </button>
            ))}
          </div>
        </div>

        {checkedIds.length > 0 && (
          <div className="v4-bulk-actions-bar" style={{ marginBottom: 14 }}>
            <span className="v4-badge info">Đã chọn {checkedIds.length} Bot</span>
            <button
              type="button"
              className="v4-btn sm success"
              onClick={() => runBulkBotAction("start", checkedIds)}
            >
              ▶ Bật ({checkedIds.length})
            </button>
            <button
              type="button"
              className="v4-btn sm accent"
              onClick={() => runBulkBotAction("hot_standby", checkedIds)}
            >
              ⚡ Chờ nóng
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
              ⏹ Dừng
            </button>
            <button type="button" className="v4-btn sm" onClick={() => setCheckedIds([])}>
              Bỏ chọn
            </button>
          </div>
        )}

        {/* VIEW MODE 1: DETAILED TABLE */}
        {viewMode === "table" && (
          <div className="v4-table-wrap">
            <table className="v4-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={filteredBots.length > 0 && checkedIds.length === filteredBots.length}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>Tài Khoản Bot & Tag</th>
                  <th>Health</th>
                  <th>Trạng Thái</th>
                  <th>Proxy & Ghi Chú</th>
                  <th>Hạn Thuê / Chủ Bot</th>
                  <th style={{ textAlign: "right" }}>Thao Tác Nhanh 1-Click</th>
                </tr>
              </thead>
              <tbody>
                {filteredBots.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center", padding: 34 }} className="v4-muted">
                      Không có Bot nào khớp điều kiện lọc hiện tại.
                    </td>
                  </tr>
                ) : (
                  filteredBots.map((bot) => {
                    const rel = formatRelativeTimeVi(bot.updatedAt);
                    return (
                      <tr key={bot.id}>
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
                                bot.cookieDead ? "dead" : bot.wsConnected ? "online" : ""
                              }`}
                            >
                              {bot.avatar ? <img src={bot.avatar} alt="" /> : (bot.displayName || "B").slice(0, 1)}
                            </div>
                            <div>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span
                                  style={{ fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}
                                  onClick={() => setDetailBotId(bot.id)}
                                >
                                  {bot.displayName}
                                </span>
                                {bot.isPrimaryAdmin && <span className="v4-badge info">PRIMARY</span>}
                                {bot.autoFailoverCandidate && (
                                  <span className="v4-badge accent">HA STANDBY</span>
                                )}
                                {(bot.tags || []).map((t) => (
                                  <span key={t} className={`v5-tag ${getTagClass(t)}`}>
                                    {t}
                                  </span>
                                ))}
                              </div>
                              <div className="v4-muted v4-mono" style={{ fontSize: 11.5 }}>
                                UID: {bot.uid} • Prefix: {bot.prefix} •{" "}
                                <span title={rel.exactIso}>{rel.relative}</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <HealthScoreBadge score={bot.healthScore} />
                        </td>
                        <td>
                          {renderStatusBadge(bot)}
                          {bot.deadReason && (
                            <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 2 }}>
                              {bot.deadReason}
                            </div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                            <button
                              type="button"
                              className="v4-btn sm"
                              onClick={() => openBotMetaEditor(bot)}
                              title="Chỉnh sửa Tag, Ghi chú, Proxy & Kiểm tra độ trễ Proxy"
                            >
                              {bot.proxyUrl ? (
                                <>
                                  🌐 {maskProxyDisplay(bot.proxyUrl)}
                                  {bot.proxyLatencyMs ? ` (${bot.proxyLatencyMs}ms)` : ""}
                                </>
                              ) : (
                                "🏷️ Tag & Proxy"
                              )}
                            </button>
                            {bot.notes && (
                              <span
                                className="v4-muted"
                                style={{ fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                title={bot.notes}
                              >
                                📝 {bot.notes}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {formatExpiryVi(bot.expiryAt)}
                            {bot.expiringSoon72h && (
                              <span className="v4-badge warning" style={{ marginLeft: 6 }}>
                                &lt;72h
                              </span>
                            )}
                          </div>
                          {bot.ownerUid && (
                            <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                              Chủ: {bot.ownerUid}
                            </div>
                          )}
                        </td>
                        <td>{renderQuickActions(bot)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* VIEW MODE 2: CARDS GRID */}
        {viewMode === "cards" && (
          <div className="v5-fleet-cards-grid">
            {filteredBots.map((bot) => (
              <div
                key={bot.id}
                className={`v5-bot-card ${bot.isPrimaryAdmin ? "is-primary" : ""} ${
                  bot.cookieDead ? "is-dead" : ""
                }`}
              >
                <div>
                  <div className="v5-row-between">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <input
                        type="checkbox"
                        checked={checkedIds.includes(bot.id)}
                        onChange={() => toggleSelect(bot.id)}
                      />
                      <div className={`v4-avatar ${bot.cookieDead ? "dead" : bot.wsConnected ? "online" : ""}`}>
                        {bot.avatar ? <img src={bot.avatar} alt="" /> : (bot.displayName || "B").slice(0, 1)}
                      </div>
                      <div>
                        <div
                          style={{ fontWeight: 700, cursor: "pointer" }}
                          onClick={() => setDetailBotId(bot.id)}
                        >
                          {bot.displayName}
                        </div>
                        <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                          UID: {bot.uid} • Prefix: {bot.prefix}
                        </div>
                      </div>
                    </div>
                    <HealthScoreBadge score={bot.healthScore} />
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                    {renderStatusBadge(bot)}
                    {bot.isPrimaryAdmin && <span className="v4-badge info">PRIMARY</span>}
                    {(bot.tags || []).map((t) => (
                      <span key={t} className={`v5-tag ${getTagClass(t)}`}>
                        {t}
                      </span>
                    ))}
                    {bot.proxyUrl && <span className="v5-tag proxy">🌐 Proxy</span>}
                  </div>

                  <div
                    className="v4-muted"
                    style={{
                      marginTop: 10,
                      fontSize: 12,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span>Hạn: {formatExpiryVi(bot.expiryAt)}</span>
                    <button
                      type="button"
                      className="v4-btn sm"
                      style={{ padding: "2px 8px" }}
                      onClick={() => openBotMetaEditor(bot)}
                    >
                      🏷️ Tag / Proxy
                    </button>
                  </div>
                  {bot.notes && (
                    <div className="v4-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                      📝 {bot.notes}
                    </div>
                  )}
                </div>

                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  {renderQuickActions(bot)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* VIEW MODE 3: HA CLUSTER TOPOLOGY */}
        {viewMode === "topology" && (
          <div className="v5-topology-stage">
            <div className="v5-topology-top-row">
              {/* Primary Node */}
              <div className="v5-topology-node primary">
                <div className="v5-row-between">
                  <span className="v4-badge info">👑 PRIMARY ORCHESTRATOR</span>
                  {primaryBot && <HealthScoreBadge score={primaryBot.healthScore} />}
                </div>
                <div style={{ fontSize: 17, fontWeight: 800 }}>
                  {primaryBot?.displayName || "Bot Admin Chính"}
                </div>
                <div className="v4-muted v4-mono">
                  ID: {primaryBot?.id || "admin"} • UID: {primaryBot?.uid || "--"} • Port:{" "}
                  {primaryBot?.webPort || 2000}
                </div>
                <div>{primaryBot && renderStatusBadge(primaryBot)}</div>
              </div>

              {/* Bridge Connector */}
              <div className="v5-topology-bridge">
                <span>⚡ Heartbeat & Hot-Swap</span>
                <div style={{ fontSize: 22 }}>⇄</div>
                <button
                  type="button"
                  className="v4-btn sm warning"
                  disabled={!designatedStandbyBot}
                  onClick={() => setSwapConfirmOpen(true)}
                >
                  Đảo chiều HA
                </button>
              </div>

              {/* Designated Standby Node */}
              <div className="v5-topology-node standby">
                <div className="v5-row-between">
                  <span className="v4-badge accent">🛡️ DESIGNATED STANDBY</span>
                  {designatedStandbyBot && <HealthScoreBadge score={designatedStandbyBot.healthScore} />}
                </div>
                {designatedStandbyBot ? (
                  <>
                    <div style={{ fontSize: 17, fontWeight: 800 }}>
                      {designatedStandbyBot.displayName}
                    </div>
                    <div className="v4-muted v4-mono">
                      ID: {designatedStandbyBot.id} • UID: {designatedStandbyBot.uid} • Sẵn sàng tiếp quản
                    </div>
                    <div>{renderStatusBadge(designatedStandbyBot)}</div>
                  </>
                ) : (
                  <div className="v4-muted" style={{ padding: "12px 0" }}>
                    Chưa có Bot phụ dự phòng. Hãy tạo ít nhất 1 Bot phụ để kích hoạt cụm HA tự động chuyển đổi dự phòng.
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="v4-nav-group-label" style={{ paddingLeft: 0, marginBottom: 8 }}>
                Nhánh Bot Thành Viên & Thuê Bao SaaS ({standbyCandidates.length} Sub-Bots)
              </div>
              <div className="v5-topology-subgrid">
                {standbyCandidates.length === 0 ? (
                  <div className="v4-muted">Chưa có Sub-Bot nào trong cụm.</div>
                ) : (
                  standbyCandidates.map((sub) => (
                    <div key={sub.id} className="v5-topology-node">
                      <div className="v5-row-between">
                        <strong style={{ fontSize: 13.5 }}>{sub.displayName}</strong>
                        <HealthScoreBadge score={sub.healthScore} />
                      </div>
                      <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                        UID: {sub.uid} • Hạn: {formatExpiryVi(sub.expiryAt)}
                      </div>
                      <div className="v5-row-between" style={{ marginTop: 4 }}>
                        {renderStatusBadge(sub)}
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => {
                            setSwapTargetId(sub.id);
                            setSwapConfirmOpen(true);
                          }}
                        >
                          Thăng làm Primary
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modal 1: Confirm Primary Admin Hot-Swap */}
      {swapConfirmOpen && designatedStandbyBot && (
        <div className="v4-modal-backdrop" onClick={() => !swapping && setSwapConfirmOpen(false)}>
          <div className="v4-modal" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>🔄 Xác Nhận Hoán Đổi Primary Admin (Hot-Swap)</h3>
                <div className="v4-muted">
                  Chuyển giao vai trò điều hành chính không gián đoạn dịch vụ
                </div>
              </div>
              <button
                type="button"
                className="v4-btn sm"
                disabled={swapping}
                onClick={() => setSwapConfirmOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="v4-card" style={{ marginBottom: 14 }}>
              <div style={{ marginBottom: 8 }}>
                • Primary hiện tại: <strong>{primaryBot?.displayName || "admin"}</strong> (
                <code>{primaryBot?.id || "admin"}</code>)
              </div>
              <div>
                • Primary mới tiếp quản: <strong>{designatedStandbyBot.displayName}</strong> (
                <code>{designatedStandbyBot.id}</code> — Health {designatedStandbyBot.healthScore}/100)
              </div>
            </div>

            <p className="v4-muted" style={{ marginTop: 0 }}>
              Hệ thống sẽ cập nhật <code>role-registry.json</code>, đồng bộ cổng Upstream và ghi lại nhật ký giao dịch kiểm toán để có thể đảo chiều bất cứ lúc nào.
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                className="v4-btn"
                disabled={swapping}
                onClick={() => setSwapConfirmOpen(false)}
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                className="v4-btn warning"
                disabled={swapping}
                onClick={handleExecuteAdminSwap}
              >
                {swapping ? "Đang hoán đổi..." : "⚡ Xác Nhận Hoán Đổi Ngay"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Edit Bot Tags, Notes, Failover Candidate & Live Proxy Latency Check */}
      {editingBot && (
        <div className="v4-modal-backdrop" onClick={() => !savingMeta && setEditingBot(null)}>
          <div className="v4-modal" style={{ maxWidth: 580 }} onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>🏷️ Nhãn Tag, Ghi Chú & Proxy — {editingBot.displayName}</h3>
                <div className="v4-muted v4-mono">Bot ID: {editingBot.id} • UID: {editingBot.uid}</div>
              </div>
              <button type="button" className="v4-btn sm" onClick={() => setEditingBot(null)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveBotMeta}>
              <div className="v4-field">
                <label>Nhãn phân loại nhanh (Tags)</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  {PRESET_TAGS.map((tag) => {
                    const active = editTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={`v4-chip ${active ? "active" : ""}`}
                        onClick={() => togglePresetTag(tag)}
                      >
                        {active ? "✓ " : "+ "}
                        {tag}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="v4-input"
                    placeholder="Thêm nhãn tùy chỉnh (vd: Cụm Miền Nam)..."
                    value={customTagInput}
                    onChange={(e) => setCustomTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomTag();
                      }
                    }}
                  />
                  <button type="button" className="v4-btn sm" onClick={addCustomTag}>
                    Thêm Tag
                  </button>
                </div>
                {editTags.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {editTags.map((t) => (
                      <span key={t} className={`v5-tag ${getTagClass(t)}`}>
                        {t}
                        <button
                          type="button"
                          className="v4-btn-icon"
                          style={{ marginLeft: 4 }}
                          onClick={() => setEditTags((prev) => prev.filter((x) => x !== t))}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="v4-field">
                <label>Cấu hình HTTP / SOCKS5 Proxy riêng cho Bot</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="v4-input v4-mono"
                    placeholder="http://user:pass@ip:port hoặc socks5://..."
                    value={editProxyUrl}
                    onChange={(e) => setEditProxyUrl(e.target.value)}
                  />
                  <button
                    type="button"
                    className="v4-btn primary"
                    disabled={testingProxy}
                    onClick={handleTestProxy}
                  >
                    {testingProxy ? "Đang đo..." : "⚡ Test Độ Trễ"}
                  </button>
                </div>
                {proxyTestResult && (
                  <div
                    className="v4-card"
                    style={{
                      marginTop: 8,
                      padding: "9px 12px",
                      borderColor: proxyTestResult.ok ? "var(--success)" : "var(--danger)",
                    }}
                  >
                    <div style={{ fontWeight: 700, color: proxyTestResult.ok ? "var(--success)" : "var(--danger)" }}>
                      {proxyTestResult.ok ? "✅ Kết nối thành công" : "❌ Lỗi kết nối Proxy"}
                      {proxyTestResult.latencyMs !== null && ` • Độ trễ: ${proxyTestResult.latencyMs} ms`}
                      {proxyTestResult.ip && ` • IP ra: ${proxyTestResult.ip}`}
                    </div>
                    <div className="v4-muted">{proxyTestResult.message}</div>
                  </div>
                )}
              </div>

              <div className="v4-field">
                <label>Ghi chú vận hành nội bộ</label>
                <textarea
                  className="v4-textarea"
                  style={{ minHeight: 72 }}
                  placeholder="Ghi chú chủ thuê, nhóm VIP phụ trách, lưu ý gia hạn..."
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                />
              </div>

              {!editingBot.isPrimaryAdmin && (
                <div className="v4-switch-card" style={{ marginBottom: 14 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>Chỉ định làm Bot Dự Phòng HA (Auto-Failover Candidate)</div>
                    <div className="v4-muted">Ưu tiên chọn Bot này khi kích hoạt chuyển đổi dự phòng Primary Admin</div>
                  </div>
                  <button
                    type="button"
                    className={`v4-switch ${editStandbyCandidate ? "on" : ""}`}
                    onClick={() => setEditStandbyCandidate((v) => !v)}
                  >
                    <span className="v4-switch-knob" />
                  </button>
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="v4-btn" onClick={() => setEditingBot(null)}>
                  Đóng
                </button>
                <button type="submit" className="v4-btn success" disabled={savingMeta}>
                  {savingMeta ? "Đang lưu..." : "💾 Lưu Thiết Lập Bot"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
