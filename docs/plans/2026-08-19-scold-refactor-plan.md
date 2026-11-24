# Kế Hoạch & Báo Cáo Triển Khai: Nâng Cấp và Ổn Định Lệnh `scold`

**Ngày thực hiện:** 19/08/2026  
**Nhánh:** `master`  
**File sửa đổi chính:** `src/service-debug/chat-bot/scold-user/scold-user.js`  
**Test suite bổ sung:** `tests/scold-regression.test.js`

---

## 1. Tổng Quan Vấn Đề (Problem Statement)
Lệnh `scold` trong `scold-user.js` gặp phải các lỗi nghiêm trọng về vòng đời bất đồng bộ và quản lý timer:
1. **Lỗi TDZ / ReferenceError:** Khởi chạy `setInterval(async ...)` trước khi `await getUserInfoData(...)` trả về kết quả. Khi `getUserInfoData` chậm hơn timer tick, callback truy cập biến `userTarget` chưa được khởi tạo gây unhandled rejection.
2. **Chồng chéo request:** `setInterval(async ...)` kích hoạt timer tick cố định không đợi kết quả `api.sendMessage` của lần gửi trước.
3. **Delay chưa chuẩn hóa:** Delay mặc định cũ là `5001ms` và cho phép delay dưới 1000ms (100ms). Cần chuẩn hóa delay mặc định là `1000ms` và delay tối thiểu là `1000ms` riêng cho `scold`.
4. **Xử lý lỗi và dừng phiên thiếu bền vững:** Thiếu khối `try/catch` bọc các lời gọi `api.sendMessage`, làm rò rỉ state `scoldUsers` và timer khi có lỗi mạng, đồng thời lệnh `scold tha` chưa đảm bảo tính idempotent.

---

## 2. Chi Tiết Các Phase Triển Khai

### Phase 1: Khảo Sát và Thiết Kế Kiểm Thử
- Khảo sát toàn diện luồng hoạt động, các module phụ thuộc (`user-info.js`, `index.js`, `service.js`, `format-util.js`).
- Xác định và bảo toàn các validation nghiệp vụ:
  - Kiểm tra mention rỗng -> gửi tin nhắc nhở `:D Đại Ca muốn em chửi ai? 🚀`.
  - Kiểm tra target là admin -> chặn với thông báo `Không thể ra lệnh chửi quản trị bot. 🚫`.
  - Kiểm tra target đang bị scold -> chặn với thông báo `Người này đang bị chửi.`.
  - Quyền admin cho lệnh `scold tha`.
  - Giữ nguyên toàn bộ 1700+ tin nhắn trong danh sách `scoldMessages`.

### Phase 2: Bổ Sung Regression Test Cho `scold`
Tạo file test `tests/scold-regression.test.js` bao phủ 6 kịch bản kiểm thử:
- **Test 1:** Giới hạn delay tối thiểu 1000ms và delay mặc định 1000ms.
- **Test 2:** Xử lý `getUserInfoData` phản hồi chậm không gây lỗi TDZ/ReferenceError.
- **Test 3:** Gửi tin nhắn tuần tự không chồng chéo (`maxConcurrentSends <= 1`).
- **Test 4:** Bắt lỗi `api.sendMessage` an toàn, dọn dẹp state và không tạo unhandled rejection.
- **Test 5:** Dừng phiên `scold tha` idempotent, gửi tin tha đúng 1 lần.
- **Test 6:** Bảo toàn các validation hiện hữu.

### Phase 3: Sửa Vòng Đời Gửi Tin `scold`
- Di chuyển `await getUserInfoData` lên đầu hàm `scoldUser`, thực hiện trước khi gửi thông báo chuẩn bị và trước khi kích hoạt timer.
- Chuẩn hóa delay: mặc định `1000ms`, giá trị thấp hơn được nâng lên `1000ms`, giới hạn tối đa `10000ms`.
- Thay `setInterval(async ...)` bằng cơ chế tự lên lịch đệ quy (recursive `setTimeout`) chỉ lên lịch lần gửi tiếp theo sau khi lần gửi trước hoàn thành.

### Phase 4: Tăng Độ Bền và Dừng Phiên Idempotent
- Bọc toàn bộ các lời gọi `api.sendMessage` và `getUserInfoData` trong `try/catch` có log ngữ cảnh.
- Quản lý phiên theo cấu trúc `activeSessions` với cờ `active` và `forgiven`.
- Đảm bảo `scold tha` giải phóng timer ngay lập tức, gửi thông báo tha duy nhất 1 lần và dọn sạch `scoldUsers`.
- Cung cấp hàm `_resetScoldState` phục vụ kiểm thử cô lập.

### Phase 5: Nghiệm Thu và Đẩy `master`
- Chạy toàn bộ regression test và contract test.
- Kiểm tra `git diff` xác nhận thay đổi chỉ ảnh hưởng đến lệnh `scold`.
- Commit và push lên nhánh `master`.

---

## 3. Kết Quả Kiểm Thử

```
TAP version 13
# Subtest: Phase 2 & 3: scold delay normalization enforces minimum 1000ms and default 1000ms
ok 1 - Phase 2 & 3: scold delay normalization enforces minimum 1000ms and default 1000ms
# Subtest: Phase 2 & 3: slow getUserInfoData does not cause TDZ ReferenceError or crash
ok 2 - Phase 2 & 3: slow getUserInfoData does not cause TDZ ReferenceError or crash
# Subtest: Phase 2 & 3: messages are sent sequentially without overlapping requests
ok 3 - Phase 2 & 3: messages are sent sequentially without overlapping requests
# Subtest: Phase 2 & 4: api.sendMessage error is safely caught and cleans up state
ok 4 - Phase 2 & 4: api.sendMessage error is safely caught and cleans up state
# Subtest: Phase 2 & 4: scold tha stops session and sends forgiveness message exactly once (idempotent)
ok 5 - Phase 2 & 4: scold tha stops session and sends forgiveness message exactly once (idempotent)
# Subtest: Phase 2: preserved validations reject missing mention, target admin, and duplicate target
ok 6 - Phase 2: preserved validations reject missing mention, target admin, and duplicate target
1..6
# tests 6
# pass 6
# fail 0
```
