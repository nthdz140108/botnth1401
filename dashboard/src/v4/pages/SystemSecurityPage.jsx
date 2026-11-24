import React, { useCallback, useEffect, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { v4Fetch } from "../http.js";

export default function SystemSecurityPage() {
  const { session, notify, refreshAll } = useControlCenter();

  // Password change form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPw, setChangingPw] = useState(false);

  // Provider AI keys form
  const [providers, setProviders] = useState({
    geminiApiKey: "",
    openaiApiKey: "",
    weatherApiKey: "",
    proxyUrl: "",
  });
  const [providerMeta, setProviderMeta] = useState(null);
  const [savingProviders, setSavingProviders] = useState(false);

  // Doctor & Maintenance state
  const [doctorReport, setDoctorReport] = useState(null);
  const [runningTask, setRunningTask] = useState("");

  const loadProviderSummary = useCallback(async () => {
    try {
      const data = await v4Fetch("/api/provider-config");
      setProviderMeta(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadProviderSummary();
  }, [loadProviderSummary]);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      notify("Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.", "error");
      return;
    }
    if (newPassword.length < 6) {
      notify("Mật khẩu mới cần dài tối thiểu 6 ký tự.", "error");
      return;
    }
    if (newPassword !== confirmPassword) {
      notify("Xác nhận mật khẩu mới không trùng khớp.", "error");
      return;
    }
    setChangingPw(true);
    try {
      await v4Fetch("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      notify("Đã đổi mật khẩu đăng nhập Web Admin thành công!", "success");
    } catch (err) {
      notify(err.message || "Đổi mật khẩu thất bại", "error");
    } finally {
      setChangingPw(false);
    }
  };

  const handleSaveProviders = async (e) => {
    e.preventDefault();
    const payload = {};
    for (const [k, v] of Object.entries(providers)) {
      if (v && v.trim()) payload[k] = v.trim();
    }
    if (Object.keys(payload).length === 0) {
      notify("Hãy nhập ít nhất 1 khóa API cần cập nhật.", "info");
      return;
    }
    setSavingProviders(true);
    try {
      await v4Fetch("/api/provider-config", {
        method: "PUT",
        body: payload,
      });
      setProviders({ geminiApiKey: "", openaiApiKey: "", weatherApiKey: "", proxyUrl: "" });
      notify("Đã mã hóa và lưu các khóa API dịch vụ thành công!", "success");
      await loadProviderSummary();
    } catch (err) {
      notify(err.message || "Lưu khóa API thất bại", "error");
    } finally {
      setSavingProviders(false);
    }
  };

  const handleRunDoctor = async () => {
    setRunningTask("doctor");
    try {
      const report = await v4Fetch("/api/system/doctor");
      setDoctorReport(report);
      notify("Đã hoàn tất kiểm tra sức khỏe toàn hệ thống!", "success");
    } catch (err) {
      notify(err.message || "Không thể chạy Bác Sĩ Hệ Thống", "error");
    } finally {
      setRunningTask("");
    }
  };

  const handleMigrateV3 = async () => {
    setRunningTask("migrate");
    try {
      const res = await v4Fetch("/api/system/migrate-v3", {
        method: "POST",
        body: {},
      });
      notify(res?.message || "Đã đồng bộ dữ liệu V3 sang cơ sở dữ liệu thành công!", "success");
      await refreshAll();
    } catch (err) {
      notify(err.message || "Đồng bộ dữ liệu V3 thất bại", "error");
    } finally {
      setRunningTask("");
    }
  };

  const handleCleanupTemp = async () => {
    setRunningTask("cleanup");
    try {
      const res = await v4Fetch("/api/system/disk-cleanup", {
        method: "POST",
        body: {},
      });
      notify(res?.message || "Đã dọn dẹp bộ nhớ đệm ảnh/video tạm thời!", "success");
    } catch (err) {
      notify(err.message || "Dọn rác tạm thất bại", "error");
    } finally {
      setRunningTask("");
    }
  };

  const handleDownloadBackup = async () => {
    try {
      const data = await v4Fetch("/api/system/backup/download");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mybot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify("Đã tải xuống tệp sao lưu cấu hình an toàn!", "success");
    } catch (err) {
      notify(err.message || "Tải bản sao lưu thất bại", "error");
    }
  };

  return (
    <div className="v4-grid-2">
      {/* Web Admin Password Card */}
      <div className="v4-card">
        <div className="v4-card-header">
          <div>
            <h2>🔐 Tài Khoản & Mật Khẩu Web Admin</h2>
            <div className="v4-muted">
              Đang đăng nhập dưới tên: <strong>{session?.username || session?.user?.username || "admin"}</strong>
            </div>
          </div>
        </div>

        <form onSubmit={handleChangePassword}>
          <div className="v4-field">
            <label>Mật khẩu Web Admin hiện tại</label>
            <input
              type="password"
              className="v4-input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="v4-field">
            <label>Mật khẩu mới (Tối thiểu 6 ký tự)</label>
            <input
              type="password"
              className="v4-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div className="v4-field">
            <label>Nhập lại mật khẩu mới</label>
            <input
              type="password"
              className="v4-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="v4-btn primary" disabled={changingPw}>
            {changingPw ? "Đang cập nhật..." : "Đổi Mật Khẩu Đăng Nhập Web"}
          </button>
        </form>
      </div>

      {/* System Doctor & 1-Click Maintenance */}
      <div className="v4-card">
        <div className="v4-card-header">
          <div>
            <h2>🩺 Bác Sĩ Hệ Thống & Bảo Trì 1-Click</h2>
            <div className="v4-muted">
              Thay thế mọi thao tác dòng lệnh bảo trì, dọn rác, sao lưu và đồng bộ dữ liệu.
            </div>
          </div>
        </div>

        <div className="v4-grid-2" style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="v4-btn primary"
            disabled={Boolean(runningTask)}
            onClick={handleRunDoctor}
          >
            {runningTask === "doctor" ? "Đang chẩn đoán..." : "🩺 Chạy Bác Sĩ Hệ Thống"}
          </button>

          <button
            type="button"
            className="v4-btn"
            disabled={Boolean(runningTask)}
            onClick={handleCleanupTemp}
          >
            {runningTask === "cleanup" ? "Đang dọn dẹp..." : "🧹 Dọn Rác Ảnh/Video Tạm"}
          </button>

          <button
            type="button"
            className="v4-btn"
            disabled={Boolean(runningTask)}
            onClick={handleMigrateV3}
          >
            {runningTask === "migrate" ? "Đang đồng bộ..." : "🔄 Đồng Bộ Dữ Liệu V3 → V4"}
          </button>

          <button type="button" className="v4-btn success" onClick={handleDownloadBackup}>
            📥 Tải Bản Sao Lưu Cấu Hình
          </button>
        </div>

        {doctorReport && (
          <div className="v4-log-box" style={{ height: 210 }}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
              {JSON.stringify(doctorReport, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* AI & External Provider Keys */}
      <div className="v4-card" style={{ gridColumn: "1 / -1" }}>
        <div className="v4-card-header">
          <div>
            <h2>🤖 Cấu Hình Khóa API Trí Tuệ Nhân Tạo (Gemini / OpenAI / Proxy)</h2>
            <div className="v4-muted">
              Các khóa bí mật được mã hóa trên máy chủ và không bao giờ hiển thị ngược lại ra trình duyệt.
            </div>
          </div>
          {providerMeta && (
            <span className="v4-badge info">Đã kết nối Kho Khóa An Toàn</span>
          )}
        </div>

        <form onSubmit={handleSaveProviders}>
          <div className="v4-grid-2">
            <div className="v4-field">
              <label>Google Gemini API Key (Cho lệnh chat AI / phân tích ảnh)</label>
              <input
                type="password"
                className="v4-input v4-mono"
                placeholder="AIzaSy... (Bỏ trống nếu giữ nguyên)"
                value={providers.geminiApiKey}
                onChange={(e) => setProviders((p) => ({ ...p, geminiApiKey: e.target.value }))}
              />
            </div>
            <div className="v4-field">
              <label>OpenAI / Tương thích GPT API Key (Tùy chọn)</label>
              <input
                type="password"
                className="v4-input v4-mono"
                placeholder="sk-... (Bỏ trống nếu giữ nguyên)"
                value={providers.openaiApiKey}
                onChange={(e) => setProviders((p) => ({ ...p, openaiApiKey: e.target.value }))}
              />
            </div>
            <div className="v4-field">
              <label>Weather / Tiện ích API Key (Tùy chọn)</label>
              <input
                type="password"
                className="v4-input v4-mono"
                placeholder="Bỏ trống nếu giữ nguyên"
                value={providers.weatherApiKey}
                onChange={(e) => setProviders((p) => ({ ...p, weatherApiKey: e.target.value }))}
              />
            </div>
            <div className="v4-field">
              <label>HTTP/SOCKS5 Proxy mặc định cho Zalo (Tùy chọn)</label>
              <input
                className="v4-input v4-mono"
                placeholder="http://user:pass@ip:port"
                value={providers.proxyUrl}
                onChange={(e) => setProviders((p) => ({ ...p, proxyUrl: e.target.value }))}
              />
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="v4-btn success" disabled={savingProviders}>
              {savingProviders ? "Đang mã hóa..." : "💾 Lưu Kho Khóa API"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
