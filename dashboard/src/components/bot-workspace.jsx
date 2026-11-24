import React, { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../app/api.js";
import { ChatPolicyPanel } from "./chat-policy-panel.jsx";
import { loadBotWorkspaceData } from "./bot-workspace-data.js";

const SAFE_COLOR_PALETTE = [
  { label: "Đỏ", hex: "db342e" },
  { label: "Xanh lá", hex: "15a85f" },
  { label: "Vàng", hex: "f7b503" },
  { label: "Xanh dương", hex: "0084ff" },
  { label: "Hồng", hex: "ff69b4" },
  { label: "Tím", hex: "8a2be2" },
  { label: "Cyan", hex: "00ffff" },
  { label: "Trắng", hex: "ffffff" },
  { label: "Cam", hex: "ffa500" },
];

export function BotWorkspace({ botId, onBack }) {
  const [bot, setBot] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [profile, setProfile] = useState(null);
  const [trialStatus, setTrialStatus] = useState(null);
  const [files, setFiles] = useState({});
  const [pathKey, setPathKey] = useState("");
  const [configText, setConfigText] = useState("{}");
  const [credentialText, setCredentialText] = useState("{}");
  const [credentialShown, setCredentialShown] = useState(false);
  const [prefix, setPrefix] = useState("!");
  const [prefixAvailable, setPrefixAvailable] = useState(false);
  const [prefixSaving, setPrefixSaving] = useState(false);
  const [backup, setBackup] = useState("");
  const [qrSession, setQrSession] = useState(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [qrError, setQrError] = useState("");

  // Profile Form state
  const [profileForm, setProfileForm] = useState({
    ownerName: "",
    nameServer: "",
    description: "",
    botInfo: "",
    typePlatform: "zalo",
  });
  const [profileSaving, setProfileSaving] = useState(false);

  // Style Form state
  const [styleForm, setStyleForm] = useState({
    icon: "🤖",
    color: "db342e",
    size: { nameServer: 18, text: 14 },
    type: { nameServer: ["bold"], text: ["none"] },
  });
  const [styleSaving, setStyleSaving] = useState(false);

  const config = useMemo(() => { try { return JSON.parse(configText); } catch { return null; } }, [configText]);
  const credential = useMemo(() => { try { return JSON.parse(credentialText); } catch { return null; } }, [credentialText]);

  useEffect(() => { load(); }, [botId]);
  useEffect(() => { if (pathKey) setConfigText(JSON.stringify(files[pathKey] || {}, null, 2)); }, [pathKey, files]);

  async function load() {
    try {
      const next = await loadBotWorkspaceData({ botId, request: apiRequest });
      setBot(next.bot);
      setRuntime(next.runtime);
      setProfile(next.profile);
      setTrialStatus(next.trialStatus);
      setFiles(next.files);
      setPathKey(Object.keys(next.files)[0] || "");
      setCredentialText(JSON.stringify(next.credential || {}, null, 2));
      setCredentialShown(false);
      setPrefix(next.prefix || "!");
      setPrefixAvailable(next.prefixAvailable !== false);
      setQrSession(next.qrSession);
      setQrError(next.qrError || "");

      if (next.profile) {
        setProfileForm({
          ownerName: next.profile.ownerName || "",
          nameServer: next.profile.nameServer || "",
          description: next.profile.description || "",
          botInfo: next.profile.botInfo || "",
          typePlatform: next.profile.typePlatform || "zalo",
        });
        if (next.profile.style) {
          setStyleForm({
            icon: next.profile.style.icon || "🤖",
            color: next.profile.style.color || "db342e",
            size: {
              nameServer: Number(next.profile.style.size?.nameServer) || 18,
              text: Number(next.profile.style.size?.text) || 14,
            },
            type: {
              nameServer: Array.isArray(next.profile.style.type?.nameServer) ? next.profile.style.type.nameServer : ["bold"],
              text: Array.isArray(next.profile.style.type?.text) ? next.profile.style.type.text : ["none"],
            },
          });
        }
      }

      setError("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function revealCredential() {
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/credential/reveal`, { method: "POST", allowSensitive: true });
      setCredentialText(JSON.stringify((result.data || result).raw || {}, null, 2));
      setCredentialShown(true);
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveConfig() {
    if (!config || !pathKey) return setError("JSON cấu hình không hợp lệ.");
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/config/${encodeURIComponent(pathKey)}`, { method: "PUT", body: config });
      setBackup(result.backup?.file || "");
      setNotice("Đã lưu cấu hình. Cần khởi động lại bot.");
      setFiles((current) => ({ ...current, [pathKey]: config }));
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveCredential() {
    if (!credential) return setError("JSON credential không hợp lệ.");
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/credential`, { method: "PUT", body: credential });
      setBackup(result.backup?.file || "");
      setNotice("Đã lưu credential. Cần khởi động lại bot.");
    } catch (e) {
      setError(e.message);
    }
  }

  async function savePrefix() {
    if (!/^\S{1,3}$/.test(prefix)) return setError("Prefix phải có 1-3 ký tự và không có khoảng trắng.");
    setPrefixSaving(true);
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/prefix`, { method: "PUT", body: { prefix } });
      setPrefix((result.data || result).prefix || prefix);
      setBackup(result.backup?.file || "");
      setNotice("Đã lưu prefix riêng cho bot. Cần khởi động lại bot.");
    } catch (e) {
      setError(e.message);
    } finally {
      setPrefixSaving(false);
    }
  }

  async function saveProfile() {
    setProfileSaving(true);
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/profile`, {
        method: "PUT",
        body: {
          ...profileForm,
          expectedRevision: profile?.revision,
        },
      });
      setProfile((result.data || result));
      setNotice("Đã cập nhật profile bot thành công!");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function saveStyle() {
    setStyleSaving(true);
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/style`, {
        method: "PUT",
        body: {
          style: styleForm,
          expectedRevision: profile?.revision,
        },
      });
      setProfile((result.data || result));
      setNotice("Đã lưu phong cách hiển thị (Style) thành công!");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setStyleSaving(false);
    }
  }

  async function handleResetStyle() {
    try {
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/style/reset`, {
        method: "POST",
        body: {
          expectedRevision: profile?.revision,
        },
      });
      setProfile((result.data || result));
      setStyleForm({
        icon: "🤖",
        color: "db342e",
        size: { nameServer: 18, text: 14 },
        type: { nameServer: ["bold"], text: ["none"] },
      });
      setNotice("Đã đặt lại Style về mặc định!");
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function rollback() {
    if (!backup || !pathKey) return;
    try {
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/config/rollback`, { method: "POST", body: { pathKey, backup } });
      setNotice("Đã rollback cấu hình từ backup.");
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function refreshQr() {
    try {
      setQrLoading(true);
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/qr-login`);
      setQrSession(result.data || result);
      setQrError("");
    } catch (e) {
      setQrError(e.message);
    } finally {
      setQrLoading(false);
    }
  }

  async function startQr() {
    try {
      setQrLoading(true);
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/actions/qr-login`, { method: "POST" });
      setQrSession(result.data || result);
      setQrError("");
      setNotice("Đã khởi động QR login.");
      await refreshQr();
    } catch (e) {
      setQrError(e.message);
    } finally {
      setQrLoading(false);
    }
  }

  async function cancelQr() {
    try {
      setQrLoading(true);
      const result = await apiRequest(`/api/bots/${encodeURIComponent(botId)}/qr-login`, { method: "DELETE" });
      setQrSession({ ...(qrSession || {}), cancelled: result.cancelled, state: result.cancelled ? "cancelled" : (qrSession?.state || "idle") });
      setQrError("");
      setNotice(result.cancelled ? "Đã huỷ QR session." : "Không có QR session đang chạy.");
      await refreshQr();
    } catch (e) {
      setQrError(e.message);
    } finally {
      setQrLoading(false);
    }
  }

  async function action(name) {
    try {
      const body = name === "delete"
        ? { confirm: globalThis.prompt?.("Nhập DELETE_SELECTED_BOTS để xác nhận"), confirmId: botId, confirmName: bot?.displayName || botId }
        : name === "disable"
          ? { reason: globalThis.prompt?.("Lý do vô hiệu hóa bot") || "" }
          : {};
      await apiRequest(`/api/bots/${encodeURIComponent(botId)}/actions/${name}`, { method: "POST", body });
      if (name === "delete") return onBack();
      setNotice(`Đã gửi lệnh ${name}.`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  function toggleType(target, typeValue) {
    setStyleForm((prev) => {
      const currentList = prev.type[target] || [];
      let nextList;
      if (typeValue === "none") {
        nextList = ["none"];
      } else {
        const withoutNone = currentList.filter((t) => t !== "none");
        if (withoutNone.includes(typeValue)) {
          nextList = withoutNone.filter((t) => t !== typeValue);
          if (nextList.length === 0) nextList = ["none"];
        } else {
          nextList = [...withoutNone, typeValue];
        }
      }
      return {
        ...prev,
        type: {
          ...prev.type,
          [target]: nextList,
        },
      };
    });
  }

  const disabled = bot?.enabled === false || bot?.status === "disabled";
  const tabs = [
    ["overview", "Tổng quan"],
    ["profile", "Profile"],
    ["style", "Style"],
    ["runtime", "Runtime"],
    ["config", "Cấu hình"],
    ["credential", "Credential"],
    ["commands", "Command"],
    ["chat-access", "Chat access"],
    ["groups", "Nhóm"],
    ["logs", "Logs"],
    ["backup", "Backup/Rollback"],
  ];

  return (
    <section className="panel workspace">
      <div className="section-heading">
        <div>
          <p className="kicker">BOT WORKSPACE</p>
          <h2>{profile?.nameServer || bot?.displayName || botId}</h2>
          <p className="muted mono">{botId} • Chủ sở hữu: {profile?.ownerName || bot?.createdBy || "-"}</p>
        </div>
        <div className="toolbar">
          <button className="primary" disabled={disabled} onClick={() => action("active")}>⚡ Kích hoạt Trial</button>
          <button className="secondary" disabled={disabled} onClick={() => action("start")}>Chạy</button>
          <button className="secondary" onClick={() => action("stop")}>Dừng</button>
          <button disabled={disabled} onClick={() => action("restart")}>Khởi động lại</button>
          {disabled ? <button onClick={() => action("enable")}>Bật</button> : <button className="secondary" disabled={botId === "admin"} onClick={() => action("disable")}>Tắt</button>}
          <button className="secondary" disabled={botId === "admin"} onClick={() => action("delete")}>Xóa</button>
          <button className="secondary" onClick={onBack}>Quay lại</button>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="workspace-card">
        <div className="section-heading compact-heading">
          <div>
            <h3>QR login</h3>
            <p className="muted">Khởi động, xem trạng thái và huỷ session QR cho bot này.</p>
          </div>
          <div className="toolbar">
            <button className="secondary" disabled={qrLoading} onClick={refreshQr}>Refresh QR</button>
            <button className="secondary" disabled={qrLoading} onClick={startQr}>Start QR</button>
            <button className="secondary" disabled={qrLoading} onClick={cancelQr}>Cancel QR</button>
          </div>
        </div>
        <dl className="definition-list">
          <div><dt>State</dt><dd>{qrSession?.state || "idle"}</dd></div>
          <div><dt>Expires</dt><dd>{qrSession?.expiresAt ? new Date(qrSession.expiresAt).toLocaleString() : "-"}</dd></div>
          <div><dt>Error</dt><dd>{qrError || qrSession?.error || "-"}</dd></div>
        </dl>
        {qrSession?.qrImage ? <img className="qr" src={qrSession.qrImage} alt={`QR login for ${botId}`} /> : null}
      </div>

      <div className="tabbar">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : "secondary"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="workspace-card">
          <dl className="definition-list">
            <div><dt>Trạng thái</dt><dd>{bot?.status || "unknown"}</dd></div>
            <div><dt>Hạn mức Trial tuần này</dt><dd>{trialStatus ? (trialStatus.eligible ? `✅ Khả dụng (Tuần ${trialStatus.currentWeek})` : `❌ Đã dùng (Tuần ${trialStatus.currentWeek})`) : "-"}</dd></div>
            <div><dt>Hết hạn</dt><dd>{profile?.expiryAt === "-1" ? "Vĩnh viễn" : (profile?.expiryAt ? new Date(profile.expiryAt).toLocaleString() : (bot?.expiryAt || "Không"))}</dd></div>
            <div><dt>Cookie</dt><dd>{bot?.credential?.state || "unknown"}</dd></div>
            <div><dt>Tên Server</dt><dd>{profile?.nameServer || bot?.displayName || "-"}</dd></div>
            <div><dt>Port</dt><dd>{bot?.port || bot?.webPort || "-"}</dd></div>
            <div><dt>Cập nhật lần cuối</dt><dd>{profile?.updatedAt ? new Date(profile.updatedAt).toLocaleString() : (bot?.lastUpdated || "-")}</dd></div>
            <div><dt>Lý do tắt</dt><dd>{bot?.disabledReason || "-"}</dd></div>
          </dl>
        </div>
      ) : null}

      {tab === "profile" ? (
        <div className="workspace-card">
          <div className="section-heading compact-heading">
            <div>
              <h3>Thông Tin Bot Profile</h3>
              <p className="muted">Cấu hình thông tin định danh và hiển thị của bot instance.</p>
            </div>
            <div className="toolbar">
              <button disabled={profileSaving} onClick={saveProfile}>
                {profileSaving ? "Đang lưu..." : "Lưu Profile"}
              </button>
            </div>
          </div>
          <div style={{ display: "grid", gap: "12px", maxWidth: "600px" }}>
            <label>
              <strong>Tên Server / Tên Bot</strong>
              <input
                type="text"
                value={profileForm.nameServer}
                onChange={(e) => setProfileForm({ ...profileForm, nameServer: e.target.value })}
                placeholder="Ví dụ: Thanh Hung hoặc Bot Zalo"
                style={{ width: "100%", marginTop: "4px", padding: "8px" }}
              />
            </label>
            <label>
              <strong>Tên Người Tạo / Chủ Sở Hữu</strong>
              <input
                type="text"
                value={profileForm.ownerName}
                onChange={(e) => setProfileForm({ ...profileForm, ownerName: e.target.value })}
                placeholder="Tên chủ sở hữu"
                style={{ width: "100%", marginTop: "4px", padding: "8px" }}
              />
            </label>
            <label>
              <strong>Mô Tả Bot</strong>
              <textarea
                value={profileForm.description}
                onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
                placeholder="Mô tả chức năng của bot..."
                rows="3"
                style={{ width: "100%", marginTop: "4px", padding: "8px" }}
              />
            </label>
            <label>
              <strong>Thông Tin Bổ Sung (botInfo)</strong>
              <input
                type="text"
                value={profileForm.botInfo}
                onChange={(e) => setProfileForm({ ...profileForm, botInfo: e.target.value })}
                placeholder="Thông tin thêm..."
                style={{ width: "100%", marginTop: "4px", padding: "8px" }}
              />
            </label>
            <label>
              <strong>Nền Tảng (Platform)</strong>
              <input
                type="text"
                value={profileForm.typePlatform}
                onChange={(e) => setProfileForm({ ...profileForm, typePlatform: e.target.value })}
                placeholder="zalo"
                style={{ width: "100%", marginTop: "4px", padding: "8px" }}
              />
            </label>
          </div>
        </div>
      ) : null}

      {tab === "style" ? (
        <div className="workspace-card">
          <div className="section-heading compact-heading">
            <div>
              <h3>Phong Cách Hiển Thị (Style)</h3>
              <p className="muted">Tùy chỉnh màu sắc, icon, cỡ chữ và kiểu chữ cho tin nhắn gửi ra Zalo.</p>
            </div>
            <div className="toolbar">
              <button className="secondary" onClick={handleResetStyle}>Đặt lại mặc định</button>
              <button disabled={styleSaving} onClick={saveStyle}>
                {styleSaving ? "Đang lưu..." : "Lưu Style"}
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            <div style={{ display: "grid", gap: "16px" }}>
              <label>
                <strong>Icon / Emoji</strong>
                <input
                  type="text"
                  value={styleForm.icon}
                  onChange={(e) => setStyleForm({ ...styleForm, icon: e.target.value })}
                  style={{ width: "100%", marginTop: "4px", padding: "8px" }}
                  maxLength="10"
                />
              </label>

              <div>
                <strong>Màu sắc (Color)</strong>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", margin: "8px 0" }}>
                  {SAFE_COLOR_PALETTE.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      onClick={() => setStyleForm({ ...styleForm, color: c.hex })}
                      style={{
                        backgroundColor: `#${c.hex}`,
                        color: ["ffffff", "00ffff", "f7b503"].includes(c.hex) ? "#000" : "#fff",
                        border: styleForm.color.toLowerCase() === c.hex ? "3px solid #000" : "1px solid #ccc",
                        padding: "6px 12px",
                        cursor: "pointer",
                        borderRadius: "4px",
                        fontWeight: "bold",
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={styleForm.color}
                  onChange={(e) => setStyleForm({ ...styleForm, color: e.target.value.replace("#", "") })}
                  placeholder="Mã hex (ví dụ: db342e)"
                  style={{ width: "100%", padding: "8px" }}
                  maxLength="6"
                />
              </div>

              <div>
                <strong>Kích thước chữ (Size: 10-24)</strong>
                <div style={{ margin: "8px 0" }}>
                  <label style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span>Tên Server: {styleForm.size.nameServer}px</span>
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="24"
                    value={styleForm.size.nameServer}
                    onChange={(e) => setStyleForm({
                      ...styleForm,
                      size: { ...styleForm.size, nameServer: parseInt(e.target.value, 10) },
                    })}
                    style={{ width: "100%" }}
                  />
                </div>
                <div style={{ margin: "8px 0" }}>
                  <label style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                    <span>Nội dung Text: {styleForm.size.text}px</span>
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="24"
                    value={styleForm.size.text}
                    onChange={(e) => setStyleForm({
                      ...styleForm,
                      size: { ...styleForm.size, text: parseInt(e.target.value, 10) },
                    })}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div>
                <strong>Kiểu chữ Tên Server (Type)</strong>
                <div style={{ display: "flex", gap: "12px", margin: "6px 0", flexWrap: "wrap" }}>
                  {["bold", "italic", "underline", "strike", "none"].map((t) => (
                    <label key={t} style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={styleForm.type.nameServer.includes(t)}
                        onChange={() => toggleType("nameServer", t)}
                      />
                      <span>{t}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <strong>Kiểu chữ Nội dung Text (Type)</strong>
                <div style={{ display: "flex", gap: "12px", margin: "6px 0", flexWrap: "wrap" }}>
                  {["bold", "italic", "underline", "strike", "none"].map((t) => (
                    <label key={t} style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={styleForm.type.text.includes(t)}
                        onChange={() => toggleType("text", t)}
                      />
                      <span>{t}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <strong>Live Preview (Mô phỏng tin nhắn)</strong>
              <div
                style={{
                  marginTop: "8px",
                  padding: "16px",
                  borderRadius: "8px",
                  backgroundColor: "#1e1e2e",
                  color: "#ffffff",
                  border: "1px solid #444",
                  minHeight: "200px",
                }}
              >
                <div
                  style={{
                    color: `#${styleForm.color || "db342e"}`,
                    fontSize: `${styleForm.size.nameServer || 18}px`,
                    fontWeight: styleForm.type.nameServer.includes("bold") ? "bold" : "normal",
                    fontStyle: styleForm.type.nameServer.includes("italic") ? "italic" : "normal",
                    textDecoration: [
                      styleForm.type.nameServer.includes("underline") ? "underline" : "",
                      styleForm.type.nameServer.includes("strike") ? "line-through" : "",
                    ].filter(Boolean).join(" ") || "none",
                    marginBottom: "8px",
                  }}
                >
                  {styleForm.icon ? `${styleForm.icon} ` : ""}{profileForm.nameServer || "Thanh Hung"}
                </div>
                <div
                  style={{
                    color: styleForm.size.text !== 14 || !styleForm.type.text.includes("none") ? `#${styleForm.color || "ffffff"}` : "#dddddd",
                    fontSize: `${styleForm.size.text || 14}px`,
                    fontWeight: styleForm.type.text.includes("bold") ? "bold" : "normal",
                    fontStyle: styleForm.type.text.includes("italic") ? "italic" : "normal",
                    textDecoration: [
                      styleForm.type.text.includes("underline") ? "underline" : "",
                      styleForm.type.text.includes("strike") ? "line-through" : "",
                    ].filter(Boolean).join(" ") || "none",
                    whiteSpace: "pre-line",
                  }}
                >
                  {`Xin chào! Đây là tin nhắn mẫu từ bot.\nLệnh đã thực thi thành công!`}
                </div>
                <div style={{ marginTop: "12px", fontSize: "16px" }}>
                  ✅✅✅
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "runtime" ? <div className="workspace-card"><pre>{JSON.stringify(runtime, null, 2)}</pre></div> : null}
      {tab === "config" ? <div className="workspace-card"><div className="toolbar"><label>Bot prefix <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength="3" aria-label="Bot prefix" /></label><button data-testid="save-prefix" disabled={prefixSaving} onClick={savePrefix}>{prefixSaving ? "Đang lưu..." : "Lưu prefix"}</button></div><p className="muted">Chỉ áp dụng cho bot này. Cần khởi động lại bot sau khi lưu.</p><div className="toolbar"><select value={pathKey} onChange={(e) => setPathKey(e.target.value)}>{Object.keys(files).map((key) => <option key={key}>{key}</option>)}</select><button disabled={!config} onClick={saveConfig}>Lưu cấu hình</button></div><textarea value={configText} onChange={(e) => setConfigText(e.target.value)} rows="20" spellCheck="false" />{!config ? <p className="error">JSON không hợp lệ.</p> : null}</div> : null}
      {tab === "credential" ? <div className="workspace-card"><div className="toolbar"><button className="secondary" onClick={revealCredential}>{credentialShown ? "Đọc lại credential" : "Hiện credential"}</button><button disabled={!credential} onClick={saveCredential}>Lưu credential</button></div><textarea value={credentialText} onChange={(e) => setCredentialText(e.target.value)} rows="20" spellCheck="false" /><p className="muted">Hỗ trợ cookie, rawCookies, imei, userAgent, prefix, active và toàn bộ JSON credential.</p></div> : null}
      {tab === "commands" ? <div className="workspace-card"><p>Chọn workspace Command để chỉnh từng command, override riêng và áp dụng theo bot.</p></div> : null}
      {tab === "chat-access" ? <ChatPolicyPanel botId={botId} compact /> : null}
      {tab === "groups" ? <div className="workspace-card"><p>Cấu hình nhóm được lưu trong các file config của bot.</p></div> : null}
      {tab === "logs" ? <div className="workspace-card"><p>Xem logs tại workspace Logs, chọn bot này để lọc.</p></div> : null}
      {tab === "backup" ? <div className="workspace-card"><div className="toolbar"><input value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="Đường dẫn backup" /><button className="secondary" disabled={!backup || !pathKey} onClick={rollback}>Rollback config</button></div><p className="muted">Mỗi lần lưu đều tạo backup atomic và audit log.</p></div> : null}
    </section>
  );
}
