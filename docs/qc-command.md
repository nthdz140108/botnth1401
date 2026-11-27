# Lệnh quảng cáo riêng `qc`

Dành cho `adminLevelHigh`, dùng trong nhóm hoặc chat riêng. Prefix ví dụ `!` được thay bằng prefix đang cấu hình.

1. Gọi `!qc`, gửi trực tiếp `1`, `1 2 3` hoặc `all` tại cuộc chat mở phiên để chọn nhóm, không cần reply. Reply một trang danh sách vẫn dùng được.
2. Gửi một tin gốc tại chính cuộc chat đó để làm quảng cáo; không cần reply. Nếu nội dung bắt đầu bằng cú pháp lệnh, reply lời nhắc nhập nội dung.
3. Bot quét các nhóm được chọn, gộp UID và gửi riêng tuần tự, cách nhau ít nhất một giây. Không có bước xác nhận thêm.
4. `!qc status` xem số liệu; `!qc stop` ngăn các lượt tiếp theo. Chỉ người mở phiên tại cuộc chat gốc được xem/dừng phiên đó.

Mỗi bot có tối đa một phiên/lượt gửi. Mỗi bước chọn nhóm và nhập nội dung có thời hạn 5 phút. Tin khác người, khác cuộc chat, tin vọng lại từ bot, lệnh bình thường và tin ngoài bước chờ nội dung không được nhận làm quảng cáo.

## Nội dung

Hỗ trợ văn bản và link, ảnh có caption, video có caption, tệp, ghi âm, GIF có caption, sticker và danh thiếp khi tin gốc chứa đủ thông tin SDK cần. Một người nhận được một tin; không thêm lời dẫn hoặc tách caption khỏi media. Album/nhiều tệp trong một tin, tin thoại/sticker/danh thiếp có caption, hoặc dữ liệu media thiếu thông tin bắt buộc sẽ bị từ chối rõ ràng; phiên tiếp tục chờ nội dung khác trong thời hạn còn lại.

Ảnh phải có URL gốc; video cần URL gốc, ảnh bìa và metadata. Với file thiếu kích thước/checksum, bot đọc tệp một lần để bổ sung. Kết quả API có mã tin của máy chủ mới được tính thành công; client ID và Promise hoàn tất không đủ để xác nhận.

## Dừng, restart và trạng thái không chắc chắn

Checkpoint nằm dưới thư mục dữ liệu instance: `data/qc/<UID-bot>.json`, ghi nguyên tử trước/sau mỗi người nhận. Trạng thái của lượt cũ được chuyển thành `interrupted` khi QC được mở lại sau restart. Không tự tiếp tục hoặc tự gửi lại người đã xử lý; request đang dở được ghi `unconfirmed`.

Nếu một request gửi quá 30 giây, bot báo chưa xác nhận và dừng chiến dịch. Khóa bot vẫn được giữ cho tới khi request cũ kết thúc, để ngăn gửi chồng. Không retry lỗi mạng hoặc phản hồi không rõ. Mất đăng nhập khi quét hoặc gửi sẽ dừng chiến dịch. Checkpoint hỏng không được bỏ qua để tạo lượt mới.

Danh sách thành viên dựa trên `readRoster`/`completeRoster` của `getuser`, kể cả phân trang `getgi/v2`. Chỉ UID thực tế do API trả về được tính. Báo cáo giữ thông tin đầy đủ/thiếu và ghi riêng lỗi quét nhóm.

## Nghiệm thu triển khai

Test mô phỏng kiểm tra registry/quyền/Studio, lựa chọn/phân trang/hết hạn, media, pipeline nhóm/DM, khử trùng UID, pacing, chiến dịch vượt 60 giây, lỗi API/network, stop/restart và checkpoint. Đây chưa phải bằng chứng Zalo đã giao tin thật.

Cần nghiệm thu bằng bot thử, nhóm thử và tài khoản nhận được phép sử dụng trước khi chạy `DAY_LEN_VPS.bat --apply`. Khi chưa có các tài khoản này, chỉ push GitHub và chạy BAT `--dry-run`; không đánh dấu nghiệm thu live hoàn tất.
