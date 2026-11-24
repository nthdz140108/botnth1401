import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { v4Fetch } from "../http.js";

const DEFAULT_HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:05`);

export default function StudioAndSchedulePage() {
  const { bots, selectedBotId, setSelectedBotId, notify } = useControlCenter();

  const [tab, setTab] = useState("schedule");

  // SendTask 24h Schedule state
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [scheduleGlobalEnabled, setScheduleGlobalEnabled] = useState(true);
  const [slots, setSlots] = useState([]);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Command Studio V2 state
  const [commands, setCommands] = useState([]);
  const [cmdSearch, setCmdSearch] = useState("");
  const [selectedCmdId, setSelectedCmdId] = useState("");
  const [scope, setScope] = useState("global");
  const [cmdConfig, setCmdConfig] = useState(null);
  const [cmdJsonText, setCmdJsonText] = useState("{}");
  const [cmdHistory, setCmdHistory] = useState([]);
  const [savingCmd, setSavingCmd] = useState(false);

  const loadSendTask = useCallback(async () => {
    try {
      const data = await v4Fetch("/api/commands/sendtask/config?scope=global");
      setScheduleVersion(Number(data?.version || 0));
      const values = data?.values || data?.config || {};
      const items =
        values["schedules.items"] ||
        values?.schedules?.items ||
        values?.schedules ||
        [];

      setScheduleGlobalEnabled(values.enabled !== false);
      const mapByTime = new Map();
      if (Array.isArray(items)) {
        for (const it of items) {
          if (it && it.time) mapByTime.set(String(it.time), it);
        }
      }

      const full24 = DEFAULT_HOURS.map((timeStr, idx) => {
        const existing = mapByTime.get(timeStr);
        return {
          time: timeStr,
          enabled: existing ? existing.enabled !== false : idx >= 6 && idx <= 22,
          mediaType: existing?.mediaType || existing?.category || "girl",
          message:
            existing?.message ||
            existing?.caption ||
            `Chúc mọi người khung giờ ${timeStr} vui vẻ và tràn đầy năng lượng!`,
        };
      });
      setSlots(full24);
    } catch {
      // Fallback 24 slots if sendtask endpoint not yet seeded
      setSlots(
        DEFAULT_HOURS.map((timeStr) => ({
          time: timeStr,
          enabled: false,
          mediaType: "girl",
          message: `Thông báo tự động khung giờ ${timeStr}`,
        }))
      );
    }
  }, []);

  const loadCommands = useCallback(async () => {
    try {
      const data = await v4Fetch("/api/commands");
      const list = Array.isArray(data) ? data : Array.isArray(data?.commands) ? data.commands : [];
      setCommands(list);
      if (list.length > 0) {
        setSelectedCmdId((curr) => curr || String(list[0].id || list[0].name));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadSendTask();
    loadCommands();
  }, [loadSendTask, loadCommands]);

  const loadSingleCommandConfig = useCallback(async (cmdId, targetScope, botId) => {
    if (!cmdId) return;
    try {
      const qs = new URLSearchParams({ scope: targetScope });
      if (targetScope === "bot" && botId) qs.set("botId", botId);
      const [cfg, hist] = await Promise.all([
        v4Fetch(`/api/commands/${encodeURIComponent(cmdId)}/config?${qs.toString()}`),
        v4Fetch(`/api/commands/${encodeURIComponent(cmdId)}/config/history?${qs.toString()}`).catch(
          () => null
        ),
      ]);
      setCmdConfig(cfg);
      setCmdJsonText(JSON.stringify(cfg?.values || cfg?.config || {}, null, 2));
      const hList = Array.isArray(hist) ? hist : Array.isArray(hist?.history) ? hist.history : [];
      setCmdHistory(hList);
    } catch {
      setCmdConfig(null);
      setCmdJsonText("{}");
    }
  }, []);

  useEffect(() => {
    if (tab === "studio" && selectedCmdId) {
      loadSingleCommandConfig(selectedCmdId, scope, selectedBotId);
    }
  }, [tab, selectedCmdId, scope, selectedBotId, loadSingleCommandConfig]);

  const updateSlot = (idx, patch) => {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const handleSaveSchedule = async () => {
    setSavingSchedule(true);
    try {
      const activeItems = slots.map((s) => ({
        time: s.time,
        enabled: Boolean(s.enabled),
        mediaType: s.mediaType,
        message: s.message,
      }));
      const res = await v4Fetch("/api/commands/sendtask/config", {
        method: "PUT",
        body: {
          scope: "global",
          expectedVersion: scheduleVersion,
          values: {
            enabled: scheduleGlobalEnabled,
            "schedules.items": activeItems,
          },
        },
      });
      if (res?.version !== undefined) setScheduleVersion(Number(res.version));
      notify("Đã lưu Lịch Tự Động 24 Giờ (SendTask) thành công!", "success");
    } catch (err) {
      notify(err.message || "Lưu lịch tự động thất bại", "error");
      await loadSendTask();
    } finally {
      setSavingSchedule(false);
    }
  };

  const filteredCommands = useMemo(() => {
    const q = cmdSearch.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        String(c.id || c.name || "").toLowerCase().includes(q) ||
        String(c.description || "").toLowerCase().includes(q) ||
        String(c.category || "").toLowerCase().includes(q)
    );
  }, [commands, cmdSearch]);

  const handleSaveCommandStudio = async () => {
    if (!selectedCmdId) return;
    let parsedValues = {};
    try {
      parsedValues = JSON.parse(cmdJsonText || "{}");
    } catch {
      notify("Nội dung cấu hình JSON không hợp lệ, vui lòng kiểm tra dấu ngoặc/dấu phẩy.", "error");
      return;
    }
    setSavingCmd(true);
    try {
      await v4Fetch(`/api/commands/${encodeURIComponent(selectedCmdId)}/config`, {
        method: "PUT",
        body: {
          scope,
          botId: scope === "bot" ? selectedBotId : undefined,
          expectedVersion: Number(cmdConfig?.version || 0),
          values: parsedValues,
        },
      });
      notify(`Đã lưu cấu hình lệnh "${selectedCmdId}"!`, "success");
      await loadSingleCommandConfig(selectedCmdId, scope, selectedBotId);
    } catch (err) {
      notify(err.message || "Lưu cấu hình lệnh thất bại", "error");
    } finally {
      setSavingCmd(false);
    }
  };

  const handleRollbackCmd = async (targetVersion) => {
    if (!selectedCmdId) return;
    setSavingCmd(true);
    try {
      await v4Fetch(`/api/commands/${encodeURIComponent(selectedCmdId)}/config/rollback`, {
        method: "POST",
        body: {
          scope,
          botId: scope === "bot" ? selectedBotId : undefined,
          targetVersion,
        },
      });
      notify(`Đã khôi phục cấu hình về phiên bản v${targetVersion}!`, "success");
      await loadSingleCommandConfig(selectedCmdId, scope, selectedBotId);
    } catch (err) {
      notify(err.message || "Khôi phục phiên bản thất bại", "error");
    } finally {
      setSavingCmd(false);
    }
  };

  return (
    <div className="v4-card">
      <div className="v4-card-header">
        <div>
          <h2>⚙️ Lịch Tự Động 24 Giờ & Studio 218 Lệnh</h2>
          <div className="v4-muted">
            Chỉnh lời chúc, nguồn ảnh/video gửi tự động mỗi giờ và tinh chỉnh tham số của toàn bộ 218 lệnh.
          </div>
        </div>
      </div>

      <div className="v4-tabs">
        <button
          type="button"
          className={`v4-tab ${tab === "schedule" ? "active" : ""}`}
          onClick={() => setTab("schedule")}
        >
          ⏰ Lịch Tự Động Gửi Tin 24 Giờ (SendTask)
        </button>
        <button
          type="button"
          className={`v4-tab ${tab === "studio" ? "active" : ""}`}
          onClick={() => setTab("studio")}
        >
          🎛️ Studio Cấu Hình 218 Lệnh ({commands.length})
        </button>
      </div>

      {tab === "schedule" ? (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                className={`v4-switch ${scheduleGlobalEnabled ? "on" : ""}`}
                onClick={() => setScheduleGlobalEnabled((v) => !v)}
              >
                <span className="v4-switch-knob" />
              </button>
              <span style={{ fontWeight: 700 }}>
                {scheduleGlobalEnabled
                  ? "Đang BẬT Lịch Tự Động (Áp dụng cho các nhóm bật công tắc SendTask)"
                  : "Đang TẮT Lịch Tự Động toàn hệ thống"}
              </span>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="v4-btn sm"
                onClick={() => setSlots((prev) => prev.map((s) => ({ ...s, enabled: true })))}
              >
                Bật cả 24 khung giờ
              </button>
              <button
                type="button"
                className="v4-btn sm"
                onClick={() => setSlots((prev) => prev.map((s) => ({ ...s, enabled: false })))}
              >
                Tắt hết
              </button>
              <button
                type="button"
                className="v4-btn success"
                disabled={savingSchedule}
                onClick={handleSaveSchedule}
              >
                {savingSchedule ? "Đang lưu..." : "💾 Lưu Lịch 24 Giờ"}
              </button>
            </div>
          </div>

          <div className="v4-grid-2">
            {slots.map((slot, idx) => (
              <div key={slot.time} className="v4-card" style={{ padding: 12 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="v4-badge info v4-mono" style={{ fontSize: 13 }}>
                      🕒 {slot.time}
                    </span>
                    <select
                      className="v4-select"
                      style={{ width: 155, padding: "4px 8px" }}
                      value={slot.mediaType}
                      onChange={(e) => updateSlot(idx, { mediaType: e.target.value })}
                    >
                      <option value="girl">Video / Ảnh Gái Xinh</option>
                      <option value="cosplay">Ảnh Cosplay</option>
                      <option value="anime">Video / Ảnh Anime</option>
                      <option value="chill">Nhạc Chill / Lofi</option>
                      <option value="boy">Ảnh Trai Đẹp</option>
                      <option value="text">Chỉ gửi chữ</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    className={`v4-switch ${slot.enabled ? "on" : ""}`}
                    onClick={() => updateSlot(idx, { enabled: !slot.enabled })}
                  >
                    <span className="v4-switch-knob" />
                  </button>
                </div>
                <input
                  className="v4-input"
                  value={slot.message}
                  onChange={(e) => updateSlot(idx, { message: e.target.value })}
                  placeholder="Nhập câu chúc cho khung giờ này..."
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="v4-grid-2" style={{ gridTemplateColumns: "320px minmax(0, 1fr)" }}>
          <div style={{ borderRight: "1px solid var(--border)", paddingRight: 14 }}>
            <input
              className="v4-input"
              style={{ marginBottom: 10 }}
              placeholder="Tìm trong 218 lệnh (vd: menu, taixiu, anti)..."
              value={cmdSearch}
              onChange={(e) => setCmdSearch(e.target.value)}
            />
            <div style={{ maxHeight: 540, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {filteredCommands.map((c) => {
                const cid = String(c.id || c.name);
                return (
                  <button
                    key={cid}
                    type="button"
                    className={`v4-nav-btn ${cid === selectedCmdId ? "active" : ""}`}
                    onClick={() => setSelectedCmdId(cid)}
                  >
                    <div>
                      <div className="v4-mono" style={{ fontWeight: 700 }}>{cid}</div>
                      <div className="v4-muted" style={{ fontSize: 11 }}>
                        {c.category || "command"} {c.description ? `• ${c.description}` : ""}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="v4-toolbar">
              <select
                className="v4-select"
                style={{ width: 200 }}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="global">Phạm vi: Toàn hệ thống</option>
                <option value="bot">Phạm vi: Riêng từng Bot</option>
              </select>

              {scope === "bot" && (
                <select
                  className="v4-select"
                  style={{ width: 220 }}
                  value={selectedBotId}
                  onChange={(e) => setSelectedBotId(e.target.value)}
                >
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.displayName} ({b.id})
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                className="v4-btn success"
                disabled={savingCmd || !selectedCmdId}
                onClick={handleSaveCommandStudio}
              >
                {savingCmd ? "Đang lưu..." : `💾 Lưu Cấu Hình "${selectedCmdId}"`}
              </button>
            </div>

            <div className="v4-field">
              <label>
                Tham số cấu hình lệnh <strong className="v4-mono">{selectedCmdId}</strong> (Phiên bản hiện tại: v
                {cmdConfig?.version ?? 0})
              </label>
              <textarea
                className="v4-textarea mono"
                rows={12}
                value={cmdJsonText}
                onChange={(e) => setCmdJsonText(e.target.value)}
              />
            </div>

            {cmdHistory.length > 0 && (
              <div>
                <div className="v4-nav-group-label" style={{ paddingLeft: 0 }}>
                  Lịch Sử Chỉnh Sửa & Khôi Phục Nhanh
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  {cmdHistory.slice(0, 6).map((h) => (
                    <button
                      key={h.version}
                      type="button"
                      className="v4-btn sm"
                      onClick={() => handleRollbackCmd(h.version)}
                    >
                      Khôi phục v{h.version}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
