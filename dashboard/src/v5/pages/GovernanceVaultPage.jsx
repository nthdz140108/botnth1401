import React, { useCallback, useEffect, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatBytesVi, formatDateVi, formatDurationVi, v4Fetch } from "../../v4/http.js";

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

const ROLE_LABELS = {
  super_admin: { label: "👑 Super Admin", badge: "danger" },
  operator: { label: "🛠️ Kỹ Thuật Viên (Operator)", badge: "info" },
  reseller: { label: "💎 Đại Lý Phân Phối (Reseller)", badge: "warning" },
  bot_owner: { label: "🎫 Chủ Thuê Bot (Bot Owner)", badge: "success" },
};

const SNAPSHOT_SCOPES = [
  { id: "bots", label: "🤖 Hồ sơ & Danh sách Đội hình Bot (bots)" },
  { id: "groups", label: "🛡️ Cấu hình Nhóm & 17 Khiên (groups)" },
  { id: "commandStudio", label: "⚙️ Command Studio 218 Lệnh & Lịch 24h (commandStudio)" },
  { id: "crm", label: "💎 Khách thuê SaaS & Mã Giftcode (crm)" },
  { id: "presets", label: "📦 Bộ mẫu Khiên & Chiến dịch (presets)" },
];

export default function GovernanceVaultPage() {
  const {
    session,
    bots = [],
    enrichedFleet = [],
    notify,
    refreshAll,
    v5Fetch,
  } = useV5();

  const botList = enrichedFleet?.length ? enrichedFleet : bots;
  const [tab, setTab] = useState("iam");

  // =========================================================================
  // SUB-TAB 1: IAM RBAC, 2FA TOTP & DEVICE SESSIONS STATE
  // =========================================================================
  const [iamUsers, setIamUsers] = useState([]);
  const [editingUserId, setEditingUserId] = useState("");
  const [userForm, setUserForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "bot_owner",
    quota: 1,
    ownerUid: "",
    accessCode: "",
    allowedBots: [],
    active: true,
  });
  const [savingUser, setSavingUser] = useState(false);

  const [totpSetupData, setTotpSetupData] = useState(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [busy2fa, setBusy2fa] = useState(false);

  const [deviceSessions, setDeviceSessions] = useState([]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPw, setChangingPw] = useState(false);

  // =========================================================================
  // SUB-TAB 2: AI ROTATING KEY POOL & VISUAL SYSTEM DOCTOR STATE
  // =========================================================================
  const [keyPool, setKeyPool] = useState({
    rotationMode: "round_robin",
    geminiKeys: [],
    openaiKeys: [],
    weatherKeys: [],
    defaultProxy: "",
  });
  const [newGeminiInput, setNewGeminiInput] = useState("");
  const [newOpenaiInput, setNewOpenaiInput] = useState("");
  const [newWeatherInput, setNewWeatherInput] = useState("");
  const [providerMeta, setProviderMeta] = useState(null);
  const [savingPool, setSavingPool] = useState(false);

  const [doctorReport, setDoctorReport] = useState(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState("");
  const [maintenanceBanner, setMaintenanceBanner] = useState(null);

  // =========================================================================
  // SUB-TAB 3: MULTI-VERSION SNAPSHOT VAULT STATE
  // =========================================================================
  const [snapshots, setSnapshots] = useState([]);
  const [snapName, setSnapName] = useState("");
  const [snapPassword, setSnapPassword] = useState("");
  const [creatingSnap, setCreatingSnap] = useState(false);

  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [restoreScopes, setRestoreScopes] = useState(["bots", "groups", "commandStudio", "crm", "presets"]);
  const [restorePassword, setRestorePassword] = useState("");
  const [externalBackupBundle, setExternalBackupBundle] = useState(null);
  const [externalBackupName, setExternalBackupName] = useState("");
  const [restorePreview, setRestorePreview] = useState(null);
  const [restoringSnap, setRestoringSnap] = useState(false);

  // Load IAM Users & Sessions
  const loadIamData = useCallback(async () => {
    const [uRes, sRes] = await Promise.all([
      callV5(v5Fetch, "/iam/users").catch(() => null),
      callV5(v5Fetch, "/iam/sessions").catch(() => null),
    ]);
    if (uRes) {
      const list = Array.isArray(uRes)
        ? uRes
        : Array.isArray(uRes.users)
          ? uRes.users
          : Array.isArray(uRes.items)
            ? uRes.items
            : [];
      setIamUsers(list);
      if (uRes.totpEnabled !== undefined) setTotpEnabled(Boolean(uRes.totpEnabled));
    }
    if (sRes) {
      const sList = Array.isArray(sRes)
        ? sRes
        : Array.isArray(sRes.sessions)
          ? sRes.sessions
          : Array.isArray(sRes.items)
            ? sRes.items
            : [];
      setDeviceSessions(sList);
      if (sRes.totpEnabled !== undefined) setTotpEnabled(Boolean(sRes.totpEnabled));
    }
  }, [v5Fetch]);

  // Load AI Key Pool & System Doctor
  const loadProvidersAndDoctor = useCallback(async () => {
    const [poolRes, provRes, docRes] = await Promise.all([
      callV5(v5Fetch, "/providers/pool").catch(() => null),
      v4Fetch("/api/provider-config").catch(() => null),
      v4Fetch("/api/system/doctor").catch(() => null),
    ]);

    if (poolRes) {
      const p = poolRes.pool || poolRes;
      setKeyPool({
        rotationMode: p.rotationMode || p.strategy || "round_robin",
        geminiKeys: Array.isArray(p.geminiKeys || p.gemini) ? p.geminiKeys || p.gemini : [],
        openaiKeys: Array.isArray(p.openaiKeys || p.openai) ? p.openaiKeys || p.openai : [],
        weatherKeys: Array.isArray(p.weatherKeys || p.weather) ? p.weatherKeys || p.weather : [],
        defaultProxy: p.defaultProxy || p.proxyUrl || "",
      });
    }
    if (provRes) setProviderMeta(provRes);
    if (docRes) setDoctorReport(docRes);
  }, [v5Fetch]);

  // Load Snapshots Vault
  const loadSnapshots = useCallback(async () => {
    try {
      const res = await callV5(v5Fetch, "/snapshots");
      const list = Array.isArray(res)
        ? res
        : Array.isArray(res?.snapshots)
          ? res.snapshots
          : Array.isArray(res?.items)
            ? res.items
            : [];
      setSnapshots(list);
      if (list.length > 0) {
        setSelectedSnapshotId((curr) => curr || String(list[0].id || list[0].name));
      }
    } catch {
      setSnapshots([]);
    }
  }, [v5Fetch]);

  useEffect(() => {
    loadIamData();
    loadProvidersAndDoctor();
    loadSnapshots();
  }, [loadIamData, loadProvidersAndDoctor, loadSnapshots]);

  // =========================================================================
  // IAM USER CRUD HANDLERS
  // =========================================================================
  const resetUserForm = () => {
    setEditingUserId("");
    setUserForm({
      username: "",
      displayName: "",
      password: "",
      role: "bot_owner",
      quota: 1,
      ownerUid: "",
      accessCode: "",
      allowedBots: [],
      active: true,
    });
  };

  const handleSaveIamUser = async (e) => {
    e.preventDefault();
    if (!userForm.username.trim()) {
      notify("Vui lòng nhập Tên đăng nhập (username).", "error");
      return;
    }
    if (!editingUserId && !userForm.password.trim() && userForm.role !== "bot_owner") {
      notify("Vui lòng đặt mật khẩu cho tài khoản mới.", "error");
      return;
    }
    setSavingUser(true);
    try {
      const payload = {
        username: userForm.username.trim(),
        displayName: userForm.displayName.trim() || userForm.username.trim(),
        ...(userForm.password.trim() ? { password: userForm.password.trim() } : {}),
        role: userForm.role,
        quota: Number(userForm.quota) || 1,
        quotaMaxBots: Number(userForm.quota) || 1,
        maxBots: Number(userForm.quota) || 1,
        ownerUid: userForm.ownerUid.trim() || undefined,
        accessCode: userForm.accessCode.trim() || undefined,
        allowedBots: userForm.allowedBots,
        allowedBotIds: userForm.allowedBots,
        active: Boolean(userForm.active),
        disabled: !userForm.active,
      };

      if (editingUserId) {
        await callV5(v5Fetch, `/iam/users/${encodeURIComponent(editingUserId)}`, {
          method: "PUT",
          body: payload,
        });
        notify(`Đã cập nhật tài khoản "${payload.username}"!`, "success");
      } else {
        await callV5(v5Fetch, "/iam/users", {
          method: "POST",
          body: payload,
        });
        notify(`Đã tạo tài khoản IAM "${payload.username}" thành công!`, "success");
      }
      resetUserForm();
      await loadIamData();
    } catch (err) {
      notify(err.message || "Lưu tài khoản IAM thất bại", "error");
    } finally {
      setSavingUser(false);
    }
  };

  const handleEditUserClick = (u) => {
    setEditingUserId(String(u.id || u.username));
    setUserForm({
      username: u.username || "",
      displayName: u.displayName || u.name || "",
      password: "",
      role: u.role || "bot_owner",
      quota: Number(u.quotaMaxBots ?? u.quota ?? u.maxBots ?? 1),
      ownerUid: u.ownerUid || "",
      accessCode: u.accessCode || "",
      allowedBots: Array.isArray(u.allowedBotIds)
        ? u.allowedBotIds
        : Array.isArray(u.allowedBots)
          ? u.allowedBots
          : [],
      active: u.disabled ? false : u.active !== false,
    });
  };

  const handleDeleteIamUser = async (u) => {
    const uid = String(u.id || u.username);
    if (!window.confirm(`Xóa tài khoản IAM "${u.username}"?`)) return;
    try {
      await callV5(v5Fetch, `/iam/users/${encodeURIComponent(uid)}`, { method: "DELETE" });
      notify(`Đã xóa tài khoản "${u.username}".`, "info");
      await loadIamData();
    } catch (err) {
      notify(err.message || "Xóa tài khoản thất bại", "error");
    }
  };

  // 2FA TOTP Setup / Enable / Disable
  const handleSetup2FA = async () => {
    setBusy2fa(true);
    try {
      const res = await callV5(v5Fetch, "/iam/2fa/setup", { method: "POST", body: {} });
      setTotpSetupData(res);
      notify("Đã khởi tạo khóa 2FA TOTP — Hãy quét mã QR bằng Google Authenticator!", "info");
    } catch (err) {
      notify(err.message || "Không thể khởi tạo 2FA TOTP", "error");
    } finally {
      setBusy2fa(false);
    }
  };

  const handleEnable2FA = async () => {
    if (!totpCode.trim()) {
      notify("Vui lòng nhập mã 6 chữ số từ ứng dụng Authenticator.", "error");
      return;
    }
    setBusy2fa(true);
    try {
      await callV5(v5Fetch, "/iam/2fa/enable", {
        method: "POST",
        body: { token: totpCode.trim(), code: totpCode.trim() },
      });
      setTotpEnabled(true);
      setTotpCode("");
      notify("Đã kích hoạt bảo mật 2 lớp (2FA TOTP) thành công!", "success");
    } catch (err) {
      notify(err.message || "Mã xác thực 2FA không hợp lệ", "error");
    } finally {
      setBusy2fa(false);
    }
  };

  const handleDisable2FA = async () => {
    setBusy2fa(true);
    try {
      await callV5(v5Fetch, "/iam/2fa/disable", {
        method: "POST",
        body: { token: totpCode.trim() || undefined, code: totpCode.trim() || undefined },
      });
      setTotpEnabled(false);
      setTotpSetupData(null);
      setTotpCode("");
      notify("Đã tắt xác thực 2 lớp (2FA).", "info");
    } catch (err) {
      notify(err.message || "Tắt 2FA thất bại", "error");
    } finally {
      setBusy2fa(false);
    }
  };

  const handleRevokeSession = async (sessionId) => {
    try {
      await callV5(v5Fetch, `/iam/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      notify("Đã thu hồi phiên đăng nhập thiết bị!", "success");
      await loadIamData();
    } catch (err) {
      notify(err.message || "Thu hồi phiên thất bại", "error");
    }
  };

  const handleChangeAdminPassword = async (e) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      notify("Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.", "error");
      return;
    }
    if (newPassword.length < 6) {
      notify("Mật khẩu mới phải dài tối thiểu 6 ký tự.", "error");
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
      notify("Đã cập nhật mật khẩu Web Admin chính & đồng bộ .env.local!", "success");
    } catch (err) {
      notify(err.message || "Đổi mật khẩu thất bại", "error");
    } finally {
      setChangingPw(false);
    }
  };

  // =========================================================================
  // SUB-TAB 2 HANDLERS: KEY POOL & SYSTEM DOCTOR
  // =========================================================================
  const parseLinesToKeys = (rawText) =>
    rawText
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleSaveKeyPool = async (e) => {
    e.preventDefault();
    setSavingPool(true);
    try {
      const addedGemini = parseLinesToKeys(newGeminiInput);
      const addedOpenai = parseLinesToKeys(newOpenaiInput);
      const addedWeather = parseLinesToKeys(newWeatherInput);

      const payload = {
        rotationMode: keyPool.rotationMode,
        addGeminiKeys: addedGemini,
        addOpenaiKeys: addedOpenai,
        addWeatherKeys: addedWeather,
        geminiKeys: [
          ...keyPool.geminiKeys.map((k) => (typeof k === "string" ? k : k.id || k.masked)),
          ...addedGemini,
        ].filter(Boolean),
        openaiKeys: [
          ...keyPool.openaiKeys.map((k) => (typeof k === "string" ? k : k.id || k.masked)),
          ...addedOpenai,
        ].filter(Boolean),
        weatherKeys: [
          ...keyPool.weatherKeys.map((k) => (typeof k === "string" ? k : k.id || k.masked)),
          ...addedWeather,
        ].filter(Boolean),
        defaultProxy: keyPool.defaultProxy.trim(),
      };

      await callV5(v5Fetch, "/providers/pool", {
        method: "PUT",
        body: payload,
      }).catch(() => null);

      // Also sync primary keys to `/api/provider-config` if new keys entered
      const singleValues = {};
      if (addedGemini[0]) singleValues.GEMINI_API_KEY = addedGemini[0];
      if (addedOpenai[0]) singleValues.OPENAI_API_KEY = addedOpenai[0];
      if (addedWeather[0]) singleValues.WEATHER_API_KEY = addedWeather[0];
      if (Object.keys(singleValues).length > 0) {
        await v4Fetch("/api/provider-config", {
          method: "PUT",
          body: { values: singleValues },
        }).catch(() => null);
      }

      setNewGeminiInput("");
      setNewOpenaiInput("");
      setNewWeatherInput("");
      notify("Đã mã hóa & cập nhật Kho Khóa AI Xoay Vòng thành công!", "success");
      await loadProvidersAndDoctor();
    } catch (err) {
      notify(err.message || "Cập nhật Kho Khóa AI thất bại", "error");
    } finally {
      setSavingPool(false);
    }
  };

  const handleRemovePoolKey = (groupField, idx) => {
    setKeyPool((prev) => ({
      ...prev,
      [groupField]: prev[groupField].filter((_, i) => i !== idx),
    }));
  };

  const handleRunDoctor = async () => {
    setMaintenanceBusy("doctor");
    try {
      const doc = await v4Fetch("/api/system/doctor");
      setDoctorReport(doc);
      notify("Đã hoàn tất kiểm tra sức khỏe toàn diện!", "success");
    } catch (err) {
      notify(err.message || "Chạy Bác Sĩ Hệ Thống thất bại", "error");
    } finally {
      setMaintenanceBusy("");
    }
  };

  const handleDiskCleanup = async () => {
    setMaintenanceBusy("cleanup");
    try {
      const res = await v4Fetch("/api/system/disk-cleanup", { method: "POST", body: {} });
      const msg =
        res?.message ||
        `Đã giải phóng ${formatBytesVi(res?.bytesFreedTotal || 0)} (${res?.filesFreedTotal || 0} tệp tạm)!`;
      setMaintenanceBanner(msg);
      notify(msg, "success");
    } catch (err) {
      notify(err.message || "Dọn rác ổ đĩa thất bại", "error");
    } finally {
      setMaintenanceBusy("");
    }
  };

  const handleCheckMigrateV3 = async () => {
    setMaintenanceBusy("migrate");
    try {
      const res = await v4Fetch("/api/system/migrate-v3", { method: "POST", body: {} });
      const msg =
        res?.message ||
        `Sẵn sàng đồng bộ ${res?.botsImported || 0} Bot và ${res?.groupsImported || 0} nhóm!`;
      setMaintenanceBanner(msg);
      notify(msg, "success");
      await refreshAll?.();
    } catch (err) {
      notify(err.message || "Kiểm tra đồng bộ V3→V4 thất bại", "error");
    } finally {
      setMaintenanceBusy("");
    }
  };

  // =========================================================================
  // SUB-TAB 3 HANDLERS: SNAPSHOT VAULT & SELECTIVE RESTORE
  // =========================================================================
  const handleCreateSnapshot = async (e) => {
    e.preventDefault();
    setCreatingSnap(true);
    try {
      await callV5(v5Fetch, "/snapshots", {
        method: "POST",
        body: {
          name: snapName.trim() || `Snapshot ${new Date().toLocaleString("vi-VN")}`,
          password: snapPassword.trim() || undefined,
          encrypted: Boolean(snapPassword.trim()),
          scopes: SNAPSHOT_SCOPES.map((s) => s.id),
        },
      });
      setSnapName("");
      setSnapPassword("");
      notify("Đã tạo bản sao lưu đa phiên bản mới trong Két Sắt!", "success");
      await loadSnapshots();
    } catch (err) {
      if (err.status === 404) {
        await v4Fetch("/api/system/backup", { method: "POST", body: {} });
        notify("Đã tạo bản sao lưu hệ thống an toàn!", "success");
        return;
      }
      notify(err.message || "Tạo bản sao lưu thất bại", "error");
    } finally {
      setCreatingSnap(false);
    }
  };

  const handleDownloadSafeBackup = async () => {
    try {
      const data = await v4Fetch("/api/system/backup/download");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mybot-safe-redacted-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify("Đã tải xuống bản sao lưu JSON (đã ẩn thông tin nhạy cảm)!", "success");
    } catch (err) {
      notify(err.message || "Tải bản sao lưu thất bại", "error");
    }
  };

  const handleDownloadSnapshotById = async (snap) => {
    const sid = String(snap.id || snap.name);
    try {
      const data = await callV5(v5Fetch, `/snapshots/${encodeURIComponent(sid)}/download`).catch(
        () => snap
      );
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sid}${snap.encrypted ? ".enc.json" : ".json"}`;
      a.click();
      URL.revokeObjectURL(url);
      notify(`Đã tải bản sao lưu "${snap.name || sid}"!`, "success");
    } catch (err) {
      notify(err.message || "Tải snapshot thất bại", "error");
    }
  };

  const handleExternalBackupUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        setExternalBackupBundle(parsed);
        setExternalBackupName(file.name);
        notify(`Đã nạp tệp sao lưu ngoài "${file.name}" — sẵn sàng Xem trước hoặc Khôi phục!`, "info");
      } catch {
        notify("Tệp tải lên không phải định dạng JSON sao lưu hợp lệ.", "error");
      }
    };
    reader.readAsText(file);
  };

  const handlePreviewRestoreDiff = async () => {
    if (!selectedSnapshotId && !externalBackupBundle) {
      notify("Hãy chọn một Snapshot trong danh sách hoặc tải tệp sao lưu ngoài lên trước.", "warning");
      return;
    }
    setRestoringSnap(true);
    try {
      const res = await callV5(v5Fetch, "/snapshots/preview-restore", {
        method: "POST",
        body: {
          snapshotId: selectedSnapshotId || undefined,
          scopes: restoreScopes,
          modules: restoreScopes,
          password: restorePassword.trim() || undefined,
          bundle: externalBackupBundle || undefined,
          uploadedBundle: externalBackupBundle || undefined,
        },
      });
      setRestorePreview(res);
      notify("Đã phân tích khác biệt (Diff) trước khi khôi phục!", "info");
    } catch (err) {
      notify(err.message || "Xem trước khôi phục thất bại", "error");
    } finally {
      setRestoringSnap(false);
    }
  };

  const handleExecuteSelectiveRestore = async () => {
    if (restoreScopes.length === 0) {
      notify("Vui lòng tích chọn ít nhất 1 phân vùng dữ liệu cần khôi phục.", "error");
      return;
    }
    if (
      !window.confirm(
        `Khôi phục có chọn lọc các phân vùng [${restoreScopes.join(", ")}]? Hệ thống sẽ tự tạo bản sao lưu an toàn trước khi ghi đè.`
      )
    ) {
      return;
    }
    setRestoringSnap(true);
    try {
      const targetId = selectedSnapshotId || "external";
      await callV5(v5Fetch, `/snapshots/${encodeURIComponent(targetId)}/restore`, {
        method: "POST",
        body: {
          scopes: restoreScopes,
          modules: restoreScopes,
          password: restorePassword.trim() || undefined,
          bundle: externalBackupBundle || undefined,
          uploadedBundle: externalBackupBundle || undefined,
        },
      });
      notify("Đã khôi phục cấu hình có chọn lọc thành công!", "success");
      setRestorePreview(null);
      await refreshAll?.();
    } catch (err) {
      notify(err.message || "Khôi phục Snapshot thất bại", "error");
    } finally {
      setRestoringSnap(false);
    }
  };

  const qr2faSrc =
    totpSetupData?.qrDataUrl || totpSetupData?.qrImage || totpSetupData?.qr || "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top Header & Sub-Tabs */}
      <div className="v4-card">
        <div className="v4-card-header" style={{ marginBottom: 12 }}>
          <div>
            <h2>🔐 Quản Trị Phân Quyền IAM, Kho Khóa AI Xoay Vòng & Két Sắt Sao Lưu</h2>
            <div className="v4-muted">
              Phân quyền đa vai trò (Super Admin / Operator / Đại Lý / Chủ Bot), bảo mật 2FA TOTP, xoay vòng API Key chống giới hạn quota và sao lưu mã hóa AES-256.
            </div>
          </div>
        </div>

        <div className="v4-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`v4-tab ${tab === "iam" ? "active" : ""}`}
            onClick={() => setTab("iam")}
          >
            👥 Phân Quyền IAM, Bảo Mật 2FA & Phiên Thiết Bị
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "providers" ? "active" : ""}`}
            onClick={() => setTab("providers")}
          >
            🤖 Kho Khóa AI Xoay Vòng & Bác Sĩ Hệ Thống
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "vault" ? "active" : ""}`}
            onClick={() => setTab("vault")}
          >
            🗄️ Két Sắt Sao Lưu Đa Phiên Bản ({snapshots.length})
          </button>
        </div>
      </div>

      {/* =====================================================================
          SUB-TAB 1: IAM RBAC, 2FA TOTP & ACTIVE SESSIONS
         ===================================================================== */}
      {tab === "iam" && (
        <>
          <div className="v4-grid-2" style={{ gridTemplateColumns: "400px minmax(0, 1fr)" }}>
            {/* Create / Edit IAM User Form */}
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>{editingUserId ? "✏️ Chỉnh Sửa Tài Khoản IAM" : "➕ Cấp Tài Khoản Phân Quyền Mới"}</h3>
                  <div className="v4-muted">Hỗ trợ Đại lý bán lẻ, Cộng tác viên và Chủ thuê Bot tự phục vụ</div>
                </div>
                {editingUserId && (
                  <button type="button" className="v4-btn sm" onClick={resetUserForm}>
                    Hủy sửa
                  </button>
                )}
              </div>

              <form onSubmit={handleSaveIamUser}>
                <div className="v4-grid-2">
                  <div className="v4-field">
                    <label>Tên đăng nhập (Username)</label>
                    <input
                      className="v4-input v4-mono"
                      placeholder="vd: daily_minh"
                      value={userForm.username}
                      onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))}
                    />
                  </div>
                  <div className="v4-field">
                    <label>Tên hiển thị</label>
                    <input
                      className="v4-input"
                      placeholder="Đại Lý Minh..."
                      value={userForm.displayName}
                      onChange={(e) => setUserForm((f) => ({ ...f, displayName: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="v4-grid-2">
                  <div className="v4-field">
                    <label>Vai trò hệ thống (Role)</label>
                    <select
                      className="v4-select"
                      value={userForm.role}
                      onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
                    >
                      <option value="bot_owner">🎫 Chủ Thuê Bot (bot_owner)</option>
                      <option value="reseller">💎 Đại Lý (reseller)</option>
                      <option value="operator">🛠️ Kỹ Thuật Viên (operator)</option>
                      <option value="super_admin">👑 Super Admin</option>
                    </select>
                  </div>
                  <div className="v4-field">
                    <label>Hạn mức số lượng Bot (Quota)</label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      className="v4-input v4-mono"
                      value={userForm.quota}
                      onChange={(e) => setUserForm((f) => ({ ...f, quota: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="v4-grid-2">
                  <div className="v4-field">
                    <label>{editingUserId ? "Đổi mật khẩu (Bỏ trống = giữ nguyên)" : "Mật khẩu đăng nhập"}</label>
                    <input
                      type="password"
                      className="v4-input"
                      placeholder="••••••••"
                      value={userForm.password}
                      onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
                    />
                  </div>
                  <div className="v4-field">
                    <label>Mã Truy Cập Nhanh (Tùy chọn)</label>
                    <input
                      className="v4-input v4-mono"
                      placeholder="OWN-XXXX (Tự sinh nếu trống)"
                      value={userForm.accessCode}
                      onChange={(e) => setUserForm((f) => ({ ...f, accessCode: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="v4-field">
                  <label>Zalo Owner UID liên kết (Tùy chọn)</label>
                  <input
                    className="v4-input v4-mono"
                    placeholder="UID Zalo của khách thuê..."
                    value={userForm.ownerUid}
                    onChange={(e) => setUserForm((f) => ({ ...f, ownerUid: e.target.value }))}
                  />
                </div>

                <div className="v4-field">
                  <label>Danh sách Bot được phép quản lý ({userForm.allowedBots.length})</label>
                  <div
                    style={{
                      maxHeight: 120,
                      overflowY: "auto",
                      padding: 8,
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: "var(--bg-input)",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    {botList.map((b) => {
                      const checked = userForm.allowedBots.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 12 }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setUserForm((f) => ({
                                ...f,
                                allowedBots: checked
                                  ? f.allowedBots.filter((x) => x !== b.id)
                                  : [...f.allowedBots, b.id],
                              }))
                            }
                          />
                          <span>{b.displayName}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <button type="submit" className="v4-btn primary" style={{ width: "100%" }} disabled={savingUser}>
                  {savingUser ? "Đang lưu..." : editingUserId ? "💾 Lưu Cập Nhật Tài Khoản" : "➕ Tạo Tài Khoản IAM"}
                </button>
              </form>
            </div>

            {/* IAM Users List */}
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>Danh Sách Tài Khoản Phân Quyền IAM ({iamUsers.length})</h3>
                  <div className="v4-muted">Kiểm soát hạn ngạch Bot, mã truy cập nhanh OWN-XXXX và quyền thao tác</div>
                </div>
                <button type="button" className="v4-btn sm" onClick={loadIamData}>
                  ↻ Làm mới
                </button>
              </div>

              {iamUsers.length === 0 ? (
                <div className="v4-muted" style={{ padding: 24, textAlign: "center" }}>
                  Chưa có tài khoản phụ nào. Quản trị viên gốc (<code>{session?.username || "admin"}</code>) đang nắm toàn quyền.
                </div>
              ) : (
                <div className="v4-table-wrap">
                  <table className="v4-table">
                    <thead>
                      <tr>
                        <th>Tài khoản</th>
                        <th>Vai trò</th>
                        <th>Mã Nhanh</th>
                        <th>Quota / Bot gán</th>
                        <th>2FA</th>
                        <th>Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {iamUsers.map((u) => {
                        const rMeta = ROLE_LABELS[u.role] || { label: u.role, badge: "neutral" };
                        return (
                          <tr key={u.id || u.username}>
                            <td>
                              <div style={{ fontWeight: 700 }}>{u.displayName || u.username}</div>
                              <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                                @{u.username} {u.ownerUid ? `• UID: ${u.ownerUid}` : ""}
                              </div>
                            </td>
                            <td>
                              <span className={`v4-badge ${rMeta.badge}`}>{rMeta.label}</span>
                            </td>
                            <td className="v4-mono">{u.accessCode || "—"}</td>
                            <td className="v4-mono">
                              {(u.allowedBots || []).length} / {u.quota ?? u.maxBots ?? "∞"} Bot
                            </td>
                            <td>
                              <span className={`v4-badge ${u.totpEnabled ? "success" : "neutral"}`}>
                                {u.totpEnabled ? "Bật" : "Tắt"}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  type="button"
                                  className="v4-btn sm"
                                  onClick={() => handleEditUserClick(u)}
                                >
                                  Sửa
                                </button>
                                <button
                                  type="button"
                                  className="v4-btn sm danger"
                                  onClick={() => handleDeleteIamUser(u)}
                                >
                                  Xóa
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* 2FA TOTP Setup + Change Web Admin Password + Active Sessions */}
          <div className="v4-grid-2">
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>📱 Bảo Mật Xác Thực 2 Lớp (2FA TOTP Authenticator)</h3>
                  <div className="v4-muted">
                    Bảo vệ tài khoản bằng Google Authenticator / Authy kèm 8 mã khôi phục dự phòng.
                  </div>
                </div>
                <span className={`v4-badge ${totpEnabled ? "success" : "warning"}`}>
                  {totpEnabled ? "Đã Kích Hoạt 2FA" : "Chưa Bật 2FA"}
                </span>
              </div>

              {!totpSetupData ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="v4-btn primary"
                    disabled={busy2fa}
                    onClick={handleSetup2FA}
                  >
                    {busy2fa ? "Đang tạo khóa..." : "🔐 Thiết Lập Khóa 2FA & Lấy Mã QR"}
                  </button>
                  {totpEnabled && (
                    <button
                      type="button"
                      className="v4-btn danger"
                      disabled={busy2fa}
                      onClick={handleDisable2FA}
                    >
                      Tắt 2FA
                    </button>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    {qr2faSrc && (
                      <div
                        style={{
                          width: 150,
                          height: 150,
                          background: "#fff",
                          padding: 8,
                          borderRadius: 12,
                        }}
                      >
                        <img
                          src={qr2faSrc}
                          alt="2FA QR"
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div className="v4-muted">Khóa bí mật Base32 (nhập tay nếu không quét được QR):</div>
                      <div className="v4-mono" style={{ fontWeight: 800, fontSize: 15, margin: "4px 0 10px" }}>
                        {totpSetupData.secret || totpSetupData.base32 || "—"}
                      </div>

                      {Array.isArray(totpSetupData.recoveryCodes) && (
                        <div>
                          <div className="v4-muted" style={{ marginBottom: 4 }}>
                            8 Mã Khôi Phục Khẩn Cấp (Lưu giữ nơi an toàn):
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {totpSetupData.recoveryCodes.map((rc) => (
                              <span key={rc} className="v4-badge neutral v4-mono">
                                {rc}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      className="v4-input v4-mono"
                      style={{ maxWidth: 200 }}
                      maxLength={8}
                      placeholder="Nhập mã 6 số TOTP..."
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value)}
                    />
                    <button
                      type="button"
                      className="v4-btn success"
                      disabled={busy2fa}
                      onClick={handleEnable2FA}
                    >
                      ✓ Xác Nhận & Kích Hoạt 2FA
                    </button>
                  </div>
                </div>
              )}

              {/* Web Admin Primary Password Change */}
              <div style={{ borderTop: "1px solid var(--border)", marginTop: 18, paddingTop: 14 }}>
                <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>
                  🔑 Đổi Mật Khẩu Web Admin Gốc (<code>{session?.username || "admin"}</code>)
                </h3>
                <form onSubmit={handleChangeAdminPassword}>
                  <div className="v4-grid-3">
                    <input
                      type="password"
                      className="v4-input"
                      placeholder="Mật khẩu hiện tại"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                    <input
                      type="password"
                      className="v4-input"
                      placeholder="Mật khẩu mới (>= 6 ký tự)"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <input
                      type="password"
                      className="v4-input"
                      placeholder="Nhập lại mật khẩu mới"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                    <button type="submit" className="v4-btn sm primary" disabled={changingPw}>
                      {changingPw ? "Đang lưu..." : "Cập Nhật Mật Khẩu Web Admin"}
                    </button>
                  </div>
                </form>
              </div>
            </div>

            {/* Active Device Sessions Table */}
            <div className="v4-card">
              <div className="v4-card-header">
                <div>
                  <h3>💻 Quản Lý Phiên Thiết Bị Đang Đăng Nhập ({deviceSessions.length})</h3>
                  <div className="v4-muted">Theo dõi IP, trình duyệt và đăng xuất từ xa các thiết bị lạ</div>
                </div>
                <button type="button" className="v4-btn sm" onClick={loadIamData}>
                  ↻ Làm mới
                </button>
              </div>

              {deviceSessions.length === 0 ? (
                <div className="v4-muted" style={{ padding: 18 }}>
                  Đang hoạt động trên phiên quản trị hiện tại ({session?.username || "admin"}).
                </div>
              ) : (
                <div className="v4-table-wrap">
                  <table className="v4-table">
                    <thead>
                      <tr>
                        <th>Tài khoản</th>
                        <th>IP & Trình duyệt</th>
                        <th>Hoạt động cuối</th>
                        <th>Thu hồi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deviceSessions.map((s, idx) => {
                        const sid = String(s.sessionId || s.id || idx);
                        return (
                          <tr key={sid}>
                            <td>
                              <strong>{s.username || "admin"}</strong>
                              {s.current && (
                                <span className="v4-badge success" style={{ marginLeft: 6 }}>
                                  Thiết bị này
                                </span>
                              )}
                            </td>
                            <td>
                              <div className="v4-mono">{s.ip || s.ipAddress || "127.0.0.1"}</div>
                              <div className="v4-muted" style={{ fontSize: 11, maxWidth: 230, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {s.userAgent || "Web Browser"}
                              </div>
                            </td>
                            <td className="v4-mono">{formatDateVi(s.lastSeenAt || s.createdAt)}</td>
                            <td>
                              <button
                                type="button"
                                className="v4-btn sm danger"
                                onClick={() => handleRevokeSession(sid)}
                              >
                                Thu hồi
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* =====================================================================
          SUB-TAB 2: AI ROTATING KEY POOL & VISUAL SYSTEM DOCTOR
         ===================================================================== */}
      {tab === "providers" && (
        <div className="v4-grid-2">
          {/* Rotating AI Key Pool Editor */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>🤖 Kho Khóa AI Xoay Vòng (Multi-Key Pool)</h3>
                <div className="v4-muted">
                  Tự động xoay vòng nhiều API Key Gemini / OpenAI khi chạm giới hạn Rate-Limit 429.
                </div>
              </div>
              {providerMeta && <span className="v4-badge success">Đã mã hóa an toàn</span>}
            </div>

            <form onSubmit={handleSaveKeyPool}>
              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Chiến lược xoay vòng khóa</label>
                  <select
                    className="v4-select"
                    value={keyPool.rotationMode}
                    onChange={(e) => setKeyPool((p) => ({ ...p, rotationMode: e.target.value }))}
                  >
                    <option value="round_robin">🔄 Chia tải luân phiên (Round-Robin)</option>
                    <option value="failover">🛡️ Dự phòng tự động khi lỗi (Failover)</option>
                  </select>
                </div>
                <div className="v4-field">
                  <label>HTTP/SOCKS5 Proxy mặc định</label>
                  <input
                    className="v4-input v4-mono"
                    placeholder="http://user:pass@ip:port"
                    value={keyPool.defaultProxy}
                    onChange={(e) => setKeyPool((p) => ({ ...p, defaultProxy: e.target.value }))}
                  />
                </div>
              </div>

              {/* Existing Masked Pool Keys */}
              {[
                { label: "Google Gemini Pool", field: "geminiKeys" },
                { label: "OpenAI / GPT Pool", field: "openaiKeys" },
                { label: "Weather API Pool", field: "weatherKeys" },
              ].map((grp) => (
                <div key={grp.field} style={{ marginBottom: 10 }}>
                  <div className="v4-muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {grp.label} đang lưu ({keyPool[grp.field].length} khóa):
                  </div>
                  {keyPool[grp.field].length > 0 ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {keyPool[grp.field].map((k, idx) => {
                        const masked = typeof k === "string" ? k : k.masked || k.label || `Key #${idx + 1}`;
                        const active = typeof k === "object" ? k.active !== false : true;
                        return (
                          <span key={idx} className="v4-admin-chip v4-mono">
                            <span className={`v4-dot ${active ? "online" : "dead"}`} />
                            {masked}
                            <button
                              type="button"
                              className="v4-btn-icon"
                              onClick={() => handleRemovePoolKey(grp.field, idx)}
                            >
                              ✕
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="v4-muted" style={{ fontSize: 11.5 }}>Chưa thêm khóa phụ trong Pool.</span>
                  )}
                </div>
              ))}

              <div className="v4-field" style={{ marginTop: 10 }}>
                <label>Thêm các khóa Google Gemini mới (mỗi dòng 1 khóa AIzaSy...)</label>
                <textarea
                  className="v4-textarea mono"
                  rows={2}
                  placeholder="AIzaSy..."
                  value={newGeminiInput}
                  onChange={(e) => setNewGeminiInput(e.target.value)}
                />
              </div>

              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Thêm khóa OpenAI / GPT (sk-...)</label>
                  <input
                    type="password"
                    className="v4-input v4-mono"
                    placeholder="sk-..."
                    value={newOpenaiInput}
                    onChange={(e) => setNewOpenaiInput(e.target.value)}
                  />
                </div>
                <div className="v4-field">
                  <label>Thêm khóa Weather API</label>
                  <input
                    type="password"
                    className="v4-input v4-mono"
                    placeholder="Nhập khóa thời tiết..."
                    value={newWeatherInput}
                    onChange={(e) => setNewWeatherInput(e.target.value)}
                  />
                </div>
              </div>

              <button type="submit" className="v4-btn success" style={{ width: "100%" }} disabled={savingPool}>
                {savingPool ? "Đang mã hóa Pool..." : "💾 Lưu Kho Khóa AI Xoay Vòng"}
              </button>
            </form>
          </div>

          {/* Visual System Doctor Cards & 1-Click Maintenance */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>🩺 Bác Sĩ Hệ Thống Trực Quan & Bảo Trì 1-Click</h3>
                <div className="v4-muted">
                  Chẩn đoán môi trường máy chủ, dọn dẹp rác bộ nhớ đệm và kiểm tra đồng bộ dữ liệu.
                </div>
              </div>
              <button
                type="button"
                className="v4-btn sm primary"
                disabled={Boolean(maintenanceBusy)}
                onClick={handleRunDoctor}
              >
                {maintenanceBusy === "doctor" ? "Đang khám..." : "🩺 Chẩn Đoán Lại"}
              </button>
            </div>

            <div className="v4-grid-2" style={{ marginBottom: 14 }}>
              <button
                type="button"
                className="v4-btn"
                disabled={Boolean(maintenanceBusy)}
                onClick={handleDiskCleanup}
              >
                {maintenanceBusy === "cleanup" ? "Đang dọn rác..." : "🧹 Dọn Rác Ảnh/Video Tạm"}
              </button>
              <button
                type="button"
                className="v4-btn"
                disabled={Boolean(maintenanceBusy)}
                onClick={handleCheckMigrateV3}
              >
                {maintenanceBusy === "migrate" ? "Đang kiểm tra..." : "🔄 Kiểm Tra Đồng Bộ V3 → V4"}
              </button>
            </div>

            {maintenanceBanner && (
              <div className="v4-card highlight-admin" style={{ padding: 10, marginBottom: 12 }}>
                ✅ {maintenanceBanner}
              </div>
            )}

            {doctorReport ? (
              <>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                    fontSize: 12.5,
                  }}
                >
                  <span className="v4-muted">
                    Nền tảng: <strong>{doctorReport.runtime || doctorReport.platform}</strong>
                  </span>
                  <span className="v4-mono v4-muted">
                    Uptime: {formatDurationVi(doctorReport.uptimeSec || 0)}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(doctorReport.checks || []).map((chk) => {
                    const st = String(chk.status || "ok").toLowerCase();
                    const badgeCls = st === "ok" ? "success" : st === "error" ? "danger" : "warning";
                    const icon = st === "ok" ? "✅" : st === "error" ? "🚨" : "⚠️";
                    return (
                      <div
                        key={chk.id || chk.label}
                        className="v4-res-item"
                        style={{ alignItems: "flex-start", gap: 12 }}
                      >
                        <div>
                          <div style={{ fontWeight: 700 }}>
                            {icon} {chk.label}
                          </div>
                          <div className="v4-muted" style={{ fontSize: 12 }}>
                            {chk.detail}
                          </div>
                        </div>
                        <span className={`v4-badge ${badgeCls}`}>
                          {st === "ok" ? " Khỏe mạnh" : st === "error" ? "Cần xử lý" : "Chú ý"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="v4-muted" style={{ padding: 20, textAlign: "center" }}>
                Đang nạp báo cáo Bác Sĩ Hệ Thống...
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 3: SNAPSHOT VAULT & SELECTIVE RESTORE
         ===================================================================== */}
      {tab === "vault" && (
        <div className="v4-grid-2">
          {/* Left: Create Snapshot & List */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>📸 Tạo Bản Sao Lưu Đa Phiên Bản (AES-256)</h3>
                <div className="v4-muted">
                  Đóng băng toàn bộ cấu hình Bot, Nhóm, Command Studio và CRM thành bản chụp có thể khôi phục bất kỳ lúc nào.
                </div>
              </div>
              <button type="button" className="v4-btn sm" onClick={handleDownloadSafeBackup}>
                📥 Tải JSON An Toàn
              </button>
            </div>

            <form onSubmit={handleCreateSnapshot} style={{ marginBottom: 16 }}>
              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Tên gợi nhớ cho Snapshot</label>
                  <input
                    className="v4-input"
                    placeholder="VD: Bản chuẩn trước khi chạy sự kiện..."
                    value={snapName}
                    onChange={(e) => setSnapName(e.target.value)}
                  />
                </div>
                <div className="v4-field">
                  <label>Mật khẩu mã hóa AES-256 (Tùy chọn)</label>
                  <input
                    type="password"
                    className="v4-input"
                    placeholder="Bỏ trống = lưu JSON chuẩn"
                    value={snapPassword}
                    onChange={(e) => setSnapPassword(e.target.value)}
                  />
                </div>
              </div>

              <button type="submit" className="v4-btn primary" style={{ width: "100%" }} disabled={creatingSnap}>
                {creatingSnap ? "Đang đóng gói Snapshot..." : "📸 Tạo Snapshot Lưu Vào Két Sắt"}
              </button>
            </form>

            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              Danh sách Snapshot trong Két Sắt ({snapshots.length})
            </div>
            {snapshots.length === 0 ? (
              <div className="v4-muted" style={{ padding: 18, textAlign: "center" }}>
                Chưa có Snapshot nào được tạo.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 340, overflowY: "auto" }}>
                {snapshots.map((snap) => {
                  const sid = String(snap.id || snap.name);
                  const active = sid === selectedSnapshotId;
                  return (
                    <div
                      key={sid}
                      onClick={() => setSelectedSnapshotId(sid)}
                      style={{
                        padding: "10px 12px",
                        borderRadius: 10,
                        cursor: "pointer",
                        background: active ? "var(--primary-soft)" : "var(--bg-input)",
                        border: active ? "1px solid var(--border-strong)" : "1px solid var(--border)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700 }}>
                          {snap.encrypted ? "🔒 " : "📄 "}
                          {snap.name || sid}
                        </div>
                        <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                          {formatDateVi(snap.createdAt)} • {formatBytesVi(snap.size || snap.bytes || 0)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="v4-btn sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownloadSnapshotById(snap);
                        }}
                      >
                        📥 Tải về
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Selective Restore & Diff Preview */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>⏪ Khôi Phục Có Chọn Lọc & Xem Trước Khác Biệt</h3>
                <div className="v4-muted">
                  Chọn đúng từng phân vùng muốn khôi phục từ Snapshot hoặc tệp sao lưu tải lên từ máy tính.
                </div>
              </div>
            </div>

            <div className="v4-field">
              <label>Tải lên tệp sao lưu ngoài (.json / .enc.json — Tùy chọn)</label>
              <input
                type="file"
                accept=".json"
                className="v4-input"
                onChange={handleExternalBackupUpload}
              />
              {externalBackupName && (
                <div className="v4-badge info" style={{ marginTop: 4, alignSelf: "flex-start" }}>
                  Đang dùng tệp tải lên: {externalBackupName}
                </div>
              )}
            </div>

            <div className="v4-field">
              <label>Chọn các phân vùng dữ liệu muốn khôi phục (Selective Restore)</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {SNAPSHOT_SCOPES.map((sc) => {
                  const checked = restoreScopes.includes(sc.id);
                  return (
                    <label
                      key={sc.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        borderRadius: 8,
                        background: "var(--bg-input)",
                        border: "1px solid var(--border)",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setRestoreScopes((prev) =>
                            checked ? prev.filter((x) => x !== sc.id) : [...prev, sc.id]
                          )
                        }
                      />
                      <span style={{ fontWeight: 600 }}>{sc.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="v4-field">
              <label>Mật khẩu giải mã AES-256 (Nếu Snapshot có đặt mật khẩu)</label>
              <input
                type="password"
                className="v4-input"
                placeholder="Nhập mật khẩu giải mã..."
                value={restorePassword}
                onChange={(e) => setRestorePassword(e.target.value)}
              />
            </div>

            {restorePreview && (
              <div className="v4-card highlight-admin" style={{ padding: 12, marginBottom: 12 }}>
                <strong>🔍 Xem trước thay đổi khi khôi phục:</strong>
                <pre
                  className="v4-mono"
                  style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", maxHeight: 150, overflowY: "auto" }}
                >
                  {JSON.stringify(restorePreview, null, 2)}
                </pre>
              </div>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                className="v4-btn"
                style={{ flex: 1 }}
                disabled={restoringSnap}
                onClick={handlePreviewRestoreDiff}
              >
                🔍 Xem Trước Diff
              </button>
              <button
                type="button"
                className="v4-btn warning"
                style={{ flex: 1 }}
                disabled={restoringSnap}
                onClick={handleExecuteSelectiveRestore}
              >
                {restoringSnap ? "Đang khôi phục..." : "⏪ Thực Hiện Khôi Phục"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
