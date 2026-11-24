import React, { useEffect, useState } from "react";
import { apiRequest } from "../app/api.js";

const defaults = { groupEnabled: true, privateEnabled: true };

export function ChatPolicyPanel({ botId, compact = false, onSaved }) {
  const [policy, setPolicy] = useState(defaults);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    if (botId) load();
    else setPolicy(defaults);
  }, [botId]);

  async function load() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/chat-policy`);
      const value = (result.data || result).policy || result.data || result;
      setPolicy({ groupEnabled: value.groupEnabled !== false, privateEnabled: value.privateEnabled !== false });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function update(key, value) {
    setPolicy((current) => ({ ...current, [key]: value }));
    setNotice("");
    setRestartRequired(false);
  }

  async function save() {
    if (!botId) return setError("Select a bot first.");
    setSaving(true);
    setError("");
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/chat-policy`, { method: "PUT", body: policy });
      const value = (result.data || result).policy || policy;
      setPolicy({ groupEnabled: value.groupEnabled !== false, privateEnabled: value.privateEnabled !== false });
      setNotice("Chat access saved.");
      setRestartRequired(result.restartRequired === true);
      onSaved?.(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`workspace-card chat-policy-panel${compact ? " compact" : ""}`}>
      <div className="section-heading">
        <div>
          <h3>Chat access</h3>
          <p className="muted">Control where this bot accepts interactions.</p>
        </div>
        <button className="secondary" onClick={load} disabled={!botId || loading || saving} title="Refresh chat access">Refresh</button>
      </div>
      {loading ? <p className="loading-state" role="status">Loading chat access...</p> : null}
      {error ? <div className="error" role="alert">{error}</div> : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}
      {restartRequired ? <div className="restart-warning" role="status">Restart the bot to apply this policy.</div> : null}
      <div className="chat-policy-options">
        <label className="chat-policy-toggle">
          <input type="checkbox" checked={policy.groupEnabled} onChange={(event) => update("groupEnabled", event.target.checked)} disabled={!botId || loading || saving} />
          <span><strong>Group chat</strong><small>{policy.groupEnabled ? "Enabled" : "Disabled"}</small></span>
        </label>
        <label className="chat-policy-toggle">
          <input type="checkbox" checked={policy.privateEnabled} onChange={(event) => update("privateEnabled", event.target.checked)} disabled={!botId || loading || saving} />
          <span><strong>Private chat</strong><small>{policy.privateEnabled ? "Enabled" : "Disabled"}</small></span>
        </label>
      </div>
      <button onClick={save} disabled={!botId || loading || saving}>{saving ? "Saving..." : "Save chat access"}</button>
    </div>
  );
}
