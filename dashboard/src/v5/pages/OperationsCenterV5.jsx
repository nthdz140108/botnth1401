import React, { useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatRelativeTimeVi } from "../../v4/http.js";

function formatActionTitle(action) {
  const act = String(action || "");
  if (act === "start") return "▶ Khởi động Bot";
  if (act === "resume") return "▶ Khôi phục từ Chờ Nóng";
  if (act === "stop" || act === "shutdown") return "⏹ Dừng Tiến Trình Bot";
  if (act === "restart") return "↻ Khởi động lại Bot";
  if (act === "hot_standby" || act === "standby") return "⚡ Chuyển Chế Độ Chờ Nóng";
  if (act === "admin_hot_swap") return "🔄 Hoán Đổi Primary Admin (HA Swap)";
  if (act.startsWith("bulk_")) return `📦 Thao tác hàng loạt (${act.replace("bulk_", "")})`;
  return act || "Tác vụ hệ thống";
}

function buildSmartRemediation(op) {
  const errLower = String(op.error || "").toLowerCase();
  if (
    op.actionType === "qr_login" ||
    errLower.includes("cookie") ||
    errLower.includes("qr") ||
    errLower.includes("hết hạn")
  ) {
    return {
      needQr: true,
      summary:
        op.recommendation ||
        "Phiên Cookie Zalo đã hết hạn hoặc mất xác thực. Hãy quét lại mã QR trên Web để khôi phục ngay.",
    };
  }
  if (errLower.includes("timeout") || errLower.includes("503") || errLower.includes("offline")) {
    return {
      needQr: false,
      summary:
        op.recommendation ||
        "Tiến trình thượng nguồn chưa sẵn sàng kết nối trong thời gian chờ. Bạn có thể bấm Thử Lại hoặc mở Live Logs kiểm tra.",
    };
  }
  return {
    needQr: Boolean(op.botId),
    summary:
      op.recommendation ||
      "Tiến trình gặp sự cố ngoài dự kiến. Hãy thử thực thi lại hoặc kiểm tra nhật ký trực tiếp.",
  };
}

export default function OperationsCenterV5() {
  const {
    serverOps,
    enrichedFleet,
    clearOperations,
    retryOperation,
    runBotAction,
    refreshV5,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    setSelectedBotId,
    setPage,
    notify,
  } = useV5();

  const [filter, setFilter] = useState("all");
  const [botFilter, setBotFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [syncing, setSyncing] = useState(false);

  const stats = useMemo(() => {
    let running = 0;
    let completed = 0;
    let hotStandby = 0;
    let failed = 0;

    for (const op of serverOps) {
      if (op.status === "in_progress" || op.status === "pending") running += 1;
      else if (op.status === "completed") completed += 1;
      else if (op.status === "hot_standby") hotStandby += 1;
      else if (op.status === "failed") failed += 1;
    }

    return { running, completed, hotStandby, failed, total: serverOps.length };
  }, [serverOps]);

  const filteredOps = useMemo(() => {
    const q = search.trim().toLowerCase();
    return serverOps.filter((op) => {
      if (filter === "running" && op.status !== "in_progress" && op.status !== "pending") return false;
      if (filter === "completed" && op.status !== "completed") return false;
      if (filter === "hot_standby" && op.status !== "hot_standby") return false;
      if (filter === "failed" && op.status !== "failed") return false;

      if (botFilter !== "all" && op.botId !== botFilter) return false;

      if (!q) return true;
      return (
        String(op.id || "").toLowerCase().includes(q) ||
        String(op.botName || "").toLowerCase().includes(q) ||
        String(op.botId || "").toLowerCase().includes(q) ||
        String(op.action || "").toLowerCase().includes(q) ||
        String(op.error || "").toLowerCase().includes(q)
      );
    });
  }, [serverOps, filter, botFilter, search]);

  const handleCopyOpId = (id) => {
    navigator.clipboard?.writeText(id).catch(() => {});
    setCopiedId(id);
    notify(`Đã sao chép mã tiến trình ${id}`, "info");
    setTimeout(() => setCopiedId(""), 2200);
  };

  const handleManualSync = async () => {
    setSyncing(true);
    try {
      await refreshV5();
    } finally {
      setTimeout(() => setSyncing(false), 250);
    }
  };

  const handleRetry = async (op) => {
    try {
      const retried = await retryOperation(op.id);
      if (retried === undefined && op.botId && !String(op.botId).startsWith("bulk_") && op.action) {
        await runBotAction(op.botId, op.action);
      }
    } catch {
      // handled by runBotAction toast
    }
  };

  const renderTimeline = (op) => {
    const isStop = op.action === "stop" || op.action === "shutdown";
    const isStandby = op.action === "hot_standby" || op.action === "standby";

    const stage2Sub = isStop ? "stopping" : isStandby ? "standby" : "connecting";
    const stage2Title = isStop
      ? "Đang Dừng (Stopping)"
      : isStandby
        ? "Chuyển Chờ Nóng (Standby)"
        : "Đang Kết Nối (Connecting)";

    const stage3Sub = isStop ? "stopped" : isStandby ? "ws_ready (standby)" : "ws_ready";
    const stage3Title = isStop
      ? "Đã Dừng An Toàn"
      : isStandby
        ? "Sẵn Sàng Kích Hoạt Tức Thì"
        : "WebSocket Sẵn Sàng (WS Ready)";

    const p1State = "completed";
    let p2State = "pending";
    if (op.phase === "connecting" || op.phase === "stopping" || op.phase === "standby") {
      p2State = op.status === "in_progress" ? "active" : "completed";
    } else if (op.phase === "ws_ready" || op.phase === "stopped" || op.phase === "completed" || op.status === "completed" || op.status === "hot_standby") {
      p2State = "completed";
    } else if (op.phase === "error" || op.status === "failed") {
      p2State = "failed";
    }

    let p3State = "pending";
    if (op.status === "completed" || op.status === "hot_standby") {
      p3State = "completed";
    } else if (op.status === "failed") {
      p3State = "failed";
    } else if (op.phase === "ws_ready") {
      p3State = "active";
    }

    return (
      <div className="v4-timeline-container">
        <div className={`v4-timeline-node ${p1State}`}>
          <div className="v4-timeline-dot">✓</div>
          <div className="v4-timeline-label">
            <span className="v4-timeline-title">1. Tiếp nhận lệnh</span>
            <span className="v4-timeline-sub">accepted</span>
          </div>
        </div>

        <div className={`v4-timeline-line ${p2State}`} />

        <div className={`v4-timeline-node ${p2State}`}>
          <div className="v4-timeline-dot">
            {p2State === "active" ? (
              <span className="v4-spinner-icon xs" />
            ) : p2State === "failed" ? (
              "✕"
            ) : (
              "✓"
            )}
          </div>
          <div className="v4-timeline-label">
            <span className="v4-timeline-title">2. {stage2Title}</span>
            <span className="v4-timeline-sub">{stage2Sub}</span>
          </div>
        </div>

        <div className={`v4-timeline-line ${p3State}`} />

        <div className={`v4-timeline-node ${p3State}`}>
          <div className="v4-timeline-dot">
            {p3State === "active" ? (
              <span className="v4-spinner-icon xs" />
            ) : p3State === "failed" ? (
              "✕"
            ) : (
              "✓"
            )}
          </div>
          <div className="v4-timeline-label">
            <span className="v4-timeline-title">3. {stage3Title}</span>
            <span className="v4-timeline-sub">{stage3Sub}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="v5-stack">
      {/* 4 KPI Cards */}
      <div className="v4-grid-4">
        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Tiến Trình Đang Xử Lý</div>
          <div className="v4-kpi-value v5-tabular" style={{ color: "var(--warning)" }}>
            {stats.running} <span style={{ fontSize: 14, color: "var(--text-muted)" }}>tác vụ</span>
          </div>
          <div className="v4-muted v4-stat-sub">Đồng bộ Client + Server Operations</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Hoàn Tất Thành Công</div>
          <div className="v4-kpi-value v5-tabular" style={{ color: "var(--success)" }}>
            {stats.completed}
          </div>
          <div className="v4-muted v4-stat-sub">Đạt pha cuối ws_ready / stopped</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Chờ Nóng (Hot Standby)</div>
          <div className="v4-kpi-value v5-tabular" style={{ color: "var(--accent)" }}>
            {stats.hotStandby}
          </div>
          <div className="v4-muted v4-stat-sub">Giữ tiến trình kích hoạt 0s</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Sự Cố Cần Khắc Phục</div>
          <div
            className="v4-kpi-value v5-tabular"
            style={{ color: stats.failed > 0 ? "var(--danger)" : "var(--text-muted)" }}
          >
            {stats.failed}
          </div>
          <div className="v4-muted v4-stat-sub">Tích hợp thẻ khắc phục nhanh 1-Click</div>
        </div>
      </div>

      {/* Operations Timeline & Troubleshooting Deck */}
      <div className="v4-card">
        <div className="v4-card-header">
          <div>
            <h2>📋 Trung Tâm Tiến Trình Vận Hành (Operations Center V5)</h2>
            <div className="v4-muted">
              Hợp nhất lịch sử thao tác trực tiếp trên trình duyệt và nhật ký tiến trình máy chủ (
              <code>GET /api/v5/operations</code>).
            </div>
          </div>

          <div className="v5-inline-actions">
            <button type="button" className="v4-btn sm" disabled={syncing} onClick={handleManualSync}>
              {syncing ? "Đang tải..." : "↻ Đồng bộ Server Ops"}
            </button>
            {serverOps.length > 0 && (
              <button type="button" className="v4-btn sm" onClick={clearOperations}>
                🗑 Dọn Tiến Trình Cũ
              </button>
            )}
            <button type="button" className="v4-btn sm" onClick={() => setPage("overview")}>
              ← Về Đội Hình Fleet
            </button>
          </div>
        </div>

        <div className="v4-toolbar" style={{ justifyContent: "space-between" }}>
          <div className="v4-fleet-filter-chips">
            {[
              { id: "all", label: `Tất cả (${stats.total})` },
              { id: "running", label: `🟡 Đang chạy (${stats.running})` },
              { id: "completed", label: `🟢 Thành công (${stats.completed})` },
              { id: "hot_standby", label: `⚡ Chờ nóng (${stats.hotStandby})` },
              { id: "failed", label: `🔴 Thất bại (${stats.failed})` },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                className={`v4-chip ${filter === item.id ? "active" : ""}`}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              className="v4-select"
              style={{ width: 200 }}
              value={botFilter}
              onChange={(e) => setBotFilter(e.target.value)}
            >
              <option value="all">Mọi Bot trong hệ thống</option>
              {enrichedFleet.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.displayName} ({b.id})
                </option>
              ))}
            </select>
            <input
              className="v4-input"
              style={{ width: 240 }}
              placeholder="Tìm mã operationId, tên lệnh..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="v4-operations-list">
          {filteredOps.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 20px" }} className="v4-muted">
              <div style={{ fontSize: 36, marginBottom: 8 }}>🧭</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>
                Chưa có tiến trình nào khớp bộ lọc hiện tại
              </div>
              <div style={{ marginTop: 4 }}>
                Mọi thao tác Bật, Tắt, Chờ nóng, Hoán đổi HA hoặc Tự phục hồi Auto-Heal sẽ hiển thị timeline 3 pha tại đây.
              </div>
            </div>
          ) : (
            filteredOps.map((op) => {
              const rel = formatRelativeTimeVi(op.startedAt);
              const remediation = op.status === "failed" ? buildSmartRemediation(op) : null;

              return (
                <div
                  key={op.id}
                  className={`v4-op-card ${
                    op.status === "failed"
                      ? "error"
                      : op.status === "in_progress"
                        ? "active"
                        : op.status === "hot_standby"
                          ? "standby"
                          : "success"
                  }`}
                >
                  <div className="v4-op-head">
                    <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                      <span className="v4-badge neutral v4-mono">
                        {op.id}
                        <button
                          type="button"
                          className="v4-icon-copy-btn"
                          onClick={() => handleCopyOpId(op.id)}
                          title="Sao chép mã operationId"
                        >
                          {copiedId === op.id ? "✓" : "📋"}
                        </button>
                      </span>

                      <span style={{ fontWeight: 700, fontSize: 14.5 }}>
                        {formatActionTitle(op.action)}
                      </span>

                      <span className="v4-muted">•</span>
                      <span style={{ fontWeight: 600 }}>{op.botName || op.botId}</span>
                      {op.source && (
                        <span className="v5-prov-badge global">
                          {op.source === "server" ? "Server" : op.source === "synced" ? "Synced" : "Live"}
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {op.durationMs !== undefined && op.durationMs !== null && (
                        <span className="v4-badge neutral v4-mono">⏱ {op.durationMs}ms</span>
                      )}
                      <span className="v4-relative-time" title={rel.exactIso}>
                        🕒 {rel.relative}
                      </span>
                      {op.status === "completed" && <span className="v4-badge success">● Hoàn Thành</span>}
                      {op.status === "hot_standby" && <span className="v4-badge accent">● Chờ Nóng</span>}
                      {(op.status === "in_progress" || op.status === "pending") && (
                        <span className="v4-badge warning">● Đang Xử Lý</span>
                      )}
                      {op.status === "failed" && <span className="v4-badge danger">● Thất Bại</span>}
                    </div>
                  </div>

                  {renderTimeline(op)}

                  {op.status === "failed" && remediation && (
                    <div className="v4-troubleshooting-box">
                      <div className="v4-troubleshooting-head">
                        <strong>⚠️ Nguyên nhân sự cố:</strong> <code>{op.error || "UNKNOWN_OPERATION_ERROR"}</code>
                      </div>
                      <div className="v4-troubleshooting-rec">
                        <span style={{ fontSize: 16 }}>💡</span>
                        <span>{remediation.summary}</span>
                      </div>
                      <div className="v4-troubleshooting-actions">
                        <button
                          type="button"
                          className="v4-btn sm primary"
                          onClick={() => {
                            if (!op.botId || op.botId === "admin") {
                              setShowAdminRecovery(true);
                            } else {
                              setCreateQrTargetBot({ mode: "relogin", botId: op.botId });
                            }
                          }}
                        >
                          ⚡ Quét QR Ngay
                        </button>
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => handleRetry(op)}
                        >
                          ↻ Thử Lại
                        </button>
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => {
                            if (op.botId && !String(op.botId).startsWith("bulk_")) {
                              setSelectedBotId(op.botId);
                            }
                            setPage("logs");
                          }}
                        >
                          📜 Xem Logs
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
