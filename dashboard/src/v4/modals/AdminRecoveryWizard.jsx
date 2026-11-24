import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { v4Fetch } from "../http.js";

const STATE_LABELS = {
  idle: "Sẵn sàng khởi tạo mã QR khôi phục",
  starting: "Đang kết nối máy chủ Zalo tạo mã QR...",
  generating: "Đang sinh ảnh mã QR...",
  waiting_scan: "Đang chờ điện thoại mở Zalo quét mã QR...",
  qr_ready: "Mã QR đã sẵn sàng — Hãy mở Zalo trên điện thoại để quét",
  scanned: "Đã quét mã! Hãy bấm 'Xác nhận đăng nhập' trên điện thoại...",
  scanned_waiting_confirm: "Đã quét mã! Hãy bấm 'Xác nhận đăng nhập' trên điện thoại...",
  uid_mismatch_confirm: "Phát hiện tài khoản Zalo khác với Admin cũ — Chờ bạn xác nhận",
  saving: "Đang mã hóa Cookie AES-256-GCM và khởi động lại Bot Admin...",
  completed: "Khôi phục Bot Admin thành công! Bot đã Online.",
  success: "Khôi phục Bot Admin thành công! Bot đã Online.",
  expired: "Mã QR đã hết hạn — Bấm 'Tạo Mã QR Mới' để quét lại.",
  cancelled: "Đã hủy phiên quét QR.",
  failed: "Phiên quét QR gặp lỗi — Bạn có thể tạo lại mã QR hoặc dán Cookie.",
  error: "Phiên quét QR gặp lỗi — Bạn có thể tạo lại mã QR hoặc dán Cookie.",
};

function resolveQrSrc(rec) {
  if (!rec) return "";
  const raw = rec.qrDataUrl || rec.qrImage || rec.qrBase64 || rec.image || "";
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  return `data:image/png;base64,${raw}`;
}

export default function AdminRecoveryWizard() {
  const {
    showAdminRecovery,
    setShowAdminRecovery,
    adminBot,
    bots,
    adminRecovery,
    setAdminRecovery,
    notify,
    refreshAll,
  } = useControlCenter();

  const [tab, setTab] = useState("qr");
  const [allowAccountChange, setAllowAccountChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tab 2: Manual Cookie / J2Team paste
  const [cookieText, setCookieText] = useState("");
  const [imei, setImei] = useState("");
  const [userAgent, setUserAgent] = useState("");

  // Tab 3: Swap Admin to healthy sub-bot
  const healthySubBots = useMemo(
    () => bots.filter((b) => !b.isMain && !b.cookieDead),
    [bots]
  );
  const [swapTargetId, setSwapTargetId] = useState("");

  useEffect(() => {
    if (!swapTargetId && healthySubBots.length > 0) {
      setSwapTargetId(healthySubBots[0].id);
    }
  }, [healthySubBots, swapTargetId]);

  useEffect(() => {
    if (!showAdminRecovery) return undefined;
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [showAdminRecovery]);

  const pollStatus = useCallback(async () => {
    try {
      const data = await v4Fetch("/api/system/admin-recovery");
      if (data && typeof data === "object") {
        setAdminRecovery(data);
      }
    } catch {
      // ignore transient poll error
    }
  }, [setAdminRecovery]);

  useEffect(() => {
    if (!showAdminRecovery || tab !== "qr") return undefined;
    pollStatus();
    const timer = setInterval(pollStatus, 1300);
    return () => clearInterval(timer);
  }, [showAdminRecovery, tab, pollStatus]);

  if (!showAdminRecovery) return null;

  const state = String(adminRecovery?.state || adminRecovery?.status || "idle").toLowerCase();
  const qrSrc = resolveQrSrc(adminRecovery);
  const expiresAtMs = adminRecovery?.expiresAt ? new Date(adminRecovery.expiresAt).getTime() : 0;
  const confirmExpiresMs = adminRecovery?.confirmExpiresAt
    ? new Date(adminRecovery.confirmExpiresAt).getTime()
    : 0;
  const remainSecs = expiresAtMs > nowMs ? Math.ceil((expiresAtMs - nowMs) / 1000) : null;
  const confirmRemainSecs =
    confirmExpiresMs > nowMs ? Math.ceil((confirmExpiresMs - nowMs) / 1000) : null;

  const handleStartQr = async () => {
    setBusy(true);
    try {
      const data = await v4Fetch("/api/system/admin-recovery/start", {
        method: "POST",
        body: {
          allowAccountChange,
          botId: adminBot?.id || "admin",
        },
      });
      if (data && typeof data === "object") {
        setAdminRecovery(data);
      }
      notify("Đã khởi tạo phiên quét mã QR Admin.", "info");
    } catch (err) {
      notify(err.message || "Không thể khởi tạo mã QR Admin", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmSwapUid = async () => {
    setBusy(true);
    try {
      const data = await v4Fetch("/api/system/admin-recovery/confirm-swap", {
        method: "POST",
        body: {},
      });
      if (data && typeof data === "object") {
        setAdminRecovery(data);
      }
      notify("Đã xác nhận đổi sang tài khoản Zalo Admin mới!", "success");
      await refreshAll();
    } catch (err) {
      notify(err.message || "Xác nhận đổi tài khoản thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleCancelQr = async () => {
    setBusy(true);
    try {
      const data = await v4Fetch("/api/system/admin-recovery/cancel", {
        method: "POST",
        body: {},
      });
      setAdminRecovery(data || { state: "idle" });
    } catch (err) {
      notify(err.message || "Hủy phiên QR thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveManualCookie = async (e) => {
    e.preventDefault();
    if (!cookieText.trim() || !imei.trim()) {
      notify("Vui lòng nhập đầy đủ Cookie (J2Team JSON hoặc chuỗi) và IMEI.", "error");
      return;
    }
    setBusy(true);
    const targetAdminId = adminBot?.id || "admin";
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(targetAdminId)}/credential`, {
        method: "PUT",
        body: {
          cookie: cookieText.trim(),
          imei: imei.trim(),
          userAgent: userAgent.trim() || undefined,
          isMain: true,
          startImmediately: true,
        },
      });
      await v4Fetch(`/api/bots/${encodeURIComponent(targetAdminId)}/actions/start`, {
        method: "POST",
        body: {},
      }).catch(() => {});
      notify("Đã nạp Cookie Admin mới và phát lệnh khởi động Bot Admin!", "success");
      setCookieText("");
      await refreshAll();
      setShowAdminRecovery(false);
    } catch (err) {
      notify(err.message || "Cập nhật Cookie Admin thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  const handlePromoteSubBot = async (e) => {
    e.preventDefault();
    if (!swapTargetId) {
      notify("Vui lòng chọn một Bot phụ đang hoạt động.", "error");
      return;
    }
    setBusy(true);
    try {
      await v4Fetch("/api/system/admin-bot/swap", {
        method: "POST",
        body: { targetBotId: swapTargetId, botId: swapTargetId },
      });
      notify(`Đã chuyển quyền Admin chính sang bot ${swapTargetId}!`, "success");
      await refreshAll();
      setShowAdminRecovery(false);
    } catch (err) {
      notify(err.message || "Chuyển quyền Admin thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v4-modal-backdrop" onClick={() => setShowAdminRecovery(false)}>
      <div className="v4-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="v4-card-header">
          <div>
            <h2> Trung Tâm Cứu Hộ & Đăng Nhập Lại Bot Admin</h2>
            <div className="v4-muted">
              Khôi phục Bot Admin từ xa 100% trên trình duyệt — không cần mở Terminal hay SSH vào máy chủ.
            </div>
          </div>
          <button type="button" className="v4-btn sm" onClick={() => setShowAdminRecovery(false)}>
            Đóng (ESC)
          </button>
        </div>

        <div className="v4-card" style={{ marginBottom: 14, padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <strong>Bot Admin hiện tại:</strong>{" "}
              <span>{adminBot ? `${adminBot.displayName} (UID: ${adminBot.uid})` : "Chưa khởi tạo (Sẽ tự tạo khi quét QR)"}</span>
            </div>
            <div>
              {adminBot && !adminBot.cookieDead && adminBot.wsConnected ? (
                <span className="v4-badge success">Đang Online bình thường</span>
              ) : (
                <span className="v4-badge danger">
                  {adminBot?.deadReason ? `Cần khôi phục: ${adminBot.deadReason}` : "Cookie hết hạn / Chưa đăng nhập"}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="v4-tabs">
          <button
            type="button"
            className={`v4-tab ${tab === "qr" ? "active" : ""}`}
            onClick={() => setTab("qr")}
          >
            1. Quét Mã QR Zalo Trực Tiếp (Khuyên dùng)
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "cookie" ? "active" : ""}`}
            onClick={() => setTab("cookie")}
          >
            2. Dán Cookie J2Team & IMEI
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "swap" ? "active" : ""}`}
            onClick={() => setTab("swap")}
          >
            3. Đảo Quyền Admin Sang Bot Phụ ({healthySubBots.length})
          </button>
        </div>

        {tab === "qr" && (
          <div>
            {state === "uid_mismatch_confirm" ? (
              <div className="v4-card highlight-danger" style={{ marginBottom: 14 }}>
                <h3 style={{ marginTop: 0, color: "#fca5a5" }}>
                  ⚠️ Cảnh Báo Bảo Vệ Tài Khoản: Zalo vừa quét khác với Admin cũ!
                </h3>
                <p style={{ margin: "8px 0 12px" }}>
                  Hệ thống phát hiện bạn vừa dùng một tài khoản Zalo mới để quét mã QR. Để tránh nhầm tài khoản, phiên đăng nhập đang được giữ tạm an toàn trong{" "}
                  <strong>{confirmRemainSecs !== null ? `${confirmRemainSecs} giây` : "60 giây"}</strong>.
                </p>
                <div className="v4-grid-2" style={{ marginBottom: 14 }}>
                  <div className="v4-card">
                    <div className="v4-muted">Tài khoản Admin cũ</div>
                    <div style={{ fontWeight: 700, fontSize: 15, marginTop: 4 }}>
                      {adminBot?.displayName || "Bot Admin Cũ"}
                    </div>
                    <div className="v4-mono v4-muted">
                      UID: {adminRecovery?.previousUid || adminBot?.uid || "--"}
                    </div>
                  </div>
                  <div className="v4-card highlight-admin">
                    <div className="v4-muted">Tài khoản Zalo vừa quét QR</div>
                    <div style={{ fontWeight: 700, fontSize: 15, marginTop: 4 }}>
                      {adminRecovery?.scannedDisplayName || "Tài khoản Zalo mới"}
                    </div>
                    <div className="v4-mono v4-muted">
                      UID: {adminRecovery?.scannedUid || "--"}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="v4-btn success"
                    disabled={busy}
                    onClick={handleConfirmSwapUid}
                  >
                    ✓ Xác nhận đổi sang Zalo Admin mới này
                  </button>
                  <button
                    type="button"
                    className="v4-btn danger"
                    disabled={busy}
                    onClick={handleCancelQr}
                  >
                    ✕ Hủy & Quét lại bằng đúng Zalo cũ
                  </button>
                </div>
              </div>
            ) : (
              <div className="v4-qr-stage">
                <div className="v4-qr-box">
                  {qrSrc ? (
                    <img src={qrSrc} alt="Mã QR Khôi Phục Bot Admin" />
                  ) : state === "completed" || state === "success" ? (
                    <div style={{ color: "#059669", fontWeight: 800, textAlign: "center", padding: 12 }}>
                      <div style={{ fontSize: 42 }}>✓</div>
                      <div>ĐÃ KẾT NỐI ONLINE</div>
                    </div>
                  ) : (
                    <div style={{ color: "#334155", textAlign: "center", padding: 14, fontWeight: 600 }}>
                      Bấm nút <strong>“Lấy Mã QR Đăng Nhập”</strong> bên phải để hiển thị mã QR tại đây
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ marginBottom: 10 }}>
                    <span
                      className={`v4-badge ${
                        state === "completed" || state === "success"
                          ? "success"
                          : state === "failed" || state === "error" || state === "expired"
                            ? "danger"
                            : "info"
                      }`}
                    >
                      {STATE_LABELS[state] || adminRecovery?.message || state}
                    </span>
                    {remainSecs !== null && (state === "waiting_scan" || state === "qr_ready") && (
                      <span className="v4-badge warning" style={{ marginLeft: 8 }}>
                        Còn {remainSecs}s
                      </span>
                    )}
                  </div>

                  {adminRecovery?.error && (
                    <div className="v4-muted" style={{ color: "#fca5a5", marginBottom: 10 }}>
                      Chi tiết lỗi: {adminRecovery.error}
                    </div>
                  )}

                  <ol style={{ margin: "0 0 14px", paddingLeft: 18, color: "var(--text-muted)", fontSize: 13 }}>
                    <li>Bấm nút <strong>Lấy Mã QR Đăng Nhập</strong> để máy chủ tạo mã QR trực tiếp từ Zalo Web.</li>
                    <li>Mở ứng dụng <strong>Zalo</strong> trên điện thoại → chọn biểu tượng <strong>Quét mã QR</strong> ở góc trên bên phải.</li>
                    <li>Quét mã trên màn hình và bấm <strong>Đăng nhập</strong> trên điện thoại. Hệ thống sẽ tự động lấy Cookie + IMEI mới, mã hóa lưu DB và bật lại Bot Admin ngay lập tức!</li>
                  </ol>

                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 14,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={allowAccountChange}
                      onChange={(e) => setAllowAccountChange(e.target.checked)}
                    />
                    <span>Cho phép đổi luôn sang tài khoản Zalo Admin mới (nếu quét Zalo khác UID cũ)</span>
                  </label>

                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="v4-btn primary"
                      disabled={busy}
                      onClick={handleStartQr}
                    >
                      {busy
                        ? "Đang khởi tạo..."
                        : qrSrc
                          ? "↻ Tạo Lại Mã QR Mới"
                          : "⚡ Lấy Mã QR Đăng Nhập"}
                    </button>

                    {(state === "waiting_scan" ||
                      state === "qr_ready" ||
                      state === "scanned" ||
                      state === "scanned_waiting_confirm") && (
                      <button
                        type="button"
                        className="v4-btn"
                        disabled={busy}
                        onClick={handleCancelQr}
                      >
                        Hủy phiên quét
                      </button>
                    )}

                    {(state === "completed" || state === "success") && (
                      <button
                        type="button"
                        className="v4-btn success"
                        onClick={() => setShowAdminRecovery(false)}
                      >
                        Hoàn tất & Quay lại Dashboard
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "cookie" && (
          <form onSubmit={handleSaveManualCookie}>
            <div className="v4-field">
              <label>Cookie Zalo (Hỗ trợ JSON xuất từ J2Team Cookies hoặc chuỗi cookie thô)</label>
              <textarea
                className="v4-textarea mono"
                rows={5}
                placeholder='{"url":"https://chat.zalo.me","cookies":[...]} hoặc zpw_sek=...;'
                value={cookieText}
                onChange={(e) => setCookieText(e.target.value)}
              />
            </div>
            <div className="v4-grid-2">
              <div className="v4-field">
                <label>IMEI thiết bị Zalo Web (`z_uuid`)</label>
                <input
                  className="v4-input v4-mono"
                  placeholder="Ví dụ: 8f4a2b1c-...-Windows_Chrome"
                  value={imei}
                  onChange={(e) => setImei(e.target.value)}
                />
              </div>
              <div className="v4-field">
                <label>User-Agent trình duyệt (Tùy chọn — bỏ trống sẽ tự nhận)</label>
                <input
                  className="v4-input"
                  placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."
                  value={userAgent}
                  onChange={(e) => setUserAgent(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="submit" className="v4-btn success" disabled={busy}>
                {busy ? "Đang nạp Cookie..." : "Lưu Cookie Mã Hóa & Khởi Động Lại Bot Admin"}
              </button>
            </div>
          </form>
        )}

        {tab === "swap" && (
          <form onSubmit={handlePromoteSubBot}>
            {healthySubBots.length === 0 ? (
              <div className="v4-card">
                <div className="v4-muted">
                  Hiện không có Bot phụ nào đang có Cookie sống để đảo quyền. Hãy sử dụng Tab 1 (Quét Mã QR Zalo) hoặc tạo một Bot mới trước.
                </div>
              </div>
            ) : (
              <>
                <div className="v4-field">
                  <label>Chọn Bot phụ đang hoạt động để thăng cấp thành Bot Admin chính</label>
                  <select
                    className="v4-select"
                    value={swapTargetId}
                    onChange={(e) => setSwapTargetId(e.target.value)}
                  >
                    {healthySubBots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.displayName} — UID: {b.uid} ({b.wsConnected ? "Đang Online" : b.status})
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="submit" className="v4-btn warning" disabled={busy}>
                    {busy ? "Đang chuyển quyền..." : "Chuyển Quyền Bot Admin Ngay"}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
