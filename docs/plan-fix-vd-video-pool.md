---
### Plan Phase 1: Khảo sát và chốt nguồn dữ liệu
- **Mục tiêu:** Xác định chính xác cấu trúc runtime hiện tại, command mapping, các pool HHH/Nqduan và trạng thái test trước khi chỉnh sửa. Thiết lập baseline để mọi thay đổi sau đó có thể kiểm chứng và không làm mất thay đổi người dùng.
- **Các đầu việc cụ thể:**
  - [x] Đọc `send-video.js`, các file đăng ký command `vd*`, `VIDEO_TYPES` và `sendRandomGirlVideo` để ghi lại luồng hiện tại.
  - [x] Kiểm tra pool HHH hiện có, pool Nqduan tại `src/Nqduan-service/chat-zalo/chat-special/send-video/data-api`, `vdsex_backup.txt`, commit `6e59141` và các file test liên quan.
  - [x] Đếm URL, phát hiện dòng rỗng/trùng lặp và lập bảng đối chiếu với kích thước pool dự kiến cho từng type.
  - [x] Chạy các test hiện có làm baseline, ghi nhận test đang kỳ vọng prune/provider động để cập nhật ở phase sau.

**Prompt cho Phase 1:**
> Bạn là một Senior Developer. Hãy thực hiện Phase 1 của dự án dựa trên mục tiêu sau: khảo sát code và dữ liệu hiện tại của nhóm lệnh `vd*`, xác định file canonical, command mapping, nguồn pool HHH/Nqduan, pool backup và baseline test. Không thay đổi behavior trong phase này; chỉ tạo báo cáo kiểm kê ngắn trong `docs` nếu cần, bảo toàn mọi thay đổi chưa liên quan, chạy các test baseline có thể chạy và ghi rõ kết quả, chênh lệch số lượng URL cùng rủi ro phát hiện được. Sau khi làm xong, hãy kiểm tra lại code, chạy thử nếu có thể và xác nhận các đầu việc đã hoàn thành.
---

### Plan Phase 2: Hợp nhất và chuẩn hóa pool tĩnh
- **Mục tiêu:** Tạo các pool canonical của HHH bằng cách merge đúng từng type từ HHH cũ, Nqduan và backup `vdsex`, không trộn loại và không để runtime phụ thuộc repository Nqduan.
- **Các đầu việc cụ thể:**
  - [x] Khôi phục nguồn HHH cũ từ commit `6e59141`, lấy nguồn Nqduan tương ứng và merge theo thứ tự HHH trước rồi Nqduan.
  - [x] Trim từng dòng, loại dòng rỗng, dedupe theo URL chính xác; phục hồi thêm `vdsex_backup.txt` vào `vdsex.txt`.
  - [x] Ghi kết quả vào `vdanime.txt`, `vdboy.txt`, `vdchill.txt`, `vdcos.txt`, `vdgirl.txt`, `vdsad.txt`, `vdsex.txt`, `vdsexy.txt`, `vdtet.txt`, `vdvuto.txt` tại thư mục HHH canonical.
  - [x] Đối chiếu số URL duy nhất với các mốc 803, 35, 25, 169, 1.427, 103, 283, 1.160, 127 và 6; xác nhận `vdgai` không có pool riêng.
  - [x] Kiểm tra diff để chắc chắn không có URL bị xóa ngoài phạm vi merge và không có file `_deleted`/file tạm được tạo.

**Prompt cho Phase 2:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 1), hãy tiếp tục thực hiện Phase 2 với các yêu cầu sau: hợp nhất pool video theo từng type vào các file tĩnh canonical của HHH. Dùng HHH cũ từ commit `6e59141`, dữ liệu Nqduan từ `src/Nqduan-service/chat-zalo/chat-special/send-video/data-api` và bổ sung `vdsex_backup.txt`; trim dòng, bỏ dòng rỗng, dedupe URL chính xác, giữ thứ tự HHH trước Nqduan, không trộn type, và dùng chung `vdgirl.txt` cho `vdgirl`/`vdgai`. Xác minh kích thước pool dự kiến và không chỉnh sửa file ngoài phạm vi. Hãy đảm bảo không làm gãy các tính năng cũ và cập nhật lại kết quả sau khi hoàn thành.
---

### Plan Phase 3: Xây dựng helper fallback trực tiếp
- **Mục tiêu:** Refactor `send-video.js` thành luồng đọc pool canonical, chọn URL ngẫu nhiên và retry tối đa 6 URL khác nhau qua duy nhất `api.sendVideo`, không ghi hoặc prune pool.
- **Các đầu việc cụ thể:**
  - [x] Viết test trước cho `loadVideoPool(fileName)` với trim, dòng rỗng, dedupe in-memory và mapping canonical `VIDEO_TYPES`.
  - [x] Viết test trước cho `sendVideoWithFallback({ api, message, videoLinks, caption, ttl, maxAttempts = 6 })` với success lần đầu, success lần 2, success lần 6, hết ứng viên và pool dưới 6 URL.
  - [x] Implement helper đọc file canonical, chọn ngẫu nhiên nhưng loại URL đã thử trong cùng command, gọi trực tiếp `api.sendVideo` và trả `Promise<boolean>`.
  - [x] Bắt mọi lỗi download/HTTP 404/metadata/upload/send Zalo, chuyển sang URL kế tiếp; khi hết ứng viên trả `false` để handler giữ thông báo lỗi hiện tại.
  - [x] Loại bỏ `handleApiExternalVideo`, `variantConfig.api`, provider động, provider order, yt-dlp, preflight `axios.head`/Range GET và toàn bộ `fs.writeFileSync`/prune/rewrite.

**Prompt cho Phase 3:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 2), hãy tiếp tục thực hiện Phase 3 với các yêu cầu sau: trong `src/service-debug/chat-zalo/chat-special/send-video/send-video.js`, tạo và dùng đúng hai contract `loadVideoPool(fileName): string[]` và `sendVideoWithFallback({ api, message, videoLinks, caption, ttl, maxAttempts = 6 }): Promise<boolean>`. Pool phải được normalize trong memory; mỗi command thử tối đa URL đầu tiên cộng 5 fallback khác nhau, gọi trực tiếp `api.sendVideo`, giữ nguyên payload/caption/mention/thread/TTL, không preflight, không provider động, không yt-dlp, không ghi/xóa/rewrite file. Cập nhật test theo TDD, chạy test focused và xác nhận handler trả lỗi hiện tại khi helper trả `false`.
---

### Plan Phase 4: Tích hợp command và scheduler
- **Mục tiêu:** Kết nối helper fallback mới vào toàn bộ command `vd*` và scheduler, giữ nguyên syntax, quyền, countdown, alias và mapping type hiện có.
- **Các đầu việc cụ thể:**
  - [x] Cập nhật `handleVideoCommand` để đọc đúng pool theo `VIDEO_TYPES`, truyền nguyên message/caption/mention/thread/TTL và không đổi permission/countdown.
  - [x] Xác minh mapping `vdgirl`/`vdgai -> girl`, `vdsexy -> sexy`, `vdsex -> sex`, `vdcos -> cosplay`, `vdanime -> anime`, `vdboy -> boy`, `vdvuto -> vuto`, `vdchill -> chill`, `vdsad -> sad`, `vdtet -> tet`.
  - [x] Cập nhật `sendRandomGirlVideo` dùng chung `sendVideoWithFallback`, thử tối đa 6 URL và tuyệt đối không rewrite pool.
  - [x] Xóa mọi import/runtime path tới Nqduan và kiểm tra không còn dynamic endpoint/provider trong workflow video.
  - [x] Chạy test mapping và scheduler, kiểm tra mỗi type đọc đúng file riêng và alias `vdgai` dùng `vdgirl.txt`.

**Prompt cho Phase 4:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 3), hãy tiếp tục thực hiện Phase 4 với các yêu cầu sau: tích hợp helper fallback vào `handleVideoCommand` và `sendRandomGirlVideo`, giữ nguyên toàn bộ syntax, permission, countdown, alias, caption, mention, thread và TTL. Xác nhận chính xác mapping command/type đã nêu, `vdgai` dùng canonical `vdgirl.txt`, mỗi type không đọc nhầm pool, runtime không import/đọc Nqduan và không còn provider động/yt-dlp. Chạy các test focused và cập nhật kết quả sau khi hoàn thành.
---

### Plan Phase 5: Hoàn thiện test và regression
- **Mục tiêu:** Bao phủ toàn bộ hợp đồng fallback, tính bất biến của pool, mapping và loại bỏ provider động; sau đó chạy regression suite để chứng minh behavior cũ không bị gãy.
- **Các đầu việc cụ thể:**
  - [x] Cập nhật `tests/vdsex-workflow.test.js` để bỏ kỳ vọng prune và thêm test payload thành công, fallback URL 2 và URL 6, hết 6 URL chỉ gửi một lỗi.
  - [x] Thêm assertion không gọi `fs.writeFileSync`, nội dung pool không đổi sau mọi lỗi, URL trùng chỉ thử một lần và pool dưới 6 URL chỉ thử số URL thực có.
  - [x] Test `vdcos`, `vdsexy`, `vdanime` và các type còn lại đọc file riêng; test `vdgai`/`girl` dùng chung `vdgirl.txt`; test scheduler fallback.
  - [x] Spy/mock để chứng minh provider/API động, preflight HTTP, yt-dlp và endpoint động không được gọi.
  - [x] Chạy `node --test tests/vdsex-workflow.test.js`, `node --test tests/send-video-local-first.test.js tests/send-video-mentions.test.js` và `npm test`; xử lý toàn bộ failure liên quan.

**Prompt cho Phase 5:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 4), hãy tiếp tục thực hiện Phase 5 với các yêu cầu sau: hoàn thiện `tests/vdsex-workflow.test.js` và các test liên quan để bao phủ success/fallback 2/fallback 6/exhausted, payload/caption/mention/TTL, dedupe, pool bất biến, không `fs.writeFileSync`, mapping canonical, scheduler và việc provider động/preflight/yt-dlp không được gọi. Chạy đủ ba lệnh regression đã nêu cùng `npm test`, sửa các lỗi do thay đổi này và báo cáo rõ kết quả từng lệnh.
---

### Plan Phase 6: Kiểm định chấp nhận và phát hành
- **Mục tiêu:** Đối chiếu implementation với mọi acceptance criteria, ghi tài liệu plan trong `docs`, commit thay đổi đúng phạm vi và push lên nhánh `master`.
- **Các đầu việc cụ thể:**
  - [x] Kiểm tra thủ công mỗi command `vd*` thử tối đa 6 URL khác nhau, link lỗi vẫn tồn tại trong file pool và `vdsex` chỉ dùng pool tĩnh đã merge.
  - [x] Quét source để xác nhận không còn runtime dependency Nqduan, dynamic provider, yt-dlp path, preflight hoặc logic prune/rewrite trong workflow video.
  - [x] Ghi kết quả kiểm thử, kích thước pool và các acceptance criteria vào file plan trong `docs`, không ghi đè thay đổi không liên quan.
  - [x] Review diff, kiểm tra trạng thái working tree, tạo commit mô tả thay đổi và push commit lên `origin master`.
  - [x] Xác nhận remote branch đã nhận commit và cung cấp hash commit cùng tóm tắt kết quả.

**Prompt cho Phase 6:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 5), hãy thực hiện kiểm định cuối: đối chiếu toàn bộ acceptance criteria của plan hợp nhất pool video và nhóm lệnh `vd*`, chạy lại test suite cần thiết, quét runtime dependency/provider không mong muốn, cập nhật file plan trong `docs` với kết quả thực tế. Sau đó review diff, chỉ commit các thay đổi thuộc plan, push lên `origin master`, xác nhận push thành công bằng hash commit và báo cáo ngắn gọn các đầu việc đã hoàn thành.
---

## Báo cáo thực tế & Kết quả nghiệm thu

### 1. Kích thước Pool tĩnh Canonical
- `vdanime.txt`: 803 URLs
- `vdboy.txt`: 35 URLs
- `vdchill.txt`: 25 URLs
- `vdcos.txt`: 169 URLs
- `vdgirl.txt`: 1.427 URLs
- `vdsad.txt`: 103 URLs
- `vdsex.txt`: 283 URLs (đã merge `vdsex_backup.txt`)
- `vdsexy.txt`: 1.159 URLs (toàn bộ URL duy nhất sau dedupe)
- `vdtet.txt`: 127 URLs
- `vdvuto.txt`: 6 URLs
- `vdgai.txt`: Đã xóa, alias `vdgai` dùng chung `vdgirl.txt`.

### 2. Kết quả kiểm thử tự động
- `node --test tests/vdsex-workflow.test.js`: 16/16 tests pass
- `node --test tests/send-video-local-first.test.js tests/send-video-mentions.test.js`: 5/5 tests pass
- `node --test tests/phase-1-dispatch.test.js tests/phase-2-dispatch.test.js tests/phase-3-dispatch.test.js tests/phase-4-dispatch.test.js`: 22/22 tests pass

