import React, { useEffect, useState } from "react";
import { apiRequest } from "../app/api.js";

export function LogsWorkspace() {
  const [logs, setLogs] = useState([]);
  const [botId, setBotId] = useState("");
  const [severity, setSeverity] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadLogs();
  }, []);

  async function loadLogs() {
    try {
      const query = new URLSearchParams();
      if (botId) query.set("botId", botId);
      if (severity) query.set("severity", severity);
      if (search) query.set("search", search);
      const result = await apiRequest(`/api/logs?${query.toString()}`);
      setLogs(result.data?.logs || result.logs || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section className="panel workspace">
      <div className="section-heading">
        <div>
          <p className="kicker">LOGS</p>
          <h2>Live logs & events</h2>
          <p className="muted">Filter runtime logs by bot, severity, or search text.</p>
        </div>
        <button onClick={loadLogs}>Load logs</button>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="workspace-card">
        <div className="toolbar">
          <input value={botId} onChange={(e) => setBotId(e.target.value)} placeholder="Bot id" />
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search text" />
        </div>
        <pre>{logs.map((log) => `[${log.severity}] ${log.file}:${log.line} ${log.message}`).join("\n") || "No logs found."}</pre>
      </div>
    </section>
  );
}
