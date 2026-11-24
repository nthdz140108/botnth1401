# Command Studio — Tóm tắt thiết kế (2026-08-23)

> Nguồn: plan `docs/superpowers/plans/2026-08-23-command-studio-max.md` (Tasks 1–13). Trang này tóm tắt 1 trang cho người đọc nhanh.

Command Studio là lớp **Behavior Profile** (schema-driven) cho phép tuỳ biến sâu từng lệnh của bot — cách vận hành, phản hồi, thông số, giới hạn — qua form sinh tự động từ schema ở tab Command của dashboard, kèm hot-reload vào bot mà không cần restart.

## 1. Mô hình Behavior Profile

Profile là JSON object có `version: 1`, gồm 4 nhóm trường (định nghĩa trong `src/dashboard/command-behavior-schema.js`):

| Nhóm | Trường chính | Ý nghĩa |
|---|---|---|
| **operation** (Vận hành) | `cooldownMode` (`perUser`/`perThread`/`global`), `cooldownOverride` (giây, nullable), `maxUsesPerHour` (0 = không giới hạn), `timeoutMs`, `killSwitch`, `dryRunRequired`, `logLevel`, `scheduleWindows[]` (`days`/`from`/`to`) | Chế độ cooldown, giới hạn lượt/giờ, kill switch khẩn, khung giờ hoạt động |
| **responses** (Phản hồi) | `useCustomTemplates`, `templates.onSuccess/onCooldown/onPermissionDenied/onScopeDenied/onError/onKillSwitch`, `reactionOnReceive`, `reactionOnSuccess` | Template phản hồi + reaction tuỳ chỉnh |
| **params** (Thông số) | `items[]`: mỗi dòng `{ key, type: number/string/boolean/select, value, defaultValue, min, max, options, description }`; key không trùng | Tham số cấu hình, runtime đọc qua `{param:<key>}` và `context.params` |
| **restrictions** (Giới hạn) | `mode` (`all`/`whitelist`/`blacklist`), `allowedThreads[]`, `blockedThreads[]`, `allowedUsers[]` (các bảng `{ threadId }` / `{ userId }`) | Giới hạn thread/người dùng |

## 2. Template variables

`{prefix}`, `{command}`, `{user}`, `{userId}`, `{thread}`, `{remaining}`, `{reason}` và `{param:<key>}` (đọc tham số từ nhóm params). Biến lạ giữ nguyên văn; biến đã biết thiếu giá trị → chuỗi rỗng; template rỗng → `renderTemplate()` trả `null` để caller fallback về message mặc định. Module thuần: `src/dashboard/command-response-template.js`.

## 3. Endpoints (trong `src/dashboard/api-routes.js`, sau auth + CSRF)

- `GET /api/commands/behavior-schema` → `{ schema, variables }`
- `GET|PUT|DELETE /api/commands/:commandName/behavior` — CRUD profile global
- `GET|PUT|DELETE /api/bots/:id/commands/:commandName/behavior` — CRUD override theo bot, GET trả kèm `{ global, override, effective, hasOverride }`
- `POST /api/commands/render-preview` body `{ template, vars? }` → `{ rendered }`
- `POST /api/system/command-config/reload` body `{ botId }` → ghi request hot-reload (202)

Validate bằng `validateBehaviorProfile()` (select ∈ options, number nguyên trong [min,max], table đủ column key, key lạ → lỗi); lưu qua `BehaviorStore` dùng `ConfigStore.writeJson` (atomic + backup).

## 4. Luồng runtime (bot)

1. **Merge:** `command-policy-loader.js` → `resolveRuntimeCommandPolicy()` trả policy kèm `behavior` đã merge global + override (override thắng từng lá); `getCommandBehavior(policy, name)` hỗ trợ lookup theo cả alias.
2. **Gate trước dispatch** (cả private lẫn group): `evaluateBehaviorGate()` kiểm tra `killSwitch` → `scheduleWindows` → `restrictions`; chặn thì trả result code (`KILL_SWITCH_ACTIVE`, `OUT_OF_SCHEDULE`, `THREAD_BLOCKED`, …).
3. **Cooldown ledger:** `CooldownLedger.consume()` tính bucket theo mode (`u:<id>` / `t:<id>` / `*`), áp `cooldownOverride` hoặc countdown gốc, rồi `checkHourlyLimit()` (sliding window 1 giờ).
4. **Templates:** khi bị chặn hoặc trả kết quả phase-1, nếu `useCustomTemplates` bật → `renderBehaviorMessage()` render template theo result code, lỗi thì fallback message mặc định. Không có profile nào → hành vi giữ nguyên 100% (backward compatible).

Module thuần liên quan: `src/commands/command-behavior-runtime.js` (+ `command-behavior-context.js` wrap lại cho `command.js`, wire đúng 3 điểm).

## 5. Vị trí lưu trữ

- **Global:** `assets/json-data/command.json` — key `behavior` trong entry lệnh tương ứng.
- **Theo bot:** `mybot/command-overrides/<botId>.json` — `<commandName>.behavior`.
- **Backup:** mọi ghi file qua `ConfigStore` tự backup vào `logs/dashboard-backups`; audit log ghi action `command.behavior.update|reset`.
- **Reload request:** `mybot/state/reload/<botId>.json` (`reloadType: "command-config"`), bot poll và tự nạp lại cấu hình.

## 6. Dùng nhanh Command Studio (dashboard → tab Command)

1. **Tổng quan** — form cơ bản (tên/alias/quyền/scope/countdown/icon/mô tả); chọn scope chỉnh sửa: global hoặc theo bot qua bot selector.
2. **Vận hành** — đổi cooldown mode/override, max uses/giờ, kill switch, khung giờ; Lưu → bấm **Reload runtime** để bot nhận ngay.
3. **Phản hồi** — bật template tuỳ chỉnh, nhập nội dung với các biến ở mục 2, nút **Xem trước** gọi render-preview; đặt reaction.
4. **Tham số** — thêm dòng tham số (`key`/`type`/`value`…); dùng `{param:<key>}` trong template để đọc giá trị.
5. **Giới hạn** — whitelist/blacklist thread, cho phép user; dirty indicator cảnh báo thay đổi chưa lưu; toolbar gồm Lưu / Reset override / Copy admin / Áp dụng tất cả / Reload runtime.
