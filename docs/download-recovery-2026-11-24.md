# Khôi phục download trên VPS — 24/11/2026

## Kết quả

- yt-dlp dùng Deno riêng cho metadata và worker; bot tiếp tục dùng Node hiện có. Không ép player client Android khi dùng cookie. Không tải cả playlist khi người dùng gửi link có `list`.
- Sửa điều kiện nhận dạng audio: selector video có `+bestaudio` vẫn tải video. Video ưu tiên H.264 và mã hóa AAC khi ghép MP4; audio xuất M4A/AAC, khớp tên file thực tế của yt-dlp.
- Lệnh TikTok nhận link mà không cần khóa tìm kiếm; tìm kiếm từ khóa vẫn kiểm tra khóa trong adapter tìm kiếm.
- Giữ chuỗi nguồn TikTok SubHatDe → HoangDev → nguồn gốc. Mỗi nguồn có log kết quả/mã lỗi; hết nguồn có một phản hồi thất bại.
- `download` không còn bị registry chặn khi thiếu khóa HoangDev. Nếu nguồn lỗi, thiếu cấu hình, thiếu định dạng hoặc tải file thất bại trước upload, link YouTube/TikTok chuyển sang luồng riêng. HoangDev trả nhiều chất lượng hợp lệ vẫn mở menu. Các nguồn AIO khác giữ đường tải hiện có và báo nguyên nhân nguồn/xác thực/timeout.
- Ghi nhận ranh giới upload/gửi trước khi gọi API: lỗi hoặc timeout sau ranh giới này không kích hoạt fallback. Giữ quyền, alias, cooldown và `enableDownload` hiện có.
- Thu hồi tiến trình khi job kết thúc; dọn cả thư mục thành phần yt-dlp khi merge lỗi. AIO dùng downloader có AbortController/pipeline thay cho timer chỉ reject mà không dừng stream. Dọn file sau upload/gửi thất bại.
- Helper gửi nhạc có chế độ truyền lỗi cho luồng download, tránh báo thành công khi gửi voice thất bại.
- Log tải chỉ ghi jobId, nguồn, bước, trạng thái và mã lỗi; không serialize lỗi Axios, header, cookie, API key hoặc query URL.

## Bấm BAT để cập nhật

Trong checkout Git hiện tại, chạy `DAY_LEN_VPS.bat`. Mặc định tool lấy commit `HEAD` trên máy này và so với commit đang chạy trên VPS. File chưa commit không được đưa vào bản cập nhật.

Tool kiểm tra Deno >= 2.3.0, FFmpeg và ffprobe trước khi upload/chuyển release. Nếu thiếu Deno, cài bản 2.3.0 có checksum SHA-256 cố định từ release chính thức; không thay Node. Nếu môi trường đã có Deno tương thích thì giữ nguyên.

Worker incremental hiện có tạo release riêng, chuyển `current`, restart thành phần liên quan và kiểm tra sức khỏe. Nếu kiểm tra thất bại, worker khôi phục release trước. Không cập nhật cookie/config/data từ Git; giữ release trước để rollback.

Các lệnh khi cần kiểm tra thủ công:

```bat
DAY_LEN_VPS.bat --dry-run
DAY_LEN_VPS.bat --status
DAY_LEN_VPS.bat --rollback
```

Cấu hình kết nối vẫn ở `deploy/vps-deploy.local.json` trên máy này, không push mật khẩu lên GitHub. Không dùng bản ZIP thiếu lịch sử Git để chạy incremental.

## Kiểm chứng

Lượt kiểm thử tập trung cuối: **151 test, 145 pass, 6 skip, 0 fail**. Bao gồm nguồn TikTok dự phòng/hết nguồn, video/slideshow/audio, thiếu khóa tìm kiếm, YouTube thường/Shorts, AIO Facebook/Instagram/CapCut, menu chất lượng hợp lệ, lỗi tải trước upload, lỗi upload không fallback, nhóm tắt autodownload, dọn file thành phần, lỗi voice, quyền và bộ cập nhật incremental. Các skip bao gồm ca cần Linux hoặc smoke cần cấu hình chủ động.

ESLint cho các module thay đổi và `git diff --check` đều pass. Rà soát độc lập đã kiểm tra ranh giới fallback, lỗi voice, cleanup và checksum Deno.

Đã chạy xong `npm test` toàn dự án: **2.214 test, 2.185 pass, 6 fail, 23 skip** (khoảng 18 phút). Các lỗi ở phần không sửa trong bản này:

- `tests/dashboard/runtime-status-resolver.test.js`: kỳ vọng danh sách field cũ, thiếu field `memory` đang có trong kết quả.
- `tests/latency-tracker.test.js`: kỳ vọng phase `ws_received->preflight_started` không có trong snapshot.
- `tests/terminal-log.test.js`: ba ca màu ANSI (`uses ansi colors only when enabled and never when NO_COLOR or redirected`, `allows managed listener pipes to color when the supervising terminal opted in`, `colors event branches and labels by field tone for easier scanning`) kỳ vọng mã màu nhưng nhận text không có ANSI trong môi trường chạy kiểm thử này.

Lượt toàn dự án ban đầu cũng gặp kỳ vọng registry TikTok cũ trong `phase-4-dependency.test.js`; kỳ vọng này đã được cập nhật theo việc kiểm tra khóa ở adapter tìm kiếm và đã pass trong lượt tập trung cuối. Các test dashboard, latency và terminal được chạy riêng để xác nhận các lỗi còn lại. Không coi toàn bộ suite là xanh.

## Kiểm tra trực tiếp trên VPS

Chạy mã sửa trong thư mục tạm, sử dụng runtime/data tương ứng bot thật, không đổi release `a9ef7f8de01d824a87bc87481630128515589544` và không gửi tin nhắn Zalo.

Video công khai do người dùng cung cấp: `MR6zUAk6ayk`, dài 229 giây.

| Bước | Kết quả |
| --- | --- |
| Runtime | Deno 2.4.0, Node 20.20.2 giữ nguyên |
| Cookie | Cấu hình có cookie; tài khoản root chạy PM2 đọc được |
| Metadata | Pass, đúng video, không lấy playlist |
| Worker tải video | 14.021.099 byte, ffprobe: H.264 video + AAC audio |
| Worker tải audio | 3.698.291 byte, ffprobe: AAC audio |
| Dọn thư mục thử | Tự động trong finally/trap |

Có thể chạy lại trên VPS bằng:

```sh
cd /opt/mybot
PROJECT_ROOT=/opt/mybot MYBOT_DATA_DIR=/opt/mybot/mybot \
  node current/scripts/diagnose-download.mjs \
  'https://www.youtube.com/watch?v=MR6zUAk6ayk' \
  --env-file /opt/mybot/.env.local --download
```

**Chưa nghiệm thu upload/gửi media và phát trên điện thoại.** Người dùng đã yêu cầu bỏ bước gửi nhóm test. TikTok live chưa kiểm tra vì không có link lỗi cụ thể; các ca TikTok/AIO nêu trên là kiểm thử tự động. Chưa áp dụng bản vá vào bot production; người dùng chạy BAT khi muốn cập nhật.

Tham chiếu runtime: [yt-dlp EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS) yêu cầu Deno >= 2.3.0 hoặc Node >= 22; chọn Deno để giữ Node của bot.
