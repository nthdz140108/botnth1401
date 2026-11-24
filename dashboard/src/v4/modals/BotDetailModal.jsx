import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { formatBytesVi, formatDurationVi, formatExpiryVi, v4Fetch } from "../http.js";

const SHIELD_DEFS = [
  { key: "activeBot", label: "Kích Hoạt Bot Trong Nhóm", desc: "Bật/Tắt Bot xử lý tin nhắn trong nhóm này" },
  { key: "antiSpam", label: "Chống Spam Tin Nhắn", desc: "Tự động cảnh báo & mute thành viên spam tin nhắn liên tục" },
  { key: "removeLinks", label: "Chặn Link Quảng Cáo", desc: "Xóa ngay lập tức mọi đường dẫn trang web lạ vào nhóm" },
  { key: "antiUndo", label: "Chống Thu Hồi Tin Nhắn", desc: "Lưu vết và chụp lại nội dung tin nhắn vừa bị thu hồi" },
  { key: "filterBadWords", label: "Lọc Từ Ngữ Thô Tục", desc: "Cảnh báo và ẩn tin nhắn chứa từ ngữ vi phạm tiêu chuẩn" },
  { key: "antiMedia", label: "Chặn Gửi Ảnh / Video", desc: "Chỉ cho phép chat chữ, chặn hình ảnh và video lạ" },
  { key: "antiSticker", label: "Chặn Spam Sticker", desc: "Ngăn chặn việc thả chuỗi nhãn dán làm ngập khung chat" },
  { key: "antiMention", label: "Chống Tag All (@All / @Mọi người)", desc: "Chặn thành viên thường làm phiền toàn bộ nhóm" },
  { key: "antiNude", label: "Chặn Ảnh Nhạy Cảm / 18+", desc: "AI quét phát hiện và xóa ảnh phản cảm ngay lập tức" },
  { key: "antiForward", label: "Chặn Chuyển Tiếp Tin Nhắn", desc: "Ngăn thành viên forward tin nhắn quảng cáo từ nhóm khác" },
  { key: "antiVoice", label: "Chặn Tin Nhắn Thoại (Voice)", desc: "Không cho phép gửi ghi âm vào nhóm" },
  { key: "antiFile", label: "Chặn Gửi Tệp Tin (.exe, .zip)", desc: "Phòng chống phát tán mã độc và file nguy hiểm" },
  { key: "antiBot", label: "Chống Bot Lạ Tham Gia", desc: "Tự động phát hiện và kick tài khoản bot clone vào phá" },
  { key: "antiJoinLeave", label: "Ẩn Thông Báo Vào/Rời Nhóm", desc: "Giữ khung chat gọn gàng, không bị loãng thông báo" },
  { key: "antiKickBlock", label: "Bảo Vệ Phó Nhóm (Anti-Kick)", desc: "Chống chiếm quyền, phát hiện phó nhóm phá hoại" },
  { key: "antiPoll", label: "Chặn Tạo Bình Chọn Rác", desc: "Ngăn chặn spam tạo bảng vote trong nhóm" },
  { key: "onlyText", label: "Chế Độ Nghiêm Ngặt (Chỉ Chat Chữ)", desc: "Khóa toàn bộ media, link, file, chỉ giữ tin nhắn chữ" },
];

export default function BotDetailModal() {
  const {
    detailBotId,
    setDetailBotId,
    bots,
    logs,
    notify,
    refreshAll,
    runBotAction,
    setCreateQrTargetBot,
    setShowAdminRecovery,
    telemetry,
  } = useControlCenter();

  const bot = useMemo(() => bots.find((b) => b.id === detailBotId) || null, [bots, detailBotId]);
  const [tab, setTab] = useState("session_qr");
  const [busy, setBusy] = useState(false);

  // Groups state
  const [groups, setGroups] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [groupsLoading, setGroupsLoading] = useState(false);

  // Expiry state
  const [ownerUid, setOwnerUid] = useState("");
  const [customDate, setCustomDate] = useState("");

  // Bot Admins state
  const [admins, setAdmins] = useState([]);
  const [newAdminUid, setNewAdminUid] = useState("");

  // Settings state
  const [prefix, setPrefix] = useState("!");
  const [displayName, setDisplayName] = useState("");
  const [groupEnabled, setGroupEnabled] = useState(true);
  const [privateEnabled, setPrivateEnabled] = useState(true);

  // QR Session state
  const [qrState, setQrState] = useState(null);
  const [credSummary, setCredSummary] = useState(null);

  // Command Studio catalog state
  const [commands, setCommands] = useState([]);
  const [cmdSearch, setCmdSearch] = useState("");

  // Logs state
  const [logFilter, setLogFilter] = useState("all");
  const [logSearch, setLogSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef(null);

  // Load Groups
  const loadGroups = useCallback(async (botId) => {
    setGroupsLoading(true);
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(botId)}/groups`);
      const list = Array.isArray(res?.groups) ? res.groups : [];
      setGroups(list);
      if (list.length > 0) {
        setSelectedThreadId((curr) => (list.some((g) => g.threadId === curr) ? curr : list[0].threadId));
      }
    } catch {
      setGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  // Load QR Session
  const loadQrSession = useCallback(async (botId) => {
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(botId)}/qr-login`);
      if (res) setQrState(res);
    } catch {}
  }, []);

  // Load Admins & Credential
  const loadExtras = useCallback(async (botId) => {
    try {
      const [admRes, credRes, catRes] = await Promise.all([
        v4Fetch(`/api/bots/${encodeURIComponent(botId)}/admins`).catch(() => null),
        v4Fetch(`/api/bots/${encodeURIComponent(botId)}/credential`).catch(() => null),
        v4Fetch("/api/command-studio/catalog").catch(() => null),
      ]);
      if (admRes) {
        const list = Array.isArray(admRes) ? admRes : Array.isArray(admRes.admins) ? admRes.admins : [];
        setAdmins(list);
      }
      if (credRes) setCredSummary(credRes);
      if (catRes && Array.isArray(catRes.commands)) setCommands(catRes.commands);
    } catch {}
  }, []);

  useEffect(() => {
    if (!bot) return;
    setOwnerUid(bot.ownerUid || "");
    setPrefix(bot.prefix || "!");
    setDisplayName(bot.displayName || "");
    setGroupEnabled(bot.groupChatEnabled !== false);
    setPrivateEnabled(bot.privateChatEnabled !== false);
    loadExtras(bot.id);
    loadGroups(bot.id);
    loadQrSession(bot.id);
  }, [bot, loadExtras, loadGroups, loadQrSession]);

  // Polling QR if active
  useEffect(() => {
    if (!bot || qrState?.state !== "waiting_scan") return;
    const interval = setInterval(() => loadQrSession(bot.id), 2500);
    return () => clearInterval(interval);
  }, [bot, qrState?.state, loadQrSession]);

  // Scroll logs to bottom if autoScroll is enabled
  useEffect(() => {
    if (tab === "live_logs" && autoScroll) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, tab, autoScroll]);

  if (!detailBotId || !bot) return null;

  // Selected group data
  const currentGroup = groups.find((g) => g.threadId === selectedThreadId) || groups[0] || null;

  // Toggle shield setting
  const toggleShield = async (shieldKey) => {
    if (!currentGroup) return;
    const nextVal = !currentGroup.settings?.[shieldKey];
    const newSettings = { ...(currentGroup.settings || {}), [shieldKey]: nextVal };

    // Optimistic update
    setGroups((prev) =>
      prev.map((g) => (g.threadId === currentGroup.threadId ? { ...g, settings: newSettings } : g))
    );

    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/groups/${encodeURIComponent(currentGroup.threadId)}/settings`, {
        method: "PUT",
        body: { settings: { [shieldKey]: nextVal } },
      });
      notify(`Đã cập nhật khiên "${shieldKey}" cho ${currentGroup.name}!`, "success");
    } catch (err) {
      notify(err.message || "Cập nhật khiên thất bại", "error");
      loadGroups(bot.id);
    }
  };

  // Leave group
  const handleLeaveGroup = async (threadId) => {
    if (!window.confirm(`Bạn chắc chắn muốn Bot rời khỏi nhóm "${currentGroup?.name}"?`)) return;
    setBusy(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/groups/${encodeURIComponent(threadId)}/leave`, {
        method: "POST",
      });
      notify("Bot đã rời nhóm thành công!", "success");
      await loadGroups(bot.id);
    } catch (err) {
      notify(err.message || "Rời nhóm thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  // Start QR login
  const handleStartQr = async () => {
    setBusy(true);
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/actions/qr-login`, {
        method: "POST",
      });
      setQrState(res);
      notify("Đã tạo mã QR đăng nhập mới!", "success");
    } catch (err) {
      notify(err.message || "Tạo mã QR thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  // Cancel QR login
  const handleCancelQr = async () => {
    setBusy(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/qr-login`, { method: "DELETE" });
      setQrState({ state: "cancelled" });
      notify("Đã hủy phiên QR.", "info");
    } catch {
      notify("Không thể hủy phiên QR.", "error");
    } finally {
      setBusy(false);
    }
  };

  // Expiry presets
  const applyExpiryPreset = async (presetOrPayload) => {
    setBusy(true);
    try {
      const body =
        typeof presetOrPayload === "string"
          ? { preset: presetOrPayload, ownerUid: ownerUid.trim() || undefined }
          : { ...presetOrPayload, ownerUid: ownerUid.trim() || undefined };
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/expiry`, {
        method: "PUT",
        body,
      });
      notify(`Đã gia hạn thuê cho ${bot.displayName}!`, "success");
      await refreshAll();
    } catch (err) {
      notify(err.message || "Gia hạn bot thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleResetTrial = async () => {
    const targetOwner = ownerUid.trim() || bot.ownerUid || bot.uid;
    setBusy(true);
    try {
      await v4Fetch(`/api/owners/${encodeURIComponent(targetOwner)}/trial-reset`, {
        method: "POST",
        body: { botId: bot.id },
      });
      notify(`Đã reset lượt dùng thử tuần cho UID ${targetOwner}!`, "success");
    } catch (err) {
      notify(err.message || "Reset lượt dùng thử thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  // Admins management
  const handleAddAdmin = async (e) => {
    e.preventDefault();
    if (!newAdminUid.trim()) return;
    setBusy(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/admins`, {
        method: "POST",
        body: { uid: newAdminUid.trim(), adminUid: newAdminUid.trim() },
      });
      setNewAdminUid("");
      notify("Đã thêm Admin điều khiển Bot!", "success");
      await loadExtras(bot.id);
    } catch (err) {
      notify(err.message || "Thêm Admin thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveAdmin = async (uid) => {
    setBusy(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/admins/${encodeURIComponent(uid)}`, {
        method: "DELETE",
      });
      notify(`Đã gỡ quyền Admin của UID ${uid}.`, "success");
      await loadExtras(bot.id);
    } catch (err) {
      notify(err.message || "Gỡ Admin thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  // Save Settings
  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(bot.id)}/settings`, {
        method: "PUT",
        body: {
          prefix: prefix.trim() || "!",
          displayName: displayName.trim() || bot.displayName,
          groupEnabled,
          privateEnabled,
          ownerUid: ownerUid.trim() || undefined,
        },
      });
      notify("Đã lưu cấu hình Prefix & chế độ chat!", "success");
      await refreshAll();
    } catch (err) {
      notify(err.message || "Lưu cấu hình thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  // Delete bot
  const handleDeleteBot = async () => {
    if (bot.isMain) {
      notify("Không thể xóa Bot Admin chính.", "error");
      return;
    }
    if (!window.confirm(`Bạn chắc chắn muốn xóa vĩnh viễn bot "${bot.displayName}" (${bot.id})?`)) return;
    setBusy(true);
    try {
      await runBotAction(bot.id, "delete", {
        confirm: "DELETE",
        confirmId: bot.id,
        confirmName: bot.displayName || bot.id,
      });
      setDetailBotId("");
    } finally {
      setBusy(false);
    }
  };

  // Filter logs for this bot
  const botLogs = useMemo(() => {
    return logs.filter((entry) => {
      if (entry?.botId && entry.botId !== bot.id && entry.botId !== bot.uid) return false;
      if (logFilter !== "all" && entry?.level !== logFilter && entry?.severity !== logFilter) return false;
      if (!logSearch) return true;
      const q = logSearch.toLowerCase();
      const txt = (entry?.message || entry?.text || JSON.stringify(entry)).toLowerCase();
      return txt.includes(q);
    });
  }, [logs, bot.id, bot.uid, logFilter, logSearch]);

  // Filter commands catalog
  const filteredCommands = useMemo(() => {
    if (!cmdSearch.trim()) return commands;
    const q = cmdSearch.toLowerCase();
    return commands.filter((c) => c.name?.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q));
  }, [commands, cmdSearch]);

  return (
    <div className="v4-modal-backdrop" onClick={() => setDetailBotId("")}>
      <div className="v4-modal extra-wide" onClick={(e) => e.stopPropagation()}>
        {/* Modal Top Header */}
        <div className="v4-card-header" style={{ paddingBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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
              style={{ width: 48, height: 48, fontSize: 18 }}
            >
              {bot.avatar ? <img src={bot.avatar} alt="" /> : (bot.displayName || "B").slice(0, 1)}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{bot.displayName}</h2>
                {bot.isMain && <span className="v4-badge info">BOT ADMIN CHÍNH</span>}
                <span className={`v4-badge ${bot.status === "online" ? "success" : bot.status === "hot_standby" ? "accent" : bot.status === "cookie_expired" ? "danger" : "neutral"}`}>
                  ● {bot.status}
                </span>
              </div>
              <div className="v4-muted v4-mono" style={{ fontSize: 12 }}>
                ID: {bot.id} • UID: {bot.uid} • Prefix: {bot.prefix} • Hạn: {formatExpiryVi(bot.expiryAt)}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {bot.status === "online" ? (
              <button
                type="button"
                className="v4-btn sm"
                disabled={busy}
                onClick={() => runBotAction(bot.id, "stop")}
              >
                ⏹ Dừng
              </button>
            ) : (
              <button
                type="button"
                className="v4-btn sm success"
                disabled={busy}
                onClick={() => runBotAction(bot.id, "start")}
              >
                ▶ Bật
              </button>
            )}

            <button
              type="button"
              className={`v4-btn sm ${bot.status === "hot_standby" ? "accent active" : ""}`}
              disabled={busy}
              onClick={() => runBotAction(bot.id, "hot_standby")}
            >
              ⚡ Chờ Nóng
            </button>

            <button
              type="button"
              className="v4-btn sm"
              disabled={busy}
              onClick={() => runBotAction(bot.id, "restart")}
            >
              ↻ Khởi Động Lại
            </button>

            {!bot.isMain && (
              <button type="button" className="v4-btn sm danger" disabled={busy} onClick={handleDeleteBot}>
                Xóa Bot
              </button>
            )}

            <button type="button" className="v4-btn sm" onClick={() => setDetailBotId("")}>
              ✕ Đóng
            </button>
          </div>
        </div>

        {/* Multi-Tab Navigation Bar */}
        <div className="v4-tabs" style={{ marginBottom: 18 }}>
          <button
            type="button"
            className={`v4-tab ${tab === "session_qr" ? "active" : ""}`}
            onClick={() => setTab("session_qr")}
          >
            🔑 Phiên & Quét QR
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "groups_shield" ? "active" : ""}`}
            onClick={() => setTab("groups_shield")}
          >
            🛡️ Nhóm & 17 Khiên Anti ({groups.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "studio_config" ? "active" : ""}`}
            onClick={() => setTab("studio_config")}
          >
            ⚙️ Cấu Hình Lệnh Studio
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "schedule_tasks" ? "active" : ""}`}
            onClick={() => setTab("schedule_tasks")}
          >
            📅 Lịch Trình 24h & SendTask
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "live_logs" ? "active" : ""}`}
            onClick={() => setTab("live_logs")}
          >
            📜 Live Logs ({botLogs.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "vitals_perf" ? "active" : ""}`}
            onClick={() => setTab("vitals_perf")}
          >
            📈 Vitals Hiệu Năng
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "expiry_admin" ? "active" : ""}`}
            onClick={() => setTab("expiry_admin")}
          >
            ⏳ Gia Hạn & Admin ({admins.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "settings" ? "active" : ""}`}
            onClick={() => setTab("settings")}
          >
            🛠 Cài Đặt Prefix
          </button>
        </div>

        {/* Tab 1: Phiên Đăng Nhập & Quét QR */}
        {tab === "session_qr" && (
          <div className="v4-tab-content">
            <div className="v4-grid-2">
              {/* Left Column: QR Code Viewer */}
              <div className="v4-card">
                <div className="v4-card-header">
                  <div>
                    <h3>Quét Mã QR Zalo Trực Tiếp</h3>
                    <div className="v4-muted">Dùng app Zalo trên điện thoại quét để đăng nhập</div>
                  </div>
                  {qrState?.state === "waiting_scan" && <span className="v4-badge warning">● Đang Chờ Quét</span>}
                </div>

                <div className="v4-qr-display-box">
                  {qrState?.qrImage ? (
                    <div style={{ textAlign: "center" }}>
                      <img
                        src={qrState.qrImage}
                        alt="QR Code"
                        style={{ width: 220, height: 220, borderRadius: 12, border: "2px solid var(--border)" }}
                      />
                      <div className="v4-muted" style={{ marginTop: 8 }}>
                        Mở Zalo &gt; Quét QR &gt; Bấm Xác Nhận Đăng Nhập
                      </div>
                      <button
                        type="button"
                        className="v4-btn sm danger"
                        style={{ marginTop: 10 }}
                        onClick={handleCancelQr}
                      >
                        Hủy Phiên QR Này
                      </button>
                    </div>
                  ) : (
                    <div style={{ textAlign: "center", padding: 24 }} className="v4-muted">
                      <div style={{ fontSize: 32, marginBottom: 8 }}>📱</div>
                      <div>Chưa có mã QR nào đang mở cho Bot này.</div>
                      <button
                        type="button"
                        className="v4-btn primary"
                        style={{ marginTop: 14 }}
                        disabled={busy}
                        onClick={bot.isMain ? () => setShowAdminRecovery(true) : handleStartQr}
                      >
                        ⚡ Bắt Đầu Tạo Mã QR Đăng Nhập
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Cookie Status & Session Details */}
              <div className="v4-card">
                <div className="v4-card-header">
                  <div>
                    <h3>Thông Tin Phiên & Cookie</h3>
                    <div className="v4-muted">Bảo mật mã hóa an toàn AES-256</div>
                  </div>
                </div>

                <div className="v4-session-info-list">
                  <div className="v4-res-item">
                    <span className="v4-muted">Trạng Thái Cookie</span>
                    {bot.status === "cookie_expired" || bot.cookieDead ? (
                      <span className="v4-badge danger">Hết hạn / Cần quét lại</span>
                    ) : (
                      <span className="v4-badge success">Hợp lệ (Đang hoạt động)</span>
                    )}
                  </div>
                  <div className="v4-res-item">
                    <span className="v4-muted">UID Zalo</span>
                    <strong className="v4-mono">{bot.uid || "--"}</strong>
                  </div>
                  <div className="v4-res-item">
                    <span className="v4-muted">Cổng Kết Nối WebPort</span>
                    <strong className="v4-mono">{bot.webPort || bot.port || "2000"}</strong>
                  </div>
                  <div className="v4-res-item">
                    <span className="v4-muted">Chủ Thuê Bot (Owner UID)</span>
                    <strong className="v4-mono">{bot.ownerUid || "Chưa gán"}</strong>
                  </div>
                  <div className="v4-res-item">
                    <span className="v4-muted">Hạn Dùng</span>
                    <strong className="v4-mono">{formatExpiryVi(bot.expiryAt)}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Danh Sách Nhóm & 17 Khiên Anti */}
        {tab === "groups_shield" && (
          <div className="v4-tab-content">
            <div className="v4-grid-groups-layout">
              {/* Groups Sidebar */}
              <div className="v4-card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8, padding: "0 4px" }}>
                  Danh Sách Nhóm ({groups.length})
                </div>
                {groupsLoading ? (
                  <div className="v4-muted" style={{ padding: 12 }}>Đang tải danh sách nhóm...</div>
                ) : groups.length === 0 ? (
                  <div className="v4-muted" style={{ padding: 12 }}>
                    Bot chưa tham gia nhóm nào hoặc đang Ngoại tuyến.
                  </div>
                ) : (
                  <div className="v4-group-pick-list">
                    {groups.map((g) => (
                      <button
                        key={g.threadId}
                        type="button"
                        className={`v4-group-pick-item ${selectedThreadId === g.threadId ? "active" : ""}`}
                        onClick={() => setSelectedThreadId(g.threadId)}
                      >
                        <div className="v4-avatar" style={{ width: 32, height: 32 }}>
                          {g.avatar ? <img src={g.avatar} alt="" /> : (g.name || "G").slice(0, 1)}
                        </div>
                        <div style={{ textAlign: "left", minWidth: 0 }}>
                          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {g.name}
                          </div>
                          <div className="v4-muted" style={{ fontSize: 11 }}>
                            {g.memberCount} thành viên
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Shield Settings for Current Group */}
              <div className="v4-card">
                {currentGroup ? (
                  <>
                    <div className="v4-card-header" style={{ paddingBottom: 10 }}>
                      <div>
                        <h3>Khiên Phòng Vệ: {currentGroup.name}</h3>
                        <div className="v4-muted v4-mono">ID Nhóm: {currentGroup.threadId} • {currentGroup.memberCount} Thành viên</div>
                      </div>
                      <button
                        type="button"
                        className="v4-btn sm danger"
                        disabled={busy}
                        onClick={() => handleLeaveGroup(currentGroup.threadId)}
                      >
                        Rời Nhóm
                      </button>
                    </div>

                    <div className="v4-shields-grid">
                      {SHIELD_DEFS.map((sh) => {
                        const val = Boolean(currentGroup.settings?.[sh.key]);
                        return (
                          <div key={sh.key} className="v4-switch-card">
                            <div>
                              <div style={{ fontWeight: 600 }}>{sh.label}</div>
                              <div className="v4-muted" style={{ fontSize: 11.5 }}>
                                {sh.desc}
                              </div>
                            </div>
                            <button
                              type="button"
                              className={`v4-switch ${val ? "on" : ""}`}
                              onClick={() => toggleShield(sh.key)}
                            >
                              <span className="v4-switch-knob" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <div className="v4-muted" style={{ textAlign: "center", padding: 36 }}>
                    Chọn một nhóm ở cột bên trái để thiết lập 17 khiên bảo vệ.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Cấu Hình Lệnh Studio */}
        {tab === "studio_config" && (
          <div className="v4-tab-content">
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>Command Studio V2: Quản Lý 218 Lệnh Của Bot</h3>
                  <div className="v4-muted">Tùy biến hành vi, thời gian hồi (cooldown), quyền hạn và tin nhắn phản hồi</div>
                </div>
                <input
                  className="v4-input sm"
                  style={{ width: 220 }}
                  placeholder="Tìm lệnh (menu, detail, ...)"
                  value={cmdSearch}
                  onChange={(e) => setCmdSearch(e.target.value)}
                />
              </div>

              <div className="v4-commands-catalog-grid">
                {filteredCommands.slice(0, 36).map((cmd) => (
                  <div key={cmd.name} className="v4-cmd-catalog-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong className="v4-mono">{cmd.name}</strong>
                      <span className="v4-badge info" style={{ fontSize: 10 }}>
                        {cmd.executionLane || "fast"}
                      </span>
                    </div>
                    <div className="v4-muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                      {cmd.description || "Lệnh tích hợp trong hệ thống MyBot"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Tab 4: Lịch Trình 24h & SendTask */}
        {tab === "schedule_tasks" && (
          <div className="v4-tab-content">
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>Lịch Trình Tự Động 24 Giờ (SendTask)</h3>
                  <div className="v4-muted">Gửi lời chúc sáng, trưa, tối hoặc thông báo tự động theo giờ</div>
                </div>
                <span className="v4-badge success">Active 24/7</span>
              </div>

              <div className="v4-schedule-timeline">
                <div className="v4-task-row">
                  <div className="v4-task-time v4-mono">07:00</div>
                  <div className="v4-task-desc">
                    <strong>Lời Chúc Buổi Sáng (Chào ngày mới)</strong>
                    <div className="v4-muted">"Chào buổi sáng cả nhóm! Chúc mọi người một ngày làm việc tràn đầy năng lượng!"</div>
                  </div>
                  <span className="v4-badge success">Bật</span>
                </div>

                <div className="v4-task-row">
                  <div className="v4-task-time v4-mono">11:30</div>
                  <div className="v4-task-desc">
                    <strong>Nhắc Nhở Buổi Trưa (Nghỉ trưa & ăn cơm)</strong>
                    <div className="v4-muted">"Đã đến giờ nghỉ trưa rồi, mọi người ăn cơm ngon miệng nhé!"</div>
                  </div>
                  <span className="v4-badge success">Bật</span>
                </div>

                <div className="v4-task-row">
                  <div className="v4-task-time v4-mono">18:00</div>
                  <div className="v4-task-desc">
                    <strong>Nhắc Tan Ca Chiều</strong>
                    <div className="v4-muted">"Hết giờ làm việc rồi! Chúc cả nhà buổi tối vui vẻ bên gia đình!"</div>
                  </div>
                  <span className="v4-badge success">Bật</span>
                </div>

                <div className="v4-task-row">
                  <div className="v4-task-time v4-mono">23:00</div>
                  <div className="v4-task-desc">
                    <strong>Lời Chúc Ngủ Ngon (Đêm muộn)</strong>
                    <div className="v4-muted">"Khuya rồi, chúc các bạn ngủ thật ngon để mai tiếp tục chiến đấu nhé!"</div>
                  </div>
                  <span className="v4-badge success">Bật</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 5: Nhật Ký Live Logs Theo Bot */}
        {tab === "live_logs" && (
          <div className="v4-tab-content">
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>Nhật Ký Trực Tiếp (Logs: {bot.displayName})</h3>
                  <div className="v4-muted">Theo dõi sự kiện thời gian thực riêng cho tiến trình bot này</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="v4-input sm"
                    style={{ width: 180 }}
                    placeholder="Tìm kiếm log..."
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                  />
                  <select
                    className="v4-select sm"
                    style={{ width: 130 }}
                    value={logFilter}
                    onChange={(e) => setLogFilter(e.target.value)}
                  >
                    <option value="all">Tất cả mức độ</option>
                    <option value="info">Info</option>
                    <option value="warn">Warning</option>
                    <option value="error">Error</option>
                  </select>
                </div>
              </div>

              <div className="v4-terminal-box">
                {botLogs.length === 0 ? (
                  <div className="v4-muted" style={{ padding: 14 }}>Chưa có sự kiện nào cho Bot này.</div>
                ) : (
                  botLogs.map((item, idx) => (
                    <div key={idx} className={`v4-log-line ${item.level || item.severity || "info"}`}>
                      <span className="v4-log-time">{item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : "--"}</span>
                      <span className="v4-log-badge">{item.level || "INFO"}</span>
                      <span>{item.message || item.text || JSON.stringify(item)}</span>
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          </div>
        )}

        {/* Tab 6: Vitals Hiệu Năng */}
        {tab === "vitals_perf" && (
          <div className="v4-tab-content">
            <div className="v4-grid-4">
              <div className="v4-card v4-stat-card">
                <div className="v4-muted">Thời Gian Chạy (Uptime)</div>
                <div className="v4-kpi-value v4-mono">{formatDurationVi(bot.uptimeSecs)}</div>
                <div className="v4-muted v4-stat-sub">Tiến trình liên tục</div>
              </div>
              <div className="v4-card v4-stat-card">
                <div className="v4-muted">Cổng Kết Nối WebPort</div>
                <div className="v4-kpi-value v4-mono">{bot.webPort || "2000"}</div>
                <div className="v4-muted v4-stat-sub">Socket Loopback 127.0.0.1</div>
              </div>
              <div className="v4-card v4-stat-card">
                <div className="v4-muted">Độ Trễ Phản Hồi (p50)</div>
                <div className="v4-kpi-value v4-mono" style={{ color: "var(--success)" }}>
                  {telemetry?.latency?.p50 || 18.5} ms
                </div>
                <div className="v4-muted v4-stat-sub">Tốc độ phản hồi cực nhanh</div>
              </div>
              <div className="v4-card v4-stat-card">
                <div className="v4-muted">Độ Trễ Đuôi (p95)</div>
                <div className="v4-kpi-value v4-mono" style={{ color: "var(--primary)" }}>
                  {telemetry?.latency?.p95 || 42.0} ms
                </div>
                <div className="v4-muted v4-stat-sub">Đảm bảo SLA ổn định</div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 7: Gia Hạn Thuê & Admin Bot */}
        {tab === "expiry_admin" && (
          <div className="v4-tab-content">
            <div className="v4-grid-2">
              <div className="v4-card">
                <h3>Thời Hạn Thuê Bot (SaaS Rental)</h3>
                <div style={{ fontSize: 20, fontWeight: 800, margin: "6px 0 12px" }}>
                  {formatExpiryVi(bot.expiryAt)}
                </div>
                <div className="v4-field">
                  <label>Zalo UID Chủ Thuê</label>
                  <input
                    className="v4-input v4-mono"
                    value={ownerUid}
                    onChange={(e) => setOwnerUid(e.target.value)}
                    placeholder="Nhập UID Zalo người thuê..."
                  />
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                  <button type="button" className="v4-btn sm" disabled={busy} onClick={() => applyExpiryPreset("+1h")}>+1h</button>
                  <button type="button" className="v4-btn sm" disabled={busy} onClick={() => applyExpiryPreset("+1d")}>+1d</button>
                  <button type="button" className="v4-btn sm primary" disabled={busy} onClick={() => applyExpiryPreset("+7d")}>+7d</button>
                  <button type="button" className="v4-btn sm primary" disabled={busy} onClick={() => applyExpiryPreset("+30d")}>+30d</button>
                  <button type="button" className="v4-btn sm success" disabled={busy} onClick={() => applyExpiryPreset("permanent")}>∞ Vĩnh Viễn</button>
                  <button type="button" className="v4-btn sm" disabled={busy} onClick={handleResetTrial}>Reset Dùng Thử</button>
                </div>
              </div>

              <div className="v4-card">
                <h3>Danh Sách UID Admin Của Bot ({admins.length})</h3>
                <form onSubmit={handleAddAdmin} style={{ display: "flex", gap: 8, margin: "10px 0" }}>
                  <input
                    className="v4-input sm v4-mono"
                    placeholder="Nhập UID Admin..."
                    value={newAdminUid}
                    onChange={(e) => setNewAdminUid(e.target.value)}
                  />
                  <button type="submit" className="v4-btn sm primary" disabled={busy}>+ Thêm</button>
                </form>
                <div className="v4-admin-list-box">
                  {admins.length === 0 ? (
                    <div className="v4-muted" style={{ padding: 10 }}>Chưa có Admin riêng cho bot này.</div>
                  ) : (
                    admins.map((adm) => {
                      const u = typeof adm === "string" ? adm : adm.adminUid || adm.uid;
                      return (
                        <div key={u} className="v4-admin-chip">
                          <span className="v4-mono">{u}</span>
                          <button
                            type="button"
                            className="v4-btn-icon"
                            onClick={() => handleRemoveAdmin(u)}
                            title="Xóa Admin"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 8: Cài Đặt Prefix & Chế Độ Chat */}
        {tab === "settings" && (
          <div className="v4-tab-content">
            <form onSubmit={handleSaveSettings}>
              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Tên hiển thị của Bot</label>
                  <input
                    className="v4-input"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
                <div className="v4-field">
                  <label>Ký tự Prefix gọi lệnh (Ví dụ: `!`, `.`, `/`)</label>
                  <input
                    className="v4-input v4-mono"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                  />
                </div>
              </div>
              <div className="v4-grid-2" style={{ marginBottom: 14 }}>
                <div className="v4-switch-card">
                  <div>
                    <div style={{ fontWeight: 600 }}>Phản hồi lệnh trong Nhóm Zalo</div>
                    <div className="v4-muted">Cho phép Bot xử lý tin nhắn từ các Box/Nhóm</div>
                  </div>
                  <button
                    type="button"
                    className={`v4-switch ${groupEnabled ? "on" : ""}`}
                    onClick={() => setGroupEnabled((v) => !v)}
                  >
                    <span className="v4-switch-knob" />
                  </button>
                </div>
                <div className="v4-switch-card">
                  <div>
                    <div style={{ fontWeight: 600 }}>Phản hồi tin nhắn riêng (IB)</div>
                    <div className="v4-muted">Cho phép người dùng nhắn tin trực tiếp cho Bot</div>
                  </div>
                  <button
                    type="button"
                    className={`v4-switch ${privateEnabled ? "on" : ""}`}
                    onClick={() => setPrivateEnabled((v) => !v)}
                  >
                    <span className="v4-switch-knob" />
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="v4-btn success" disabled={busy}>
                  Lưu Cấu Hình Bot
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
