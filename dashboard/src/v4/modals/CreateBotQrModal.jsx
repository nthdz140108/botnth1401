import React, { useCallback, useEffect, useState } from "react";
import { useControlCenter } from "../store.jsx";
import { v4Fetch } from "../http.js";

function resolveQrSrc(rec) {
  if (!rec) return "";
  const raw = rec.qrDataUrl || rec.qrImage || rec.qrBase64 || rec.image || "";
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  return `data:image/png;base64,${raw}`;
}

export default function CreateBotQrModal() {
  const { createQrTargetBot, setCreateQrTargetBot, bots, notify, refreshAll } = useControlCenter();

  const [tab, setTab] = useState("qr");
  const [activeBotId, setActiveBotId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [prefix, setPrefix] = useState("!");
  const [ownerUid, setOwnerUid] = useState("");
  const [expiryPreset, setExpiryPreset] = useState("30d");

  const [cookieText, setCookieText] = useState("");
  const [imei, setImei] = useState("");
  const [userAgent, setUserAgent] = useState("");

  const [qrState, setQrState] = useState({ state: "idle" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!createQrTargetBot) return;
    if (createQrTargetBot.mode === "relogin" && createQrTargetBot.botId) {
      setActiveBotId(createQrTargetBot.botId);
      const found = bots.find((b) => b.id === createQrTargetBot.botId);
      setDisplayName(found?.displayName || createQrTargetBot.botId);
      setPrefix(found?.prefix || "!");
      setOwnerUid(found?.ownerUid || "");
    } else {
      setActiveBotId("");
      setDisplayName("");
      setPrefix("!");
      setOwnerUid("");
      setExpiryPreset("30d");
    }
    setQrState({ state: "idle" });
    setTab("qr");
  }, [createQrTargetBot, bots]);

  const pollBotQr = useCallback(async () => {
    if (!activeBotId) return;
    try {
      const data = await v4Fetch(`/api/bots/${encodeURIComponent(activeBotId)}/qr-login`);
      if (data && typeof data === "object") {
        setQrState(data);
        const st = String(data.state || data.status || "").toLowerCase();
        if (st === "completed" || st === "success" || st === "configured") {
          notify(`Bot ${data.displayName || activeBotId} đã lưu thông tin đăng nhập! Sẵn sàng kích hoạt.`, "success");
          await refreshAll();
        }
      }
    } catch {
      // ignore poll error
    }
  }, [activeBotId, notify, refreshAll]);

  useEffect(() => {
    if (!createQrTargetBot || !activeBotId || tab !== "qr") return undefined;
    const st = String(qrState?.state || qrState?.status || "").toLowerCase();
    if (st === "completed" || st === "success" || st === "configured") return undefined;
    const timer = setInterval(pollBotQr, 1300);
    return () => clearInterval(timer);
  }, [createQrTargetBot, activeBotId, tab, qrState, pollBotQr]);

  if (!createQrTargetBot) return null;

  const isRelogin = createQrTargetBot.mode === "relogin";
  const qrSrc = resolveQrSrc(qrState);
  const state = String(qrState?.state || qrState?.status || "idle").toLowerCase();

  const handleStartQr = async () => {
    setBusy(true);
    try {
      let targetId = activeBotId;
      if (!targetId) {
        const created = await v4Fetch("/api/bots", {
          method: "POST",
          body: {
            displayName: displayName.trim() || undefined,
            prefix: prefix.trim() || "!",
            ownerUid: ownerUid.trim() || undefined,
            expiryPreset,
            startQr: true,
          },
        });
        targetId = created?.botKey || created?.id || created?.bot?.id || "";
        if (!targetId) {
          throw new Error("Máy chủ chưa trả về mã định danh Bot mới.");
        }
        setActiveBotId(targetId);
        if (created?.qr) {
          setQrState(created.qr);
          setBusy(false);
          return;
        }
      }

      const qr = await v4Fetch(`/api/bots/${encodeURIComponent(targetId)}/actions/qr-login`, {
        method: "POST",
        body: {
          prefix: prefix.trim() || "!",
          ownerUid: ownerUid.trim() || undefined,
          expiryPreset,
        },
      });
      setQrState(qr || { state: "waiting_scan" });
      notify("Đã tạo mã QR đăng nhập Bot!", "info");
    } catch (err) {
      notify(err.message || "Không thể khởi tạo phiên QR cho Bot", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleCreateByCookie = async (e) => {
    e.preventDefault();
    if (!cookieText.trim() || !imei.trim()) {
      notify("Vui lòng nhập đầy đủ Cookie và IMEI.", "error");
      return;
    }
    setBusy(true);
    try {
      let targetId = activeBotId;
      if (!targetId) {
        const created = await v4Fetch("/api/bots", {
          method: "POST",
          body: {
            displayName: displayName.trim() || undefined,
            prefix: prefix.trim() || "!",
            ownerUid: ownerUid.trim() || undefined,
            expiryPreset,
            cookie: cookieText.trim(),
            imei: imei.trim(),
            userAgent: userAgent.trim() || undefined,
          },
        });
        targetId = created?.botKey || created?.id || created?.bot?.id || "";
      } else {
        await v4Fetch(`/api/bots/${encodeURIComponent(targetId)}/credential`, {
          method: "PUT",
          body: {
            cookie: cookieText.trim(),
            imei: imei.trim(),
            userAgent: userAgent.trim() || undefined,
          },
        });
      }
      notify(`Đã lưu Cookie cho bot ${targetId || "mới"} thành công! Trạng thái: Sẵn sàng kích hoạt.`, "success");
      await refreshAll();
      setCreateQrTargetBot(null);
    } catch (err) {
      notify(err.message || "Lưu Cookie cho Bot thất bại", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v4-modal-backdrop" onClick={() => setCreateQrTargetBot(null)}>
      <div className="v4-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="v4-card-header">
          <div>
            <h2>{isRelogin ? `Đăng Nhập Lại Bot: ${displayName}` : "➕ Tạo & Đăng Nhập Bot Mới Từ Xa"}</h2>
            <div className="v4-muted">
              Quét mã QR Zalo trực tiếp trên Web hoặc dán Cookie J2Team để thêm Bot phụ vào hệ thống.
            </div>
          </div>
          <button type="button" className="v4-btn sm" onClick={() => setCreateQrTargetBot(null)}>
            Đóng
          </button>
        </div>

        {!isRelogin && (
          <div className="v4-grid-4" style={{ marginBottom: 14 }}>
            <div className="v4-field" style={{ marginBottom: 0 }}>
              <label>Tên gợi nhớ (Tùy chọn)</label>
              <input
                className="v4-input"
                placeholder="Tự lấy theo tên Zalo..."
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="v4-field" style={{ marginBottom: 0 }}>
              <label>Prefix lệnh</label>
              <input
                className="v4-input v4-mono"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </div>
            <div className="v4-field" style={{ marginBottom: 0 }}>
              <label>UID Chủ thuê (Tùy chọn)</label>
              <input
                className="v4-input v4-mono"
                placeholder="UID người thuê..."
                value={ownerUid}
                onChange={(e) => setOwnerUid(e.target.value)}
              />
            </div>
            <div className="v4-field" style={{ marginBottom: 0 }}>
              <label>Thời hạn sử dụng</label>
              <select
                className="v4-select"
                value={expiryPreset}
                onChange={(e) => setExpiryPreset(e.target.value)}
              >
                <option value="1h">Dùng thử 1 Giờ</option>
                <option value="1d">Thuê 1 Ngày</option>
                <option value="7d">Thuê 7 Ngày</option>
                <option value="30d">Thuê 30 Ngày</option>
                <option value="permanent">Vĩnh viễn (Không giới hạn)</option>
              </select>
            </div>
          </div>
        )}

        <div className="v4-tabs">
          <button
            type="button"
            className={`v4-tab ${tab === "qr" ? "active" : ""}`}
            onClick={() => setTab("qr")}
          >
            Quét Mã QR Zalo
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "cookie" ? "active" : ""}`}
            onClick={() => setTab("cookie")}
          >
            Dán Cookie J2Team & IMEI
          </button>
        </div>

        {tab === "qr" ? (
          <div className="v4-qr-stage">
            <div className="v4-qr-box">
              {qrSrc ? (
                <img src={qrSrc} alt="Mã QR Đăng Nhập Bot" />
              ) : state === "completed" || state === "success" || state === "configured" ? (
                <div style={{ color: "#059669", fontWeight: 800, textAlign: "center", padding: 12 }}>
                  <div style={{ fontSize: 40 }}>✓</div>
                  <div>SẴN SÀNG KÍCH HOẠT</div>
                </div>
              ) : (
                <div style={{ color: "#334155", textAlign: "center", padding: 14, fontWeight: 600 }}>
                  Bấm <strong>“Tạo Mã QR Zalo”</strong> để lấy mã quét
                </div>
              )}
            </div>
            <div>
              <div style={{ marginBottom: 10 }}>
                <span className={`v4-badge ${state === "completed" || state === "success" || state === "configured" ? "success" : "info"}`}>
                  Trạng thái: {state === "configured" ? "Sẵn sàng kích hoạt" : (qrState?.message || state)}
                </span>
                {activeBotId && (
                  <span className="v4-badge neutral" style={{ marginLeft: 8 }}>
                    Mã Bot: {activeBotId}
                  </span>
                )}
              </div>
              <p className="v4-muted" style={{ marginTop: 0 }}>
                Gửi ảnh chụp mã QR này cho khách thuê hoặc tự mở ứng dụng Zalo trên điện thoại để quét. Sau khi quét và xác nhận trên điện thoại, Bot sẽ lưu thông tin đăng nhập ở trạng thái chờ kích hoạt.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="v4-btn primary" disabled={busy} onClick={handleStartQr}>
                  {busy ? "Đang tạo QR..." : qrSrc ? "↻ Tạo Lại Mã QR Mới" : "⚡ Tạo Mã QR Zalo"}
                </button>
                {(state === "completed" || state === "success" || state === "configured") && (
                  <button
                    type="button"
                    className="v4-btn success"
                    onClick={() => setCreateQrTargetBot(null)}
                  >
                    Hoàn tất (Sẵn sàng kích hoạt)
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreateByCookie}>
            <div className="v4-field">
              <label>Cookie Zalo (JSON J2Team hoặc chuỗi cookie)</label>
              <textarea
                className="v4-textarea mono"
                rows={4}
                value={cookieText}
                onChange={(e) => setCookieText(e.target.value)}
                placeholder='{"cookies":[...]}'
              />
            </div>
            <div className="v4-grid-2">
              <div className="v4-field">
                <label>IMEI (`z_uuid`)</label>
                <input
                  className="v4-input v4-mono"
                  value={imei}
                  onChange={(e) => setImei(e.target.value)}
                  placeholder="IMEI thiết bị Zalo Web"
                />
              </div>
              <div className="v4-field">
                <label>User-Agent (Tùy chọn)</label>
                <input
                  className="v4-input"
                  value={userAgent}
                  onChange={(e) => setUserAgent(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="v4-btn success" disabled={busy}>
                {busy ? "Đang lưu..." : "Lưu Cookie & Tạo Bot (Chờ kích hoạt)"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
