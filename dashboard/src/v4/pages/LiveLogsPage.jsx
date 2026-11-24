import React, { useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { formatDateVi, v4Fetch } from "../http.js";

export default function LiveLogsPage() {
  const { logs, setLogs, metrics, socketConnected, notify } = useControlCenter();

  const [levelFilter, setLevelFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozenLogs, setFrozenLogs] = useState([]);

  const togglePause = () => {
    if (!paused) {
      setFrozenLogs(logs);
      setPaused(true);
    } else {
      setPaused(false);
    }
  };

  const activeLogs = paused ? frozenLogs : logs;

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activeLogs.filter((entry) => {
      const lv = String(entry.level || "INFO").toUpperCase();
      if (levelFilter !== "ALL" && !lv.includes(levelFilter)) return false;
      if (!q) return true;
      const msg = `${entry.message || ""} ${entry.component || entry.source || ""}`.toLowerCase();
      return msg.includes(q);
    });
  }, [activeLogs, levelFilter, query]);

  const handleReloadLogs = async () => {
    try {
      const res = await v4Fetch("/api/logs?limit=250");
      if (Array.isArray(res?.logs)) {
        setLogs(res.logs);
        notify("Đã tải lại 250 dòng nhật ký mới nhất.", "info");
      }
    } catch (err) {
      notify(err.message || "Không thể tải nhật ký", "error");
    }
  };

  const lanes = metrics?.lanes || metrics?.workloadLanes || null;

  return (
    <>
      {lanes && (
        <div className="v4-grid-4">
          {Object.entries(lanes).map(([laneName, laneStat]) => (
            <div key={laneName} className="v4-card">
              <div className="v4-muted" style={{ textTransform: "uppercase" }}>
                Luồng Xử Lý: {laneName}
              </div>
              <div className="v4-kpi-value" style={{ fontSize: 20 }}>
                {typeof laneStat === "object"
                  ? `${laneStat.active ?? 0} đang chạy`
                  : String(laneStat)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="v4-card">
        <div className="v4-card-header">
          <div>
            <h2>📜 Nhật Ký Hoạt Động Thời Gian Thực (Live Logs)</h2>
            <div className="v4-muted">
              Theo dõi mọi tin nhắn, lệnh và cảnh báo hệ thống trực tiếp trên Web thay thế hoàn toàn màn hình Terminal.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`v4-badge ${socketConnected ? "success" : "warning"}`}>
              {socketConnected ? "● Đang truyền trực tiếp" : "● Chế độ HTTP"}
            </span>
            <button type="button" className="v4-btn sm" onClick={togglePause}>
              {paused ? "▶ Tiếp tục cuộn" : "⏸ Tạm dừng màn hình"}
            </button>
            <button type="button" className="v4-btn sm" onClick={handleReloadLogs}>
              ↻ Làm mới
            </button>
            <button type="button" className="v4-btn sm" onClick={() => setLogs([])}>
              Xóa màn hình
            </button>
          </div>
        </div>

        <div className="v4-toolbar">
          <input
            className="v4-input"
            style={{ maxWidth: 340 }}
            placeholder="Lọc nội dung nhật ký, UID, tên lệnh..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="v4-select"
            style={{ width: 180 }}
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
          >
            <option value="ALL">Mọi mức độ ({activeLogs.length})</option>
            <option value="INFO">Thông tin (INFO)</option>
            <option value="WARN">Cảnh báo (WARN)</option>
            <option value="ERR">Lỗi (ERROR)</option>
          </select>
        </div>

        <div className="v4-log-box">
          {filteredLogs.length === 0 ? (
            <div className="v4-muted">Chưa có dòng nhật ký nào khớp bộ lọc...</div>
          ) : (
            filteredLogs.map((entry, idx) => {
              const lv = String(entry.level || "INFO").toUpperCase();
              const cls = lv.includes("ERR")
                ? "error"
                : lv.includes("WARN")
                  ? "warn"
                  : "";
              return (
                <div key={entry.id || idx} className={`v4-log-line ${cls}`}>
                  <span style={{ color: "#64748b" }}>
                    [{formatDateVi(entry.timestamp || entry.createdAt)}]
                  </span>{" "}
                  <strong style={{ color: cls === "error" ? "#f87171" : "#38bdf8" }}>
                    [{lv}]
                  </strong>{" "}
                  {entry.component && (
                    <span style={{ color: "#a78bfa" }}>({entry.component}) </span>
                  )}
                  <span>{entry.message || JSON.stringify(entry)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
