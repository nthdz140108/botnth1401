### Plan Phase 1: Baseline và hợp đồng lỗi tải video
- **Mục tiêu:** Chốt hành vi hiện tại của nhóm lệnh `vd*`, các điểm tích hợp và hợp đồng lỗi cần giữ ổn định trước khi thay đổi. Tạo baseline test để phát hiện regression trong quá trình triển khai.
- **Các đầu việc cụ thể:**
  - [x] Đọc `src/api-zalo/media/video-temp-file.js`, `src/api-zalo/apis/sendVideo.js`, `src/service-debug/chat-zalo/chat-special/send-video/send-video.js` và registry để lập sơ đồ luồng tải/gửi video.
  - [x] Xác nhận pool canonical, giới hạn 6 URL, mapping/payload của `vdsex`, `vdanime`, `vdsexy`, `vdcos`, `vdgirl`, `vdgai`, `vdboy`, `vdtet`, `vdchill`, `vdsad`, `vdvuto`.
  - [x] Chạy các test baseline `tests/vdsex-workflow.test.js`, `tests/send-video-local-first.test.js`, `tests/send-video-mentions.test.js` và ghi nhận kết quả.
  - [x] Định nghĩa shape lỗi tải gồm `status`, `url`, `hostname`, `retryAfterMs` và nguyên tắc không sửa/xóa/rewrite các file pool `vd*.txt`.

**Prompt cho Phase 1:**
> Bạn là một Senior Developer. Hãy thực hiện Phase 1 của dự án dựa trên mục tiêu sau: khảo sát đầy đủ luồng `vd*` từ command registry đến `api.sendVideo()` và downloader, xác nhận các mapping/payload hiện hữu, chạy ba nhóm test baseline và ghi lại hợp đồng lỗi HTTP/network cũng như các giới hạn bất biến. Chỉ thêm test hoặc tài liệu cần thiết cho baseline, không thay đổi behavior production. Sau khi làm xong, hãy kiểm tra lại code, chạy thử nếu có thể và xác nhận các đầu việc đã hoàn thành.

---

### Plan Phase 2: Health store URL và hostname
- **Mục tiêu:** Xây dựng sidecar health store bền vững để quarantine URL trả `404` và cooldown hostname trả `429`, không đụng vào pool canonical. Store phải fail-open và ghi file an toàn.
- **Các đầu việc cụ thể:**
  - [x] Tạo `src/service-debug/chat-zalo/chat-special/send-video/video-health-store.js` với schema `version`, `urls`, `hosts` và API đọc/ghi/kiểm tra trạng thái URL-host.
  - [x] Tạo cơ chế `404` quarantine 30 ngày, `429` cooldown theo `Retry-After` hoặc mặc định 60 giây, tối đa 15 phút, tự dọn entry hết hạn.
  - [x] Ghi `assets/data/video-source-health.json` bằng temp file và `renameSync`; khi file hỏng hoặc không ghi được phải giữ state RAM, log cảnh báo và tiếp tục fail-open.
  - [x] Viết `tests/video-health-store.test.js` cho khởi tạo thiếu file, phục hồi JSON hỏng, expiry, atomic write, 404 quarantine, 429 cooldown và fail-open.

**Prompt cho Phase 2:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 1), hãy tiếp tục thực hiện Phase 2 với các yêu cầu sau: tạo module health store sidecar độc lập, lưu trạng thái URL/hostname đúng schema, áp dụng TTL 30 ngày cho 404 và cooldown Retry-After cho 429 với trần 15 phút, dọn entry hết hạn, ghi atomic bằng temp file + renameSync và fail-open khi sidecar lỗi. Không sửa bất kỳ file `vd*.txt` nào. Hãy viết test đơn vị đầy đủ cho các hành vi trên, đảm bảo không làm gãy các tính năng cũ và cập nhật lại kết quả sau khi hoàn thành.

---

### Plan Phase 3: Downloader phân loại HTTP và giới hạn hostname
- **Mục tiêu:** Làm cho downloader trả lỗi có cấu trúc, dừng retry ngay với lỗi không nên lặp và vẫn retry có backoff với lỗi tạm thời. Bổ sung giới hạn đồng thời/khoảng cách request theo hostname để giảm 429.
- **Các đầu việc cụ thể:**
  - [x] Cập nhật `src/api-zalo/media/video-temp-file.js` để export lỗi có `status`, `url`, `hostname`, `retryAfterMs` và parse `Retry-After` dạng giây hoặc HTTP date.
  - [x] Dừng ngay, không retry cùng URL với `404` và `429`; giữ tối đa 3 lần retry exponential backoff + jitter cho `5xx`, timeout, `ECONNRESET`, `EAI_AGAIN`.
  - [x] Bảo đảm mọi thất bại đều xóa `.part`, chỉ rename sang `.mp4` sau khi tải hoàn tất, và cleanup không làm che mất lỗi gốc.
  - [x] Thêm limiter theo hostname: tối đa một download đồng thời và khoảng cách tối thiểu giữa hai request cùng host; cho phép inject clock/sleep để test không chờ thật.
  - [x] Cập nhật `tests/video-temp-file.test.js` cho phân loại lỗi, Retry-After, số lần retry, jitter/backoff, limiter và cleanup file tạm.

**Prompt cho Phase 3:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 2), hãy tiếp tục thực hiện Phase 3 với các yêu cầu sau: cập nhật downloader để chuẩn hóa lỗi HTTP/network, không retry 404/429 trên cùng URL, tôn trọng Retry-After, retry tối đa 3 lần cho 5xx/network với exponential backoff và jitter, xóa `.part` trong mọi nhánh lỗi, đồng thời giới hạn một download đồng thời và khoảng cách request theo hostname. Giữ tương thích với `api.sendVideo()` hiện tại và cung cấp dependency injection cần thiết để test deterministic. Hãy chạy test liên quan và cập nhật lại kết quả sau khi hoàn thành.

---

### Plan Phase 4: Fallback tích hợp health state
- **Mục tiêu:** Kết nối health store với orchestration fallback để bỏ qua nguồn chết/cooldown, chuyển host đúng cách và luôn kết thúc trong giới hạn 6 URL mỗi invocation.
- **Các đầu việc cụ thể:**
  - [x] Cập nhật `sendVideoWithFallback()` trong `src/service-debug/chat-zalo/chat-special/send-video/send-video.js` để đọc health state trước khi chọn URL và loại URL/host không khả dụng.
  - [x] Ghi health state sau lỗi: 404 quarantine URL, 429 cooldown hostname, 5xx/network chỉ loại khỏi invocation hiện tại.
  - [x] Khi mọi ứng viên bị chặn, trả lỗi có kiểm soát và gửi đúng thông báo hiện tại; không retry vô hạn, không thay đổi caption, mention, TTL, permission hoặc countdown.
  - [x] Áp dụng cùng orchestration cho `handleVideoCommand()` và `sendRandomGirlVideo()`; giữ nguyên pool bất biến.
  - [x] Mở rộng `tests/vdsex-workflow.test.js` cho quarantine giữa hai invocation, cooldown host, fallback sang host khác, pool một host bị 429 và giới hạn 6 URL.

**Prompt cho Phase 4:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 3), hãy tiếp tục thực hiện Phase 4 với các yêu cầu sau: tích hợp `video-health-store.js` vào `sendVideoWithFallback()`, lọc URL/hostname trước khi tải, cập nhật trạng thái theo 404/429/5xx-network, chuyển sang host khác khi có thể và trả lỗi hữu hạn khi tất cả ứng viên bị chặn. Áp dụng nhất quán cho `handleVideoCommand()` và `sendRandomGirlVideo()`, giữ nguyên command mapping, payload, caption, mention, TTL, permission, countdown và không sửa pool `vd*.txt`. Hãy chạy toàn bộ workflow test liên quan và cập nhật lại kết quả sau khi hoàn thành.

---

### Plan Phase 5: Logging và kiểm thử đồng thời
- **Mục tiêu:** Bổ sung logging có cấu trúc, không làm lộ token trong query URL, và xác minh các request đồng thời không vượt limiter hostname. Đảm bảo lỗi vận hành có thể truy vết.
- **Các đầu việc cụ thể:**
  - [x] Thêm log theo format `[vd-video] stage=download|fallback status=... action=...`, log hostname và URL đã rút gọn khi có query nhạy cảm.
  - [x] Viết test cho redaction URL, log quarantine/cooldown/skip và thông báo lỗi cuối invocation.
  - [x] Viết test hai command đồng thời để chứng minh cùng hostname không có hơn một download chạy song song và giữ khoảng cách request tối thiểu.
  - [x] Kiểm tra cleanup `.part`/`.mp4` trong success, HTTP failure, network failure và fallback nhiều lượt.

**Prompt cho Phase 5:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 4), hãy tiếp tục thực hiện Phase 5 với các yêu cầu sau: bổ sung structured logging cho download/fallback, che query token khi log, kiểm thử các action quarantine/cooldown/skip, kiểm thử hai invocation đồng thời theo cùng hostname và xác nhận cleanup file tạm trong mọi nhánh. Không thay đổi nội dung thông báo và payload người dùng ngoài phần log nội bộ. Hãy chạy các test mới cùng workflow test hiện có và cập nhật lại kết quả sau khi hoàn thành.

---

### Plan Phase 6: Hồi quy, tài liệu và phát hành
- **Mục tiêu:** Xác nhận toàn bộ nhóm lệnh `vd*` không regress, sidecar/pool được quản lý đúng, hoàn tất tài liệu triển khai và đưa thay đổi lên nhánh `master`.
- **Các đầu việc cụ thể:**
  - [x] Chạy `node --test tests/video-health-store.test.js tests/video-temp-file.test.js tests/vdsex-workflow.test.js`.
  - [x] Chạy `node --test tests/send-video-local-first.test.js tests/send-video-mentions.test.js` và các test suites liên quan; xử lý mọi regression trước khi phát hành.
  - [x] Xác nhận test mapping/payload cho toàn bộ `vdsex`, `vdanime`, `vdsexy`, `vdcos`, `vdgirl`, `vdgai`, `vdboy`, `vdtet`, `vdchill`, `vdsad`, `vdvuto`, cùng bất biến của pool `vd*.txt`.
  - [x] Cập nhật tài liệu vận hành về sidecar `assets/data/video-source-health.json`, fail-open, TTL/cooldown, log redaction và cách reset state an toàn.
  - [x] Review diff, commit theo từng nhóm thay đổi, push lên remote nhánh `master` và ghi lại commit/test result.

**Prompt cho Phase 6:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 5), hãy tiếp tục thực hiện Phase 6 với các yêu cầu sau: chạy đầy đủ test suite được nêu trong plan, xác nhận mọi command `vd*` giữ nguyên mapping và payload, kiểm tra pool không bị sửa, cập nhật tài liệu vận hành cho health sidecar và logging, review diff rồi commit các thay đổi. Sau khi mọi kiểm tra đều đạt, push code lên remote nhánh `master` và báo cáo rõ các lệnh test, kết quả, commit và trạng thái push.
