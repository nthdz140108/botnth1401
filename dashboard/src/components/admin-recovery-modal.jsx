import React from "react";

const ACTIVE_STATES = new Set(["starting", "waiting_scan", "waiting_confirm"]);

const STATE_COPY = {
  starting: { label: "Đang khởi tạo phiên khôi phục", hint: "Đang chuẩn bị phiên đăng nhập lại bằng mã QR." },
  waiting_scan: { label: "Chờ quét mã QR", hint: "Mở Zalo trên điện thoại và quét mã để tiếp tục." },
  waiting_confirm: { label: "Chờ xác nhận trên điện thoại", hint: "Đã quét mã. Xác nhận đăng nhập trên điện thoại." },
};

function hasQr(recovery) {
  return Boolean(recovery && typeof recovery.qrImage === "string" && recovery.qrImage.startsWith("data:image/"));
}

export function formatBangkokExpiry(expiresAt) {
  if (!expiresAt) return "";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const day = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
  return `${time} ICT — ${day} (giờ Bangkok)`;
}

export function formatCountdown(expiresAt, nowMs = Date.now()) {
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return "00:00";
  const remaining = Math.max(0, target - nowMs);
  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function AdminRecoveryModal({ recovery, onDismiss, nowMs = Date.now() }) {
  if (!hasQr(recovery) || !ACTIVE_STATES.has(recovery.state)) return null;

  const copy = STATE_COPY[recovery.state] || STATE_COPY.starting;
  const countdown = formatCountdown(recovery.expiresAt, nowMs);
  const expiresLabel = formatBangkokExpiry(recovery.expiresAt);

  return (
    <div className="recovery-overlay" onClick={onDismiss}>
      <section
        className="recovery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-recovery-title"
        aria-describedby="admin-recovery-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="recovery-head">
          <p className="kicker">ADMIN RECOVERY</p>
          <h3 id="admin-recovery-title">Khôi phục đăng nhập admin bằng mã QR</h3>
          <p id="admin-recovery-desc" className="recovery-state" role="status">{copy.label}</p>
        </header>
        <div className="recovery-body">
          <div className="recovery-qr">
            <img src={recovery.qrImage} alt="Mã QR đăng nhập lại Zalo admin" />
          </div>
          <div className="recovery-details">
            <p className="recovery-hint">{copy.hint}</p>
            <p className="recovery-countdown" role="timer" aria-live="off">
              Hết hạn sau <strong>{countdown}</strong>
            </p>
            <p className="recovery-expiry">Hạn: {expiresLabel}</p>
            <p className="recovery-warning">
              Không chia sẻ mã QR này với bất kỳ ai. Mã chỉ hoạt động một lần và hết hạn nhanh.
            </p>
            <p className="recovery-security">
              Mã QR chỉ được truyền qua API dashboard có xác thực với Cache-Control: no-store, không lưu trong
              localStorage, sessionStorage hay bất kỳ lưu trữ nào khác.
            </p>
          </div>
        </div>
        <footer className="recovery-foot">
          <button type="button" className="secondary" onClick={onDismiss}>Ẩn cửa sổ này</button>
        </footer>
      </section>
    </div>
  );
}
