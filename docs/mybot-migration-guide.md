# Hướng Dẫn Migration MyBot & Profile/Style System

Tài liệu hướng dẫn nâng cấp hệ thống MyBot sang phiên bản kiến trúc Profile/Style độc lập và Trial Ledger Bangkok tuần.

---

## 1. Các thay đổi chính (Architecture Changes)

1. **Tách biệt Creation và Activation**:
   - `!mybot create <imei> <cookie>`: Chỉ khởi tạo credential và cấu hình bot ở trạng thái `status: "stopped"`, `trialStatus: "pending"`.
   - Nếu bot đã tồn tại: Cập nhật thông tin đăng nhập an toàn, giữ nguyên trạng thái và expiry date.
   - `!mybot active`: Kích hoạt trial 1 giờ (áp dụng hạn mức 1 lần / tuần lịch Bangkok UTC+7).

2. **Dịch vụ Profile & Style Độc lập**:
   - Mỗi bot có hồ sơ lưu tại `mybot/instances/<botId>/data/profile.json`.
   - Định dạng profile có revision lock để chống ghi đè đồng thời.
   - Khi chỉnh sửa profile/style, hệ thống tự động lưu bản sao lưu (backup) trong `logs/profile-backups/<botId>/`.

3. **Atomic Trial Ledger**:
   - Hạn mức trial dùng thử được quản lý tập trung trong `mybot/state/trial-ledger.json`.
   - Sử dụng cơ chế khóa file liên tiến trình (`trial-ledger.json.lock`) để bảo đảm tính nguyên tử khi nhiều bot kích hoạt đồng thời.

---

## 2. Các bước chạy Migration

Chạy script migration để tự động chuẩn hóa toàn bộ bot cũ trong `mybot/mybots.json` và tạo profile:

```bash
node scripts/migrate-mybot-profiles.js
```

---

## 3. Kiểm tra tính tương thích (Verification)

Chạy bộ test kiểm tra:

```bash
npm run test:runtime-fast
npm run test:runtime-isolation
npm test
```
