# Sửa autodownload và payload video Zalo

Đã áp dụng cho nhánh `codex/locmem-recovery`, dựa trên release `fccdb84`.

## Hành vi đã sửa

- Bộ đọc link chung nhận body, nội dung chữ, title và href của preview; nhận đúng hostname và chọn một link hỗ trợ. Lệnh có prefix, kể cả sau mention, và reply đã xử lý được ưu tiên.
- Tài khoản bot được dán link khi autodownload bật. Tin do API tự gửi được nhận diện bằng clientId ghi trước request và msgId bổ sung sau receipt. Chống trùng theo bot/nhóm/ID, kể cả sự kiện đầu chỉ có client ID rồi mới có server ID.
- TikTok, YouTube và hai nhánh AIO gửi video dùng metadata thực, thumbnail JPEG frame đầu đã upload và payload đủ duration (ms), width, height, fileSize. Nguồn không tương thích được chuyển MP4 H.264/AAC; audio và ảnh giữ luồng riêng.
- Cache video thiếu thumbnail/metadata bị bỏ qua. Cache mới chỉ ghi sau khi sendVideo hoàn tất thành công. Lỗi gửi sau upload kết thúc lượt, không tự gửi lại video. File tạm và thông báo chờ được dọn khi thao tác hoàn tất.
- Log tải/gửi chỉ dùng trường an toàn và mã lỗi; không đưa URL nguồn có chữ ký hoặc lỗi provider nguyên văn vào log của các nhánh sửa.

## Kiểm chứng

- Kiểm thử tập trung cuối: **144 test, 143 pass, 1 skip, 0 fail**, gồm input, echo trước receipt, self/member, sự kiện trùng, ưu tiên lệnh, TikTok video/audio/slideshow, cache cũ/hợp lệ, lỗi 114 và lượt tiếp theo, YouTube thường/Shorts/menu/audio, AIO Facebook/Instagram/CapCut và script cập nhật VPS. Skip là smoke YouTube live cần bật chủ động.
- ESLint các module thay đổi và `git diff --check`: đạt.
- Rà soát độc lập tìm hai lỗi hồi quy (prefix sau mention, audio WebM bị coi là video); đều đã tái hiện bằng test lỗi rồi sửa để test đạt.
- Lượt test tổng: `node --test --test-force-exit --test-concurrency=6 "tests/**/*.test.js" "tests/**/*.test.cjs"`: **2.239 test, 2.211 pass, 5 fail, 23 skip**. Năm lỗi cũng được ghi nhận ở báo cáo release trước: `runtime-status-resolver` thiếu kỳ vọng field `memory`; `latency-tracker` thiếu phase trong snapshot; ba test `terminal-log` kỳ vọng ANSI trong môi trường không có màu. Không coi toàn bộ suite là xanh.
- Lượt `npm test` tuần tự ban đầu được dừng sau khi lượt toàn bộ mới hoàn tất. Lượt đầu còn thấy hai lỗi Phase 8 trong lúc chạy nhiều runner; chạy lại riêng `phase-8-handler.test.js` đạt **4/4**. Kỳ vọng cũ “bỏ qua self” được cập nhật theo yêu cầu mới và đã đạt trong lượt tổng mới.

## Chuẩn bị trên VPS

Chạy đúng hàm chuẩn bị media mới trong thư mục tạm qua SSH, dùng FFmpeg/ffprobe trên VPS, không gửi tin Zalo và không đổi release:

| Nguồn | Kích thước | Thời lượng | File gửi | Thumbnail JPEG |
| --- | --- | --- | --- | --- |
| MP4 H.264/AAC | 180×320 | 400 ms | 6.426 byte | 584 byte |
| WebM VP9/Opus → MP4 H.264/AAC | 180×320 | 407 ms | 6.506 byte | 584 byte |

`--dry-run` xác nhận baseline VPS `fccdb84`, chỉ restart Node, không build Rust/dashboard hoặc cài dependency. Cấu hình SSH nằm ở file local ngoài Git.

## Cập nhật và nghiệm thu

Chạy `DAY_LEN_VPS.bat` từ checkout chứa commit sửa trên nhánh này. BAT đóng gói **HEAD local**; push GitHub không tự cập nhật HEAD của một checkout khác. Nếu dùng bản clone khác, checkout/pull nhánh này trước khi bấm BAT. Không dùng ZIP thiếu lịch sử Git.

Trong nhóm bật `!atd`, dùng cùng link TikTok qua `!tt`, `!download` và dán link trực tiếp; xác nhận cả ba video phát trên điện thoại. Kiểm tra thêm YouTube và một lượt mới sau lỗi gửi. Chưa có nghiệm thu gửi thật/phát trên điện thoại trong lượt sửa này.

Nếu sau cập nhật có lỗi nhận tin/gửi media: `DAY_LEN_VPS.bat --rollback`.
