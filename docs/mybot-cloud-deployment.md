# MYBOT Cloud — Hướng dẫn cập nhật & vận hành trên VPS

Nguồn đặc tả: `docs/superpowers/plans/2026-11-25-mybot-cloud-spec.md`.

## 1. Cập nhật lên VPS từ Windows bằng file `.bat`

1. Chạy `DAY_LEN_VPS.bat --dry-run` (hoặc chạy `update.bat` chọn `[1]`) để kiểm tra trước danh sách file gói cập nhật từ commit `HEAD`.
2. Chạy `DAY_LEN_VPS.bat` để đẩy bản cập nhật lên VPS:
   - Lần đầu tiên có MYBOT Cloud, trình cập nhật tự động cài đặt PostgreSQL, tạo 3 role database tách quyền (`mybot_portal_api` không có `SUPERUSER`/`BYPASSRLS`, `mybot_portal_worker`, `mybot_portal_migrator`), cài systemd service, biên dịch `cargo leptos build --release --cargo-locked` + `mybot-portal-worker`, và chạy migration trước khi chuyển symlink `/opt/mybot/current`.
   - Lần đầu biên dịch Rust + WASM trên VPS có thể mất vài phút; các lần sau tận dụng cache Cargo incremental.
3. Sau khi cập nhật xong, chạy `CAI_DAT_PORTAL.bat`:
   - Tạo tài khoản người vận hành (`operator`), nhận **token kích hoạt 1 lần (24 giờ)** và **mã TOTP 2 bước** (lưu vào ứng dụng Google Authenticator / Authy).
   - Nhập tên miền đã trỏ DNS A record về IP VPS để tự động cấu hình Nginx reverse proxy + chứng chỉ HTTPS Let's Encrypt.
4. Truy cập `https://TEN_MIEN/activate?token=TOKEN` để đặt mật khẩu lần đầu cho `operator`, sau đó đăng nhập kèm mã 6 số TOTP và mở `/operator`:
   - Vào tab **Giá, suất bán & Ngân hàng** để cấu hình đơn giá/bot/ngày, thông tin ngân hàng nhận chuyển khoản, ảnh QR ngân hàng, kênh hỗ trợ và số suất mở bán (`capacity` mặc định = `0` để khóa mua cho tới khi bạn kiểm tra xong).

> Lưu ý bảo mật: `INTERNAL_API_SECRET` trong `/opt/mybot/.env` phải dài tối thiểu 32 ký tự ASCII an toàn (không dùng secret mặc định của dashboard). Tệp `/etc/mybot/portal.env` đặt ngoài thư mục release với quyền `0600`.

## 2. Kiến trúc dịch vụ & dữ liệu trên VPS

- **Web & API Portal:** `mybot-portal.service` lắng nghe loopback `127.0.0.1:4180`, kiểm tra sức khỏe tại `/health` (kiểm tra kết nối PostgreSQL trực tiếp).
- **Worker bền vững:** `mybot-portal-worker.service` xử lý phiên QR, kích hoạt/hết hạn/hoàn ví 7 ngày, quét thành viên và hàng đợi gửi quảng cáo.
- **Cầu nối Node nội bộ:** `127.0.0.1:4174` (`/bridge/portal/operations`), bắt buộc xác thực chữ ký HMAC.
- **Binary & tài nguyên tĩnh:** `/opt/mybot/current/bin/mybot-portal`, `/opt/mybot/current/bin/mybot-portal-worker`, `/opt/mybot/current/portal-site` (`pkg/mybot-portal.wasm`, `pkg/mybot-portal.js`, `assets/portal.css`).
- **Dữ liệu bền vững ngoài release:** PostgreSQL `mybot_portal` (tài khoản, ví, bút toán bất biến, đơn hàng, suất thuê, tệp ảnh tải lên, chiến dịch, hàng đợi) và thư mục shared `mybot/` cho phiên runtime riêng của từng `slot_id` + `binding_revision`. Không tự gán các bot quản trị/cũ hiện có cho khách.

Xem nhật ký dịch vụ trên VPS:
```bash
journalctl -u mybot-portal -u mybot-portal-worker -n 100 --no-pager
```

## 3. Rollback & Sao lưu / Phục hồi

- **Rollback mã nguồn:** `DAY_LEN_VPS.bat --rollback` quay lại bản release trước mà **không xóa hoặc ghi đè lịch sử ví, đơn hàng trong PostgreSQL** (các migration đều theo hướng chỉ-thêm tương thích ngược).
- **Sao lưu PostgreSQL:**
  ```bash
  sudo bash /opt/mybot/current/deploy/ubuntu/backup-portal.sh
  ```
  Bản sao lưu định dạng custom được lưu tại `/var/backups/mybot-portal/` (bao gồm cả ảnh upload đính kèm). Sao lưu kèm `/etc/mybot/portal.env` và thư mục shared runtime `mybot/`.
- **Diễn tập khôi phục:** Khôi phục thử sang database riêng bằng `pg_restore --no-owner --dbname=mybot_portal_restore BACKUP.dump` để đối soát số dư ví và đơn hàng trước khi chuyển kết nối thực tế.

## 4. Nghiệm thu thực tế trước khi nâng giới hạn bán

1. Tạo 2 tài khoản khách thử nghiệm A và B, xác nhận A không truy cập được suất thuê, phiên QR, ảnh tải lên, danh sách quét thành viên hay ví của B.
2. Thử quy trình nạp ví → bấm “Tôi đã chuyển” kèm biên lai → duyệt nạp trong `/operator` → mua 3 suất → quét QR Zalo kết nối thật → kiểm tra tự đồng bộ nhóm/lệnh → thử đổi sang tài khoản Zalo khác và xác nhận giữ nguyên `expires_at`.
3. Kiểm tra quét thành viên nhóm và gửi thử nhóm / DM trước khi tăng dần `capacity` theo tài nguyên thực tế của VPS (`5 -> 10 -> tối đa 30` suất).
