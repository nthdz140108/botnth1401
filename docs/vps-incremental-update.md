# Cập nhật VPS theo commit

Chạy các lệnh dưới đây trong checkout của repo `botnth1401` có cấu hình
`deploy/vps-deploy.local.json` hợp lệ. `DAY_LEN_VPS.bat` không có tham số sẽ
triển khai commit `HEAD`; chỉ các file đã commit được đưa vào bản vá.

```bat
DAY_LEN_VPS.bat --target HEAD --dry-run
DAY_LEN_VPS.bat --target HEAD --apply
DAY_LEN_VPS.bat --status
DAY_LEN_VPS.bat --rollback
DAY_LEN_VPS.bat --recover
```

`--dry-run` đọc bản hiện tại trên VPS và hiển thị commit nền, commit đích,
file thay đổi, SHA-256, dung lượng và các tác vụ dự kiến. Có thể thêm
`--base <commit>` để yêu cầu bản nền cụ thể. Sau khi kiểm tra, `--apply` gửi
manifest và các file thêm hoặc sửa; file xóa chỉ có trong manifest. Đổi tên
được biểu diễn bằng xóa và thêm. Commit chỉ có tài liệu, kiểm thử hoặc nút
Windows được báo là không có thay đổi cần triển khai.

Trên VPS, mỗi release có mã và sản phẩm build riêng. `current` được chuyển
bằng đổi tên symlink; mã Node được ghim vào release khi tiến trình khởi động,
còn `PROJECT_ROOT` tiếp tục trỏ tới `/opt/mybot` để giữ dữ liệu bot. Các bot
đang dừng được giữ nguyên. Bản vá JavaScript khởi động lại các tiến trình Node
đang hoạt động; bản vá giao diện build trong release và không khởi động lại
Node hoặc Rust. Thay đổi Rust hoặc dependency chỉ build và restart các thành
phần liên quan. Khóa `flock` ngăn hai lần deploy cùng chạy.

Worker chạy trong systemd transient unit nên có thể tiếp tục khi SSH ngắt.
Sau khi mất kết nối, chạy `--status` để xem commit hiện tại, trạng thái và
nhật ký giao dịch. Nếu trạng thái giao dịch là `pending` hoặc
`recovery_pending`, chạy `--recover` để khôi phục và kiểm tra bản trước.
Nếu kiểm tra sau chuyển đổi thất bại, worker tự khôi phục bản trước; nếu không
kiểm tra được bản khôi phục, trạng thái vẫn báo cần xử lý.

Catalog dùng chung và dữ liệu runtime không bị ghi đè. Lệnh mới có thể khai báo
trong `src/utils/release-command-defaults.js`: bot và dashboard bổ sung metadata
chỉ khi release đang chạy chưa có tên lệnh đó trong catalog dùng chung. Cấu hình
đã có luôn được ưu tiên. Preview chỉ bỏ qua thay đổi trong hai catalog JSON khi
chúng thuần bổ sung các khai báo khớp chính xác file defaults của commit đích;
đổi prefix, sửa/xóa lệnh cũ hoặc đụng dữ liệu khác vẫn bị từ chối. Rollback mã
cũng loại bỏ các khai báo ngầm bổ sung mà không sửa catalog dùng chung. Chỉnh
một lệnh khác không ghi các khai báo ngầm này vào JSON. Nếu quản trị viên sửa
đích danh cấu hình global của lệnh mới, cấu hình đó được lưu như lựa chọn chủ
động và được giữ khi rollback. Muốn tắt lệnh thuộc release, đặt `active=false`
trong cấu hình riêng của bot; không xóa khai báo mặc định của release.

Migration SQL vẫn yêu cầu xử lý riêng. Không phục hồi SQLite khi rollback mã thông
thường. `--bootstrap` chạy installer đầy đủ cũ cho VPS chưa dùng release;
thao tác này cài phụ thuộc, build Rust và restart dịch vụ. Để bảo vệ release
và binary hiện có, installer từ chối chạy khi VPS đã có `current`.
Hai script chép trực tiếp `sync-js-to-vps.mjs` và `sync-all-to-vps.mjs` đã
được vô hiệu hóa vì chúng ghi đè mã hoặc binary ngoài giao dịch release.

Các release và bản sao legacy hiện được giữ lại để quay lui; công cụ chưa tự
xóa release cũ vì dependency có thể được chia sẻ giữa các release. Theo dõi
dung lượng đĩa trước khi dọn thủ công, và không xóa release đang chạy hoặc
được một release khác tham chiếu.
