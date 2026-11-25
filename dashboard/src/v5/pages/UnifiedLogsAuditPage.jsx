import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatDateVi, v4Fetch } from "../../v4/http.js";

async function callV5(v5Fetch, subPath, options = {}) {
  const cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  if (typeof v5Fetch === "function") {
    try {
      return await v5Fetch(cleanSub, options);
    } catch (err) {
      if (err && err.status === 404 && !err.code) {
        return v4Fetch(`/api/v5${cleanSub}`, options);
      }
      throw err;
    }
  }
  return v4Fetch(`/api/v5${cleanSub}`, options);
}

const PINNED_LOGS_STORAGE_KEY = "mybot_v5_pinned_logs";
const WINDOW_STEP = 300;

function loadPinnedKeys() {
  try {
    const raw = localStorage.getItem(PINNED_LOGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 200) : [];
  } catch {
    return [];
  }
}

function getLogRowKey(entry, fallbackIdx) {
  if (entry?.id) return String(entry.id);
  const ts = entry?.timestamp || entry?.createdAt || "";
  const msg = String(entry?.message || entry?.text || "").slice(0, 48);
  return ts || msg ? `${ts}_${msg}` : `row_${fallbackIdx}`;
}

function triggerTextDownload(filename, content, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildCsvFromAudit(entries) {
  const headers = ["timestamp", "action", "actor", "botId", "commandName", "ipAddress", "changedPaths", "requestId"];
  const escapeCell = (val) => {
    const s = Array.isArray(val) ? val.join("; ") : String(val ?? "");
    return /[,"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const e of entries) {
    lines.push(
      [
        e.timestamp || e.createdAt || "",
        e.action || "",
        e.actor || e.username || "admin",
        e.botId || e.target || "",
        e.commandName || "",
        e.ipAddress || e.ip || "",
        e.changedPaths || e.changedKeys || [],
        e.requestId || "",
      ]
        .map(escapeCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export default function UnifiedLogsAuditPage() {
  const {
    bots = [],
    enrichedFleet = [],
    logs = [],
    setLogs,
    socketConnected,
    notify,
    v5Fetch,
  } = useV5();

  const botList = enrichedFleet?.length ? enrichedFleet : bots;
  const [tab, setTab] = useState("logs");

  // =========================================================================
  // SUB-TAB 1: LIVE STREAM LOGS STATE (WINDOWED + PINNABLE + INSPECTOR)
  // =========================================================================
  const [botFilter, setBotFilter] = useState("ALL");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [searchText, setSearchText] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [paused, setPaused] = useState(false);
  const [frozenLogs, setFrozenLogs] = useState([]);
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [pinnedKeys, setPinnedKeys] = useState(() => loadPinnedKeys());
  const [expandedLogKey, setExpandedLogKey] = useState("");
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // =========================================================================
  // SUB-TAB 2: AUDIT TRAIL EXPLORER STATE
  // =========================================================================
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditAction, setAuditAction] = useState("");
  const [auditActor, setAuditActor] = useState("");
  const [auditQuery, setAuditQuery] = useState("");
  const [auditLimit, setAuditLimit] = useState(200);
  const [expandedAuditIdx, setExpandedAuditIdx] = useState(-1);
  const [loadingAudit, setLoadingAudit] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(PINNED_LOGS_STORAGE_KEY, JSON.stringify(pinnedKeys.slice(0, 200)));
    } catch {}
  }, [pinnedKeys]);

  // Reset window slice when filters change
  useEffect(() => {
    setVisibleCount(WINDOW_STEP);
  }, [botFilter, severityFilter, searchText, useRegex, onlyPinned]);

  const togglePause = () => {
    if (!paused) {
      setFrozenLogs(logs);
      setPaused(true);
    } else {
      setPaused(false);
    }
  };

  const activeLogs = paused ? frozenLogs : logs;

  const compiledRegexInfo = useMemo(() => {
    if (!useRegex || !searchText.trim()) return { regex: null, error: "" };
    try {
      return { regex: new RegExp(searchText.trim(), "i"), error: "" };
    } catch (err) {
      return { regex: null, error: err.message || "Regex không hợp lệ" };
    }
  }, [useRegex, searchText]);

  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);

  const filteredLogs = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return activeLogs.filter((entry, idx) => {
      const rowKey = getLogRowKey(entry, idx);
      if (onlyPinned && !pinnedSet.has(rowKey)) return false;

      if (botFilter !== "ALL") {
        const entryBot = String(entry?.botId || entry?.botName || entry?.scope || "");
        if (entryBot && entryBot !== botFilter) return false;
        if (!entryBot && !JSON.stringify(entry).includes(botFilter)) return false;
      }

      const lv = String(entry?.level || entry?.severity || "INFO").toUpperCase();
      if (severityFilter !== "ALL") {
        if (severityFilter === "ERROR" && !lv.includes("ERR") && !lv.includes("FATAL")) return false;
        if (severityFilter === "WARN" && !lv.includes("WARN")) return false;
        if (severityFilter === "INFO" && (lv.includes("ERR") || lv.includes("WARN"))) return false;
      }

      if (!q) return true;
      const haystack = `${entry?.message || ""} ${entry?.component || entry?.source || ""} ${entry?.botId || ""} ${JSON.stringify(entry)}`;
      if (useRegex) {
        if (!compiledRegexInfo.regex) return true;
        return compiledRegexInfo.regex.test(haystack);
      }
      return haystack.toLowerCase().includes(q);
    });
  }, [activeLogs, onlyPinned, pinnedSet, botFilter, severityFilter, searchText, useRegex, compiledRegexInfo]);

  const visibleLogs = useMemo(
    () => filteredLogs.slice(0, visibleCount),
    [filteredLogs, visibleCount]
  );

  const togglePinLog = (rowKey, e) => {
    e.stopPropagation();
    setPinnedKeys((prev) =>
      prev.includes(rowKey) ? prev.filter((k) => k !== rowKey) : [rowKey, ...prev]
    );
  };

  const handleFetchServerLogs = async () => {
    setLoadingLogs(true);
    try {
      const qs = new URLSearchParams({ limit: "500" });
      if (botFilter !== "ALL") qs.set("botId", botFilter);
      if (severityFilter !== "ALL") qs.set("severity", severityFilter.toLowerCase());
      if (!useRegex && searchText.trim()) qs.set("search", searchText.trim());
      const res = await v4Fetch(`/api/logs?${qs.toString()}`);
      if (Array.isArray(res?.logs)) {
        setLogs(res.logs);
        if (paused) setFrozenLogs(res.logs);
        notify(`Đã nạp ${res.logs.length} dòng nhật ký từ máy chủ.`, "info");
      }
    } catch (err) {
      notify(err.message || "Tải nhật ký thất bại", "error");
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleDownloadJsonl = () => {
    if (filteredLogs.length === 0) {
      notify("Không có dòng nhật ký nào để xuất tệp .jsonl.", "warning");
      return;
    }
    const content = filteredLogs.map((item) => JSON.stringify(item)).join("\n") + "\n";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    triggerTextDownload(`mybot-logs-${stamp}.jsonl`, content, "application/x-ndjson;charset=utf-8");
    notify(`Đã xuất ${filteredLogs.length} dòng nhật ký ra tệp .jsonl!`, "success");
  };

  // Load Audit Trail with fallback to `/api/vip/audit`
  const loadAuditTrail = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const qs = new URLSearchParams({ limit: String(auditLimit) });
      if (auditAction.trim()) qs.set("action", auditAction.trim());
      if (auditActor.trim()) qs.set("actor", auditActor.trim());
      if (auditQuery.trim()) {
        qs.set("q", auditQuery.trim());
        qs.set("query", auditQuery.trim());
      }

      let data = null;
      try {
        data = await callV5(v5Fetch, `/audit?${qs.toString()}`);
      } catch {
        data = await v4Fetch(`/api/vip/audit?${qs.toString()}`);
      }

      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data?.entries)
          ? data.entries
          : Array.isArray(data?.items)
            ? data.items
            : [];

      const actorFilterLower = auditActor.trim().toLowerCase();
      const refined = actorFilterLower
        ? rawList.filter((item) =>
            String(item.actor || item.username || "admin")
              .toLowerCase()
              .includes(actorFilterLower)
          )
        : rawList;

      setAuditEntries(refined);
    } catch (err) {
      notify(err.message || "Không thể tải nhật ký kiểm toán (Audit Trail)", "error");
    } finally {
      setLoadingAudit(false);
    }
  }, [v5Fetch, auditLimit, auditAction, auditActor, auditQuery, notify]);

  useEffect(() => {
    if (tab === "audit") {
      loadAuditTrail();
    }
  }, [tab, loadAuditTrail]);

  // 1-Click Export Audit CSV / JSON
  const handleExportAudit = async (format) => {
    const qs = new URLSearchParams({
      format,
      limit: String(auditLimit),
    });
    if (auditAction.trim()) qs.set("action", auditAction.trim());
    if (auditActor.trim()) qs.set("actor", auditActor.trim());
    if (auditQuery.trim()) qs.set("query", auditQuery.trim());

    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `mybot-audit-${stamp}.${format}`;
    const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";

    try {
      const resp = await fetch(`/api/v5/audit/export?${qs.toString()}`, {
        credentials: "include",
      });
      if (resp.ok) {
        const text = await resp.text();
        triggerTextDownload(filename, text, mime);
        notify(`Đã xuất báo cáo Kiểm toán định dạng ${format.toUpperCase()}!`, "success");
        return;
      }
      const fbResp = await fetch(`/api/vip/audit/export?${qs.toString()}`, {
        credentials: "include",
      });
      if (fbResp.ok) {
        const text = await fbResp.text();
        triggerTextDownload(filename, text, mime);
        notify(`Đã xuất báo cáo Kiểm toán định dạng ${format.toUpperCase()}!`, "success");
        return;
      }
    } catch {
      // fallback to client export below
    }

    const fallbackText =
      format === "csv"
        ? buildCsvFromAudit(auditEntries)
        : JSON.stringify(auditEntries, null, 2);
    triggerTextDownload(filename, fallbackText, mime);
    notify(`Đã xuất ${auditEntries.length} bản ghi Kiểm toán (${format.toUpperCase()})!`, "success");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header & Sub-Tabs */}
      <div className="v4-card">
        <div className="v4-card-header" style={{ marginBottom: 12 }}>
          <div>
            <h2>📜 Nhật Ký Hệ Thống Trực Tiếp & Kiểm Toán Quản Trị (Audit Explorer)</h2>
            <div className="v4-muted">
              Windowed Log Stream chống giật lag tới hàng nghìn dòng, ghim sự kiện quan trọng, soi JSON chi tiết và truy vết mọi thay đổi cấu hình.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`v4-badge ${socketConnected ? "success" : "warning"}`}>
              {socketConnected ? "● Realtime Stream" : "● Chế độ HTTP"}
            </span>
          </div>
        </div>

        <div className="v4-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`v4-tab ${tab === "logs" ? "active" : ""}`}
            onClick={() => setTab("logs")}
          >
            📜 Nhật Ký Hệ Thống Trực Tiếp ({filteredLogs.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "audit" ? "active" : ""}`}
            onClick={() => setTab("audit")}
          >
            🔍 Kiểm Toán Quản Trị & So Sánh Thay Đổi ({auditEntries.length})
          </button>
        </div>
      </div>

      {/* =====================================================================
          SUB-TAB 1: LIVE STREAM LOGS (WINDOWED RENDERING)
         ===================================================================== */}
      {tab === "logs" && (
        <div className="v4-card">
          <div className="v4-toolbar" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
              <select
                className="v4-select"
                style={{ width: 195 }}
                value={botFilter}
                onChange={(e) => setBotFilter(e.target.value)}
              >
                <option value="ALL">🤖 Tất cả Bot ({activeLogs.length})</option>
                {botList.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.displayName} ({b.id})
                  </option>
                ))}
              </select>

              <select
                className="v4-select"
                style={{ width: 165 }}
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
              >
                <option value="ALL">Mọi mức độ (ALL)</option>
                <option value="INFO">Thông tin (INFO)</option>
                <option value="WARN">Cảnh báo (WARN)</option>
                <option value="ERROR">Lỗi (ERROR)</option>
              </select>

              <input
                className="v4-input v4-mono"
                style={{ maxWidth: 300 }}
                placeholder={useRegex ? "Biểu thức Regex (vd: error|timeout)..." : "Tìm nội dung, UID, lệnh..."}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />

              <button
                type="button"
                className={`v4-chip ${useRegex ? "active" : ""}`}
                onClick={() => setUseRegex((v) => !v)}
                title="Bật/tắt tìm kiếm bằng Biểu thức chính quy (Regex)"
              >
                .* Regex
              </button>

              <button
                type="button"
                className={`v4-chip ${onlyPinned ? "active" : ""}`}
                onClick={() => setOnlyPinned((v) => !v)}
              >
                📌 Đã ghim ({pinnedKeys.length})
              </button>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" className="v4-btn sm" onClick={togglePause}>
                {paused ? "▶ Tiếp tục luồng" : "⏸ Tạm dừng"}
              </button>
              <button
                type="button"
                className="v4-btn sm"
                disabled={loadingLogs}
                onClick={handleFetchServerLogs}
              >
                {loadingLogs ? "Đang tải..." : "↻ Nạp 500 dòng"}
              </button>
              <button type="button" className="v4-btn sm primary" onClick={handleDownloadJsonl}>
                📥 Tải .jsonl
              </button>
              <button type="button" className="v4-btn sm" onClick={() => setLogs([])}>
                🧹 Xóa màn hình
              </button>
            </div>
          </div>

          {compiledRegexInfo.error && (
            <div className="v4-badge danger" style={{ marginBottom: 10 }}>
              Lỗi cú pháp Regex: {compiledRegexInfo.error}
            </div>
          )}

          <div className="v4-muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Đang hiển thị <strong>{visibleLogs.length}</strong> / <strong>{filteredLogs.length}</strong> dòng khớp bộ lọc • Nhấp vào bất kỳ dòng nào để soi chi tiết JSON Metadata.
          </div>

          <div className="v4-log-box" style={{ height: 540 }}>
            {visibleLogs.length === 0 ? (
              <div className="v4-muted" style={{ padding: 16 }}>
                Chưa có dòng nhật ký nào khớp điều kiện lọc hiện tại...
              </div>
            ) : (
              visibleLogs.map((entry, idx) => {
                const rowKey = getLogRowKey(entry, idx);
                const isPinned = pinnedSet.has(rowKey);
                const isExpanded = expandedLogKey === rowKey;
                const lv = String(entry?.level || entry?.severity || "INFO").toUpperCase();
                const cls = lv.includes("ERR") ? "error" : lv.includes("WARN") ? "warn" : "";

                return (
                  <div
                    key={rowKey}
                    className={`v4-log-line ${cls}`}
                    onClick={() => setExpandedLogKey(isExpanded ? "" : rowKey)}
                    style={{
                      cursor: "pointer",
                      borderLeft: isPinned ? "3px solid var(--warning)" : "3px solid transparent",
                      background: isPinned ? "rgba(245, 158, 11, 0.09)" : undefined,
                      marginBottom: 2,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <button
                        type="button"
                        onClick={(e) => togglePinLog(rowKey, e)}
                        title={isPinned ? "Bỏ ghim dòng này" : "Ghim dòng nhật ký quan trọng"}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          opacity: isPinned ? 1 : 0.4,
                          fontSize: 12,
                        }}
                      >
                        📌
                      </button>

                      <div style={{ flex: 1 }}>
                        <span style={{ color: "#64748b" }}>
                          [{formatDateVi(entry?.timestamp || entry?.createdAt)}]
                        </span>{" "}
                        <strong
                          style={{
                            color:
                              cls === "error"
                                ? "#f87171"
                                : cls === "warn"
                                  ? "#fbbf24"
                                  : "#38bdf8",
                          }}
                        >
                          [{lv}]
                        </strong>{" "}
                        {(entry?.botId || entry?.component || entry?.scope) && (
                          <span style={{ color: "#a78bfa" }}>
                            ({entry.botId || entry.component || entry.scope}){" "}
                          </span>
                        )}
                        <span>{entry?.message || entry?.text || JSON.stringify(entry)}</span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          marginTop: 8,
                          padding: 10,
                          borderRadius: 8,
                          background: "rgba(15, 23, 42, 0.95)",
                          border: "1px solid var(--border-strong)",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                          <strong style={{ color: "#38bdf8" }}>Chi tiết JSON Metadata</strong>
                          <button
                            type="button"
                            className="v4-btn sm"
                            onClick={() => {
                              navigator.clipboard?.writeText?.(JSON.stringify(entry, null, 2));
                              notify("Đã sao chép JSON dòng nhật ký!", "info");
                            }}
                          >
                            📋 Sao chép JSON
                          </button>
                        </div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11.5 }}>
                          {JSON.stringify(entry, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {filteredLogs.length > visibleCount && (
              <div style={{ textAlign: "center", padding: "12px 0" }}>
                <button
                  type="button"
                  className="v4-btn sm primary"
                  onClick={() => setVisibleCount((c) => c + WINDOW_STEP)}
                >
                  ⬇ Tải thêm {WINDOW_STEP} dòng (Còn {filteredLogs.length - visibleCount} dòng trong bộ đệm)
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 2: AUDIT TRAIL EXPLORER & DIFF VIEWER
         ===================================================================== */}
      {tab === "audit" && (
        <div className="v4-card">
          <div className="v4-toolbar" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1 }}>
              <input
                className="v4-input v4-mono"
                style={{ width: 210 }}
                placeholder="Lọc theo Action (vd: studio.apply)..."
                value={auditAction}
                onChange={(e) => setAuditAction(e.target.value)}
              />
              <input
                className="v4-input"
                style={{ width: 175 }}
                placeholder="Người thực hiện (Actor)..."
                value={auditActor}
                onChange={(e) => setAuditActor(e.target.value)}
              />
              <input
                className="v4-input"
                style={{ width: 230 }}
                placeholder="Tìm từ khóa, botId, lệnh..."
                value={auditQuery}
                onChange={(e) => setAuditQuery(e.target.value)}
              />
              <select
                className="v4-select"
                style={{ width: 135 }}
                value={auditLimit}
                onChange={(e) => setAuditLimit(Number(e.target.value))}
              >
                <option value={100}>100 bản ghi</option>
                <option value={200}>200 bản ghi</option>
                <option value={500}>500 bản ghi</option>
              </select>
              <button
                type="button"
                className="v4-btn sm primary"
                disabled={loadingAudit}
                onClick={loadAuditTrail}
              >
                {loadingAudit ? "Đang truy vấn..." : "🔍 Lọc Kiểm Toán"}
              </button>
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="v4-btn sm success"
                onClick={() => handleExportAudit("csv")}
              >
                📊 Xuất CSV
              </button>
              <button
                type="button"
                className="v4-btn sm"
                onClick={() => handleExportAudit("json")}
              >
                📥 Xuất JSON
              </button>
            </div>
          </div>

          {auditEntries.length === 0 ? (
            <div className="v4-muted" style={{ padding: 28, textAlign: "center" }}>
              Không tìm thấy bản ghi kiểm toán nào khớp điều kiện truy vấn.
            </div>
          ) : (
            <div className="v4-table-wrap">
              <table className="v4-table">
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Hành động (Action)</th>
                    <th>Người thực hiện</th>
                    <th>Đối tượng (Bot / Lệnh)</th>
                    <th>Địa chỉ IP</th>
                    <th>Thay đổi (Diff)</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry, idx) => {
                    const isOpen = expandedAuditIdx === idx;
                    const changed = entry.changedPaths || entry.changedKeys || [];
                    return (
                      <React.Fragment key={entry.id || entry.requestId || idx}>
                        <tr
                          style={{ cursor: "pointer" }}
                          onClick={() => setExpandedAuditIdx(isOpen ? -1 : idx)}
                        >
                          <td className="v4-mono" style={{ whiteSpace: "nowrap" }}>
                            {formatDateVi(entry.timestamp || entry.createdAt)}
                          </td>
                          <td>
                            <span className="v4-badge info v4-mono">{entry.action || "audit.event"}</span>
                          </td>
                          <td>
                            <strong>{entry.actor || entry.username || "admin"}</strong>
                            {entry.role && (
                              <span className="v4-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                                ({entry.role})
                              </span>
                            )}
                          </td>
                          <td className="v4-mono">
                            {entry.botId ? `Bot: ${entry.botId} ` : ""}
                            {entry.commandName ? `!${entry.commandName} ` : ""}
                            {entry.target || (!entry.botId && !entry.commandName ? "—" : "")}
                          </td>
                          <td className="v4-mono">{entry.ipAddress || entry.ip || "127.0.0.1"}</td>
                          <td>
                            <button type="button" className="v4-btn sm">
                              {isOpen
                                ? "▲ Thu gọn"
                                : `🔍 Soi chi tiết${changed.length ? ` (${changed.length})` : ""}`}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={6} style={{ background: "var(--bg-input)" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 6 }}>
                                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12.5 }}>
                                  <span>
                                    <strong>Request ID:</strong>{" "}
                                    <code className="v4-mono">{entry.requestId || "n/a"}</code>
                                  </span>
                                  {entry.backup && (
                                    <span>
                                      <strong>Tệp Backup tự động:</strong>{" "}
                                      <code className="v4-mono">
                                        {typeof entry.backup === "string"
                                          ? entry.backup
                                          : JSON.stringify(entry.backup)}
                                      </code>
                                    </span>
                                  )}
                                </div>

                                {changed.length > 0 && (
                                  <div>
                                    <strong style={{ fontSize: 12 }}>Các đường dẫn cấu hình đã thay đổi: </strong>
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                                      {changed.map((p) => (
                                        <span key={p} className="v4-badge warning v4-mono">
                                          {p}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                <pre
                                  className="v4-mono"
                                  style={{
                                    margin: 0,
                                    padding: 10,
                                    borderRadius: 8,
                                    background: "#050811",
                                    color: "#e2e8f0",
                                    whiteSpace: "pre-wrap",
                                    maxHeight: 220,
                                    overflowY: "auto",
                                  }}
                                >
                                  {JSON.stringify(entry, null, 2)}
                                </pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
