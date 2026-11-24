import React, { useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { formatRelativeTimeVi } from "../http.js";

export default function OperationsTracker() {
  const {
    operations,
    clearOperations,
    retryOperation,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    setDetailBotId,
    setPage,
    notify,
  } = useControlCenter();

  const [filter, setFilter] = useState("all");
  const [copiedId, setCopiedId] = useState(null);

  const stats = useMemo(() => {
    let running = 0;
    let completed = 0;
    let failed = 0;
    let hotStandby = 0;

    for (const op of operations) {
      if (op.status === "in_progress" || op.status === "pending") running += 1;
      else if (op.status === "completed") completed += 1;
      else if (op.status === "failed") failed += 1;
      else if (op.status === "hot_standby") hotStandby += 1;
    }

    return { running, completed, failed, hotStandby, total: operations.length };
  }, [operations]);

  const filteredOps = useMemo(() => {
    return operations.filter((op) => {
      if (filter === "running") return op.status === "in_progress" || op.status === "pending";
      if (filter === "completed") return op.status === "completed";
      if (filter === "failed") return op.status === "failed";
      if (filter === "hot_standby") return op.status === "hot_standby";
      return true;
    });
  }, [operations, filter]);

  const copyOpId = (id) => {
    navigator.clipboard?.writeText(id).catch(() => {});
    setCopiedId(id);
    notify(`Đã sao chép mã ${id}`, "info");
    setTimeout(() => setCopiedId(null), 2500);
  };

  const renderTimeline = (op) => {
    const isStop = op.action === "stop" || op.action === "shutdown";
    const isStandby = op.action === "hot_standby" || op.action === "standby";
    const isBulk = op.action?.startsWith("bulk_");

    const phase2Label = isStop ? "Đang Dừng (Stopping)" : isStandby ? "Chờ Nóng (Standby)" : "Đang Kết Nối (Connecting)";
    const phase3Label = isStop ? "Đã Dừng (Stopped)" : isStandby ? "Sẵn Sàng Chờ (Standby Ready)" : "WS Sẵn Sàng (WS Ready)";

    // Phase 1: accepted
    const p1State = "completed"; // always reached if created
    // Phase 2: connecting / stopping / standby
    let p2State = "pending";
    if (op.phase === "connecting" || op.phase === "stopping" || op.phase === "standby") {
      p2State = op.status === "in_progress" ? "active" : "completed";
    } else if (op.phase === "ws_ready" || op.phase === "stopped" || op.phase === "completed") {
      p2State = "completed";
    } else if (op.phase === "error") {
      p2State = "failed";
    }

    // Phase 3: ws_ready / standby / completed
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
        {/* Step 1: Accepted */}
        <div className={`v4-timeline-node ${p1State}`}>
          <div className="v4-timeline-dot">✓</div>
          <div className="v4-timeline-label">
            <span className="v4-timeline-title">Tiếp nhận</span>
            <span className="v4-timeline-sub">accepted</span>
          </div>
        </div>

        <div className={`v4-timeline-line ${p2State}`} />

        {/* Step 2: Intermediate Action */}
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
            <span className="v4-timeline-title">{phase2Label}</span>
            <span className="v4-timeline-sub">{isStop ? "stopping" : isStandby ? "standby" : "connecting"}</span>
          </div>
        </div>

        <div className={`v4-timeline-line ${p3State}`} />

        {/* Step 3: Completion */}
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
            <span className="v4-timeline-title">{phase3Label}</span>
            <span className="v4-timeline-sub">{isStop ? "stopped" : isStandby ? "standby" : "ws_ready"}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="v4-operations-container">
      {/* 4 Stats Cards */}
      <div className="v4-grid-4">
        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Đang Thực Hiện</div>
          <div className="v4-kpi-value" style={{ color: "var(--warning)" }}>
            {stats.running} <span style={{ fontSize: 14, color: "var(--text-muted)" }}>tiến trình</span>
          </div>
          <div className="v4-muted v4-stat-sub">Đồng bộ socket thời gian thực</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Hoàn Thành Thành Công</div>
          <div className="v4-kpi-value" style={{ color: "var(--success)" }}>
            {stats.completed}
          </div>
          <div className="v4-muted v4-stat-sub">Các thao tác Bật / Dừng / Khởi động lại</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Chế Độ Chờ Nóng (Hot Standby)</div>
          <div className="v4-kpi-value" style={{ color: "var(--accent)" }}>
            {stats.hotStandby}
          </div>
          <div className="v4-muted v4-stat-sub">Sẵn sàng kích hoạt tức thì</div>
        </div>

        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Thất Bại Cần Xử Lý</div>
          <div className="v4-kpi-value" style={{ color: stats.failed > 0 ? "var(--danger)" : "var(--text-muted)" }}>
            {stats.failed}
          </div>
          <div className="v4-muted v4-stat-sub">Kèm hướng dẫn khắc phục tự động</div>
        </div>
      </div>

      {/* Main Operations Card */}
      <div className="v4-card">
        <div className="v4-card-header">
          <div>
            <h2>Theo Dõi Tiến Độ Thao Tác (Operations Tracker)</h2>
            <div className="v4-muted">
              Giám sát từng chu kỳ tác vụ với <code>operationId</code>, theo dõi timeline các pha và xem hướng dẫn xử lý sự cố.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {operations.length > 0 && (
              <button type="button" className="v4-btn sm" onClick={clearOperations}>
                🗑 Xóa Lịch Sử
              </button>
            )}
            <button type="button" className="v4-btn sm" onClick={() => setPage("overview")}>
              ← Quay lại Fleet
            </button>
          </div>
        </div>

        {/* Filter Chips */}
        <div className="v4-toolbar">
          <div className="v4-fleet-filter-chips">
            <button
              type="button"
              className={`v4-chip ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              Tất cả ({operations.length})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "running" ? "active" : ""}`}
              onClick={() => setFilter("running")}
            >
              🟡 Đang chạy ({stats.running})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "completed" ? "active" : ""}`}
              onClick={() => setFilter("completed")}
            >
              🟢 Thành công ({stats.completed})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "hot_standby" ? "active" : ""}`}
              onClick={() => setFilter("hot_standby")}
            >
              ⚡ Chờ nóng ({stats.hotStandby})
            </button>
            <button
              type="button"
              className={`v4-chip ${filter === "failed" ? "active" : ""}`}
              onClick={() => setFilter("failed")}
            >
              🔴 Thất bại ({stats.failed})
            </button>
          </div>
        </div>

        {/* Operations List */}
        <div className="v4-operations-list">
          {filteredOps.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 24px" }} className="v4-muted">
              <div style={{ fontSize: 36, marginBottom: 8 }}>📋</div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>Chưa có thao tác nào trong danh mục này</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>
                Khi bạn bấm nút Bật, Tắt, Chờ nóng hoặc thao tác hàng loạt, toàn bộ tiến trình sẽ hiển thị trực tiếp tại đây.
              </div>
            </div>
          ) : (
            filteredOps.map((op) => {
              const rel = formatRelativeTimeVi(op.startedAt);
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
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span className="v4-badge neutral v4-mono">
                        {op.id}
                        <button
                          type="button"
                          className="v4-icon-copy-btn"
                          onClick={() => copyOpId(op.id)}
                          title="Sao chép Operation ID"
                        >
                          {copiedId === op.id ? "✓" : "📋"}
                        </button>
                      </span>

                      <span style={{ fontWeight: 700, fontSize: 15 }}>
                        {op.action === "start"
                          ? "▶ Khởi động Bot"
                          : op.action === "stop"
                            ? "⏹ Dừng Bot"
                            : op.action === "restart"
                              ? "↻ Khởi động lại Bot"
                              : op.action === "hot_standby"
                                ? "⚡ Chuyển Chế Độ Chờ Nóng"
                                : op.action === "delete"
                                  ? "🗑 Xóa Bot"
                                  : op.action}
                      </span>

                      <span className="v4-muted">•</span>
                      <span style={{ fontWeight: 600 }}>{op.botName}</span>
                      {op.botId && !op.botId.startsWith("bulk_") && (
                        <span className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                          ({op.botId})
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {op.durationMs !== null && (
                        <span className="v4-badge neutral v4-mono">⏱ {op.durationMs}ms</span>
                      )}
                      <span className="v4-relative-time" title={rel.exactIso}>
                        🕒 {rel.relative}
                      </span>
                      {op.status === "completed" && <span className="v4-badge success">● Hoàn Thành</span>}
                      {op.status === "hot_standby" && <span className="v4-badge accent">● Chờ Nóng</span>}
                      {op.status === "in_progress" && <span className="v4-badge warning">● Đang Xử Lý...</span>}
                      {op.status === "failed" && <span className="v4-badge danger">● Thất Bại</span>}
                    </div>
                  </div>

                  {/* Timeline Stage Visualization */}
                  <div className="v4-op-timeline-wrap">{renderTimeline(op)}</div>

                  {/* Error & Smart Troubleshooting Recommendation */}
                  {op.status === "failed" && (
                    <div className="v4-troubleshooting-box">
                      <div className="v4-troubleshooting-head">
                        <strong>⚠️ Chi tiết lỗi:</strong> <code>{op.error}</code>
                      </div>
                      <div className="v4-troubleshooting-rec">
                        <span style={{ fontSize: 16 }}>💡</span>
                        <span>{op.recommendation || "Vui lòng kiểm tra lại tiến trình và thử lại."}</span>
                      </div>
                      <div className="v4-troubleshooting-actions">
                        {op.actionType === "qr_login" && (
                          <button
                            type="button"
                            className="v4-btn sm primary"
                            onClick={() => {
                              if (op.botId === "admin") setShowAdminRecovery(true);
                              else setCreateQrTargetBot({ mode: "relogin", botId: op.botId });
                            }}
                          >
                            ⚡ Quét Mã QR Ngay
                          </button>
                        )}
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => retryOperation(op.id)}
                        >
                          ↻ Thử Lại (Retry)
                        </button>
                        <button
                          type="button"
                          className="v4-btn sm"
                          onClick={() => setPage("logs")}
                        >
                          📜 Xem Live Logs
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
