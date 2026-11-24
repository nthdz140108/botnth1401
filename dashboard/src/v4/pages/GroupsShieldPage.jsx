import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { v4Fetch } from "../http.js";

const CORE_SWITCHES = [
  {
    key: "enableBot",
    title: "Bật Bot hoạt động trong nhóm",
    desc: "Cho phép Bot nghe và phản hồi các lệnh trong Box này",
  },
  {
    key: "onlyAdminBox",
    title: "Chỉ Quản trị viên nhóm mới dùng được Bot",
    desc: "Chặn thành viên thường spam lệnh giải trí trong nhóm",
  },
  {
    key: "sendTask",
    title: "Nhận Lịch Tự Động Mỗi Giờ (SendTask)",
    desc: "Tự động gửi tin chúc / ảnh / video / nhạc theo khung giờ",
  },
];

const ANTI_SHIELDS = [
  { key: "antiSpam", title: "1. Chống Spam tin nhắn liên tục", desc: "Tự động nhắc nhở / kick khi xả tin quá nhanh" },
  { key: "filterBadWords", title: "2. Lọc & xóa từ ngữ thô tục", desc: "Tự thu hồi/xóa các câu chửi thề vi phạm" },
  { key: "removeLinks", title: "3. Tự động xóa Link lạ", desc: "Xóa ngay đường dẫn website không thuộc danh sách trắng" },
  { key: "antiLink", title: "4. Khiên Chặn Liên Kết (Anti-Link)", desc: "Cảnh cáo & chặn hành vi rải link quảng cáo" },
  { key: "antiMention", title: "5. Chống Tag Tất Cả (@All)", desc: "Ngăn thành viên tag @All làm phiền cả nhóm" },
  { key: "antiUndo", title: "6. Chống Thu Hồi Tin Nhắn (Anti-Undo)", desc: "Bóc phốt nội dung tin nhắn vừa bị thu hồi" },
  { key: "antiMedia", title: "7. Kiểm Soát Ảnh / Video Rác", desc: "Chặn xả ảnh/video liên hoàn gây lag nhóm" },
  { key: "antiSticker", title: "8. Chống Xả Sticker Liên Tục", desc: "Giới hạn tốc độ gửi nhãn dán hàng loạt" },
  { key: "antiVoice", title: "9. Hạn Chế Tin Nhắn Thoại (Voice)", desc: "Kiểm soát gửi ghi âm spam trong nhóm" },
  { key: "antiFile", title: "10. Chặn Tệp Đính Kèm Độc Hại", desc: "Ngăn phát tán file .apk, .exe, .zip lạ" },
  { key: "antiCard", title: "11. Chặn Gửi Danh Thiếp Quảng Cáo", desc: "Ngăn rải danh thiếp Zalo lôi kéo khách" },
  { key: "antiForward", title: "12. Chặn Chuyển Tiếp Hàng Loạt", desc: "Chặn tin nhắn forward dây chuyền" },
  { key: "antiKickBlock", title: "13. Bảo Vệ Chống Kick Phá Hoại", desc: "Giám sát Phó nhóm kick hàng loạt bất thường" },
  { key: "antiJoinLeave", title: "14. Kiểm Soát Ra / Vào Nhóm", desc: "Chống tài khoản ảo vào rồi thoát liên tục" },
  { key: "enableSetup", title: "15. Thẻ Chào Mừng & Tạm Biệt Thành Viên", desc: "Tự gửi ảnh chào đón thành viên mới vào Box" },
  { key: "learnEnabled", title: "16. Cho Phép Bot Học Câu Trả Lời", desc: "Học từ điển hội thoại riêng của nhóm" },
  { key: "replyEnabled", title: "17. Tự Động Trả Lời Từ Khóa Thông Minh", desc: "Phản hồi tự động khi khớp từ khóa đã dạy" },
];

export default function GroupsShieldPage() {
  const { bots, selectedBotId, setSelectedBotId, notify } = useControlCenter();

  const activeBot = useMemo(
    () => bots.find((b) => b.id === selectedBotId) || bots[0] || null,
    [bots, selectedBotId]
  );

  const [groups, setGroups] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadGroups = useCallback(async (botId) => {
    if (!botId) return;
    setLoading(true);
    try {
      const data = await v4Fetch(`/api/bots/${encodeURIComponent(botId)}/groups`);
      const list = Array.isArray(data) ? data : Array.isArray(data?.groups) ? data.groups : [];
      setGroups(list);
      if (list.length > 0) {
        const firstId = String(list[0].threadId || list[0].id);
        setSelectedThreadId((curr) => {
          const valid = curr && list.some((g) => String(g.threadId || g.id) === curr);
          return valid ? curr : firstId;
        });
      } else {
        setSelectedThreadId("");
      }
    } catch (err) {
      notify(err.message || "Không thể tải danh sách nhóm của Bot", "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (activeBot?.id) loadGroups(activeBot.id);
  }, [activeBot?.id, loadGroups]);

  const currentGroup = useMemo(
    () => groups.find((g) => String(g.threadId || g.id) === selectedThreadId) || null,
    [groups, selectedThreadId]
  );

  useEffect(() => {
    if (!currentGroup) {
      setSettings({});
      return;
    }
    const raw = currentGroup.settings || {};
    const next = {};
    for (const item of [...CORE_SWITCHES, ...ANTI_SHIELDS]) {
      const val =
        currentGroup[item.key] !== undefined ? currentGroup[item.key] : raw[item.key];
      next[item.key] = Boolean(val);
    }
    setSettings(next);
  }, [currentGroup]);

  const handleBulkEnableAllGroups = async (enabled) => {
    if (!activeBot) return;
    setSaving(true);
    try {
      const res = await v4Fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/groups/enable-all`,
        {
          method: "POST",
          body: { enabled },
        }
      );
      if (Array.isArray(res?.groups)) {
        setGroups(res.groups);
      } else {
        await loadGroups(activeBot.id);
      }
      notify(
        enabled
          ? `Đã bật Bot hoạt động trên toàn bộ ${res?.updatedCount ?? ""} nhóm!`
          : `Đã tắt Bot trên toàn bộ ${res?.updatedCount ?? ""} nhóm!`,
        "success"
      );
    } catch (err) {
      notify(err.message || "Không thể cập nhật hàng loạt trạng thái nhóm", "error");
    } finally {
      setSaving(false);
    }
  };

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        String(g.name || "").toLowerCase().includes(q) ||
        String(g.threadId || g.id || "").toLowerCase().includes(q)
    );
  }, [groups, search]);

  const saveGroupSettings = async (nextSettings) => {
    if (!activeBot || !selectedThreadId) return;
    setSaving(true);
    try {
      await v4Fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/groups/${encodeURIComponent(selectedThreadId)}/settings`,
        {
          method: "PUT",
          body: nextSettings,
        }
      );
      setGroups((prev) =>
        prev.map((g) =>
          String(g.threadId || g.id) === selectedThreadId
            ? { ...g, settings: { ...(g.settings || {}), ...nextSettings }, ...nextSettings }
            : g
        )
      );
      notify(`Đã lưu cấu hình khiên bảo vệ cho nhóm ${currentGroup?.name || selectedThreadId}!`, "success");
    } catch (err) {
      notify(err.message || "Lưu cấu hình nhóm thất bại", "error");
    } finally {
      setSaving(false);
    }
  };

  const toggleKey = (key) => {
    const updated = { ...settings, [key]: !settings[key] };
    setSettings(updated);
    saveGroupSettings(updated);
  };

  const bulkSetShields = (val) => {
    const updated = { ...settings };
    for (const item of ANTI_SHIELDS) {
      updated[item.key] = val;
    }
    setSettings(updated);
    saveGroupSettings(updated);
  };

  const handleLeaveGroup = async () => {
    if (!activeBot || !selectedThreadId) return;
    if (
      !window.confirm(
        `Bạn chắc chắn muốn cho bot "${activeBot.displayName}" rời khỏi nhóm "${currentGroup?.name || selectedThreadId}"?`
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      await v4Fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/groups/${encodeURIComponent(selectedThreadId)}/leave`,
        { method: "POST", body: {} }
      );
      notify("Bot đã rời khỏi nhóm thành công.", "success");
      await loadGroups(activeBot.id);
    } catch (err) {
      notify(err.message || "Không thể rời khỏi nhóm", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="v4-card">
      <div className="v4-card-header">
        <div>
          <h2>🛡️ Quản Lý Nhóm Zalo & 17 Khiên Chống Phá Hoại</h2>
          <div className="v4-muted">
            Bật/tắt trực quan từng tính năng bảo vệ nhóm bằng công tắc mà không cần nhớ cú pháp lệnh trên Zalo.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            className="v4-select"
            style={{ minWidth: 240 }}
            value={activeBot?.id || ""}
            onChange={(e) => setSelectedBotId(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.isMain ? "★ [ADMIN] " : ""}
                {b.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="v4-btn success"
            disabled={loading || saving || !activeBot}
            onClick={() => handleBulkEnableAllGroups(true)}
          >
            ⚡ Bật Bot Tất Cả Nhóm
          </button>
          <button
            type="button"
            className="v4-btn"
            disabled={loading || saving || !activeBot}
            onClick={() => handleBulkEnableAllGroups(false)}
          >
            Tắt Bot Tất Cả Nhóm
          </button>
          <button
            type="button"
            className="v4-btn"
            disabled={loading || !activeBot}
            onClick={() => activeBot && loadGroups(activeBot.id)}
          >
            {loading ? "Đang đồng bộ..." : "↻ Đồng bộ danh sách nhóm"}
          </button>
        </div>
      </div>

      <div className="v4-grid-2" style={{ gridTemplateColumns: "320px minmax(0, 1fr)" }}>
        {/* Left column: Group Picker */}
        <div style={{ borderRight: "1px solid var(--border)", paddingRight: 14 }}>
          <input
            className="v4-input"
            style={{ marginBottom: 10 }}
            placeholder="Tìm tên nhóm hoặc Thread ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ maxHeight: 620, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {filteredGroups.length === 0 ? (
              <div className="v4-muted" style={{ padding: 12 }}>
                Chưa có nhóm nào được ghi nhận cho Bot này.
              </div>
            ) : (
              filteredGroups.map((g) => {
                const gid = String(g.threadId || g.id);
                const active = gid === selectedThreadId;
                const botEnabled = Boolean(
                  g.enableBot !== undefined ? g.enableBot : g.settings?.enableBot
                );
                return (
                  <button
                    key={gid}
                    type="button"
                    className={`v4-nav-btn ${active ? "active" : ""}`}
                    onClick={() => setSelectedThreadId(gid)}
                  >
                    <div style={{ width: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {g.name || `Nhóm ${gid}`}
                        </span>
                        <span
                          className={`v4-badge ${botEnabled ? "ok" : ""}`}
                          style={{ fontSize: 10, flexShrink: 0 }}
                        >
                          {botEnabled ? "ĐANG BẬT" : "ĐANG TẮT"}
                        </span>
                      </div>
                      <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                        ID: {gid} • {g.memberCount || "--"} TV
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right column: Visual Shield Matrix */}
        <div>
          {!selectedThreadId ? (
            <div className="v4-muted" style={{ padding: 24 }}>
              Hãy chọn một nhóm ở cột bên trái để chỉnh cấu hình và 17 khiên chống phá nhóm.
            </div>
          ) : (
            <>
              <div className="v4-card-header" style={{ marginBottom: 12 }}>
                <div>
                  <h3>{currentGroup?.name || `Nhóm ${selectedThreadId}`}</h3>
                  <div className="v4-muted v4-mono">Thread ID: {selectedThreadId}</div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="v4-btn sm success"
                    disabled={saving}
                    onClick={() => bulkSetShields(true)}
                  >
                    Bật Tất Cả 17 Khiên
                  </button>
                  <button
                    type="button"
                    className="v4-btn sm"
                    disabled={saving}
                    onClick={() => bulkSetShields(false)}
                  >
                    Tắt Tất Cả Khiên
                  </button>
                  <button
                    type="button"
                    className="v4-btn sm danger"
                    disabled={saving}
                    onClick={handleLeaveGroup}
                  >
                    Cho Bot Rời Nhóm
                  </button>
                </div>
              </div>

              <div className="v4-nav-group-label" style={{ paddingLeft: 0, marginBottom: 8 }}>
                Chế Độ Vận Hành Cốt Lõi
              </div>
              <div className="v4-grid-3" style={{ marginBottom: 18 }}>
                {CORE_SWITCHES.map((sw) => (
                  <div key={sw.key} className="v4-switch-card">
                    <div>
                      <div style={{ fontWeight: 700 }}>{sw.title}</div>
                      <div className="v4-muted" style={{ fontSize: 11.5 }}>{sw.desc}</div>
                    </div>
                    <button
                      type="button"
                      className={`v4-switch ${settings[sw.key] ? "on" : ""}`}
                      onClick={() => toggleKey(sw.key)}
                    >
                      <span className="v4-switch-knob" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="v4-nav-group-label" style={{ paddingLeft: 0, marginBottom: 8 }}>
                17 Khiên Chống Spam & Quản Trị An Ninh Nhóm
              </div>
              <div className="v4-grid-2">
                {ANTI_SHIELDS.map((sw) => (
                  <div key={sw.key} className="v4-switch-card">
                    <div>
                      <div style={{ fontWeight: 600 }}>{sw.title}</div>
                      <div className="v4-muted" style={{ fontSize: 11.5 }}>{sw.desc}</div>
                    </div>
                    <button
                      type="button"
                      className={`v4-switch ${settings[sw.key] ? "on" : ""}`}
                      onClick={() => toggleKey(sw.key)}
                    >
                      <span className="v4-switch-knob" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
