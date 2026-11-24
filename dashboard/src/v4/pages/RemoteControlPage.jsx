import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { v4Fetch } from "../http.js";

const QUICK_COMMANDS = [
  { label: "Menu Tổng Hợp", cmd: "menu" },
  { label: "Bật Bot Trong Nhóm", cmd: "bot on" },
  { label: "Chi Tiết Hệ Thống", cmd: "detail" },
  { label: "Thông Tin Nhóm", cmd: "group" },
  { label: "Top Tương Tác", cmd: "topchat" },
  { label: "Thời Tiết Hà Nội", cmd: "thoitiet Hà Nội" },
  { label: "Bật Khiên Tiêu Chuẩn", cmd: "antisetup on" },
  { label: "Lịch Âm Hôm Nay", cmd: "lich" },
];

export default function RemoteControlPage() {
  const {
    bots,
    selectedBotId,
    setSelectedBotId,
    broadcastProgress,
    notify,
  } = useControlCenter();

  const activeBot = useMemo(
    () => bots.find((b) => b.id === selectedBotId) || bots[0] || null,
    [bots, selectedBotId]
  );

  const [tab, setTab] = useState("chat");
  const [groups, setGroups] = useState([]);
  const [friends, setFriends] = useState([]);
  const [loadingTargets, setLoadingTargets] = useState(false);

  // Single message form
  const [targetType, setTargetType] = useState("group"); // 'group' | 'user'
  const [threadId, setThreadId] = useState("");
  const [messageText, setMessageText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaType, setMediaType] = useState("auto");
  const [ttlSecs, setTtlSecs] = useState(0);
  const [sending, setSending] = useState(false);

  // Broadcast form
  const [selectedGroupIds, setSelectedGroupIds] = useState([]);
  const [broadcastSearch, setBroadcastSearch] = useState("");
  const [broadcastText, setBroadcastText] = useState("");
  const [broadcastMediaUrl, setBroadcastMediaUrl] = useState("");
  const [delaySecs, setDelaySecs] = useState(5);
  const [broadcastResult, setBroadcastResult] = useState(null);

  // Remote command execution form
  const [cmdThreadId, setCmdThreadId] = useState("web_remote_console");
  const [commandInput, setCommandInput] = useState("menu");
  const [deliverToZalo, setDeliverToZalo] = useState(false);
  const [cmdOutput, setCmdOutput] = useState(null);
  const [catalogCommands, setCatalogCommands] = useState([]);

  useEffect(() => {
    v4Fetch("/api/studio/commands")
      .then((res) => {
        const list = Array.isArray(res) ? res : Array.isArray(res?.commands) ? res.commands : [];
        setCatalogCommands(list);
      })
      .catch(() => {});
  }, []);

  const loadTargets = useCallback(async (botId) => {
    if (!botId) return;
    setLoadingTargets(true);
    try {
      const [gRes, fRes] = await Promise.all([
        v4Fetch(`/api/bots/${encodeURIComponent(botId)}/groups`).catch(() => null),
        v4Fetch(`/api/bots/${encodeURIComponent(botId)}/friends`).catch(() => null),
      ]);
      const gList = Array.isArray(gRes) ? gRes : Array.isArray(gRes?.groups) ? gRes.groups : [];
      const fList = Array.isArray(fRes) ? fRes : Array.isArray(fRes?.friends) ? fRes.friends : [];
      setGroups(gList);
      setFriends(fList);
      if (gList.length > 0) {
        const firstGid = String(gList[0].threadId || gList[0].id || "");
        setThreadId((curr) => curr || firstGid);
        setCmdThreadId((curr) => {
          if (!curr || curr === "web_remote_console") {
            setDeliverToZalo(true);
            return firstGid;
          }
          return curr;
        });
      }
    } finally {
      setLoadingTargets(false);
    }
  }, []);

  useEffect(() => {
    if (activeBot?.id) {
      loadTargets(activeBot.id);
    }
  }, [activeBot?.id, loadTargets]);

  const handleSendSingle = async (e) => {
    e.preventDefault();
    if (!activeBot) return;
    if (!threadId.trim()) {
      notify("Vui lòng chọn Nhóm / Người nhận hoặc nhập Thread ID.", "error");
      return;
    }
    if (!messageText.trim() && !mediaUrl.trim()) {
      notify("Vui lòng nhập nội dung tin nhắn hoặc link Ảnh/Video.", "error");
      return;
    }
    setSending(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/remote/send-message`, {
        method: "POST",
        body: {
          threadId: threadId.trim(),
          threadType: targetType,
          targetType,
          text: messageText,
          mediaUrl: mediaUrl.trim() || undefined,
          mediaType,
          ttlMs: Number(ttlSecs) > 0 ? Number(ttlSecs) * 1000 : undefined,
        },
      });
      notify("Đã gửi tin nhắn từ xa thành công!", "success");
      setMessageText("");
    } catch (err) {
      notify(err.message || "Gửi tin nhắn từ xa thất bại", "error");
    } finally {
      setSending(false);
    }
  };

  const filteredBroadcastGroups = useMemo(() => {
    const q = broadcastSearch.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        String(g.name || "").toLowerCase().includes(q) ||
        String(g.threadId || g.id || "").toLowerCase().includes(q)
    );
  }, [groups, broadcastSearch]);

  const toggleBroadcastGroup = (gid) => {
    setSelectedGroupIds((prev) =>
      prev.includes(gid) ? prev.filter((x) => x !== gid) : [...prev, gid]
    );
  };

  const handleStartBroadcast = async (e) => {
    e.preventDefault();
    if (!activeBot) return;
    if (selectedGroupIds.length === 0) {
      notify("Vui lòng tích chọn ít nhất 1 nhóm để gửi thông báo hàng loạt.", "error");
      return;
    }
    if (!broadcastText.trim() && !broadcastMediaUrl.trim()) {
      notify("Vui lòng nhập nội dung thông báo hàng loạt.", "error");
      return;
    }
    setSending(true);
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/remote/broadcast`, {
        method: "POST",
        body: {
          threadIds: selectedGroupIds,
          text: broadcastText,
          mediaUrl: broadcastMediaUrl.trim() || undefined,
          delayMs: Math.max(1000, Number(delaySecs) * 1000),
        },
      });
      setBroadcastResult(res);
      notify(`Đã phát lệnh gửi Broadcast tới ${selectedGroupIds.length} nhóm!`, "success");
    } catch (err) {
      notify(err.message || "Gửi thông báo hàng loạt thất bại", "error");
    } finally {
      setSending(false);
    }
  };

  const handleExecuteCommand = async (e) => {
    if (e) e.preventDefault();
    if (!activeBot) return;
    if (!commandInput.trim()) {
      notify("Vui lòng nhập tên lệnh cần chạy.", "error");
      return;
    }
    setSending(true);
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/remote/execute-command`, {
        method: "POST",
        body: {
          commandLine: commandInput.trim(),
          threadId: cmdThreadId.trim() || "web_remote_console",
          deliverToZalo,
        },
      });
      setCmdOutput(res);
      notify("Đã thực thi lệnh từ xa thành công!", "success");
    } catch (err) {
      notify(err.message || "Chạy lệnh từ xa thất bại", "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="v4-card">
      <div className="v4-card-header">
        <div>
          <h2>🎮 Trung Tâm Điều Khiển Bot Từ Xa</h2>
          <div className="v4-muted">
            Nhắn tin, gửi ảnh/video, phát thông báo hàng loạt chống khóa acc và chạy trực tiếp 218 lệnh ngay trên trình duyệt.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="v4-select"
            style={{ minWidth: 250 }}
            value={activeBot?.id || ""}
            onChange={(e) => setSelectedBotId(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.isMain ? "★ [ADMIN] " : ""}
                {b.displayName} ({b.cookieDead ? "Cookie Hết Hạn" : b.wsConnected ? "Online" : b.status})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="v4-btn"
            disabled={!activeBot || loadingTargets}
            onClick={() => activeBot && loadTargets(activeBot.id)}
          >
            {loadingTargets ? "Đang tải..." : "↻ Tải lại Nhóm & Bạn bè"}
          </button>
        </div>
      </div>

      <div className="v4-tabs">
        <button
          type="button"
          className={`v4-tab ${tab === "chat" ? "active" : ""}`}
          onClick={() => setTab("chat")}
        >
          💬 Gửi Tin Nhắn / Ảnh - Video Đơn Lẻ
        </button>
        <button
          type="button"
          className={`v4-tab ${tab === "broadcast" ? "active" : ""}`}
          onClick={() => setTab("broadcast")}
        >
          📢 Gửi Thông Báo Hàng Loạt ({groups.length} Nhóm)
        </button>
        <button
          type="button"
          className={`v4-tab ${tab === "console" ? "active" : ""}`}
          onClick={() => setTab("console")}
        >
          ⚡ Bảng Chạy 218 Lệnh Từ Xa
        </button>
      </div>

      {tab === "chat" && (
        <form onSubmit={handleSendSingle}>
          <div className="v4-grid-3">
            <div className="v4-field">
              <label>Loại đích nhận</label>
              <select
                className="v4-select"
                value={targetType}
                onChange={(e) => {
                  const next = e.target.value;
                  setTargetType(next);
                  if (next === "group" && groups[0]) {
                    setThreadId(String(groups[0].threadId || groups[0].id));
                  } else if (next === "user" && friends[0]) {
                    setThreadId(String(friends[0].uid || friends[0].userId || friends[0].id));
                  }
                }}
              >
                <option value="group">Nhóm Zalo (Box Chat — {groups.length})</option>
                <option value="user">Cá nhân / Bạn bè ({friends.length})</option>
              </select>
            </div>

            <div className="v4-field">
              <label>Chọn nhanh từ danh sách đang tham gia</label>
              <select
                className="v4-select"
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
              >
                <option value="">-- Chọn đích nhận --</option>
                {targetType === "group"
                  ? groups.map((g) => {
                      const gid = String(g.threadId || g.id);
                      return (
                        <option key={gid} value={gid}>
                          {g.name || `Nhóm ${gid}`} ({g.memberCount || "--"} TV)
                        </option>
                      );
                    })
                  : friends.map((f) => {
                      const uid = String(f.uid || f.userId || f.id);
                      return (
                        <option key={uid} value={uid}>
                          {f.displayName || f.zaloName || uid} ({uid})
                        </option>
                      );
                    })}
              </select>
            </div>

            <div className="v4-field">
              <label>Hoặc nhập trực tiếp Thread ID / UID</label>
              <input
                className="v4-input v4-mono"
                value={threadId}
                onChange={(e) => setThreadId(e.target.value)}
                placeholder="Nhập mã nhóm hoặc UID Zalo..."
              />
            </div>
          </div>

          <div className="v4-field">
            <label>Nội dung tin nhắn cần gửi</label>
            <textarea
              className="v4-textarea"
              rows={4}
              placeholder="Nhập tin nhắn bạn muốn Bot gửi vào nhóm hoặc cá nhân..."
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
            />
          </div>

          <div className="v4-grid-3">
            <div className="v4-field">
              <label>Link đính kèm Ảnh / Video / Nhạc (Tùy chọn)</label>
              <input
                className="v4-input"
                placeholder="https://example.com/anh-hoac-video.mp4"
                value={mediaUrl}
                onChange={(e) => setMediaUrl(e.target.value)}
              />
            </div>
            <div className="v4-field">
              <label>Định dạng Media</label>
              <select
                className="v4-select"
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value)}
              >
                <option value="auto">Tự động nhận diện</option>
                <option value="image">Ảnh (JPG / PNG / GIF)</option>
                <option value="video">Video MP4</option>
                <option value="audio">Âm thanh / Voice</option>
              </select>
            </div>
            <div className="v4-field">
              <label>Tự hủy tin nhắn sau (Giây — 0 là giữ vĩnh viễn)</label>
              <input
                type="number"
                min={0}
                className="v4-input"
                value={ttlSecs}
                onChange={(e) => setTtlSecs(e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="v4-btn primary" disabled={sending}>
              {sending ? "Đang gửi..." : "🚀 Gửi Tin Nhắn Ngay"}
            </button>
          </div>
        </form>
      )}

      {tab === "broadcast" && (
        <form onSubmit={handleStartBroadcast}>
          <div className="v4-grid-2">
            <div>
              <div className="v4-toolbar">
                <input
                  className="v4-input"
                  style={{ flex: 1 }}
                  placeholder="Tìm kiếm nhóm để tích chọn..."
                  value={broadcastSearch}
                  onChange={(e) => setBroadcastSearch(e.target.value)}
                />
                <button
                  type="button"
                  className="v4-btn sm"
                  onClick={() =>
                    setSelectedGroupIds(
                      filteredBroadcastGroups.map((g) => String(g.threadId || g.id))
                    )
                  }
                >
                  Chọn tất cả
                </button>
                <button
                  type="button"
                  className="v4-btn sm"
                  onClick={() => setSelectedGroupIds([])}
                >
                  Bỏ chọn
                </button>
              </div>

              <div
                style={{
                  maxHeight: 310,
                  overflowY: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 8,
                }}
              >
                {filteredBroadcastGroups.length === 0 ? (
                  <div className="v4-muted" style={{ padding: 12 }}>
                    Không có nhóm nào để hiển thị. Hãy đảm bảo Bot đang Online và bấm “Tải lại Nhóm”.
                  </div>
                ) : (
                  filteredBroadcastGroups.map((g) => {
                    const gid = String(g.threadId || g.id);
                    const checked = selectedGroupIds.includes(gid);
                    return (
                      <label
                        key={gid}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "7px 8px",
                          borderBottom: "1px solid var(--border)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBroadcastGroup(gid)}
                        />
                        <div>
                          <div style={{ fontWeight: 600 }}>{g.name || `Nhóm ${gid}`}</div>
                          <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                            ID: {gid} • {g.memberCount || "--"} thành viên
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <div className="v4-field">
                <label>
                  Nội dung thông báo gửi tới <strong>{selectedGroupIds.length}</strong> nhóm đã chọn
                </label>
                <textarea
                  className="v4-textarea"
                  rows={5}
                  placeholder="Nhập thông báo chung cho các nhóm..."
                  value={broadcastText}
                  onChange={(e) => setBroadcastText(e.target.value)}
                />
              </div>
              <div className="v4-field">
                <label>Link Ảnh / Video đính kèm (Tùy chọn)</label>
                <input
                  className="v4-input"
                  placeholder="https://..."
                  value={broadcastMediaUrl}
                  onChange={(e) => setBroadcastMediaUrl(e.target.value)}
                />
              </div>
              <div className="v4-field">
                <label>
                  Độ trễ giãn cách giữa mỗi nhóm chống khóa Zalo: <strong>{delaySecs} giây / nhóm</strong>
                </label>
                <input
                  type="range"
                  min={3}
                  max={30}
                  value={delaySecs}
                  onChange={(e) => setDelaySecs(Number(e.target.value))}
                />
              </div>

              {(broadcastProgress || broadcastResult) && (
                <div className="v4-card" style={{ marginBottom: 12, padding: 12 }}>
                  <div style={{ fontWeight: 700 }}>
                    Tiến độ Broadcast:{" "}
                    {broadcastProgress
                      ? `${broadcastProgress.sent || 0}/${broadcastProgress.total || selectedGroupIds.length} nhóm (Lỗi: ${broadcastProgress.failed || 0})`
                      : broadcastResult?.message || `Đã xếp hàng gửi tới ${selectedGroupIds.length} nhóm`}
                  </div>
                </div>
              )}

              <button type="submit" className="v4-btn success" style={{ width: "100%" }} disabled={sending}>
                {sending
                  ? "Đang khởi chạy chiến dịch Broadcast..."
                  : `📢 Phát Thông Báo An Toàn Tới ${selectedGroupIds.length} Nhóm`}
              </button>
            </div>
          </div>
        </form>
      )}

      {tab === "console" && (
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {QUICK_COMMANDS.map((q) => (
              <button
                key={q.cmd}
                type="button"
                className="v4-btn sm"
                onClick={() => setCommandInput(q.cmd)}
              >
                ⚡ {q.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleExecuteCommand}>
            <div className="v4-grid-2">
              <div className="v4-field">
                <label>
                  Lệnh cần thực thi (Gợi ý sẵn {catalogCommands.length || 218} lệnh — không bắt buộc gõ dấu `!`)
                </label>
                <input
                  className="v4-input v4-mono"
                  list="v4-218-cmd-datalist"
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  placeholder="Ví dụ: menu, bot on, detail, group, thoitiet Hà Nội, kick @uid..."
                />
                <datalist id="v4-218-cmd-datalist">
                  {catalogCommands.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.description || c.syntax || c.name}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="v4-field">
                <label>Ngữ cảnh Nhóm áp dụng (Thread ID)</label>
                <select
                  className="v4-select"
                  value={cmdThreadId}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setCmdThreadId(nextVal);
                    if (nextVal === "web_remote_console") {
                      setDeliverToZalo(false);
                    } else {
                      setDeliverToZalo(true);
                    }
                  }}
                >
                  <option value="web_remote_console">Chạy nội bộ trên Web (Không gửi ra Zalo)</option>
                  {groups.map((g) => {
                    const gid = String(g.threadId || g.id);
                    return (
                      <option key={gid} value={gid}>
                        {g.name || `Nhóm ${gid}`} ({gid})
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

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
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={deliverToZalo && cmdThreadId !== "web_remote_console"}
                  disabled={cmdThreadId === "web_remote_console"}
                  onChange={(e) => setDeliverToZalo(e.target.checked)}
                />
                <span>Đồng thời gửi thẳng câu trả lời của lệnh này ra nhóm Zalo đã chọn</span>
              </label>

              <button type="submit" className="v4-btn primary" disabled={sending}>
                {sending ? "Đang xử lý lệnh..." : "▶ Thực Thi Lệnh Ngay"}
              </button>
            </div>
          </form>

          {cmdOutput && (
            <div className="v4-log-box" style={{ height: 260 }}>
              <div style={{ color: "#38bdf8", fontWeight: 700, marginBottom: 8 }}>
                [Kết quả thực thi lệnh `{commandInput}`]
              </div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                {cmdOutput.replyText ||
                  cmdOutput.output ||
                  JSON.stringify(cmdOutput, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
