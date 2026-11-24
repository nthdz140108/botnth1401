# Hướng dẫn Triển Khai & Vận Hành Bot Zalo trên Windows

Dự án tối ưu hóa cho **Windows Server 2012 x64, Windows 10 và Windows 11** chạy **Node.js 20**.

---

## 1. Yêu cầu hệ thống

- **Hệ điều hành**: Windows Server 2012 R2 x64 / Windows 10 / Windows 11
- **Node.js**: Phiên bản 20.x LTS (x64)
- **PowerShell**: 5.1 trở lên
- **FFmpeg**: Đã có sẵn trong `assets/` hoặc cài trong PATH hệ thống.

---

## 2. Cài đặt ban đầu

1. Mở PowerShell hoặc Command Prompt tại thư mục bot:
   ```powershell
   npm ci
   ```

2. Kiểm tra tính toàn vẹn của môi trường:
   ```powershell
   node scripts/preflight-sqlite.js
   npm run doctor
   npm run audit:imports
   ```

---

## 3. Khởi động và Giám sát

### Cách 1: Sử dụng `run.bat` (Khuyến nghị)
Double-click `run.bat` hoặc chạy từ dòng lệnh:
```cmd
run.bat
```
Lệnh này sẽ khởi chạy tiến trình Bot và Dashboard song song dưới dạng dịch vụ Windows.

### Cách 2: Sử dụng PowerShell
```powershell
.\run.ps1
```

### Kiểm tra sức khỏe hệ thống (Health Check)
```powershell
node scripts/windows-healthcheck.js
```
Endpoint `/api/system/health` cung cấp đầy đủ thông số:
- `runtime`: event-loop lag (p50/p95/p99), heap/RSS memory.
- `queues`: inbound pipeline active/pending, spool bytes.
- `storage`: chế độ lưu trữ (`sqlite` hoặc `json-fallback`).
- `workers`: trạng thái worker thread pool và media child process.

---

## 4. Cập nhật an toàn (Safe Update)

Chạy script cập nhật tự động:
```powershell
.\update.ps1
```
Quy trình cập nhật tự động:
- Tạo snapshot sao lưu các file runtime (`.env.local`, `video/`, `mybot/`, logs, `groupSettings.json`).
- Kéo code mới nhất từ nhánh `origin/master`.
- Cài đặt dependency và chạy preflight test.
- Khởi động lại supervisor mà không làm mất dữ liệu người dùng.

---

## 5. Sao lưu và Khôi phục (Backup & Rollback)

- Tất cả dữ liệu runtime được bảo toàn trong thư mục `mybot/` và `assets/json-data/`.
- Bản sao lưu tự động được lưu tại `mybot-update-backups/`.
- Khi cần phục hồi:
  ```powershell
  node scripts/safe-update.js --rollback
  ```

---

## 6. Khôi phục Admin bằng QR (Admin Recovery)

Khi cookie admin hết hạn, bot tự động xuất bản QR khôi phục vào kênh `.runtime/admin-recovery/`. **Lưu ý quan trọng:** `pm2 restart admin` KHÔNG tự hiển thị cửa sổ GUI nào — PM2 chạy nền trong daemon, nên QR không bao giờ hiện lên màn hình RDP từ tiến trình PM2. Để nhìn thấy QR, dùng một trong hai cách sau:

### Cách 1: Dashboard (khuyến nghị)

Đăng nhập vào dashboard rồi mở trang khôi phục; modal QR sẽ tự động hiển thị khi có phiên khôi phục đang hoạt động:

```
http://localhost:4173
```

### Cách 2: CLI foreground trong cửa sổ RDP

Hiển thị QR dạng ASCII ngay trong terminal (foreground, không phụ thuộc PM2):

```powershell
npm run admin:recovery:show
```

Hoặc mở ảnh QR bằng ứng dụng xem ảnh mặc định của phiên RDP hiện tại:

```powershell
npm run admin:recovery:show -- --open
```

Mã thoát (exit code): `0` = đã hiển thị QR, `2` = không có phiên hoặc phiên đã hết hạn, `3` = không đọc được tệp QR.

### Xem log PM2 của admin

Log của tiến trình admin chạy dưới PM2 nằm tại:

```powershell
Get-Content "$env:USERPROFILE\.pm2\logs\admin-out.log" -Tail 50
Get-Content "$env:USERPROFILE\.pm2\logs\admin-error.log" -Tail 50
```

