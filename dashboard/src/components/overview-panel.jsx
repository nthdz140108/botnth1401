import React, { useMemo, useState } from "react";

const esc = (value) => String(value ?? "");

const READINESS_TONES = {
  ready: "online",
  verified: "online",
  starting: "warn",
  stopping: "warn",
  restarting: "warn",
  "identity-mismatch": "issue",
  "not-ready": "warn",
  error: "issue",
  unknown: "issue",
  "backend-stale": "issue",
};

function readinessTone(status) {
  return READINESS_TONES[status] || "issue";
}

const BACKEND_STALE = "Backend cũ — cần restart mybot-dashboard";

function isBackendStale(bot) {
  return Boolean(bot) && bot.statusSchemaVersion !== 2;
}

function readinessLabel(bot) {
  const status = bot?.readiness?.status;
  if (isBackendStale(bot)) return "backend-stale";
  if (bot?.readiness?.identityVerified) return "verified";
  if (status === "ready") return "ready";
  if (bot?.readiness?.portOpen) return "port-only";
  return status || "unknown";
}

function pm2Label(bot) {
  const status = bot?.supervisor?.status || bot?.pm2Status;
  if (isBackendStale(bot)) return "backend-stale";
  if (bot?.supervisor && bot.supervisor.available === false) return "unavailable";
  return status || "unknown";
}

export function OverviewPanel({ loading, overview, bots, onOpen, onAction, onBulkAction }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("name");
  const [selected, setSelected] = useState(() => new Set());
  const [actionSummary, setActionSummary] = useState("");
  const visibleBots = useMemo(() => bots
    .filter((bot) => !status || (status === "disabled" ? bot.enabled === false || bot.status === "disabled" : bot.status === status))
    .filter((bot) => !search || `${bot.id} ${bot.displayName}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort === "status" ? String(a.status).localeCompare(String(b.status)) : String(a.displayName || a.id).localeCompare(String(b.displayName || b.id))), [bots, search, status, sort]);
  const toggleSelected = (id) => setSelected((old) => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const runBulk = async (action) => {
    if (!selected.size) return;
    try {
      const result = await onBulkAction?.(action, [...selected]);
      const failedIds = result?.failedIds || [];
      setSelected(new Set(failedIds));
      setActionSummary(failedIds.length ? `${failedIds.length} bot thao tác lỗi; đã giữ lại lựa chọn để thử lại.` : `Đã xử lý ${selected.size} bot.`);
    } catch {
      setActionSummary("Thao tác thất bại; các bot vẫn được giữ lựa chọn.");
    }
  };
  const counts = overview?.counts || {};
  const running = counts.running || 0;
  const total = overview?.total || 0;
  const lastSync = overview?.updatedAt ? new Date(overview.updatedAt).toLocaleTimeString() : "--";

  return (
    <>
      {loading && !overview ? <section className="panel loading-state" role="status" aria-live="polite">Loading fleet telemetry...</section> : null}
      <section className="welcome-row">
        <div>
          <p className="kicker">REALTIME TELEMETRY</p>
          <h2>Good to see you, operator.</h2>
          <p className="muted">Monitor every bot, credential and service from one place.</p>
        </div>
        <div className="sync-card">
          <span className="live-dot" />
          <div>
            <strong>All systems operational</strong>
            <span>Last sync {lastSync}</span>
          </div>
        </div>
      </section>
      <section className="grid">
        {[
          ["Total bots", total, "Registered instances", "neutral"],
          ["Running", running, `${total ? Math.round((running / total) * 100) : 0}% of fleet`, "success"],
          ["Stopped", counts.stopped || 0, "Awaiting start", "warning"],
          ["Errors", (counts.error || 0) + (counts.unknown || 0), "Needs attention", "danger"],
        ].map(([label, value, detail, tone]) => (
          <div className={`panel metric ${tone}`} key={label}>
            <div className="metric-head">
              <span className="muted">{label}</span>
              <span className="metric-indicator" />
            </div>
            <strong>{value}</strong>
            <span className="metric-detail">{detail}</span>
          </div>
        ))}
      </section>
      <section className="panel fleet-panel">
        <div className="section-heading">
          <div>
            <p className="kicker">BOT FLEET</p>
            <h2>Active instances</h2>
          </div>
          <span className="count-label">{running} online / {total} total</span>
        </div>
        <div className="toolbar fleet-toolbar">
          <input aria-label="Search bots" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search fleet" />
          <select aria-label="Filter bots by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="disabled">Disabled</option><option value="error">Error</option>
          </select>
          <select aria-label="Sort bots" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">Sort by name</option><option value="status">Sort by status</option></select>
          <button disabled={!selected.size} onClick={() => runBulk("start")}>Start</button>
          <button disabled={!selected.size} onClick={() => runBulk("stop")}>Stop</button>
          <button disabled={!selected.size} onClick={() => runBulk("restart")}>Restart</button>
          <button disabled={!selected.size} onClick={() => runBulk("enable")}>Enable</button>
          <button disabled={!selected.size} onClick={() => runBulk("disable")}>Disable</button>
          <button disabled={!selected.size} onClick={() => runBulk("delete")}>Delete</button>
        </div>
        <p className="muted" role="status" aria-live="polite">{actionSummary || " "}</p>
        {visibleBots.some(isBackendStale) ? (
          <div className="notice" role="alert">{BACKEND_STALE}</div>
        ) : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bot identity</th>
                <th>Status</th>
                <th>PM2</th>
                <th>Bot readiness</th>
                <th>Port</th>
                <th>Credential</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleBots.length ? visibleBots.map((bot) => (
                <tr key={bot.id}>
                  <td>
                    <div className="bot-cell">
                      <input type="checkbox" aria-label={`Select ${bot.displayName || bot.id}`} checked={selected.has(bot.id)} onChange={() => toggleSelected(bot.id)} />
                      <span className={`bot-avatar ${bot.status === "running" ? "online" : ""}`}>
                        {esc(bot.displayName || bot.id).slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{esc(bot.displayName)}</strong>
                        <small>{esc(bot.id)}</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`status-text ${bot.status === "running" ? "online" : bot.status === "stopped" ? "offline" : "issue"}`} title={isBackendStale(bot) ? BACKEND_STALE : undefined}>
                      <span />
                      {isBackendStale(bot) ? "backend-stale" : esc(bot.status)}
                    </span>
                  </td>
                  <td>
                    <span className={`status-text ${pm2Label(bot) === "online" ? "online" : pm2Label(bot) === "unavailable" || pm2Label(bot) === "backend-stale" ? "issue" : "offline"}`} title={isBackendStale(bot) ? BACKEND_STALE : undefined}>
                      <span />
                      {esc(pm2Label(bot))}
                    </span>
                  </td>
                  <td>
                    <span className={`status-text ${readinessTone(readinessLabel(bot)) === "online" ? "online" : readinessTone(readinessLabel(bot)) === "warn" ? "offline" : "issue"}`} title={isBackendStale(bot) ? BACKEND_STALE : undefined}>
                      <span />
                      {esc(readinessLabel(bot))}
                    </span>
                  </td>
                  <td className="mono">{bot.port || "-"}</td>
                  <td>
                    <span><span className="credential-pill">{esc(bot.credential?.state || "unknown")}</span>{bot.status === "disabled" ? <small className="muted">{esc(bot.disabledReason || "Đã vô hiệu hóa")} {bot.disabledAt ? `· ${new Date(bot.disabledAt).toLocaleString("vi-VN")}` : ""}</small> : null}</span>
                  </td>
                  <td className="actions">
                    <button onClick={() => onOpen(bot.id)}>Configure</button>
                    <button disabled={bot.id === "admin" ? false : bot.enabled === false || bot.status === "disabled"} onClick={() => onAction(bot.id, "start", bot)}>Start</button>
                    <button className="secondary" onClick={() => onAction(bot.id, "stop", bot)}>Stop</button>
                    <button className="secondary" disabled={bot.enabled === false || bot.status === "disabled"} onClick={() => onAction(bot.id, "restart", bot)}>Restart</button>
                    {bot.status === "disabled" ? <button onClick={() => onAction(bot.id, "enable", bot)}>Enable</button> : <button className="secondary" disabled={bot.id === "admin"} onClick={() => onAction(bot.id, "disable", bot)}>Disable</button>}
                    <button className="secondary" disabled={bot.id === "admin"} onClick={() => onAction(bot.id, "delete", bot)}>Delete</button>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="7" className="empty-state">No bot instances found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
