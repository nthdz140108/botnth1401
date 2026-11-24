# Bot Detail Pipeline & Safe Cleanup Design

## Overview
Lệnh `detail` (aliases: `uptime`, `xtt`) là lệnh hệ thống cung cấp thông tin tổng quan về bot bao gồm phiên bản, hệ điều hành, uptime, tài nguyên (CPU/RAM/Disk), và trạng thái cấu hình của nhóm (nếu ở group scope).

Tài liệu này chuẩn hóa toàn bộ kiến trúc pipeline, cơ chế timeout per stage, contract API xóa tin nhắn an toàn, phản hồi fallback và nghiệm thu kiểm thử.

---

## 1. Routing & Permissions
- **Canonical Command**: `detail`
- **Aliases**: `uptime`, `xtt` (hỗ trợ case-insensitive)
- **Scope**: `both` (Group và Private)
- **Permission**: `all` (Cấp 0)
- **Countdown**: `15` giây
- **Type**: `1`

---

## 2. Pipeline Architecture & Timeout Boundaries

Xử lý lệnh `getBotDetails` được cô lập thành các chặng độc lập với timeout xác định:

| Chặng (Stage) | Mô tả | Timeout | Fallback khi lỗi / timeout |
|---|---|---|---|
| `PROFILE` | Lấy avatar và tên bot từ `getUserInfoData` | 3500ms | `normalizeBotInfo(null)` -> `{ name: "Bot", avatar: null }` |
| `SYSINFO` | Thu thập CPU (`si.currentLoad()`), RAM (`os.*`), Disk (`si.fsSize()`) | 4000ms | Dữ liệu cấu trúc mặc định an toàn |
| `RENDER` | Render canvas `createBotInfoImage` | 5000ms | Chuyển sang fallback text |
| `SEND` | Gửi ảnh kèm TTL `api.sendMessage` | 8000ms | Chuyển sang fallback text |
| `CLEANUP` | Dọn dẹp file temp và hẹn giờ xoá tin nhắn | Không block | Bắt lỗi độc lập, log cảnh báo |

---

## 3. Fallback Response Guarantee
Khi có bất kỳ lỗi hoặc timeout nào ở chặng Render / Send / Pipeline:
- **Thông điệp gửi người dùng**:
  ```
  ❌ Không thể lấy thông tin bot lúc này. Vui lòng thử lại sau.
  ```
- **Xử lý an toàn**: `sendDetailFallback` tự bao bọc try-catch để đảm bảo không bao giờ phát sinh `UnhandledPromiseRejection`.

---

## 4. Contract `api.deleteMessage` & Safe Cleanup
### Signature
`api.deleteMessage(message, onlyMe = true)`

### Payload Chuẩn Hóa
`buildDeleteMessagePayload` tạo cấu trúc tin nhắn hợp lệ từ response của `api.sendMessage`:
```js
{
  type: MessageType.GroupMessage | MessageType.DirectMessage,
  threadId: string,
  data: {
    cliMsgId: string,
    msgId: string,
    uidFrom: string
  }
}
```

### Cleanup Hậu Xử Lý
- Xóa file temp canvas trong khối `finally` qua `clearImagePath(imagePath)`.
- Hẹn giờ 30s gọi `api.deleteMessage(deletePayload, false)` với `timer.unref()`, không làm chặn tiến trình và không làm fail handler chính nếu API delete gặp lỗi quyền hạn.

---

## 5. Verification & Test Execution
Các lệnh kiểm thử đã chạy và đảm bảo 100% pass:
- `node --test tests/bot-details.test.js` (15/15 tests pass)
- `node --test tests/phase-2-dispatch.test.js tests/command-router.test.js tests/command-registry-contract.test.js tests/command-contract.test.js tests/command-policy.test.js tests/bot-details.test.js` (54/54 tests pass)
