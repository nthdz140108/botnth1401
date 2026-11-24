import React, { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../app/api.js";

const FLAG_LABELS = {
  "vip.media": "Media",
  "vip.ai": "AI",
  "vip.group": "Group",
  "vip.utility": "Utility",
  "vip.highRisk": "High Risk",
};

const DEFAULT_FLAG_DRAFT = {
  "vip.media": true,
  "vip.ai": true,
  "vip.group": true,
  "vip.utility": true,
  "vip.highRisk": false,
};

const PROVIDER_CONFIG_ENDPOINT = "/api/provider-config";
const SYSTEM_HEALTH_ENDPOINT = "/api/system/health";
const SYSTEM_CLEANUP_ENDPOINT = "/api/system/disk-cleanup";
const SYSTEM_BACKUP_ENDPOINT = "/api/system/backup";
const SYSTEM_RESTORE_ENDPOINT = "/api/system/restore";
const restartRequired = false;

export function SystemWorkspace() {
  const [tab, setTab] = useState("health");
  const [health, setHealth] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [featureFlags, setFeatureFlags] = useState(DEFAULT_FLAG_DRAFT);
  const [providerStatus, setProviderStatus] = useState({ groups: [], keys: [] });
  const [queue, setQueue] = useState({ queues: {}, totalQueued: 0 });
  const [audit, setAudit] = useState({ entries: [], export: "", total: 0 });
  const [migrationPreview, setMigrationPreview] = useState({ preview: [], changedKeys: [] });
  const [flagDraft, setFlagDraft] = useState(DEFAULT_FLAG_DRAFT);
  const [providerDraft, setProviderDraft] = useState({});
  const [auditQuery, setAuditQuery] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditFormat, setAuditFormat] = useState("json");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingFlags, setSavingFlags] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    refreshAll();
  }, []);

  const catalogRows = useMemo(() => catalog.map((item) => ({
    ...item,
    healthTone: item.health === "healthy" ? "good" : item.health === "missing" ? "bad" : "warn",
  })), [catalog]);

  async function refreshAll() {
    await Promise.all([loadHealth(), loadCatalog(), loadFlags(), loadProviderStatus(), loadQueue(), loadAudit()]);
  }

  async function loadHealth() {
    try {
      const result = await apiRequest(SYSTEM_HEALTH_ENDPOINT);
      setHealth(result.data || result);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadCatalog() {
    try {
      const result = await apiRequest("/api/vip/catalog");
      const payload = result.data || result;
      setCatalog(payload.commands || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadFlags() {
    try {
      const result = await apiRequest("/api/vip/feature-flags");
      const payload = result.data || result;
      setFeatureFlags(payload.flags || DEFAULT_FLAG_DRAFT);
      setFlagDraft(payload.flags || DEFAULT_FLAG_DRAFT);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadProviderStatus() {
    try {
      const result = await apiRequest(PROVIDER_CONFIG_ENDPOINT);
      const payload = result.data || result;
      setProviderStatus((current) => ({
        ...current,
        ...payload,
        groups: payload.groups || current.groups || [],
      }));
      setProviderDraft(Object.fromEntries((payload.keys || []).map((item) => [item.name, ""])));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadQueue() {
    try {
      const result = await apiRequest("/api/vip/queue");
      setQueue(result.data || result);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadAudit(nextQuery = auditQuery, nextAction = auditAction, nextFormat = auditFormat) {
    try {
      const params = new URLSearchParams();
      if (nextQuery) params.set("query", nextQuery);
      if (nextAction) params.set("action", nextAction);
      params.set("format", nextFormat);
      params.set("limit", "100");
      const result = await apiRequest(`/api/vip/audit?${params.toString()}`);
      setAudit(result.data || result);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveFlags() {
    setSavingFlags(true);
    try {
      const result = await apiRequest("/api/vip/feature-flags", {
        method: "PUT",
        body: flagDraft,
      });
      setFeatureFlags(result.data || result);
      setNotice(restartRequired ? "Feature flags saved; restart required." : "Feature flags saved with backup.");
      await refreshAll();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingFlags(false);
    }
  }

  async function previewMigration() {
    try {
      const result = await apiRequest("/api/vip/migration-preview", {
        method: "POST",
        body: { flags: flagDraft },
      });
      setMigrationPreview(result.data || result);
      setNotice("Migration preview refreshed.");
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveProviderRefresh() {
    const values = Object.fromEntries(Object.entries(providerDraft).filter(([, value]) => String(value || "").trim()));
    if (!Object.keys(values).length) {
      setError("Nhập ít nhất một provider key để refresh.");
      return;
    }
    setSavingProvider(true);
    try {
      const result = await apiRequest(PROVIDER_CONFIG_ENDPOINT, {
        method: "POST",
        body: values,
      });
      const payload = result.data || result;
      setProviderStatus((current) => ({
        ...current,
        ...payload,
        groups: payload.groups || current.groups || [],
      }));
      setProviderDraft(Object.fromEntries((payload.keys || []).map((item) => [item.name, ""])));
      setNotice("Provider keys validated and refreshed.");
      await loadHealth();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingProvider(false);
    }
  }

  async function exportAudit() {
    try {
      const params = new URLSearchParams();
      if (auditQuery) params.set("query", auditQuery);
      if (auditAction) params.set("action", auditAction);
      params.set("format", auditFormat);
      params.set("limit", "100");
      const response = await fetch(`/api/vip/audit/export?${params.toString()}`, { credentials: "include" });
      if (!response.ok) throw new Error("Không thể xuất audit log.");
      const text = await response.text();
      const blob = new Blob([text], { type: auditFormat === "csv" ? "text/csv" : "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = auditFormat === "csv" ? "dashboard-audit.csv" : "dashboard-audit.json";
      link.click();
      URL.revokeObjectURL(url);
      setNotice("Audit log exported.");
    } catch (e) {
      setError(e.message);
    }
  }

  async function runSystemCleanup() {
    try {
      setError("");
      const result = await apiRequest(SYSTEM_CLEANUP_ENDPOINT, { method: "POST" });
      const payload = result.data || result;
      const freedKb = Math.round(Number(payload?.bytesFreedTotal || 0) / 1024);
      setNotice(`Safe SSD cleanup completed (${payload?.filesFreedTotal || 0} files, ${freedKb} KB freed).`);
      await loadHealth();
    } catch (e) {
      setError(e.message);
    }
  }

  async function runSystemBackup() {
    try {
      setError("");
      const result = await apiRequest(SYSTEM_BACKUP_ENDPOINT, { method: "POST" });
      const payload = result.data || result;
      setNotice(`Snapshot saved (${(payload?.files || []).length} config files).`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function runSystemRestore() {
    try {
      setError("");
      const result = await apiRequest(SYSTEM_RESTORE_ENDPOINT, { method: "POST" });
      const payload = result.data || result;
      setNotice(`Snapshot restored (${(payload?.files || []).length} config files).`);
      await refreshAll();
    } catch (e) {
      setError(e.message);
    }
  }

  const activeFlags = Object.entries(flagDraft).filter(([, value]) => value).map(([key]) => FLAG_LABELS[key] || key);

  return (
    <section className="panel workspace">
      <div className="section-heading">
        <div>
          <p className="kicker">SYSTEM</p>
          <h2>System health & operations</h2>
          <p className="muted">Dashboard cho health, safe SSD cleanup, command catalog, feature flags, provider validation, queue monitor và audit log.</p>
        </div>
        <div className="toolbar">
          <button onClick={refreshAll}>Refresh all</button>
          <button className="secondary" onClick={runSystemCleanup}>Clean SSD</button>
          <button className="secondary" onClick={previewMigration}>Preview migration</button>
          <button className="secondary" onClick={runSystemBackup}>Backup</button>
          <button className="secondary" onClick={runSystemRestore}>Restore</button>
        </div>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}
      <div className="toolbar command-toolbar">
        {["health", "catalog", "flags", "providers", "queues", "audit"].map((name) => (
          <button key={name} className={tab === name ? "" : "secondary"} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === "health" ? (
        <div className="workspace-grid single">
          <div className="workspace-card">
            <h3>Health overview</h3>
            <pre>{JSON.stringify(health, null, 2)}</pre>
          </div>
          <div className="workspace-card">
            <h3>Active VIP groups</h3>
            <div className="diagnostics">
              {activeFlags.length ? activeFlags.map((flag) => <span key={flag}>{flag}</span>) : <span>No enabled flags</span>}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "catalog" ? (
        <div className="workspace-grid single">
          <div className="workspace-card">
            <h3>VIP command catalog</h3>
            <div className="catalog-grid">
              {catalogRows.map((command) => (
                <article className="catalog-card" key={command.name}>
                  <header className="catalog-card-header">
                    <strong>{command.name}</strong>
                    <span className={`status-pill status-${command.healthTone}`}>{command.health}</span>
                  </header>
                  <dl className="definition-list compact">
                    <div><dt>Status</dt><dd>{command.enabled ? "enabled" : "disabled"}</dd></div>
                    <div><dt>Permission</dt><dd>{command.permission}</dd></div>
                    <div><dt>Risk</dt><dd>{command.riskLevel}</dd></div>
                    <div><dt>Provider</dt><dd>{command.providerDependency || "-"}</dd></div>
                    <div><dt>Scope</dt><dd>{command.scope}</dd></div>
                  </dl>
                  <p className="muted">Aliases: {(command.aliases || []).join(", ") || "-"}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "flags" ? (
        <div className="workspace-grid single">
          <div className="workspace-card">
            <div className="section-heading compact-heading">
              <div>
                <h3>Feature flags</h3>
                <p className="muted">Validate and backup before changing runtime access.</p>
              </div>
              <button disabled={savingFlags} onClick={saveFlags}>{savingFlags ? "Saving..." : "Save flags"}</button>
            </div>
            <div className="provider-grid">
              {Object.entries(flagDraft).map(([key, value]) => (
                <label className="provider-row" key={key}>
                  <span className="provider-label">
                    <strong>{FLAG_LABELS[key] || key}</strong>
                    <span className={value ? "provider-status configured" : "provider-status missing"}>{value ? "Enabled" : "Disabled"}</span>
                  </span>
                  <select value={value ? "true" : "false"} onChange={(e) => setFlagDraft((current) => ({ ...current, [key]: e.target.value === "true" }))}>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
              ))}
            </div>
            <pre>{JSON.stringify(featureFlags, null, 2)}</pre>
          </div>
          <div className="workspace-card">
            <h3>Migration preview</h3>
            <pre>{JSON.stringify(migrationPreview, null, 2)}</pre>
          </div>
        </div>
      ) : null}

      {tab === "providers" ? (
        <div className="workspace-grid single">
          <div className="workspace-card">
            <div className="section-heading compact-heading">
              <div>
                <h3>Provider validation</h3>
                <p className="muted">Keys are masked in the dashboard. Refresh writes through validation and backup.</p>
              </div>
              <button disabled={savingProvider} onClick={saveProviderRefresh}>{savingProvider ? "Validating..." : "Refresh keys"}</button>
            </div>
            <div className="provider-grid">
              {(providerStatus.keys || []).map((item) => (
                <label className="provider-row" key={item.name}>
                  <span className="provider-label">
                    <strong>{item.name}</strong>
                    <span className={item.configured ? "provider-status configured" : "provider-status missing"}>{item.configured ? "Configured" : "Missing"}</span>
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={item.masked || "Enter new value"}
                    value={providerDraft[item.name] || ""}
                    onChange={(e) => setProviderDraft((current) => ({ ...current, [item.name]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="workspace-card">
            <h3>Provider groups</h3>
            <pre>{JSON.stringify(providerStatus.groups, null, 2)}</pre>
          </div>
        </div>
      ) : null}

      {tab === "queues" ? (
        <div className="workspace-grid single">
          <div className="workspace-card">
            <h3>Queue monitor</h3>
            <dl className="definition-list">
              <div><dt>Total queued</dt><dd>{queue.totalQueued || 0}</dd></div>
              {Object.entries(queue.queues || {}).map(([name, item]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{item.pending} pending, {item.running} running, sample: {(item.sample || []).join(", ") || "-"}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}

      {tab === "audit" ? (
        <div className="workspace-grid single">
          <div className="workspace-card">
            <div className="toolbar">
              <input value={auditQuery} onChange={(e) => setAuditQuery(e.target.value)} placeholder="Search audit text" />
              <input value={auditAction} onChange={(e) => setAuditAction(e.target.value)} placeholder="Action filter" />
              <select value={auditFormat} onChange={(e) => setAuditFormat(e.target.value)}>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
              <button onClick={() => loadAudit(auditQuery, auditAction, auditFormat)}>Filter</button>
              <button className="secondary" onClick={exportAudit}>Export</button>
            </div>
            <pre>{JSON.stringify(audit, null, 2)}</pre>
          </div>
        </div>
      ) : null}
    </section>
  );
}
