import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatDateVi, formatExpiryVi, v4Fetch } from "../../v4/http.js";

const PORTAL_SHIELD_DEFS = [
  { key: "activeBot", label: "Kích Hoạt Bot Trong Nhóm" },
  { key: "onlyAdminBox", label: "Chỉ QTV Nhóm Dùng Lệnh" },
  { key: "sendTask", label: "Nhận Lịch Chúc Tự Động 24h" },
  { key: "antiSpam", label: "1. Chống Spam Tin Nhắn" },
  { key: "filterBadWords", label: "2. Lọc Từ Ngữ Thô Tục" },
  { key: "removeLinks", label: "3. Tự Động Xóa Link Lạ" },
  { key: "antiLink", label: "4. Chặn Quảng Cáo Link" },
  { key: "antiMention", label: "5. Chống Tag All (@All)" },
  { key: "antiUndo", label: "6. Chống Thu Hồi Tin Nhắn" },
  { key: "antiMedia", label: "7. Kiểm Soát Ảnh / Video" },
  { key: "antiSticker", label: "8. Chống Spam Sticker" },
  { key: "antiNude", label: "9. Chặn Ảnh Nhạy Cảm" },
  { key: "antiForward", label: "10. Chặn Chuyển Tiếp Tin" },
  { key: "antiVoice", label: "11. Chặn Tin Nhắn Thoại" },
  { key: "antiFile", label: "12. Chặn File Nguy Hiểm" },
  { key: "antiCard", label: "13. Chặn Rải Danh Thiếp" },
  { key: "antiBot", label: "14. Chống Bot Lạ Vào Phá" },
  { key: "antiJoinLeave", label: "15. Ẩn Thông Báo Ra/Vào" },
  { key: "antiKickBlock", label: "16. Bảo Vệ Chống Kick" },
  { key: "onlyText", label: "17. Chỉ Cho Phép Chat Chữ" },
];

function computeRemainingCountdown(expiry) {
  if (!expiry || expiry === "Never" || expiry === "permanent" || expiry === "-1" || expiry === -1) {
    return { text: "Vĩnh viễn", tone: "success" };
  }
  const rawIso = typeof expiry === "object" ? expiry.at : expiry;
  const ms = Date.parse(rawIso) - Date.now();
  if (Number.isNaN(ms)) return { text: formatExpiryVi(expiry), tone: "info" };
  if (ms <= 0) return { text: "Đã hết hạn — Cần nạp Giftcode", tone: "danger" };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return { text: `Còn ${hours} giờ`, tone: "warning" };
  const days = Math.floor(hours / 24);
  return {
    text: `Còn ${days} ngày ${hours % 24}h`,
    tone: days <= 3 ? "warning" : "success",
  };
}

function resolveQrImageSrc(qrObj) {
  const raw = qrObj?.qrDataUrl || qrObj?.qrImage || qrObj?.qrBase64 || qrObj?.image || "";
  if (!raw) return "";
  return raw.startsWith("data:image/") ? raw : `data:image/png;base64,${raw}`;
}

export default function TenantOwnerPortal({ onEnterWorkspace }) {
  const {
    portalSession,
    portalLogout,
    v5Fetch,
    bots = [],
    enrichedFleet = [],
    logs = [],
    theme,
    setTheme,
    notify,
    refreshV5,
  } = useV5();

  const user = portalSession?.user || portalSession || {};
  const role = user.role || "bot_owner";
  const token = portalSession?.token || "";

  const [portalBots, setPortalBots] = useState([]);
  const [activeTab, setActiveTab] = useState("bots"); // 'bots' | 'voucher' | 'shields' | 'logs'
  const [selectedBotId, setSelectedBotId] = useState("");
  const [loadingBots, setLoadingBots] = useState(false);

  // QR Modal state
  const [qrTargetBotId, setQrTargetBotId] = useState("");
  const [qrState, setQrState] = useState(null);
  const [startingQr, setStartingQr] = useState(false);

  // Giftcode Redemption state
  const [voucherCode, setVoucherCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [lastRedeemInfo, setLastRedeemInfo] = useState(null);

  // Prefix & 17 Shields state
  const [prefixInput, setPrefixInput] = useState("!");
  const [groups, setGroups] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [groupSettings, setGroupSettings] = useState({});
  const [savingConfig, setSavingConfig] = useState(false);

  // Scoped Logs state
  const [botLogs, setBotLogs] = useState([]);
  const [logQuery, setLogQuery] = useState("");

  // Authenticated portal helper supporting both v5Fetch and Bearer/cookie endpoints
  const portalCall = useCallback(
    async (subPath, options = {}) => {
      const headers = {
        ...(options.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      if (typeof v5Fetch === "function") {
        try {
          return await v5Fetch(subPath, { ...options, headers });
        } catch (err) {
          if (err && err.status === 404 && !err.code && !subPath.startsWith("/api/")) {
            return v4Fetch(`/api/v5${subPath.startsWith("/") ? subPath : `/${subPath}`}`, {
              ...options,
              headers,
            });
          }
          throw err;
        }
      }
      const url = subPath.startsWith("/api/") || subPath.startsWith("/v5-auth")
        ? subPath
        : `/api/v5${subPath.startsWith("/") ? subPath : `/${subPath}`}`;
      return v4Fetch(url, { ...options, headers });
    },
    [v5Fetch, token]
  );

  // Load Tenant's Rented Bots
  const loadMyBots = useCallback(async () => {
    setLoadingBots(true);
    try {
      let fetched = null;
      try {
        fetched = await portalCall("/bots");
      } catch {
        try {
          fetched = await portalCall("/me");
        } catch {
          fetched = null;
        }
      }

      const rawList = Array.isArray(fetched)
        ? fetched
        : Array.isArray(fetched?.bots)
          ? fetched.bots
          : Array.isArray(portalSession?.bots)
            ? portalSession.bots
            : [];

      if (rawList.length > 0) {
        setPortalBots(rawList);
        setSelectedBotId((curr) =>
          curr && rawList.some((b) => (b.id || b.botId) === curr)
            ? curr
            : String(rawList[0].id || rawList[0].botId)
        );
        return;
      }

      // Filter from enrichedFleet / bots by allowedBotIds / allowedBots or ownerUid
      const sourceFleet = enrichedFleet?.length ? enrichedFleet : bots;
      const allowedArr = Array.isArray(user.allowedBotIds)
        ? user.allowedBotIds
        : Array.isArray(user.allowedBots)
          ? user.allowedBots
          : [];
      const allowedSet = new Set(allowedArr);
      const filtered = sourceFleet.filter(
        (b) =>
          allowedSet.has("*") ||
          allowedSet.has(b.id) ||
          (user.ownerUid && String(b.ownerUid) === String(user.ownerUid))
      );
      setPortalBots(filtered);
      if (filtered.length > 0) {
        setSelectedBotId((curr) => curr || filtered[0].id);
      }
    } finally {
      setLoadingBots(false);
    }
  }, [portalCall, portalSession?.bots, enrichedFleet, bots, user.allowedBots, user.ownerUid]);

  useEffect(() => {
    loadMyBots();
  }, [loadMyBots]);

  const activeBot = useMemo(
    () =>
      portalBots.find((b) => String(b.id || b.botId) === selectedBotId) ||
      portalBots[0] ||
      null,
    [portalBots, selectedBotId]
  );

  useEffect(() => {
    if (activeBot) {
      setPrefixInput(activeBot.prefix || "!");
    }
  }, [activeBot]);

  // Load Groups for Selected Rented Bot
  const loadBotGroups = useCallback(
    async (botId) => {
      if (!botId) return;
      try {
        let res = null;
        try {
          res = await portalCall(`/portal/bots/${encodeURIComponent(botId)}/groups`);
        } catch {
          res = await portalCall(`/api/bots/${encodeURIComponent(botId)}/groups`);
        }
        const list = Array.isArray(res) ? res : Array.isArray(res?.groups) ? res.groups : [];
        setGroups(list);
        if (list.length > 0) {
          const gid = String(list[0].threadId || list[0].id);
          setSelectedThreadId((curr) => curr || gid);
        }
      } catch {
        setGroups([]);
      }
    },
    [portalCall]
  );

  // Load Scoped Logs for Selected Rented Bot
  const loadScopedLogs = useCallback(
    async (botId) => {
      if (!botId) return;
      try {
        let res = null;
        try {
          res = await portalCall(`/portal/bots/${encodeURIComponent(botId)}/logs`);
        } catch {
          res = await portalCall(`/api/logs?botId=${encodeURIComponent(botId)}&limit=150`);
        }
        const list = Array.isArray(res) ? res : Array.isArray(res?.logs) ? res.logs : [];
        setBotLogs(list);
      } catch {
        setBotLogs(logs.filter((l) => l.botId === botId));
      }
    },
    [portalCall, logs]
  );

  useEffect(() => {
    const bid = String(activeBot?.id || activeBot?.botId || "");
    if (!bid) return;
    if (activeTab === "shields") loadBotGroups(bid);
    if (activeTab === "logs") loadScopedLogs(bid);
  }, [activeBot, activeTab, loadBotGroups, loadScopedLogs]);

  const currentGroup = useMemo(
    () => groups.find((g) => String(g.threadId || g.id) === selectedThreadId) || null,
    [groups, selectedThreadId]
  );

  useEffect(() => {
    if (!currentGroup) {
      setGroupSettings({});
      return;
    }
    const raw = currentGroup.settings || {};
    const next = {};
    for (const s of PORTAL_SHIELD_DEFS) {
      next[s.key] = Boolean(
        s.key === "activeBot"
          ? raw.activeBot ?? raw.enableBot ?? currentGroup.activeBot
          : raw[s.key] ?? currentGroup[s.key]
      );
    }
    setGroupSettings(next);
  }, [currentGroup]);

  // Poll QR Session while modal open
  useEffect(() => {
    if (!qrTargetBotId) return undefined;
    const poll = async () => {
      try {
        let st = null;
        try {
          st = await portalCall(`/bots/${encodeURIComponent(qrTargetBotId)}/qr`);
        } catch {
          st = await portalCall(`/api/bots/${encodeURIComponent(qrTargetBotId)}/qr-login`);
        }
        if (st) {
          setQrState(st);
          const s = String(st.state || st.status || "").toLowerCase();
          if (s === "completed" || s === "success" || s === "configured") {
            notify("Đăng nhập QR Zalo cho Bot thành công!", "success");
            loadMyBots();
          }
        }
      } catch {}
    };
    const timer = setInterval(poll, 1600);
    return () => clearInterval(timer);
  }, [qrTargetBotId, portalCall, notify, loadMyBots]);

  const handleStartBotQr = async (botId) => {
    setQrTargetBotId(botId);
    setStartingQr(true);
    try {
      let res = null;
      try {
        res = await portalCall(`/bots/${encodeURIComponent(botId)}/qr/start`, {
          method: "POST",
          body: {},
        });
      } catch {
        res = await portalCall(`/api/bots/${encodeURIComponent(botId)}/actions/qr-login`, {
          method: "POST",
          body: {},
        });
      }
      setQrState(res || { state: "waiting_scan" });
      notify("Đã khởi tạo mã QR — Hãy mở Zalo trên điện thoại để quét!", "info");
    } catch (err) {
      notify(err.message || "Không thể khởi tạo mã QR", "error");
    } finally {
      setStartingQr(false);
    }
  };

  // Redeem Giftcode Voucher
  const handleRedeemVoucher = async (e) => {
    e.preventDefault();
    const code = voucherCode.trim().toUpperCase();
    if (!code) {
      notify("Vui lòng nhập mã Giftcode cần kích hoạt.", "error");
      return;
    }
    const targetBotId = String(activeBot?.id || activeBot?.botId || selectedBotId || "");
    setRedeeming(true);
    try {
      let res = null;
      try {
        res = await portalCall("/crm/vouchers/redeem", {
          method: "POST",
          body: {
            code,
            voucherCode: code,
            botId: targetBotId || undefined,
            ownerUid: user.ownerUid || undefined,
          },
        });
      } catch {
        const rawResp = await fetch("/v5-auth/redeem-voucher", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
          body: JSON.stringify({
            code,
            voucherCode: code,
            botId: targetBotId || undefined,
            ownerUid: user.ownerUid || undefined,
          }),
        });
        const parsed = await rawResp.json().catch(() => ({}));
        if (!rawResp.ok) {
          throw new Error(parsed?.error?.message || parsed?.message || "Mã Giftcode không hợp lệ hoặc đã sử dụng");
        }
        res = parsed?.data || parsed;
      }

      setLastRedeemInfo(res);
      setVoucherCode("");
      notify("🎉 Đã kích hoạt mã Giftcode & cộng thêm thời hạn sử dụng Bot!", "success");
      await loadMyBots();
      await refreshV5?.();
    } catch (err) {
      notify(err.message || "Kích hoạt Giftcode thất bại", "error");
    } finally {
      setRedeeming(false);
    }
  };

  // Save Prefix
  const handleSavePrefix = async (e) => {
    e.preventDefault();
    const bid = String(activeBot?.id || activeBot?.botId || "");
    if (!bid) return;
    setSavingConfig(true);
    try {
      try {
        await portalCall(`/portal/bots/${encodeURIComponent(bid)}/settings`, {
          method: "PUT",
          body: { prefix: prefixInput.trim() || "!" },
        });
      } catch {
        await portalCall(`/api/bots/${encodeURIComponent(bid)}/settings`, {
          method: "PUT",
          body: { prefix: prefixInput.trim() || "!" },
        });
      }
      notify(`Đã đổi Prefix lệnh thành "${prefixInput.trim() || "!"}"!`, "success");
      await loadMyBots();
    } catch (err) {
      notify(err.message || "Đổi Prefix thất bại", "error");
    } finally {
      setSavingConfig(false);
    }
  };

  // Toggle Group Shield
  const handleTogglePortalShield = async (key) => {
    const bid = String(activeBot?.id || activeBot?.botId || "");
    if (!bid || !selectedThreadId) return;
    const nextVal = !groupSettings[key];
    const updated = {
      ...groupSettings,
      [key]: nextVal,
      ...(key === "activeBot" ? { enableBot: nextVal } : {}),
    };
    setGroupSettings(updated);
    try {
      try {
        await portalCall(
          `/portal/bots/${encodeURIComponent(bid)}/groups/${encodeURIComponent(selectedThreadId)}/settings`,
          { method: "PUT", body: { settings: updated, ...updated } }
        );
      } catch {
        await portalCall(
          `/api/bots/${encodeURIComponent(bid)}/groups/${encodeURIComponent(selectedThreadId)}/settings`,
          { method: "PUT", body: { settings: updated, ...updated } }
        );
      }
      notify(`Đã cập nhật "${key}"!`, "success");
    } catch (err) {
      notify(err.message || "Cập nhật khiên thất bại", "error");
    }
  };

  const filteredLogs = useMemo(() => {
    const q = logQuery.trim().toLowerCase();
    if (!q) return botLogs;
    return botLogs.filter((l) => JSON.stringify(l).toLowerCase().includes(q));
  }, [botLogs, logQuery]);

  const qrImgSrc = resolveQrImageSrc(qrState);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-base)", color: "var(--text)" }}>
      {/* Self-Service Portal Topbar */}
      <header className="v4-topbar" style={{ position: "sticky", top: 0, zIndex: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="v4-brand-logo">M5</span>
          <div>
            <h1 style={{ margin: 0, fontSize: 18 }}>
              Cổng Tự Phục Vụ Khách Thuê & Đại Lý (Tenant Self-Service)
            </h1>
            <div className="v4-muted" style={{ fontSize: 12 }}>
              Xin chào <strong>{user.displayName || user.name || user.username || "Khách thuê"}</strong>{" "}
              •{" "}
              <span className={`v4-badge ${role === "reseller" ? "warning" : "success"}`}>
                {role === "reseller" ? "👑 Đại Lý Phân Phối" : "🎫 Chủ Thuê Bot"}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {role === "reseller" && typeof onEnterWorkspace === "function" && (
            <button type="button" className="v4-btn sm primary" onClick={onEnterWorkspace}>
              🖥️ Mở Bảng Điều Khiển Đại Lý V5
            </button>
          )}
          <button type="button" className="v4-btn sm" onClick={loadMyBots}>
            ↻ Đồng bộ Bot
          </button>
          <button
            type="button"
            className="v4-btn sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀️ Giao diện Sáng" : "🌙 Giao diện Tối"}
          </button>
          <button type="button" className="v4-btn sm danger" onClick={portalLogout}>
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="v4-content" style={{ maxWidth: 1280 }}>
        {/* Navigation Tabs */}
        <div className="v4-card" style={{ padding: "12px 16px" }}>
          <div className="v4-tabs" style={{ marginBottom: 0, borderBottom: "none", paddingBottom: 0 }}>
            <button
              type="button"
              className={`v4-tab ${activeTab === "bots" ? "active" : ""}`}
              onClick={() => setActiveTab("bots")}
            >
              🤖 Bot Đang Thuê Của Tôi ({portalBots.length})
            </button>
            <button
              type="button"
              className={`v4-tab ${activeTab === "voucher" ? "active" : ""}`}
              onClick={() => setActiveTab("voucher")}
            >
              🎁 Nhập Mã Giftcode Gia Hạn
            </button>
            <button
              type="button"
              className={`v4-tab ${activeTab === "shields" ? "active" : ""}`}
              onClick={() => setActiveTab("shields")}
            >
              🛡️ Chỉnh Prefix & 17 Khiên Nhóm
            </button>
            <button
              type="button"
              className={`v4-tab ${activeTab === "logs" ? "active" : ""}`}
              onClick={() => setActiveTab("logs")}
            >
              📜 Xem Nhật Ký Hoạt Động Riêng
            </button>
          </div>
        </div>

        {/* =================================================================
            PORTAL TAB 1: MY RENTED BOTS CARDS
           ================================================================= */}
        {activeTab === "bots" && (
          <div>
            {loadingBots ? (
              <div className="v4-card v4-muted">Đang tải danh sách Bot của bạn...</div>
            ) : portalBots.length === 0 ? (
              <div className="v4-card" style={{ textAlign: "center", padding: 36 }}>
                <h3>Bạn chưa có Bot nào đang gắn với tài khoản này</h3>
                <p className="v4-muted">
                  Nếu bạn có Mã Giftcode mới, hãy chuyển sang tab <strong>“Nhập Mã Giftcode Gia Hạn”</strong> để kích hoạt ngay!
                </p>
                <button
                  type="button"
                  className="v4-btn primary"
                  onClick={() => setActiveTab("voucher")}
                >
                  🎁 Nhập Mã Giftcode Ngay
                </button>
              </div>
            ) : (
              <div className="v4-grid-2">
                {portalBots.map((b) => {
                  const bid = String(b.id || b.botId);
                  const online = Boolean(!b.cookieDead && (b.wsConnected || b.status === "online" || b.status === "running"));
                  const countdown = computeRemainingCountdown(b.expiryAt);
                  return (
                    <div key={bid} className="v4-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div className={`v4-avatar ${online ? "online" : b.cookieDead ? "dead" : ""}`}>
                            {b.avatar ? <img src={b.avatar} alt="" /> : (b.displayName || bid).slice(0, 1)}
                          </div>
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 16 }}>{b.displayName || bid}</div>
                            <div className="v4-muted v4-mono" style={{ fontSize: 12 }}>
                              Mã Bot: {bid} • Prefix: <strong>{b.prefix || "!"}</strong>
                            </div>
                          </div>
                        </div>

                        <span className={`v4-badge ${online ? "success" : b.cookieDead ? "danger" : "neutral"}`}>
                          ● {online ? "Đang Online" : b.cookieDead ? "Cần quét QR lại" : b.status || "Tạm dừng"}
                        </span>
                      </div>

                      <div
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          background: "var(--bg-input)",
                          border: "1px solid var(--border)",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <div className="v4-muted" style={{ fontSize: 11.5 }}>Hạn sử dụng thuê bao</div>
                          <strong className="v4-mono">{formatExpiryVi(b.expiryAt)}</strong>
                        </div>
                        <span className={`v4-badge ${countdown.tone}`}>{countdown.text}</span>
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="v4-btn sm primary"
                          onClick={() => handleStartBotQr(bid)}
                        >
                          📱 Quét QR Đăng Nhập Zalo
                        </button>
                        <button
                          type="button"
                          className="v4-btn sm success"
                          onClick={() => {
                            setSelectedBotId(bid);
                            setActiveTab("voucher");
                          }}
                        >
                          🎁 Nhập Giftcode Gia Hạn
                        </button>
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => {
                            setSelectedBotId(bid);
                            setActiveTab("shields");
                          }}
                        >
                          🛡️ Prefix & 17 Khiên
                        </button>
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => {
                            setSelectedBotId(bid);
                            setActiveTab("logs");
                          }}
                        >
                          📜 Nhật Ký
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* =================================================================
            PORTAL TAB 2: REDEEM VOUCHER / GIFTCODE
           ================================================================= */}
        {activeTab === "voucher" && (
          <div className="v4-card" style={{ maxWidth: 620, margin: "0 auto", width: "100%" }}>
            <div className="v4-card-header">
              <div>
                <h3>🎁 Kích Hoạt Mã Giftcode Gia Hạn Tự Động</h3>
                <div className="v4-muted">
                  Nhập mã Giftcode mua từ Quản trị viên hoặc Đại lý để cộng thêm ngày sử dụng ngay lập tức.
                </div>
              </div>
            </div>

            <form onSubmit={handleRedeemVoucher}>
              {portalBots.length > 0 && (
                <div className="v4-field">
                  <label>Chọn Bot muốn cộng thêm hạn dùng</label>
                  <select
                    className="v4-select"
                    value={selectedBotId}
                    onChange={(e) => setSelectedBotId(e.target.value)}
                  >
                    {portalBots.map((b) => {
                      const bid = String(b.id || b.botId);
                      return (
                        <option key={bid} value={bid}>
                          {b.displayName || bid} (Hạn hiện tại: {formatExpiryVi(b.expiryAt)})
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              <div className="v4-field">
                <label>Mã Giftcode (VD: VIP30D-XXXX-XXXX)</label>
                <input
                  className="v4-input v4-mono"
                  style={{ fontSize: 16, fontWeight: 700, letterSpacing: "0.06em" }}
                  placeholder="NHẬP MÃ GIFTCODE TẠI ĐÂY..."
                  value={voucherCode}
                  onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
                />
              </div>

              <button type="submit" className="v4-btn success" style={{ width: "100%", padding: "11px 16px" }} disabled={redeeming}>
                {redeeming ? "Đang kiểm tra & kích hoạt..." : "✨ Kích Hoạt Mã Giftcode Ngay"}
              </button>
            </form>

            {lastRedeemInfo && (
              <div className="v4-card highlight-admin" style={{ marginTop: 14, padding: 12 }}>
                <strong>✅ Gia hạn thành công!</strong>
                <div className="v4-muted" style={{ marginTop: 4 }}>
                  Hạn dùng mới: <strong className="v4-mono">{formatExpiryVi(lastRedeemInfo.expiryAt || lastRedeemInfo.newExpiryAt)}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================
            PORTAL TAB 3: PREFIX & 17 GROUP SHIELDS
           ================================================================= */}
        {activeTab === "shields" && (
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>🛡️ Cài Đặt Prefix & 17 Khiên Chống Phá Nhóm</h3>
                <div className="v4-muted">Tùy chỉnh riêng cho các Bot thuộc quyền sở hữu của bạn</div>
              </div>

              {portalBots.length > 1 && (
                <select
                  className="v4-select"
                  style={{ width: 220 }}
                  value={selectedBotId}
                  onChange={(e) => setSelectedBotId(e.target.value)}
                >
                  {portalBots.map((b) => {
                    const bid = String(b.id || b.botId);
                    return (
                      <option key={bid} value={bid}>
                        {b.displayName || bid}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>

            <form onSubmit={handleSavePrefix} className="v4-toolbar" style={{ marginBottom: 18 }}>
              <span style={{ fontWeight: 700 }}>Ký tự gọi lệnh (Prefix):</span>
              <input
                className="v4-input v4-mono"
                style={{ width: 90 }}
                maxLength={4}
                value={prefixInput}
                onChange={(e) => setPrefixInput(e.target.value)}
              />
              <button type="submit" className="v4-btn sm primary" disabled={savingConfig}>
                💾 Lưu Prefix
              </button>
            </form>

            <div className="v4-grid-2" style={{ gridTemplateColumns: "280px minmax(0, 1fr)" }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Nhóm của Bot ({groups.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 460, overflowY: "auto" }}>
                  {groups.length === 0 ? (
                    <div className="v4-muted">Chưa có nhóm hoặc Bot chưa đăng nhập Zalo.</div>
                  ) : (
                    groups.map((g) => {
                      const gid = String(g.threadId || g.id);
                      return (
                        <button
                          key={gid}
                          type="button"
                          className={`v4-nav-btn ${selectedThreadId === gid ? "active" : ""}`}
                          onClick={() => setSelectedThreadId(gid)}
                        >
                          <span>{g.name || `Nhóm ${gid}`}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div>
                {!selectedThreadId ? (
                  <div className="v4-muted" style={{ padding: 24 }}>
                    Chọn một nhóm bên trái để bật/tắt 17 khiên bảo vệ.
                  </div>
                ) : (
                  <div className="v4-grid-2">
                    {PORTAL_SHIELD_DEFS.map((sh) => (
                      <div key={sh.key} className="v4-switch-card">
                        <span style={{ fontWeight: 600 }}>{sh.label}</span>
                        <button
                          type="button"
                          className={`v4-switch ${groupSettings[sh.key] ? "on" : ""}`}
                          onClick={() => handleTogglePortalShield(sh.key)}
                        >
                          <span className="v4-switch-knob" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* =================================================================
            PORTAL TAB 4: SCOPED PRIVATE BOT LOGS
           ================================================================= */}
        {activeTab === "logs" && (
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>📜 Nhật Ký Hoạt Động Riêng ({activeBot?.displayName || selectedBotId})</h3>
                <div className="v4-muted">Chỉ hiển thị các sự kiện thuộc Bot thuê của bạn</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="v4-input"
                  style={{ width: 220 }}
                  placeholder="Tìm kiếm nhật ký..."
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                />
                <button
                  type="button"
                  className="v4-btn sm"
                  onClick={() => activeBot && loadScopedLogs(String(activeBot.id || activeBot.botId))}
                >
                  ↻ Làm mới
                </button>
              </div>
            </div>

            <div className="v4-log-box" style={{ height: 420 }}>
              {filteredLogs.length === 0 ? (
                <div className="v4-muted">Chưa có nhật ký hoạt động nào cho Bot này.</div>
              ) : (
                filteredLogs.map((entry, idx) => (
                  <div key={entry.id || idx} className="v4-log-line">
                    <span style={{ color: "#64748b" }}>
                      [{formatDateVi(entry.timestamp || entry.createdAt)}]
                    </span>{" "}
                    <strong style={{ color: "#38bdf8" }}>
                      [{String(entry.level || "INFO").toUpperCase()}]
                    </strong>{" "}
                    <span>{entry.message || JSON.stringify(entry)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>

      {/* QR Login Modal for Tenant Bot */}
      {qrTargetBotId && (
        <div className="v4-modal-backdrop" onClick={() => setQrTargetBotId("")}>
          <div className="v4-modal" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>📱 Quét Mã QR Đăng Nhập Zalo ({qrTargetBotId})</h3>
                <div className="v4-muted">Mở ứng dụng Zalo trên điện thoại → Quét QR → Bấm Xác nhận</div>
              </div>
              <button type="button" className="v4-btn sm" onClick={() => setQrTargetBotId("")}>
                ✕ Đóng
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 14 }}>
              <div className="v4-qr-box">
                {qrImgSrc ? (
                  <img src={qrImgSrc} alt="Zalo QR" />
                ) : (
                  <div style={{ color: "#334155", textAlign: "center", padding: 14, fontWeight: 600 }}>
                    {startingQr ? "Đang kết nối Zalo sinh mã QR..." : `Trạng thái: ${qrState?.state || "Đang chờ"}`}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="v4-btn primary"
                disabled={startingQr}
                onClick={() => handleStartBotQr(qrTargetBotId)}
              >
                ↻ Tạo Lại Mã QR Mới
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
