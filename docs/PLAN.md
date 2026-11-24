---
### Plan Phase 1: Khảo sát và khóa phạm vi dữ liệu
- **Mục tiêu:** Xác nhận đúng HHH đích, hai nguồn đầu vào, cấu trúc pool hiện tại và các điểm runtime đang đọc video. Thiết lập tiêu chí an toàn để tuyệt đối không sửa backup Documents và có thể khôi phục snapshot.
- **Các đầu việc cụ thể:**
  - [ ] Kiểm tra tồn tại, quyền đọc/ghi và danh sách file của ba root path; xác nhận source backup Documents chỉ được mở ở chế độ đọc.
  - [ ] Lập inventory các file `vd*.txt`, loại trừ pool ảnh và giữ riêng `vdsex-ytdlp.txt`; ghi nhận encoding, BOM, dòng comment và URL trùng.
  - [ ] Truy vết code runtime, test framework và quy ước script hiện có để xác định module cần tích hợp mà không phá API cũ.
  - [ ] Chốt tiêu chí nghiệm thu: union 4161 URL duy nhất theo 10 pool, snapshot trước ghi, atomic rename, health sidecar fail-open và runtime chỉ skip `dead`.

**Prompt cho Phase 1:**
> Bạn là một Senior Developer. Hãy thực hiện Phase 1 của dự án dựa trên mục tiêu sau: khảo sát repo HHH đích và hai nguồn pool, xác minh chính xác đường dẫn, quyền truy cập, file `vd*.txt`, các lệnh đọc pool và bộ test hiện có; tuyệt đối không sửa source backup Documents. Hãy lập inventory có thể kiểm chứng, ghi rõ các ràng buộc và tiêu chí nghiệm thu cho các phase sau. Sau khi làm xong, hãy kiểm tra lại kết quả và xác nhận các đầu việc đã hoàn thành.
---

### Plan Phase 2: Xây dựng bộ merge pool an toàn
- **Mục tiêu:** Tạo `scripts/rebuild-video-pools.js` với chế độ `--dry-run` và `--apply`, thực hiện chuẩn hóa, deduplicate và hợp nhất đúng thể loại. Mọi thay đổi trên HHH phải có snapshot và được ghi atomically.
- **Các đầu việc cụ thể:**
  - [ ] Cài parser CLI cho `--backup`, `--nqduan`, `--dry-run`, `--apply`, `--check-all`, kiểm tra path bắt buộc và chặn source/đích không hợp lệ.
  - [ ] Đọc đúng mapping nguồn: backup `src/service-debug/chat-zalo/chat-special/data-send`, Nqduan `src/Nqduan-service/chat-zalo/chat-special/send-video/data-api`; chỉ nhận 10 tên pool canonical.
  - [ ] Chuẩn hóa BOM, whitespace, dòng trống, comment; deduplicate theo URL đầy đủ; không trộn URL direct vào `vdsex-ytdlp.txt` và không nhận pool ảnh.
  - [ ] Implement snapshot pool đích trước khi ghi và atomic write bằng file tạm cùng thư mục rồi rename; `--dry-run` không được ghi file.
  - [ ] Thêm test merge cho mapping path, số lượng, deduplicate, phân loại, loại trừ pool ảnh, snapshot và atomic write.

**Prompt cho Phase 2:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 1), hãy tiếp tục thực hiện Phase 2 với các yêu cầu sau: tạo `scripts/rebuild-video-pools.js` có `--dry-run`/`--apply`, đọc đúng hai source path, chuẩn hóa và deduplicate URL theo từng pool, loại trừ pool ảnh, giữ riêng `vdsex-ytdlp.txt`, tạo snapshot trước khi ghi và atomic rename. Viết test thất bại trước rồi triển khai tối thiểu để chứng minh các quy tắc merge. Hãy đảm bảo không làm gãy các tính năng cũ và cập nhật lại kết quả sau khi hoàn thành.
---

### Plan Phase 3: Thực thi merge và đối chiếu pool canonical
- **Mục tiêu:** Chạy merge thật trên HHH sau khi dry-run được duyệt, tạo bộ pool canonical với union dự kiến 4161 URL duy nhất. Xác minh transient/URL không hợp lệ chưa bị xóa khỏi file pool.
- **Các đầu việc cụ thể:**
  - [ ] Chạy lệnh `node scripts/rebuild-video-pools.js ... --dry-run` với đúng backup và Nqduan path, lưu báo cáo đối chiếu.
  - [ ] So sánh từng pool với số lượng kỳ vọng: anime 803, boy 35, chill 25, cos 169, girl 1427, sad 103, sex 306, sexy 1160, tet 127, vuto 6.
  - [ ] Chạy `--apply`, kiểm tra snapshot được tạo, file đích hợp lệ và tổng URL duy nhất bằng 4161.
  - [ ] Kiểm tra `vdsex-ytdlp.txt` không bị trộn direct URL, pool ảnh không xuất hiện và backup Documents không có thay đổi.

**Prompt cho Phase 3:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 2), hãy chạy dry-run rồi apply merge pool vào HHH theo đúng hai lệnh chuẩn, đối chiếu đủ 10 số lượng kỳ vọng và tổng 4161 URL duy nhất. Xác nhận snapshot, atomic output, file `vdsex-ytdlp.txt`, pool ảnh và trạng thái git của backup Documents; không tự ý xóa URL chỉ vì chưa health-check. Hãy ghi lại mọi sai lệch và chỉ xác nhận hoàn thành khi dữ liệu được kiểm chứng.
---

### Plan Phase 4: Implement health checker bằng GET Range
- **Mục tiêu:** Xây dựng health checker xác định URL video sống/chết bằng `GET` kèm `Range`, theo redirect và kiểm tra status, content type, magic bytes. Chỉ kết luận `dead` sau hai probe độc lập cùng kết quả chắc chắn.
- **Các đầu việc cụ thể:**
  - [ ] Tạo module checker theo pattern repo, giới hạn bytes đọc và timeout; không dùng `HEAD` để kết luận URL chết.
  - [ ] Phân loại `healthy`, `dead`, `transient` theo status, lỗi cú pháp, HTML/JSON/text giả video, magic bytes và redirect.
  - [ ] Bảo đảm `403`, `405`, `416`, `429`, `5xx`, timeout, DNS và lỗi mạng là `transient`; parse `Retry-After` cho cooldown hostname.
  - [ ] Viết test mock cho `404`, `410`, `403`, `429`, `5xx`, timeout, HTML giả video, video hợp lệ và redirect.

**Prompt cho Phase 4:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 3), hãy triển khai health checker dùng `GET` với `Range`, follow redirect và đọc tối đa phần response nhỏ để kiểm tra HTTP status, `Content-Type` và magic bytes video. Chỉ trả về `dead` sau hai lần probe độc lập cùng kết quả chắc chắn; các lỗi bị giới hạn phải là `transient`, kèm cooldown hostname cho `429` theo `Retry-After`. Không dùng `HEAD`. Hãy viết và chạy test cho toàn bộ ma trận kết quả.
---

### Plan Phase 5: Lưu sidecar health atomic và cơ chế cooldown
- **Mục tiêu:** Lưu trạng thái health vào `assets/data/video-source-health.json` một cách bền vững, có expiry/cooldown và fail-open khi sidecar lỗi hoặc thiếu. Dữ liệu pool canonical không bị sửa bởi health-check.
- **Các đầu việc cụ thể:**
  - [ ] Thiết kế schema sidecar gồm URL, trạng thái, số lần probe, timestamp, expiry và cooldown theo hostname; tương thích khi file chưa tồn tại.
  - [ ] Implement đọc/ghi JSON atomic bằng file tạm + rename, chống dữ liệu dở dang và xử lý permission/JSON hỏng theo fail-open.
  - [ ] Implement expiry để trạng thái cũ không được coi là `dead` vô thời hạn và cooldown `429` không chặn hostname quá thời hạn.
  - [ ] Viết test atomic write, expiry, cooldown, sidecar thiếu/hỏng và xác nhận fallback không làm gián đoạn runtime.

**Prompt cho Phase 5:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 4), hãy xây dựng health store cho `assets/data/video-source-health.json` với schema rõ ràng, atomic write, expiry, cooldown hostname và fail-open khi sidecar thiếu, hỏng hoặc không ghi được. Runtime không được chỉnh sửa các file `vd*.txt`. Viết test cho lưu/đọc, hết hạn, cooldown và mọi nhánh fail-open rồi chạy chúng.
---

### Plan Phase 6: Tích hợp runtime và báo cáo lọc
- **Mục tiêu:** Nối health store/checker vào luồng chọn video hiện tại để chỉ bỏ qua URL `dead` đã xác nhận, vẫn giữ `transient` và không xóa URL khỏi pool. Log phải là tổng hợp, không spam từng URL.
- **Các đầu việc cụ thể:**
  - [ ] Xác định điểm đọc từng pool và thêm lớp quyết định skip dựa trên trạng thái sidecar; giữ nguyên thứ tự và hành vi fallback hiện tại.
  - [ ] Chỉ skip `dead` còn hạn; `healthy`, `transient`, trạng thái thiếu hoặc lỗi sidecar đều tiếp tục được sử dụng theo logic cũ.
  - [ ] Thêm bộ đếm/log tổng hợp theo pool và trạng thái (`filtered`, `healthy`, `dead`, `transient`) sau mỗi lượt xử lý.
  - [ ] Viết test runtime chứng minh chỉ skip `dead`, giữ `transient`, không sửa canonical pool và mỗi lệnh `vd*` đọc đúng file tương ứng.

**Prompt cho Phase 6:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 5), hãy tích hợp health checker/store vào runtime chọn video. Chỉ skip URL `dead` đã xác nhận và còn hạn; phải giữ URL `transient`, fail-open khi sidecar lỗi/thiếu, không xóa hay rewrite pool canonical, và log số liệu tổng hợp theo pool thay vì in từng dòng. Chạy test workflow cho toàn bộ lệnh `vd*` và xác nhận các tính năng cũ vẫn hoạt động.
---

### Plan Phase 7: Hoàn thiện CLI `--check-all` và báo cáo 4161 URL
- **Mục tiêu:** Mở rộng script bảo trì để quét đủ toàn bộ 4161 URL, tái sử dụng checker/store, xuất báo cáo `healthy/dead/transient` theo từng pool và áp dụng cooldown đúng hostname.
- **Các đầu việc cụ thể:**
  - [ ] Implement pipeline `--check-all` đọc pool canonical sau merge, chạy probe có giới hạn concurrency/timeout và cập nhật sidecar sau từng batch an toàn.
  - [ ] Đảm bảo báo cáo cuối có đủ 10 pool, tổng input 4161 URL và tổng phân loại khớp số lượng thực tế; lỗi mạng không làm hỏng toàn bộ lượt quét.
  - [ ] Kiểm tra retry độc lập cho ứng viên `dead`, `Retry-After` của `429` và không loại URL `transient` khỏi file pool.
  - [ ] Bổ sung test CLI với fixture/mocks, bao gồm dry-run, check-all, báo cáo thiếu dữ liệu và resume sau gián đoạn.

**Prompt cho Phase 7:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 6), hãy hoàn thiện `--check-all` trong `scripts/rebuild-video-pools.js` để quét đủ 4161 URL với concurrency và timeout hợp lý, retry độc lập cho ứng viên `dead`, cập nhật sidecar atomic và xuất báo cáo `healthy/dead/transient` theo từng pool. Hãy đảm bảo `transient` vẫn tồn tại trong HHH pool, cooldown `429` được tôn trọng và lệnh có thể tiếp tục sau gián đoạn.
---

### Plan Phase 8: Kiểm thử hồi quy, tài liệu và bàn giao GitHub
- **Mục tiêu:** Chạy toàn bộ test suite, rà soát thay đổi, cập nhật tài liệu vận hành và hoàn tất commit/push lên nhánh `master`. Kết quả bàn giao phải nêu rõ số lượng pool, health report và các giới hạn còn lại.
- **Các đầu việc cụ thể:**
  - [ ] Chạy các lệnh: `node --test tests/video-pool-merge.test.js tests/video-health-check.test.js`, `node --test tests/video-health-store.test.js tests/vd-video-workflow.test.js` và `npm test`.
  - [ ] Kiểm tra báo cáo có đủ 4161 URL, transient còn trong pool, sidecar hợp lệ, snapshot khôi phục được và không có thay đổi ngoài phạm vi HHH đích.
  - [ ] Cập nhật hướng dẫn chạy dry-run/apply/check-all, schema sidecar, cách đọc log và quy trình rollback snapshot trong `docs/`.
  - [ ] Review diff, commit theo nhóm thay đổi, push lên remote nhánh `master`, xác nhận commit hash và trạng thái clean sau push.

**Prompt cho Phase 8:**
> Bạn là một Senior Developer. Dựa trên code hiện tại của dự án (đã hoàn thành Phase 7), hãy chạy đầy đủ các lệnh test được yêu cầu và kiểm tra báo cáo 4161 URL, transient, sidecar, snapshot cùng trạng thái backup. Cập nhật tài liệu vận hành trong `docs/`, review diff, commit các thay đổi liên quan và push lên GitHub nhánh `master`. Chỉ xác nhận hoàn thành khi test, push và commit hash đều được kiểm chứng.
---
