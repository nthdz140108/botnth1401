# Đặc tả V4 — Nhóm lệnh Quản trị Nhóm / Admin / Kick–Block (đối chiếu V3)

Tài liệu này mô tả **hành vi CHÍNH XÁC của MyBot V3** (commit `3650ff7`) cho nhóm lệnh quản trị nhóm, để bản viết lại Rust (`rust/`, "V4") tái tạo đúng ngữ nghĩa. Mọi khẳng định đều kèm trích dẫn `file:line` trong mã nguồn V3 (đường dẫn tương đối từ gốc repo).

Quy ước:
- `prefix` = tiền tố lệnh toàn cục, mặc định `"!"` (`src/service-debug/service.js:77-81`).
- "quote/style" = cặp helper `sendMessageStateQuote` / `sendMessageFromSQL` / `sendMessageWarning`… trong `src/service-debug/chat-zalo/chat-style/chat-style.js`.
- `state=true` → icon `✅✅✅`, `state=false` → `❌❌❌` (`chat-style.js:243-275`).
- "TTL" = tham số `ttl` (ms) của `api.sendMessage`.
- Mọi phản hồi mặc định **quote** tin nhắn lệnh và **mention** người gửi (`chat-style.js:243-275`, `chat-style.js:313-345`).

---

## 0. Khung thực thi chung (áp dụng cho MỌI lệnh dưới đây)

### 0.1 Đường đi của một lệnh trong nhóm

1. `handleCommand(api, message, groupInfo, groupAdmins, groupSettings, isAdminLevelHighest, callerIsBotAdmin, callerIsAdminBox, handleChat)` (`src/commands/command.js:784`).
2. Snapshot phân quyền hợp nhất được tính **trước** khi tra registry: `authorizationSnapshot = resolveInstanceAuthorization(...)` (`command.js:807-816`).
3. Gate "nhóm có bật bot": `canInteractWithGroup({ activeBot, isAdminBot, isAdminBox, commandParts })` → nếu fail thì **im lặng** trả về `numHandleCommand` (`command.js:851-859`, `src/commands/group-interaction-policy.js:76-92`). Ngoại lệ duy nhất là lệnh `bot` on/off (`group-interaction-policy.js:82-87, 94-101`).
4. Phân giải registry: `resolveCommand(commandParts, commandRegistry)`; nếu không khớp registry thì thử custom command / runtime alias (`command.js:826-846`, `861-875`).
5. Cooldown (countdown) theo từng lệnh: `checkCommandCountdown(...)` (`command.js:889-899`).
6. Tính `userPermissionLevel`: `authorizationSnapshot.role === "member" ? "all" : role`; nếu `isAdminLevelHighest || isMainAdmin` → `"adminLevelHigh"`; nếu lệnh thuộc high-risk **và** `isMainAdmin` → `"adminLevelHigh"` (`command.js:904-908`).
7. `checkPermission(...)` với policy từ `resolveRequiredRole({ canonicalName, alias, args, scope })` (`command.js:166-216, 910-937`).
8. Gate phạm vi (`scopeAllows`), gate behavior (killSwitch/schedule/restrictions) (`command.js:955-976`).
9. `numHandleCommand = commandInfo.type` (`command.js:981`).
10. Reaction "đã nhận lệnh": chỉ khi `type ∈ {1,2,3}` **và** (`isCallerAdmin` hoặc `groupSettings[threadId].activeBot === true`) → `api.addReaction("thanks", message)` (`command.js:986-992`, `src/commands/command-response.js:1-14`).
11. Dispatch tới handler lazy-load; kết quả `{code,value}` → `sendPhase1Result` và `shouldPersistGroupSettings` quyết định ghi `group-settings.json` (`command.js:998-1029`, `group-interaction-policy.js:103-109`).

### 0.2 Mô hình 4 vai trò

`ROLE_LEVELS = { member: 0, adminBox: 1, adminBot: 2, adminLevelHigh: 3 }` (`src/utils/role-policy.js:3-8`), nhãn: `Thành viên` / `Quản trị Nhóm` / `Quản trị Bot` / `Quản trị Tối cao` (`role-policy.js:13-18`, alias `all→member`, `adminBotOrGroup→adminBox` tại `role-policy.js:20`).

Thông điệp từ chối chuẩn (`formatPermissionDenied`) — **nguyên văn**:

```
Bạn không có đủ quyền hạn để sử dụng lệnh này.
Yêu cầu quyền hạn tối thiểu: <label>
```
(`role-policy.js:27-33`)

`isAdmin(userId, threadId, groupAdmins)` trả `true` khi role ≥ `adminBox`, đọc `groupSettings[threadId].adminList` cộng với `mainAdmins`, `highCommandAdmins`, `botAdmins`, và (nếu truyền `groupAdmins`) cả admin native của Zalo (`role-policy.js:111-127`, `47-55`).

### 0.3 Chuỗi ưu tiên phân quyền (fail-closed)

`resolveInstanceAuthorization` (`src/utils/instance-authorization.js:467`):

**Bot con (`kind === "child"`)** (`instance-authorization.js:513-590`):
1. UID Main-bot đã đăng ký → `adminLevelHigh` (`MAIN_BOT`) **chỉ khi** `childIdentityIsPending()` = false (`513-526`).
2. UID của chính bot con → `adminLevelHigh` (`INSTANCE_SELF`) (`528-533`).
3. `admin-identity-audit.json` của bot con (`resolvedUids.ownerUid` / `botAdminUid`) → `adminLevelHigh` (`538-550`).
4. `profile.json` của bot con: `ownerUid` chỉ được tin khi `identityPending !== true` (`552-562`).
5. `childHighPath` (admin-high riêng của bot con) → `adminLevelHigh` (`565-570`).
6. `botAdminsPath` → `adminBot` (`572-577`).
7. `groupSettings[threadId].adminList` → `adminBox` (`579-584`).
8. Còn lại → `member` (`586-589`).

**Bot chính** (`instance-authorization.js:592-634`): self → `adminLevelHigh`; nguồn HIGH (FILE, COMMAND) → `adminLevelHigh`; `admin-list.json` → `adminBot`; `adminList` nhóm → `adminBox`; còn lại `member`.

`childIdentityIsPending` (`instance-authorization.js:35-63`) đọc cờ `identityPending` trong profile/state của bot con. Khi pending, **mọi UID quan sát từ state dùng chung của Main đều KHÔNG được cấp quyền** (fail-closed) (`552-562`, `660-662`).

### 0.4 High-risk policy

`HIGH_RISK_COMMANDS` gồm: `spamjoin, spamgroup, addfriendall, kickall, blockall, leave, kickallmember, blockallmember, leaveallbox, leavelock, dispersegroup, kickimg, blockimg, target, key, locmem` (`src/commands/high-risk-policy.js:3-20`).

`resolveHighRiskPolicy` (`high-risk-policy.js:45-70`):
- `killSwitch === true` → deny `KILL_SWITCH_ACTIVE` ("High-risk commands are disabled by dashboard kill switch.").
- không phải top-level admin (`isMainBotAdmin` hoặc `isAdminLevelHighest` hoặc `permissionLevel === "adminlevelhigh"`) → deny `PERMISSION_DENIED` ("High-risk commands require main bot admin permission.").
- Ngược lại: allow, `riskLevel` mặc định `critical`.

Lưu ý: `permission: "adminLevelHigh"` trong registry (`command-registry.js`) là **yêu cầu tối thiểu**; high-risk policy là lớp chặn thứ hai độc lập.

### 0.5 Cổng phạm vi (scope)

`scope: "group"` → chỉ nhóm; `"both"` → nhóm + riêng tư; `"multiGroup"`/`"global"`/`"user"` là `effectScope` của policy chứ không phải scope gọi (`src/commands/command-permission-policy.js:7-11`, `command.js:955-957`, `678-681`). Sai scope → `sendPhase1Result({code:"SCOPE_DENIED"})` → chuỗi `"This command is not available in this chat scope."` (`command.js:488-489`).

### 0.6 Ghi trạng thái

`groupSettings` được ghi xuống `<dataDir>/group-settings.json` (`src/utils/group-settings-store.js:58`, `250-254`) **chỉ khi** handler trả `value === true` hoặc `value.ok === true` (`group-interaction-policy.js:103-109`, `command.js:1024-1026`). Một số handler tự gọi `writeGroupSettings(groupSettings)` bên trong (ví dụ `group-manage.js:421`).

---

## 1. `kickall` (alias `cútall`) và `kickallmember`

### 1.1 Cú pháp V3
```
!kickall
!kickallmember
!cútall
```
Không có tham số. `minArgs` không được khai báo → 0 (`src/commands/command-registry.js:573`, `643`).

### 1.2 Điều kiện & quyền
- Registry: `permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `risk: "critical"`, `executionLane: "control"` (`command-registry.js:573`; `kickallmember` tại `643`).
- Policy: `kickall: HIGH("group","critical")` (`command-permission-policy.js:176`), `kickallmember: HIGH("group","critical")` (`199`).
- High-risk → bắt buộc top-level admin (`high-risk-policy.js:3-20, 65-67`).
- Handler: `lazy("./bot-manager/group-manage.js", "handleKickAll", …)` cho **cả hai** tên (`command-registry.js:599`, `656`). Nghĩa là `kickallmember` là **bí danh hành vi y hệt** `kickall` — không có logic riêng, không có tham số thành viên.

### 1.3 Nguồn dữ liệu
- `api.getGroupInfo(threadId)` — gọi **tươi**, không dùng cache (`group-manage.js:132`).
- `group.gridInfoMap[threadId]` → `creatorId`, `adminIds`, `memVerList` (`group-manage.js:142-147`).
- `memVerList` là mảng chuỗi dạng `<uid>_<…>`; UID = phần trước dấu `_` đầu tiên (`group-manage.js:147`).
- `getBotId()` để nhận diện bot hiện tại (`group-manage.js:144`).
- `isAdmin(uid, threadId)` đọc `group-settings.json` + danh sách admin (`group-manage.js:155`, `role-policy.js:111-127`).

### 1.4 Tác động
1. `api.removeUserFromGroup(threadId, validMembers)` — **một lần gọi duy nhất** cho toàn bộ danh sách (`group-manage.js:164`).
2. `errorMembers` (nếu là mảng) được log cảnh báo; **không** chặn phần còn lại (`165-168`).
3. `kickedCount = validMembers.length - errorMembers.length` (`169`).
4. Không mutate `groupSettings`, không ghi file.

### 1.5 Phản hồi (nguyên văn)

| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| `api.getGroupInfo` throw | `Không thể lấy thông tin nhóm, vui lòng thử lại sau` | false | mặc định | `group-manage.js:134` |
| Thiếu `gridInfoMap[threadId]` | `Lỗi: Không thể lấy thông tin nhóm! 🚀` | false | mặc định | `group-manage.js:139` |
| `memVerList` rỗng/không mảng | `Lỗi: Không thể lấy danh sách thành viên nhóm! 🚀` | false | mặc định | `group-manage.js:150` |
| Sau khi lọc còn 0 người | `Không có thành viên nào để kick! 🚀` | false | mặc định | `group-manage.js:158` |
| `kickedCount === 0` | `Không thể kick bất kỳ thành viên nào! 🚀` | false | mặc định | `group-manage.js:176` |
| Thành công | `Đã kick ${kickedCount} thành viên!` | **true** | 300000 | `group-manage.js:180` |
| Lỗi ngoài cùng (catch tổng) | `Đưa Em Key Vàng 🔑, Em Kick Tất Cả Cho Đại Ca Xem :D 🚀` | false | mặc định | `group-manage.js:183` |

`sendMessageWarning` mặc định: icon `🚨🚨🚨`, TTL 60000 (`chat-style.js:129-165`).

### 1.6 Trường hợp lỗi / miễn trừ
- **Bỏ qua (không bao giờ kick)**: `creatorId`, `getBotId()`, mọi UID trong `adminIds` (admin native Zalo), mọi UID mà `isAdmin(uid, threadId)` = true (`group-manage.js:154-156`).
- UID rỗng/`null` bị loại bởi `filter(uid => uid && …)` (`154`).
- Nếu `removeUserFromGroup` throw → **im lặng** (`return`), không gửi báo lỗi (`170-173`).
- Không kiểm tra bot có phải admin nhóm trước khi gọi — dựa hoàn toàn vào lỗi API; nếu lỗi thì rơi vào nhánh im lặng/`Đưa Em Key Vàng…`.
- `sendMessageWarning` ở đây được gọi với `isNotify = false` (tham số thứ 4) → **không** ping/mention người gửi ở các nhánh lỗi (`group-manage.js:134,139,150,158,176,183`).

---

## 2. `blockall` (alias `biếnall`) và `blockallmember`

### 2.1 Cú pháp V3
```
!blockall
!blockallmember
!biếnall
```
Không tham số (`command-registry.js:574`, `644`).

### 2.2 Điều kiện & quyền
- Registry: `permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `risk: "critical"` (`command-registry.js:574`, `644`).
- Policy: `blockall: HIGH("group","critical")`, `blockallmember: HIGH("group","critical")` (`command-permission-policy.js:177`, `200`).
- Handler dùng chung: `handleBlockAll` cho cả hai tên (`command-registry.js:600`, `657`).
- **Kiểm tra quyền riêng trong handler** (khác `kickall`): người gửi phải là `creatorId` **hoặc** có "key bạc" (có UID trong `groupData.adminIds`) (`group-manage.js:335-338`). Đây là điều kiện **thứ hai**, độc lập với `adminLevelHigh` của registry.

### 2.3 Nguồn dữ liệu
`api.getGroupInfo(threadId)` tươi (`group-manage.js:323`), `gridInfoMap[threadId]` → `creatorId`, `adminIds`, `memVerList` (`332-340`).

### 2.4 Tác động
1. Lọc `validMembers`: bỏ `creatorId`, bot, `isAdmin(...)`, và mọi UID có trong `adminIds` (`group-manage.js:347-349`).
2. `api.blockUsers(threadId, validMembers)` — một lần gọi (`357`).
3. `blockedCount = validMembers.length - errorMembers.length` (`358-359`).
4. Không ghi state.

### 2.5 Phản hồi (nguyên văn)

| Tình huống | Text | state | Nguồn |
|---|---|---|---|
| Không xác định được `senderId` | `Lỗi: Không thể xác định người gửi! 🚀` | false | `group-manage.js:317` |
| `getGroupInfo` throw | `Không thể lấy thông tin nhóm, vui lòng thử lại sau` | false | `group-manage.js:325` |
| Thiếu `gridInfoMap` | `Lỗi: Không thể lấy thông tin nhóm! 🚀` | false | `group-manage.js:329` |
| Không phải creator/key bạc | `Bạn cần là creator hoặc có key bạc để thực hiện lệnh này! 🔑` | false | `group-manage.js:336` |
| `memVerList` rỗng | `Lỗi: Không thể lấy danh sách thành viên nhóm! 🚀` | false | `group-manage.js:342` |
| Sau lọc còn 0 | `Không có thành viên nào để chặn! 🚀` | false | `group-manage.js:351` |
| `blockUsers` throw | `Đưa Em Key Vàng hoặc Key Bạc 🔑, Em Block Tất Cả Cho Đại Ca Xem :D 🚀` | false | `group-manage.js:361` |
| `blockedCount === 0` | `Không thể chặn bất kỳ thành viên nào! 🚀` | false | `group-manage.js:366` |
| Thành công | `Đã chặn ${blockedCount} thành viên!` | true (TTL 300000) | `group-manage.js:370` |
| Catch tổng | `Đưa Em Key Vàng hoặc Key Bạc 🔑, Em Block Tất Cả Cho Đại Ca Xem :D 🚀` | false | `group-manage.js:372` |

### 2.6 Trường hợp lỗi / miễn trừ
- Loại trừ: `creatorId`, `botId`, `isAdmin(uid, threadId)`, UID trong `adminIds` (`group-manage.js:347-349`).
- Không có bước re-check quyền admin của bot trước khi block.
- `blockUsers` throw → không có partial count, gửi text "Đưa Em Key Vàng hoặc Key Bạc…".

---

## 3. `locmem` — lọc thành viên không tương tác 7 ngày

Đây là lệnh **nguy hiểm nhất** trong phạm vi tài liệu: kick hàng loạt dựa trên dữ liệu lịch sử, có xác nhận reaction.

### 3.1 Cú pháp V3
```
!locmem
```
Không tham số (`command-registry.js:739`). Registry: `permission: "adminLevelHigh"`, `type: 1`, `countdown: 30`, `scope: "group"`, `risk: "critical"`, `executionLane: "control"` (`command-registry.js:739`). Policy: `locmem: HIGH("group","critical")` (`command-permission-policy.js:254`). Trong `HIGH_RISK_COMMANDS` (`high-risk-policy.js:19`).

Handler: `handleLocmemCommand(api, message, context)` (`src/service-debug/locmem/locmem-service.js:144`, export qua `src/service-debug/locmem/index.js`, `command-registry.js:790`).

### 3.2 Điều kiện & quyền (theo đúng thứ tự kiểm tra)

| # | Điều kiện | Thất bại → | Nguồn |
|---|---|---|---|
| 1 | **Chỉ nhóm** (`ctx.scope === "group"` hoặc `type === GroupMessage` hoặc `isGroup` hoặc có `ctx.threadId`) | gửi `⚠️ Lệnh !locmem chỉ có thể sử dụng trong nhóm trò chuyện.` → `{code:"SCOPE_DENIED"}` | `locmem-service.js:164-175` |
| 2 | `auth.isAdminLevelHigh` | gửi `formatPermissionDenied("adminLevelHigh")` → `{code:"PERMISSION_DENIED"}` | `locmem-service.js:177-195` |
| 3 | Không có pending trong nhóm | gửi `⚠️ Nhóm đang có một yêu cầu lọc thành viên chờ xác nhận!\nVui lòng chờ yêu cầu hiện tại hoàn tất hoặc hết hạn (120s).` | `locmem-service.js:197-209` |
| 4 | ACK ngay | gửi `🔍 Đang bắt đầu quét thành viên không tương tác (7 ngày)... Vui lòng đợi trong giây lát!` | `locmem-service.js:211-220` |
| 5 | Deadline quét 45000 ms (mặc định, override `ctx.scanDeadlineMs`) | `⚠️ Quá thời gian quét dữ liệu (deadline exceeded). Đã hủy tác vụ lọc thành viên để đảm bảo an toàn.` → `{code:"TIMEOUT"}` | `locmem-service.js:222-236` |
| 6 | Bot phải là **chủ nhóm hoặc admin nhóm** | `⚠️ Bot không có quyền quản trị viên hoặc chủ nhóm trong nhóm này!\nVui lòng trao quyền quản trị viên cho bot trước khi dùng lệnh lọc thành viên.` | `locmem-service.js:238-273` |
| 7 | Đủ **7 ngày lịch hoàn chỉnh liền trước hôm nay** | `⚠️ Chưa đủ dữ liệu để lọc thành viên an toàn!` + chi tiết `x/7` → `{code:"HANDLED", reason:"insufficient_coverage_days"}` | `locmem-service.js:275-296` |
| 8 | Danh sách ứng viên không rỗng | `✅ Không có thành viên nào không tương tác đủ điều kiện lọc!` + kỳ thống kê | `locmem-service.js:353-369` |
| 9 | Deadline còn hạn (kiểm tra lại 3 lần) | như #5 | `locmem-service.js:300-309, 371-380, 386-395` |

**Cơ chế đủ 7 ngày** — `getQualified7DayWindow(groupId, todayDateKey)` (`src/service-debug/locmem/locmem-store.js:510-537`):
- `required7Days = getConsecutiveCalendarDays(todayDateKey, 7)` → 7 ngày lịch **liền trước hôm nay**, giảm dần `[today-1, today-2, …, today-7]` (`src/service-debug/locmem/time-util.js:71`, múi giờ `Asia/Ho_Chi_Minh`, `time-util.js:9`).
- `qualified = (completeSet.size === 7 && missingDays.length === 0)`, trong đó "complete" = `coverage.is_complete === 1` (`locmem-store.js:518-526`, `getDailyCoverage` tại `493-508`).
- Trạng thái coverage: `locmem-store.js:11-22` (`INCOMPLETE`, `COMPLETE`, `DOWNTIME`, …).

### 3.3 Nguồn dữ liệu

**a) SQLite day-partition store** (`src/service-debug/locmem/locmem-store.js`):
- Mỗi ngày một partition: `snapshots[groupId]` (danh sách UID) và `activities[groupId][memberId] = [messageCount, reactionCount, groupActionCount]` (`locmem-store.js:558-591`).
- `recordActivity({groupId, memberId, dateKey, messageCount, reactionCount, groupActionCount})` — cộng dồn, buffer 50 phần tử hoặc flush sau 10 s (`locmem-store.js:280-314`).
- `resetMemberOnJoin(groupId, memberId)` — **xóa mọi snapshot + activity của member trên TẤT CẢ các partition ngày** và flush đồng bộ (`locmem-store.js:316-339`). Được gọi từ event JOIN (`src/automations/events-group.js:44-59`).

**b) `getInactiveCandidates({groupId, completeDays, todayDateKey, excludeMemberIds})`** (`locmem-store.js:545-594`):
- Yêu cầu `completeDays.length >= 7` và `uniqueDays.length >= 7`, nếu không → `[]` (`546-553`).
- Mọi ngày trong `uniqueDays` **phải có** snapshot không rỗng; thiếu một ngày → trả `[]` ngay (`558-568`).
- Ứng viên = UID xuất hiện trong snapshot của **cả 7 ngày** (`count === uniqueDays.length`) (`570-576`).
- Loại tiếp: bất kỳ UID nào có `tuple[0]+tuple[1]+tuple[2] > 0` trong **bất kỳ** ngày nào thuộc `[...uniqueDays, todayDateKey]` (`578-591`). Tức là **hoạt động hôm nay cũng loại khỏi danh sách**.
- Trả về danh sách UID không hoạt động (`593`).

**c) Metadata nhóm**: `extractGroupMeta(groupInfo, threadId)` → `{creatorId, adminIds, name}` (`locmem-service.js:105`, dùng tại `248`, `573`). `extractGroupMemberUids(groupInfo, threadId)` (`locmem-tracker.js:19`, dùng tại `313`, `625`).

**d) Danh sách loại trừ** được dựng ở `locmem-service.js:311-340`:
1. `creatorId` (chủ nhóm) — `316`
2. mọi `adminIds` (admin native Zalo) — `317`
3. `currentBotKey` (bot hiện tại) — `318`
4. `liveBotId` nếu khác `"-1"` — `319`
5. `getRegisteredBotUids()` (mọi bot hệ thống đã đăng ký) — `312`, `320`
6. `ctx.adminBotUids` — `321-323`
7. `ctx.highAdminUids` — `324-326`
8. Mọi thành viên còn lại được kiểm tra `resolveInstanceAuthorization(...)`: nếu `isAdminLevelHigh` **hoặc** `isBotAdmin` → thêm vào `excludeSet` (`328-340`)
9. `excludeMemberIds` truyền xuống store (`347`)

**e) Tên hiển thị**: `fetchCandidateNames(api, eligibleCandidates, { batchSize: 20, timeoutMs: 5000 })` (`locmem-service.js:52`, gọi tại `383`); lỗi → fallback `Thành viên (${uid})` (`locmem-service.js:52`).

### 3.4 Tác động

**Bước 1 — Preview** (chia lô **25** ứng viên/tin) (`locmem-service.js:397-411`):
```
📋 DANH SÁCH THÀNH VIÊN KHÔNG TƯƠNG TÁC (<i>/<n>)
(Kỳ xét: <ngày cũ nhất> ➜ <ngày gần nhất> & hôm nay)

1. <tên> (<uid>)
2. <tên> (<uid>)
…
```

**Bước 2 — Tin xác nhận** (`locmem-service.js:414-423`):
```
⚠️ XÁC NHẬN LỌC THÀNH VIÊN
━━━━━━━━━━━━━━━━━━━━
• Nhóm: <tên nhóm>
• Số lượng lọc: <N> thành viên
• Khoảng ngày: 7 ngày hoàn chỉnh (<start> đến <end>)
• Thời hạn xác nhận: 120 giây
━━━━━━━━━━━━━━━━━━━━
👉 Bất kỳ Quản trị viên cấp cao (adminLevelHigh) nào hãy thả reaction TIM (❤️) vào tin nhắn này trong 120 giây để kích hoạt lọc!
```

**Bước 3 — Đăng ký pending** (`locmem-service.js:425-448`):
- `serverMsgId` lấy từ `confirmRes.message.msgId` / `confirmRes.msgId` / `confirmRes.data.msgId`; **thiếu → abort** `{code:"HANDLER_ERROR", error:"missing_serverMsgId"}` (`430-434`).
- `pendingManager.addRequest({threadId, serverMsgId, candidates, dateRange, expiresMs: 120000, botUid})` (`441-448`).

**Bước 4 — Xác nhận bằng reaction** (`handleLocmemReaction`, `locmem-service.js:477-768`):

| # | Điều kiện | Thất bại |
|---|---|---|
| 1 | `rType === 5` (**chỉ TIM ❤️**; like/`rType 3` bị bỏ) | `return false` (`480-482`) |
| 2 | Là reaction trong nhóm, không phải DM | `return false` (`485-488`) |
| 3 | Có `threadId` + `msgId` | `return false` (`490-502`) |
| 4 | Nhóm có pending | `return false` (`505-507`) |
| 5 | Người thả reaction **hiện tại** là `adminLevelHigh` | log warn + `return false` (`513-529`) |
| 6 | `takeRequest(threadId, msgId)` — **atomic, xóa ngay** | `return false` (`532-535`) |
| 7 | ACK | gửi `⏳ Đã nhận xác nhận từ Quản trị viên cấp cao! Đang tái kiểm tra dữ liệu và quyền hạn trước khi thực thi...` (`538-546`) |
| 8 | Re-fetch `api.getGroupInfo(threadId)` **tươi, bypass cache** | `⚠️ Không thể lấy thông tin nhóm mới nhất từ Zalo (lỗi API hoặc phản hồi rỗng). Đã hủy toàn bộ thao tác lọc để đảm bảo an toàn.` (`548-571`) |
| 9 | Bot **vẫn** là chủ/admin nhóm | `⚠️ Bot không còn là quản trị viên hoặc chủ nhóm trong nhóm này! Đã hủy toàn bộ thao tác lọc.` (`601-623`) |

**Bước 5 — Lọc lại lần cuối (intersection với preview)** (`locmem-service.js:644-686`) — mỗi ứng viên trong `request.candidates` bị **bỏ qua** nếu:
| Lý do skip | Nguồn |
|---|---|
| `Đã rời nhóm` (không còn trong member list tươi) | `649-652` |
| `Được bổ nhiệm QTV/Chủ nhóm` (`=== freshCreatorId` hoặc trong `freshAdminIds`) | `653-656` |
| `Bot hệ thống` (`managedBotUids.has(uid)`) | `657-660` |
| `Quyền quản trị viên bot/cấp cao` (`resolveInstanceAuthorization` lần nữa → `isAdminLevelHigh \|\| isBotAdmin`) | `662-672` |
| `Vừa tương tác sau xem trước` (không còn trong `getInactiveCandidates` recheck) | `633-642`, `674-677` |
| `Vừa tương tác sau xem trước` (activity **hôm nay** > 0) | `679-683` |

**Bước 6 — Kick theo lô 20** (`locmem-service.js:688-738`):
- `batchPauseMs` mặc định **600 ms** (override `ctx.batchPauseMs` / `ctx.batchDelayMs`) (`692-694`).
- Nếu `api.removeUserFromGroup` không tồn tại → **halt**, đẩy toàn bộ vào `unprocessed` (`696-699`).
- `chunkArray(toKick, 20)` (`700`), mỗi lô gọi `api.removeUserFromGroup(threadId, batch)` (`705`).
- **Throw** → log, đẩy **tất cả** lô còn lại (kể cả lô hiện tại) vào `unprocessed`, `break` (`706-712`).
- **Sai schema** (không phải object hoặc `errorMembers` không phải Array) → coi như lỗi, đẩy lô còn lại vào `unprocessed`, `break` (`715-721`).
- `errorMembers` → `failed`, còn lại → `kicked` (`723-732`).
- Nghỉ `batchPauseMs` giữa các lô (`734-736`).

**Bước 7 — Báo cáo** (`locmem-service.js:740-761`):
```
📊 KẾT QUẢ LỌC THÀNH VIÊN
━━━━━━━━━━━━━━━━━━━━
• Đã kick thành công: <kicked> thành viên
• Đã bỏ qua sau tái kiểm tra: <skipped> thành viên
[• Thất bại (lỗi từ Zalo): <failed> thành viên]
[• Chưa xử lý (dừng do lỗi kết nối/quyền/schema): <unprocessed> thành viên]
━━━━━━━━━━━━━━━━━━━━

Lý do bỏ qua:
- <uid>: <reason>          (tối đa 8 dòng)
[... và <n> thành viên khác.]
```
(`741-757`; dòng "Lý do bỏ qua" chỉ khi `skipped.length > 0`, tối đa 8 mục tại `752-757`)

### 3.5 Phản hồi
Xem bảng 3.2 và các text tại 3.4. Tất cả gửi qua `api.sendMessage({msg}, threadId, MessageType.GroupMessage)` — **không** dùng quote/style helper, **không** TTL (trừ khi API mặc định).

### 3.6 Trường hợp lỗi / miễn trừ (quan trọng)
- **Pending manager là in-memory**: restart → mọi yêu cầu pending tự hủy, không thể xác nhận lại tin cũ (`src/service-debug/locmem/locmem-pending.js:1-11`). Default 120000 ms (`locmem-pending.js:7`).
- `addRequest` ném lỗi nếu nhóm đã có pending (`locmem-pending.js:48-50`).
- `takeRequest` **xóa ngay trước khi trả** → không thể double-execute kể cả khi nhiều reaction đồng thời (`locmem-pending.js:114-142`).
- `hasPending` tự dọn khi quá hạn (`locmem-pending.js:18-27`).
- Thành viên mới vào nhóm được `resetMemberOnJoin` → luôn bị loại khỏi snapshot 7 ngày → **không bao giờ** bị coi là "không tương tác" (`locmem-store.js:316-339`, `events-group.js:44-59`).
- Thiếu bất kỳ snapshot ngày nào trong 7 ngày → `getInactiveCandidates` trả `[]` (fail-closed) (`locmem-store.js:558-568`).
- `unit`: mọi phép cộng hoạt động chỉ tính `messageCount + reactionCount + groupActionCount` (`locmem-store.js:587`, `locmem-service.js:680`).
- Dữ liệu bị prune: giữ hôm nay + 7 ngày trước (`src/service-debug/locmem/locmem-cleanup.js:20`), retention mặc định 35 ngày (`locmem-store.js:619`), cleanup tháng cron `10 3 1 * *` (`locmem-cleanup.js:85`).

---

## 4. `leaveallbox`

### 4.1 Cú pháp V3
```
!leaveallbox
```
Không tham số (`command-registry.js:645`). `permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "both"`, `executionLane: "control"` (`645`). Policy: `leaveallbox: HIGH("global","critical")` (`command-permission-policy.js:201`). High-risk (`high-risk-policy.js:12`).

Handler: `handleLeaveAllBoxCommand` (`src/commands/bot-manager/nqduan-bridge.js:170`).

### 4.2 Điều kiện & quyền
- Chỉ yêu cầu `adminLevelHigh` (registry + high-risk). **Không** kiểm tra thêm quyền trong nhóm.
- Chạy được cả trong nhóm lẫn tin nhắn riêng (`scope: "both"`).
- Runtime wrapper `createNqduanBridgeRuntime({ commandName: "leaveallbox", api, message })` (`nqduan-bridge.js:171-177`).

### 4.3 Nguồn dữ liệu
`getDataAllGroup(api)` — danh sách toàn bộ nhóm bot đang tham gia (`nqduan-bridge.js:183`, `src/service-debug/info-service/group-info-data.js:119`).

### 4.4 Tác động
1. Gửi thông báo bắt đầu vào **box đang gọi lệnh** (`nqduan-bridge.js:181`).
2. Duyệt `groups`; **bỏ qua chính box đang gọi lệnh** (`186-187`).
3. `api.leaveGroup(group.groupId)` từng nhóm; lỗi từng nhóm chỉ log, không dừng (`188-193`).
4. Đếm `successCount` (`190`).

### 4.5 Phản hồi (nguyên văn)
| Tình huống | Text | TTL | Nguồn |
|---|---|---|---|
| Bắt đầu | `🚀 Đang rời tất cả box...\n[ Bỏ qua box gọi lệnh ]` | 300000 (default `sendGroupText`) | `nqduan-bridge.js:56-58, 181` |
| Kết thúc | `✅ Đã rời thành công ${successCount} box.` | 60000 | `nqduan-bridge.js:196` |
| Lỗi tổng | `❌ Lỗi khi xử lý: ${error.message}` | 60000 | `nqduan-bridge.js:199` |

Tất cả gửi vào `commandBoxId = message.threadId` qua `api.sendMessage({msg, ttl}, threadId, MessageType.GroupMessage)` — **không quote**.

### 4.6 Trường hợp lỗi / miễn trừ
- **Không bao giờ rời box đang gọi lệnh** (`nqduan-bridge.js:187`).
- Lỗi từng nhóm bị nuốt (`catch` chỉ `console.error`) → tiếp tục nhóm kế (`188-193`).
- Không có xác nhận trước, không thể hủy giữa chừng, không idempotent guard.
- Nếu là bot con và `mybot/instances/<uid>/` — vẫn rời **tất cả** nhóm nhìn thấy từ `getDataAllGroup`.

---

## 5. `leavelock` — rời các box bị khóa chat

### 5.1 Cú pháp V3
```
!leavelock
```
Không tham số (`command-registry.js:646`). `permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "both"`, `executionLane: "control"` (`646`). Policy: `leavelock: HIGH("multiGroup","critical")` (`command-permission-policy.js:202`). High-risk (`high-risk-policy.js:13`).

Handler: `handleLeaveLockedGroups` (`nqduan-bridge.js:120`).

### 5.2 Điều kiện & quyền
- Chỉ `adminLevelHigh` / high-risk.
- Không kiểm tra thêm trong handler.

### 5.3 Nguồn dữ liệu
- `getDataAllGroup(api)` (`nqduan-bridge.js:134`).
- Với **từng** nhóm: `getGroupInfoData(api, group.groupId)` (`139`) → kiểm tra `groupInfo.lockSendMsg === 1` **hoặc** `groupInfo.setting.lockSendMsg === 1` (`140`).
- `getGroupAdmins(groupInfo)` để biết bot có phải admin (`143`).

### 5.4 Tác động
1. Gửi `🔍 Đang quét các box...` với `state=true`, TTL 10000 (`nqduan-bridge.js:131`).
2. Duyệt từng nhóm:
   - Không khóa (`lockSendMsg !== 1`) → bỏ qua (`140-141`).
   - **Bot là admin/chủ nhóm** → bỏ qua (`143-144`).
   - Ngược lại: `api.leaveGroup(group.groupId)`, `leftCount++` (`146-147`).
3. Lỗi từng nhóm chỉ log (`148-150`).

### 5.5 Phản hồi (nguyên văn)
| Tình huống | Text | TTL | Nguồn |
|---|---|---|---|
| Bắt đầu | `🔍 Đang quét các box...` (state=true) | 10000 | `nqduan-bridge.js:131` |
| Có rời | `✅ Đã rời ${leftCount} box bị khóa chat (đã bỏ qua các box mà bot là admin).` | 180000 | `153-158` |
| Không rời được | `⚡ Không tìm thấy box nào bị khóa chat hoặc tất cả box khóa đều là admin.` | 180000 | `157-159` |
| Lỗi tổng | `❌ Lỗi khi quét box: ${error.message}` | default (`sendMessageFailed`) | `164-166` |

### 5.6 Trường hợp lỗi / miễn trừ
- **Bắt buộc** bỏ qua nhóm mà bot là admin/chủ nhóm (`143-144`) — đây là bất biến an toàn quan trọng.
- Điều kiện khóa chấp nhận **hai** dạng payload: `lockSendMsg` ở gốc **hoặc** trong `setting` (`140`) — Rust phải hỗ trợ cả hai.
- Không loại trừ box đang gọi lệnh → **có thể** rời chính nó nếu nó bị khóa và bot không phải admin.
- Không xác nhận trước.

---

## 6. `dispersegroup` — giải tán nhóm

### 6.1 Cú pháp V3
```
!dispersegroup
```
Không tham số (`command-registry.js:647`). `permission: "adminLevelHigh"`, `type: 1`, `countdown: 1`, `scope: "group"`, `executionLane: "control"` (`647`). Policy: `dispersegroup: HIGH("group","critical")` (`command-permission-policy.js:203`). High-risk (`high-risk-policy.js:14`).

Handler: `handleDisperseGroupCommand` (`nqduan-bridge.js:94`).

### 6.2 Điều kiện & quyền
1. Phải là nhóm: `message.type !== MessageType.GroupMessage` → text lỗi (`nqduan-bridge.js:105-108`).
2. `isAdmin(senderId, threadId)` phải true (`110-113`) — kiểm tra **quyền admin nhóm** (không phải adminBot/adminLevelHigh).

### 6.3 Nguồn dữ liệu
`isAdmin(senderId, threadId)` → `role-policy.js:111-127` (group `adminList` + danh sách admin toàn cục).

### 6.4 Tác động
`api.disperseGroup(threadId)` (`nqduan-bridge.js:116`) — **giải tán vĩnh viễn**, không thể hoàn tác. Không có bước xác nhận.

### 6.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | Nguồn |
|---|---|---|---|
| Không phải nhóm | `Lệnh này chỉ có thể dùng trong nhóm chat.` | mặc định | `nqduan-bridge.js:106` |
| Không phải admin nhóm | `Chỉ quản trị viên nhóm mới có quyền giải tán nhóm.` | mặc định | `111` |
| Trước khi giải tán | `⚠️ Đang tiến hành GIẢI TÁN NHÓM...` | false | `115` |

### 6.6 Trường hợp lỗi / miễn trừ
- Không có kiểm tra bot có quyền giải tán → lỗi API sẽ propagate ra ngoài handler (không bắt).
- Trả `true` sau khi gọi thành công (`117`) → `shouldPersistGroupSettings` ghi `group-settings.json` nếu `value === true` (`group-interaction-policy.js:103-109`).

---

## 7. `leave` (alias `out`)

### 7.1 Cú pháp V3
```
!leave
!out
```
Không tham số (`command-registry.js:579`). `permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `risk: "critical"` (`579`). Policy: `leave` nằm trong `HIGH_RISK_COMMANDS` (`high-risk-policy.js:9`) và `command-permission-policy.js:176-185` vùng high-risk.

Handler: `handleLeaveGroup` (`src/commands/bot-manager/remote-action-group.js:175`).

### 7.2 Điều kiện & quyền
- `adminLevelHigh` + high-risk policy.
- Không kiểm tra thêm.

### 7.3 Nguồn dữ liệu
`message.threadId` (nhóm hiện tại). Không đọc file.

### 7.4 Tác động
1. Gửi text rồi mới rời: `Bai mấy cu, bố đi đây!!!` với `state=true`, TTL 30000 (`remote-action-group.js:178`).
2. `api.leaveGroup(threadId)` (`179`).

### 7.5 Phản hồi (nguyên văn)
| Tình huống | Text | TTL | Nguồn |
|---|---|---|---|
| Thành công | `Bai mấy cu, bố đi đây!!!` | 30000 | `remote-action-group.js:178` |
| Lỗi | `Có lỗi xảy ra, không rời nhóm được!` | 30000 | `182` |

### 7.6 Trường hợp lỗi / miễn trừ
- Không có xác nhận; rời ngay.
- Text gửi **trước** khi rời (`178` trước `179`) — nếu gửi lỗi thì không rời.

---

## 8. `undo` (alias `un`) — thu hồi tin nhắn được reply

### 8.1 Cú pháp V3
```
!undo        (reply vào tin nhắn của bot cần thu hồi)
!un
```
`permission: "adminBox"`, `type: 3`, `countdown: 1`, `scope: "group"`, `executionLane: "control"` (`command-registry.js:517`). Policy: `undo: BOX("group")` (`command-permission-policy.js:168`).

Handler: `handleUndoMessage` (`src/commands/bot-manager/undo-message.js:27`, re-export từ `utilities.js:31`, gắn tại `command-registry.js:541`).

### 8.2 Điều kiện & quyền
- `adminBox` trở lên.
- **Bắt buộc** reply: nếu không resolve được target → gửi thông báo lỗi (`undo-message.js:7-25, 28-32`).

### 8.3 Nguồn dữ liệu
`message.data.quote` (hoặc `message.quote`) → `{ globalMsgId ?? msgId, cliMsgId }` + `message.threadId` + `message.type` (`undo-message.js:7-25`). Thiếu bất kỳ trường nào → `null`.

### 8.4 Tác động
`api.undoMessage({ threadId, type, data: { msgId, globalMsgId, cliMsgId } })` (`undo-message.js:36`). Không ghi state.

### 8.5 Phản hồi (nguyên văn)
| Tình huống | Text | TTL | Nguồn |
|---|---|---|---|
| Không reply | `Hãy reply tin nhắn bot cần thu hồi rồi dùng !undo.` | 30000 | `undo-message.js:1, 30` |
| Lỗi API | `Lỗi khi xử lý lệnh undo: ${error.message}` | 30000 | `undo-message.js:38` |
| Thành công | **không phản hồi gì** | — | `undo-message.js:36` |

Gửi qua `api.sendMessage({msg, ttl: 30000, linkOn: false}, threadId, message.type)` (`undo-message.js:3-5`) — **không quote**, **không** mention.

### 8.6 Trường hợp lỗi / miễn trừ
- `MISSING_TARGET_MESSAGE` **hard-code** cứng chữ `!undo` bất kể prefix thực tế (`undo-message.js:1`).
- Không kiểm tra tin nhắn mục tiêu có phải của bot hay không.
- Không có TTL/expiry cho quote — tin nhắn cũ vẫn được chấp nhận nếu API cho phép.

---

## 9. `deletemessage` (alias `delmsg`, `del`)

### 9.1 Cú pháp V3
```
!deletemessage <count> [normal|all]      → xóa theo phạm vi
!deletemessage                            (reply vào tin nhắn cần xóa)
!delmsg <count> [all]
!del <count> [all]
```
`permission: "adminBox"`, `type: 3`, `countdown: 1`, `scope: "group"`, `minArgs: 1` (`command-registry.js:582`). Policy: `deletemessage: BOX("group")` (`command-permission-policy.js:185`).

Handler: `handleDeleteMessage(api, message, groupAdmins, aliasCommand)` (`src/commands/bot-manager/recent-message.js:7`).

### 9.2 Điều kiện & quyền
- `adminBox` trở lên; `minArgs: 1` (có `count` hoặc có quote).
- Ưu tiên nhánh **quote**: nếu `message.data.quote` tồn tại thì bỏ qua `count`/`target` (`recent-message.js:16-33`).

### 9.3 Nguồn dữ liệu
- Quote: `cliMsgId`, `globalMsgId`, `ownerId` (nếu `ownerId === "0"` → thay bằng `getBotId()`) (`recent-message.js:17-19`).
- Số lượng: `keyContent.split(" ")` → `[count, target = "normal"]` (`11`).
- Tin nhắn gần đây: `api.getRecentMessages(threadId, currentMsgId, 50)` — **phân trang 50 tin/lần**, gộp và sort giảm dần theo `ts`, cắt đúng `count` (`83-108`).
- Tìm tin theo quote: lặp tối đa **100 lần**, dừng khi tin cũ nhất vượt **1 ngày** (`24*60*60*1000`), so khớp `cliMsgId` **và** `msgId` (`110-173`).

### 9.4 Tác động
- Nhánh quote: `api.deleteMessage(msgDel, false)` cho **một** tin (`recent-message.js:21-25`, `145-157`).
- Nhánh số lượng: lọc `recentMessage` theo:
  - `target === "all"` → xóa tất cả, hoặc
  - `mentionTarget.includes(msg.uidFrom)` → chỉ tin của người được mention, hoặc
  - `mentionTarget.includes(idBot) && msg.uidFrom === "0"` → tin hệ thống khi mention chính bot (`48-53`).
  Sau đó gọi **song song** `api.deleteMessage(..., false)` cho từng tin (`54-76`).
- Không ghi `groupSettings`.

### 9.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Quote, xóa được | `Tin nhắn đã được xóa rồi nhé` | true | 5000 | `recent-message.js:28` |
| Quote, không tìm thấy | `Đếch tìm thấy tin nhắn cần xóa` | false | 5000 | `30` |
| `count <= 0` | `Hãy nhập phạm vi số lượng tin nhắn cần check` | false | 10000 | `36` |
| Có xóa | `Thành công xóa ${countDelete} tin nhắn` [+ `\nCó ${countDeleteFail} tin nhắn Không xóa được`] | **true** (luôn) | 60000 | `78-80` |
| Không xóa được | `Đếch có tin nhắn nào được xóa` [+ dòng lỗi] | true | 60000 | `78-80` |

### 9.6 Trường hợp lỗi / miễn trừ
- Nhánh quote **nuốt** lỗi tìm kiếm (`catch` → `return false`) và báo `Đếch tìm thấy…`.
- Nhánh số lượng: lỗi từng tin được đếm vào `countDeleteFail`, không throw (`70-73`).
- `caption` luôn truyền `state=true` **kể cả khi 0 tin bị xóa** (`80`).
- Giới hạn tìm kiếm: 100 vòng × 50 tin = tối đa 5000 tin, trong phạm vi 1 ngày (`114-118, 121-138`).
- `getRecentMessage` bắt mọi lỗi và trả mảng đã có (`102-104`).

---

## 10. `join` (alias `thamgianhom`)

### 10.1 Cú pháp V3
```
!join <link nhóm>
!thamgianhom <link nhóm>
```
`permission: "adminBot"`, `type: 3`, `countdown: 1`, `scope: "both"`, `minArgs: 1` (`command-registry.js:578`). Policy: `join: BOT("multiGroup")` (`command-permission-policy.js:181`).

Handler: `handleJoinGroup` (`remote-action-group.js:26`).

### 10.2 Điều kiện & quyền
- `adminBot` trở lên (không phải high-risk).
- Không có link → in cú pháp (`remote-action-group.js:33-45`).

### 10.3 Nguồn dữ liệu
`api.getGroupInfoByLink(linkJoin)` (`remote-action-group.js:49`). Throw → báo link không tồn tại (`50-62`). Kết quả rỗng → im lặng (`64`).

### 10.4 Tác động
1. Gửi tin xác nhận qua `sendMessageCompleteRequest` với timeout **30000 ms** (`remote-action-group.js:21, 68-78`):
```
Tên <Nhóm|Cộng đồng>: <name>
Mô tả: <desc | "Không có mô tả">
Tổng số thành viên: <totalMember>

Xác nhận tham gia <Nhóm|Cộng đồng> bằng cách thả reaction like hoặc heart!
```
   (`type = groupInfo.type === 2 ? "Cộng đồng" : "Nhóm"` tại `66`)
2. Lưu `requestJoinGroupMap.set(msgId, {message, timestamp, groupInfo, linkJoin})` — LRU max 500, TTL `30000*2 = 60000` (`23, 80-87`).
3. `startInteractionCountdown({key: "join_group_<msgId>", seconds: 30, deleteOnExpire: true})` → hết hạn thì xóa map (`89-99`).
4. Xác nhận: `handleReactionConfirmJoinGroup` (`102-173`):
   - Lấy `msgId` từ `reaction.data.content.rMsg[0].gMsgID` hoặc `reaction.messageID`; không có → `false` (`103-104`).
   - Không có trong map → `false` (`105-106`).
   - **Người thả reaction phải là người đã gọi lệnh** (`senderId !== data.message.data.uidFrom` → `false`) (`107-108`).
   - **Chỉ `rType === 3` (like) hoặc `rType === 5` (heart)** (`110-111`).
   - Rồi `api.joinGroup(data.linkJoin)` (`129`).

### 10.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Thiếu link | `Cú pháp tham gia nhóm thông qua link:\n!join [link]` | false | 30000 | `remote-action-group.js:39-42` |
| Link sai | `Link này đếch tồn tại nhóm/cộng đồng nào!` | **true** | 30000 | `56-59` |
| Vào thành công | `Bố đã tham gia vào nhóm thành công!` | true | 180000 | `135-138` |
| Chờ duyệt (`error.message` chứa `Waiting for approve`) | `Bố đã gửi yêu cầu tham gia nhóm này và đang chờ chủ nhóm phê duyệt!` | warning | 180000 | `141-149` |
| Đã là thành viên (chứa `đã là thành viên`) | `Bố đã là thành viên của nhóm này!` | warning | 180000 | `151-159` |
| Bị chặn (chứa `chặn tham gia nhóm`) | `Bố đã bị chặn tham gia nhóm này!` | warning | 180000 | `161-169` |

### 10.6 Trường hợp lỗi / miễn trừ
- Lỗi không khớp 3 chuỗi trên → **im lặng** (không phản hồi) (`140-171`).
- Phát hiện lỗi dựa trên **so khớp chuỗi con** trong `error.message` — Rust phải tái tạo chính xác (hoặc dùng mã lỗi tương đương).
- Map là LRU TTL 60 s nhưng countdown là 30 s → cửa sổ hiệu lực thực tế **30 s**.
- Không có `linkJoin` được xác thực lại trước khi join (dùng đúng link đã lưu).

---

## 11. `listgroups` (alias `lgr`)

### 11.1 Cú pháp V3
```
!listgroups [từ khóa lọc]
!lgr [từ khóa]
```
`permission: "adminBot"`, `type: 3`, `countdown: 1`, `scope: "both"` (`command-registry.js:580`). Policy: `listgroups: BOT("multiGroup")` (`command-permission-policy.js:183`).

Handler: `handleShowGroupsList(api, message, aliasCommand)` (`remote-action-group.js:185`).

### 11.2 Điều kiện & quyền
`adminBot` trở lên. Tham số tùy chọn = từ khóa lọc theo tên nhóm (`remote-action-group.js:189-197`), so khớp **không phân biệt hoa/thường** bằng `includes` (`196-197`).

### 11.3 Nguồn dữ liệu
`getDataAllGroup(api)` (`remote-action-group.js:191`); `getUserInfoData(api, group.creatorId)` để lấy tên trưởng nhóm (`228`).

### 11.4 Tác động
Không thay đổi trạng thái. Chia **30 nhóm/tin** (`CHUNK_SIZE = 30`, `remote-action-group.js:214-220`):
```
Danh sách nhóm:

1. <tên> (<totalMember> thành viên)
 - Trưởng nhóm: <tên>

2. …
```
(tin tiếp theo mở đầu bằng `(Tiếp theo)` — `223-225`)

Tin cuối được nối thêm:
```
Reply tin nhắn này với số index và "->" + cú pháp liên quan đến hành động mà Đại Ca muốn tôi thực hiện cho danh sách bên trên!
```
(`235-237`)

Mỗi tin gửi qua `sendMessageCompleteRequest(api, message, {caption}, 60000)` (`239-246`). Với tin cuối: lưu `waitingActionGroupMap.set(msgId, {message, timestamp, groups})` (LRU 500, TTL 120000) và `startInteractionCountdown({seconds: 60, deleteOnExpire: true})` (`248-267`, constants tại `22, 24`).

### 11.5 Phản hồi
Xem 11.4. Lỗi tổng chỉ `console.error`, **không** phản hồi (`remote-action-group.js:269-271`).

### 11.6 Trường hợp lỗi / miễn trừ
- Không giới hạn số nhóm; chỉ giới hạn 30 nhóm/tin.
- `getUserInfoData` cho từng trưởng nhóm → có thể chậm với danh sách lớn.
- Reply hợp lệ phải đến từ **đúng người gọi** (`remote-action-group.js:296`) và có dạng `<index>-><cú pháp>` (`298-311`).
- Index ngoài phạm vi → `Số index Không hợp lệ!` (`313-325`); index không phải số → `Lựa chọn Không hợp lệ. Vui lòng chọn một số từ danh sách.` (`301-307`); thiếu action → `Vui lòng nhập hành động cần thực hiện!` (`326-338`); action không bắt đầu bằng prefix → bỏ qua im lặng (`309-311`).
- Thực thi: xóa tin chứa danh sách (`343-352`), rồi `handleCommand` với `threadId` = nhóm được chọn (`371-391`), rồi trả `Đã thực hiện hành động "<action>" trong nhóm "<tên>"!` với TTL 60000 (`392-398`).

---

## 12. `scangroups` (alias `scgr`)

### 12.1 Cú pháp V3
```
!scangroups find <tên>            — khớp hoàn toàn
!scangroups findmatch <tên>       — khớp một phần
!scangroups tìm <tên>             — khớp hoàn toàn
!scangroups findtag <tên>         — khớp hoàn toàn + tag
!scangroups findmatchtag <tên>    — khớp một phần + tag
```
`permission: "adminBot"`, `type: 3`, `countdown: 1`, `scope: "group"`, `minArgs: 1` (`command-registry.js:581`). Policy: `scangroups: BOT("multiGroup")` (`command-permission-policy.js:184`).

`VALID_ACTIONS` (`src/commands/bot-manager/scan-group.js:66-72`):

| action | ý nghĩa |
|---|---|
| `find` | kết quả khớp hoàn toàn |
| `findmatch` | kết quả khớp một phần |
| `tìm` | kết quả khớp hoàn toàn |
| `findtag` | kết quả khớp hoàn toàn và tag |
| `findmatchtag` | kết quả khớp một phần và tag |

### 12.2 Điều kiện & quyền
- `adminBot` trở lên.
- Thiếu/sai `action` → `⚠️ Vui lòng nhập lệnh với 1 trong các hành động: find, findmatch, tìm, findtag, findmatchtag!\nVí dụ: !scangroups find tên_thành_viên` (`scan-group.js:74-82`).
- Thiếu từ khóa → `⚠️ Vui lòng nhập từ khóa tìm kiếm!` (`84-91`).

### 12.3 Nguồn dữ liệu
- `groupInfo.memVerList` → `getMembersInfo(api, memVerList)` gọi `api.getGroupMembers(chunk)` theo lô (`scan-group.js:34-52, 93`).
- `getGroupAdmins(groupInfo)` để biết `botIsAdminBox` (`59-60`).
- `getBotId()` để loại chính bot khỏi kết quả (`58`, `99`, `101`).

### 12.4 Tác động
- Tìm kiếm: `findmatch`/`findmatchtag` → `name.includes(term)`; còn lại → `name === term` (lowercase); luôn loại `idBot` (`scan-group.js:95-103`).
- Có kết quả + action tag → `sendMessageTag(...)` với mentions tính theo `pos` (`110-134`, `145-149`); ngược lại `sendMessageCompleteRequest(...)` (`135-153`).
- Timeout chờ chọn: `TIME_WAIT_SELECTION = 60000` (`scan-group.js:14`).
- Lưu `scanResultsMap.set(msgId, {results, groupInfo, timestamp, userRequest, botIsAdminBox})` + countdown 60 s, `deleteOnExpire: true` (`156-177`).

### 12.5 Phản hồi (nguyên văn)
| Tình huống | Text | Nguồn |
|---|---|---|
| Không kết quả | `🔍 Không tìm thấy thành viên nào trong nhóm <tên> có <mô tả action> với "<term>"!` | `scan-group.js:141` |
| Có kết quả (không tag) | `🔍 Kết quả tìm kiếm cho "<term>" trong nhóm <tên>:\n` + `1. <tên>\n  - ID: <uid>\n…` + (nếu bot là admin) `\nReply tin nhắn với từ khóa kick/block để thực hiện hành động với các tài khoản này!` | `136-139` |
| Có kết quả (tag) | `🔍 Kết quả tìm kiếm cho "<term>" trong nhóm <tên>:\n\n` + `1. @<tên>\n  - ID: <uid>\n\n…` + `\n\nReply tin nhắn với từ khóa kick/block để thực hiện hành động với các tài khoản này!` | `111-134` |
| Lỗi quét | `❌ Đã xảy ra lỗi khi quét thành viên nhóm, vui lòng thử lại hoặc nhập thông tin cụ thể hơn!` | `182-187` |

### 12.6 Reply hành động (`handleScanGroupsReply`, `scan-group.js:192-299`)
Điều kiện:
1. Phải có `message.data.quote.globalMsgId` (`197`).
2. `scanResultsMap` phải chứa `msgId` (`200`).
3. **Người reply phải là người đã yêu cầu** → nếu không: `Bạn Không phải người yêu cầu hành động này!` (`203-211`).
4. Nội dung phải **chính xác** `kick` hoặc `block` (so sánh nguyên chuỗi, không trim thêm) → nếu không: `⚠️ Vui lòng sử dụng một trong các từ khóa 'kick' hoặc 'block'!` (`213-224`).
5. `scanData.botIsAdminBox` phải true → nếu không: `Tôi Không đủ quyền để thực hiện hành động này!` (`226-234`).

Thực thi (`236-266`):
- Loại trừ: chính bot, `isAdmin(member.id, threadId)`, `groupAdmins` → ghi `"<tên> -> Không thể <Kick|Block> quản trị nhóm!"` (`240-246`).
- `kick` → `api.removeUserFromGroup(threadId, [member.id])` **từng người một** → `"<tên> -> Đã Kick!"` / `"<tên> -> Không thể Kick do <error>!"` (`248-256`).
- `block` → `api.blockUsers(threadId, [member.id])` từng người → `"<tên> -> Đã Block!"` / `"<tên> -> Không thể Block do <error>!"` (`257-266`).
- Xóa tin danh sách, hủy countdown, xóa map (`268-280`).
- Báo cáo: `Kết quả thực hiện <kick|block>:\n<dòng…>` với `sendMessageComplete(..., false)` (`282-287`).
- Lỗi: `❌ Đã xảy ra lỗi khi thực hiện hành động. Vui lòng thử lại sau!` (`292-297`).

### 12.7 Trường hợp lỗi / miễn trừ
- Reply thiếu `quote.globalMsgId`, hoặc `msgId` không có trong `scanResultsMap` (hết 60 s / đã dùng) → `return false`, **im lặng** (`scan-group.js:197-200`).
- Người reply khác người yêu cầu → `Bạn Không phải người yêu cầu hành động này!` và **giữ nguyên** entry trong map (`203-211`).
- Nội dung không đúng `kick`/`block` → `⚠️ Vui lòng sử dụng một trong các từ khóa 'kick' hoặc 'block'!` (`213-224`).
- Bot không còn là admin nhóm → `Tôi Không đủ quyền để thực hiện hành động này!` (`226-234`).
- Loại trừ bắt buộc: chính bot, `isAdmin(...)`, mọi `groupAdmins` — kể cả khi người yêu cầu đã tag họ (`240-246`).
- Thực thi **tuần tự từng người** (không batch); lỗi một người ghi vào kết quả và tiếp tục (`248-266`).
- Lỗi ngoài cùng (throw) → text chung, **không** xóa map, **không** xóa tin danh sách (`290-298`).
- Không có kiểm tra lại `isAdmin(sender)` tại thời điểm reply — chỉ kiểm tra `botIsAdminBox` đã chụp lúc scan (`226`).

---

## 13. `todo`

### 13.1 Cú pháp V3
```
!todo_<nội dung>_<số lần> @mention
!todo_<nội dung>_<số lần>_<UID>
!todo_stop
```
**Đặc biệt**: `todo` thuộc `SPECIAL_COMMANDS` → parser tách theo `_`, không theo khoảng trắng (`src/commands/command-parser.js:1-22`).

`permission: "adminBot"`, `type: 3`, `countdown: 1`, `scope: "both"`, `minArgs: 1` (`command-registry.js:518`). Policy: `todo: BOT("multiGroup")` (`command-permission-policy.js:169`).

Handler: `handleSendToDo` (`src/commands/bot-manager/utilities.js:33`).

### 13.2 Điều kiện & quyền
- `adminBot` trở lên.
- `parts = content.split("_")` (`utilities.js:41`).
- `parts.length == 2 && parts[1].toLowerCase() === "stop"` → nhánh dừng (`43-69`).
- `parts.length < 2` → in cú pháp (`71-86`).
- Nội dung rỗng → `Không Có Nội Dung Công Việc!` (`91-103`).
- `repeatCount = parseInt(parts[2])` nếu hợp lệ, mặc định 1 (`108-113`).
- **Người không phải admin bị giới hạn `repeatCount ≤ 3`** (`115-117`).
- Nguồn người nhận: `mentions` (`Object.values(mentions)`), nếu không có thì `parts[3]` (UID đơn), nếu không có nữa → `Không Tìm Thấy Mục Tiêu Để Giao Việc!` (`119-138`).

### 13.3 Nguồn dữ liệu
`message.data.mentions`, `message.data.uidFrom`, `message.data.dName`, `getUserInfoData(api, userIds[0])` (`utilities.js:36-38, 140`).

### 13.4 Tác động
- `activeTodo = true` rồi vòng lặp `repeatCount` lần: `api.sendTodo(message, todoContent, userIds, -1, todoContent)`; nếu `activeTodo` bị đặt false thì `break` (`utilities.js:160-166`).
- `stopTodo()` đặt `activeTodo = false` (`12-16`).
- **Không** ghi `groupSettings`. `activeTodo` là biến module-level **toàn cục, không theo thread**.

### 13.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Sai cú pháp | `Cú pháp Không đúng. Vui lòng sử dụng:\n!todo_[Nội dung công việc]_[Số lần] @user\nhoặc: !todo_[Nội dung công việc]_[Số lần]_[ID người nhận]` | false | 30000 | `utilities.js:77-84` |
| Dừng thành công | `Đã dừng tất cả các todo đang chạy!` | false | 30000 | `46-55` |
| Dừng khi không chạy | `Không có todo nào đang chạy!` | false | 30000 | `57-66` |
| Nội dung rỗng | `Không Có Nội Dung Công Việc!` | false | 30000 | `92-101` |
| Không có mục tiêu | `Không Tìm Thấy Mục Tiêu Để Giao Việc!` | false | 30000 | `127-136` |
| Bắt đầu | `Đã giao việc "<nội dung>" <N> lần cho <bản thân|người dùng X|N người>` | false | 30000 | `142-158` |
| Lỗi | `Lỗi khi giao việc: <message>` | false | 30000 | `167-177` |

`targetText`: nếu 1 UID và trùng người gửi → `"bản thân"`; 1 UID khác → `"người dùng <tên>"`; nhiều → `"<N> người"` (`142-147`).

### 13.6 Trường hợp lỗi / miễn trừ
- **`!todo stop` dừng TẤT CẢ todo trên mọi nhóm**, vì `activeTodo` là biến toàn cục (`utilities.js:12-16`).
- `sendTodo` dùng `-1` cho tham số thứ 4 (`165`) — ngữ nghĩa do API Zalo quyết định.
- Không có giới hạn số lần tối đa cho admin (`repeatCount` không bị clamp khi là admin).
- Không kiểm tra mention có phải thành viên nhóm.

---

## 14. `sendp` (alias `sendprivate`)

### 14.1 Cú pháp V3
```
!sendp_<nội dung>_<số lần> @mention
!sendp_<nội dung>_<số lần>_<UID>
!sendprivate_…
```
**Đặc biệt**: thuộc `SPECIAL_COMMANDS`, tách theo `_` (`command-parser.js:1-22`).

`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `minArgs: 1`, `risk: "high"` (`command-registry.js:519`). Policy: `sendp: HIGH("global","high")` (`command-permission-policy.js:170`).

Handler: `handleSendMessagePrivate` (`utilities.js:630`).

### 14.2 Điều kiện & quyền
- `adminLevelHigh` (policy effectScope `global`).
- `parts.length < 2` → cú pháp (`utilities.js:639-654`).
- Nội dung rỗng → `Không có nội dung tin nhắn!` (`659-671`).
- `repeatCount`: mặc định 1 (`673-681`); **không phải admin → cap 20** (`683-685`); sau đó **clamp `[1, 50]`** cho mọi người (`686`).
- Người nhận: `mentions` → `parts[3]` → lỗi `Không tìm thấy người nhận!` (`688-707`).

### 14.3 Nguồn dữ liệu
`message.data.mentions`, `message.data.uidFrom`, `getUserInfoData(api, userIds[0])` (`utilities.js:632-634, 709`).

### 14.4 Tác động
Với mỗi `userId` × mỗi lần lặp: `api.sendMessage(smsContent, userId, MessageType.DirectMessage)` (`utilities.js:729-738`); lỗi từng tin được log và `continue` (`731-736`).

### 14.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Sai cú pháp | `Cú pháp Không đúng. Vui lòng sử dụng:\n!sendp_[Nội dung tin nhắn]_[Số lần] @user\nhoặc: !sendp_[Nội dung tin nhắn]_[Số lần]_[ID người nhận]` | false | 30000 | `utilities.js:646-651` |
| Nội dung rỗng | `Không có nội dung tin nhắn!` | false | 30000 | `665` |
| Không có người nhận | `Không tìm thấy người nhận!` | false | 30000 | `701` |
| Bắt đầu | `Đã bắt đầu send tin nhắn riêng "<nội dung>" <N> lần cho <targetText>` | false | 30000 | `723` |
| Hoàn tất | `Đã hoàn thành gửi tin nhắn riêng cho <targetText>` | false | 30000 | `745` |
| Lỗi | `Lỗi khi gửi tin nhắn riêng: <message>` | false | 30000 | `756` |

### 14.6 Trường hợp lỗi / miễn trừ
- Giới hạn cứng **50 lần** (`686`) — kể cả admin.
- Lỗi một tin không chặn các tin sau (`731-736`).
- Không có delay giữa các tin → nguy cơ rate-limit Zalo.
- Gửi DM tới UID bất kỳ (không cần là bạn bè) — lỗi được nuốt.

---

## 15. `senduser` — gửi nội dung từ file tới người được tag

### 15.1 Cú pháp V3
```
!senduser @Ten|delay|soLan
```
`permission: "adminLevelHigh"`, `type: 1`, `countdown: 120`, `scope: "both"` (`command-registry.js:731`). Policy: `senduser: HIGH("global","high")` (`command-permission-policy.js:246`).

Handler: `handleSendMessageToMentioned` (`src/commands/bot-manager/nqduan-phase5.js:60`).

### 15.2 Điều kiện & quyền
- `adminLevelHigh`, `countdown` **120 giây** (dài nhất trong phạm vi tài liệu).
- `commandParts = content.split("|")`; `length < 3` → cú pháp (`nqduan-phase5.js:63-70`).
- `delayMs = clamp(delay, 500, 10000)`, mặc định 1000 (`72-74`).
- `repeatCount = clamp(n, 1, 20)` (`MAX_REPEAT = 20`, `nqduan-phase5.js:19, 75`).
- Không có mention → `Khong co ai duoc tag trong tin nhan.` (`78-83`).

### 15.3 Nguồn dữ liệu
- Nội dung: `src/commands/bot-manager/data/noidung.txt`, mỗi dòng một tin, **tối đa 20 dòng**; thiếu file → fallback 2 dòng mẫu (`nqduan-phase5.js:21-24, 45-54`).
- Đích: `mentions` → `{uid, name}` (`86-89`).

### 15.4 Tác động
Ba vòng lặp lồng nhau: `repeatCount` × `targets` × `lines`, mỗi tin `api.sendMessage({msg: line, ttl: 5000000}, target.uid, MessageType.DirectMessage)` rồi `setTimeout(delayMs)` (`nqduan-phase5.js:95-104`).

### 15.5 Phản hồi (nguyên văn, **không dấu**)
| Tình huống | Text | Nguồn |
|---|---|---|
| Sai cú pháp | `Sai cu phap. Vui long dung: !senduser @Ten\|delay(500-10000ms)\|so lan(1-20)` | `nqduan-phase5.js:67` |
| Không tag ai | `Khong co ai duoc tag trong tin nhan.` | `80` |
| Bắt đầu | `Dang gui tin nhan den <danh sách tên>...` | `92` |
| Hoàn tất | `Da hoan thanh gui tin nhan den <danh sách tên>.` | `107` |

TTL: 10000 cho lỗi cú pháp/không tag (`68`, `81`); 30000 cho bắt đầu/hoàn tất (`93`, `108`).

### 15.6 Trường hợp lỗi / miễn trừ
- Số tin tối đa = `20 (repeat) × số target × 20 (dòng)` → có thể rất lớn.
- `ttl: 5000000` (~83 phút) cho tin gửi đi.
- Không bắt lỗi từng tin — một lỗi `sendMessage` sẽ ném ra ngoài (không có try/catch quanh vòng lặp, chỉ có phần đầu).
- `readSendUserLines` cắt `MAX_REPEAT` dòng đầu tiên (`nqduan-phase5.js:51`).

---

## 16. `keygold` (alias `keyvang`)

### 16.1 Cú pháp V3
```
!keygold                 → nhường key vàng cho chính người gửi
!keygold @mention        → nhường key vàng cho (các) người được tag
```
`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `risk: "critical"` (`command-registry.js:575`). Policy: `keygold: HIGH("group","critical")` (`command-permission-policy.js:178`). High-risk set **chứa `key`** nhưng **không** chứa literal `keygold` (`high-risk-policy.js:3-20`).

Handler: `handleKeyCommands` (`src/commands/bot-manager/group-manage.js:376`).

### 16.2 Điều kiện & quyền
- `cmdToken` phải ∈ `{keygold, keyvang}` (`group-manage.js:385-393`).
- **Bắt buộc `isAdminLevelHighest`**; nếu không → `sendMessageInsufficientAuthority` với `Không phải quản trị bot cấp mà sử dụng lệnh này!` rồi `return false` (`395-399`).
- Ưu tiên nguồn đích: `mentions` → `quote.uidFrom` → chính người gửi (`401-419`).
- Không có mention **và** không có quote → áp dụng cho người gửi với tên `"Bạn"` (`409`).

### 16.3 Nguồn dữ liệu
`message.data.mentions` (`{uid, pos, len}`), `message.data.quote.{uidFrom, fromD}`, `groupSettings` (`group-manage.js:401-419`).

### 16.4 Tác động
`api.changeGroupOwner(threadId, targetId)` (`group-manage.js:429`). Sau đó `writeGroupSettings(groupSettings)` (`421`).

> Lưu ý: `handleKeyCommands` **không** thay đổi `groupSettings` mà vẫn gọi `writeGroupSettings` → ghi lại file với nội dung không đổi (`421-422`).

### 16.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Không đủ quyền | `Không phải quản trị bot cấp mà sử dụng lệnh này!` (icon `🚫🚫🚫`) | false | 60000 | `group-manage.js:396-397`, `chat-style.js:53-89` |
| Thành công | `Đã nhường key vàng cho ${targetName}.` | true | 300000 | `group-manage.js:430` |
| Lỗi | `Không quyền hạn để nhường key cho ${targetName}.` | false | 300000 | `432` |

### 16.6 Trường hợp lỗi / miễn trừ
- Nhiều mention → gọi tuần tự, mention cuối cùng thắng (chủ nhóm cuối) (`410-415`).
- `targetName` lấy bằng `content.substring(pos, pos+len).replace("@", "")` — giữ nguyên khoảng trắng nếu tên có (`413`).
- Không kiểm tra bot có quyền chuyển chủ nhóm; lỗi API được bắt và báo text tương ứng.

---

## 17. `keysilver` (alias `keybac`)

### 17.1 Cú pháp V3
```
!keysilver               → phong key bạc cho chính người gửi
!keysilver @mention      → phong key bạc cho (các) người được tag
```
`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `risk: "critical"` (`command-registry.js:576`). Policy: `keysilver: HIGH("group","critical")` (`command-permission-policy.js:179`).

Cùng handler `handleKeyCommands` (`group-manage.js:376`).

### 17.2 Điều kiện & quyền
`cmdToken ∈ {keysilver, keybac}` (`group-manage.js:386`); `isAdminLevelHighest` bắt buộc (`395-399`).

### 17.3 Nguồn dữ liệu
Như §16.3.

### 17.4 Tác động
`api.addGroupAdmins(threadId, targetId)` (`group-manage.js:437`); `writeGroupSettings(groupSettings)` (`421`).

### 17.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Không đủ quyền | `Không phải quản trị bot cấp mà sử dụng lệnh này!` | false | 60000 | `group-manage.js:396-397` |
| Thành công | `Đã phong key bạc cho ${targetName}.` | true | 300000 | `438` |
| Lỗi | `Không hạn để phong key bạc cho ${targetName}.` | false | 300000 | `440` |

### 17.6 Trường hợp lỗi / miễn trừ
Như §16.6. Text lỗi `"Không hạn để phong key bạc cho …"` là **nguyên văn V3** (thiếu chữ "quyền") — phải giữ đúng.

---

## 18. `unkey` (alias `xoakey`)

### 18.1 Cú pháp V3
```
!unkey @mention          → gỡ key của (các) người được tag
!unkey                   (reply)  → gỡ key người được reply
!unkey                   (không mention/quote) → lỗi cú pháp
```
`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `risk: "critical"` (`command-registry.js:577`). Policy: `unkey: HIGH("group","critical")` (`command-permission-policy.js:180`).

Cùng handler `handleKeyCommands` (`group-manage.js:376`).

### 18.2 Điều kiện & quyền
- `cmdToken ∈ {unkey, xoakey}` (`group-manage.js:387`).
- `isAdminLevelHighest` bắt buộc (`395-399`).
- **Khác biệt**: `unkey` **không** cho phép "tự áp dụng cho chính mình" — nếu không có mention **và** không có quote → `Vui lòng @mention hoặc reply người cần gỡ key!` (`404-408`).

### 18.3 Nguồn dữ liệu
Như §16.3.

### 18.4 Tác động
`api.removeGroupAdmins(threadId, targetId)` (`group-manage.js:445`); `writeGroupSettings` (`421`).

### 18.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Không đủ quyền | `Không phải quản trị bot cấp mà sử dụng lệnh này!` | false | 60000 | `396-397` |
| Thiếu đích | `Vui lòng @mention hoặc reply người cần gỡ key!` | false | mặc định | `406` |
| Thành công | `Đã xóa key của ${targetName}.` | true | 300000 | `446` |
| Lỗi | `${targetName} Không có key để xóa.` | false | 300000 | `448` |

### 18.6 Trường hợp lỗi / miễn trừ
Như §16.6.

---

## 19. `keylist` (alias `listkey`)

### 19.1 Cú pháp V3
```
!keylist
!listkey
```
`permission: "adminBox"`, `type: 1`, `countdown: 1`, `scope: "group"` (`command-registry.js:591`). Policy: `keylist: BOX("group")` (`command-permission-policy.js:194`).

Handler: `handleListKeyCommand` (`src/commands/bot-manager/key-list.js:103`).

### 19.2 Điều kiện & quyền
`adminBox` trở lên. Không kiểm tra thêm.

### 19.3 Nguồn dữ liệu
`getGroupInfoData(api, threadId)` (`key-list.js:107`) → `groupType`, `creatorId`, `adminIds`, `name`; `getUserInfoData` cho từng UID (`117`, `127`).

### 19.4 Tác động
- `isCommunity = groupInfo.groupType === 2` → nhãn `Trưởng cộng đồng` / `Phó cộng đồng`; ngược lại `Trưởng nhóm` / `Phó nhóm` (`key-list.js:110-112`).
- Creator → `keyType: "gold"` (`115-122`).
- `adminIds` (loại creator) → `keyType: "silver"` (`124-132`).
- Render ảnh PNG (`createKeyListImage`), ghi vào `tempDir`, gửi kèm `ttl: 3600000`, `quote: message`, rồi xóa file (`139-141`).

### 19.5 Phản hồi (nguyên văn)
| Tình huống | Text | Nguồn |
|---|---|---|
| Không có key | `Không tìm thấy thông tin Key nào trong nhóm này.` | `key-list.js:135` |
| Lỗi | `Đã xảy ra lỗi khi lấy danh sách Key.` | `145` |
| Thành công | Ảnh (msg rỗng) TTL 3600000 | `140` |

### 19.6 Trường hợp lỗi / miễn trừ
- Lỗi `getUserInfoData` cho từng UID bị nuốt; người đó bị bỏ khỏi ảnh (`119-121`, `129-131`).
- Không có text fallback khi render ảnh lỗi → rơi vào catch chung.

---

## 20. `key`  `gold|up|down`

### 20.1 Cú pháp V3
```
!key                          → hướng dẫn
!key gold @mention            → chuyển chủ nhóm
!key up @mention              → phong phó nhóm
!key down @mention            → hạ phó nhóm
```
`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"` (`command-registry.js:649`). Policy: `key: HIGH("group","critical")` (`command-permission-policy.js` vùng high-risk); nằm trong `HIGH_RISK_COMMANDS` (`high-risk-policy.js:18`).

Handler: `handleKeyCommand` (`nqduan-bridge.js:225`).

### 20.2 Điều kiện & quyền
- `content` phải bắt đầu bằng `<prefix>key` hoặc `key` (`nqduan-bridge.js:242-244`).
- `!key` trơn → hướng dẫn, trả `true` (`247-261`).
- Chỉ chấp nhận `key gold`, `key up`, `key down`; khác → `return false` (`263-265`).
- **Bắt buộc `isAdminLevelHighest`**: nếu không → `Chỉ chủ bot mới được dùng lệnh key!` (`267-270`).

### 20.3 Nguồn dữ liệu
`message.data.mentions`, `readCommandParts(message).slice(2)` (`nqduan-bridge.js:273-274`).

### 20.4 Tác động (`applyKeyAction`, `nqduan-bridge.js:204-223`)
| action | API | Text thành công | Text lỗi |
|---|---|---|---|
| `gold` | `api.changeGroupOwner(threadId, targetId)` | `Đã đưa key vàng cho ${targetName}.` | `Không thể xử lý key cho ${targetName}: ${error.message}` |
| `up` | `api.addGroupAdmins(threadId, targetId)` | `Đã phong key bạc cho ${targetName}.` | như trên |
| `down` | `api.removeGroupAdmins(threadId, targetId)` | `Đã hạ key của ${targetName}.` | như trên |

Tất cả với `state=true`, TTL 300000 khi thành công (`208`, `213`, `217`) và `state=false`, TTL 300000 khi lỗi (`220`).

Đích: không mention & không args → chính người gửi với tên `"bạn"` (`277-278`); có mention → từng mention, tên lấy từ `content.substring(pos, pos+len)` (`279-284`); có args → từng UID (`285-291`).

### 20.5 Phản hồi (nguyên văn)
Hướng dẫn (`nqduan-bridge.js:251-258`, TTL 600000):
```
🔑 HƯỚNG DẪN LỆNH KEY
• !key gold @mention: đưa key vàng
• !key up @mention: phong key bạc
• !key down @mention: hạ key bạc
```
Không đủ quyền: `Chỉ chủ bot mới được dùng lệnh key!` (`268`).

### 20.6 Trường hợp lỗi / miễn trừ
- `args` rỗng nhưng có action → áp dụng cho chính người gửi (`277-278`).
- Lỗi từng target được báo riêng, không dừng vòng lặp (`204-222`).
- Khác `keygold`: text khác (`Đã đưa key vàng` vs `Đã nhường key vàng`), TTL lỗi khác, và `key` không gọi `writeGroupSettings`.

---

## 21. `settinggroup` (alias `stg`, `stgr`) — **KHÔNG có lệnh `setting`**

### 21.1 Cú pháp V3
```
!settinggroup                          → in danh sách cài đặt + trạng thái hiện tại
!settinggroup <lockchat|lockview|history|joinappr|showkey> <on|off|1|0>
!settinggroup name <tên mới>
```
`permission: "adminBox"`, `type: 3`, **`countdown: 0`** (không cooldown), `scope: "group"` (`command-registry.js:373`). Policy: `settinggroup: BOX("group","sensitive")` (`command-permission-policy.js:114`). Nằm trong `ANTI_MANAGEMENT_COMMANDS` (`group-interaction-policy.js:8`).

Handler: `handleSettingGroupCommand(api, message, groupInfo, aliasCommand)` (`group-manage.js:682`).

> **`setting` KHÔNG tồn tại** dưới dạng lệnh riêng: không có entry `name: "setting"` trong `assets/json-data/command.json`, không có alias `setting`, không có key `setting` trong registry (`command-registry.js:373`). Chỉ có `settinggroup`. V4 **không được** tạo lệnh `setting`.

### 21.2 Điều kiện & quyền
- `adminBox` trở lên; `countdown = 0` → không có thời gian chờ giữa các lần gọi.
- `args = content.slice(prefix.length).trim().split(/\s+/); args.shift()` (`group-manage.js:686-688`).
- `args.length < 1` → in hướng dẫn và `return` (`690-705`).

### 21.3 Nguồn dữ liệu
`groupInfo.setting` (dữ liệu Zalo trả về): `lockSendMsg`, `lockViewMember`, `enableMsgHistory`, `joinAppr`, `signAdminMsg` (`group-manage.js:695-699, 739`).

### 21.4 Tác động
**Nhánh chuỗi** (`group-manage.js:711-730`): chỉ `name`:
- Thiếu giá trị → `Vui lòng nhập giá trị cho cài đặt name` (`712-715`).
- `api.changeGroupName(threadId, value)` → `Tên nhóm đã được đổi thành ${value}` (`719-722`).
- Lỗi → `Không thể thay đổi ${settingType}: ${error.message}` (`725-728`).

**Nhánh on/off** (`732-786`):
- Giá trị không ∈ `{on, off, 0, 1}` → `Vui lòng chọn on/off hoặc 1/0 để thay đổi cài đặt` (`733-736`).
- `newValue = ["on","1"].includes(value) ? 1 : 0` (`738`).

| settingType | field Zalo | Text thành công (khi `newValue === 1`) | Text (khi `0`) |
|---|---|---|---|
| `lockchat` | `lockSendMsg` | `Đã tắt chat cho tất cả thành viên!` | `Đã mở chat cho tất cả thành viên!` |
| `lockview` | `lockViewMember` | `Đã tắt xem thành viên trong nhóm!` | `Đã mở xem thành viên trong nhóm!` |
| `history` | `enableMsgHistory` | `Đã mở cho phép thành viên mới đọc tin nhắn gần nhất!` | `Đã tắt …` |
| `joinappr` | `joinAppr` | `Đã mở chế độ phê duyệt thành viên!` | `Đã tắt …` |
| `showkey` | `signAdminMsg` | `Đã mở hiển thị key quản trị!` | `Đã tắt …` |
| khác | — | — | `Loại cài đặt '${settingType}' Không hợp lệ!` |

(`group-manage.js:742-782`)

Ghi qua `updateGroupSetting` → `api.changeGroupSetting(threadId, settings)` rồi `sendMessageStateQuote(..., true, 60000)` (`group-manage.js:1215-1218`).

### 21.5 Phản hồi (nguyên văn, hướng dẫn `group-manage.js:691-703`)
```
Sử dụng: !<aliasCommand> <loại config> <giá trị>

[Cài đặt Bật/Tắt] (on/off hoặc 1/0):
- lockchat: <Tắt|Mở> chat trong nhóm
- lockview: <Tắt|Mở> xem thành viên trong nhóm
- history: <Mở|Tắt> cho phép thành viên mới đọc tin nhắn gần nhất
- joinappr: <Mở|Tắt> chế độ phê duyệt thành viên
- showkey: <Mở|Tắt> hiển thị key quản trị

[Cài đặt Chuỗi]:
- name <tên mới>: Đổi tên nhóm
```
`success: false`, `hasState: false`, `ttl: 60000` (`group-manage.js:703`).

### 21.6 Trường hợp lỗi / miễn trừ
- `countdown: 0` → spam liên tục được gọi API Zalo.
- Không kiểm tra bot có quyền `changeGroupSetting` trước; lỗi được bắt và báo (`783-786`).
- `name` cho phép chuỗi chứa khoảng trắng (`args.slice(1).join(" ")`, `708`).
- Chỉ là cài đặt Zalo — **không** ghi `group-settings.json`.
- Lưu ý: helper `updateGroupSetting` **luôn** truyền `state=true` kể cả khi cài đặt là "tắt" (`1215-1218`) — nhưng text đã tự mô tả trạng thái.

---

## 22. `welcome` (alias `wl`, `wlc`)

### 22.1 Cú pháp V3
```
!welcome            → toggle
!welcome on         → bật
!welcome off        → tắt
```
`permission: "adminBox"`, `type: 3`, `countdown: 1`, `scope: "group"` (`command-registry.js:431` — nhóm metadata; handler tại `456`). Policy: `welcome: BOX("group","sensitive")` (`command-permission-policy.js:130`). Nằm trong `ANTI_MANAGEMENT_COMMANDS` (`group-interaction-policy.js:3-5`).

Handler: `handleWelcomeBye(api, message, groupSettings, "welcome")` (`src/commands/bot-manager/welcome-bye.js:5`, gắn tại `command-registry.js:456`).

### 22.2 Điều kiện & quyền
- `adminBox` trở lên.
- `settingKey = getWelcomeSettingKey("welcome")` → `"welcomeGroup"` (`welcome-command.js:1-7, 9-18`).
- `option === "on"` → `true`; `"off"` → `false`; không option → **toggle** `!groupSettings[threadId][settingKey]` (`welcome-bye.js:12-25`).

### 22.3 Nguồn dữ liệu
`groupSettings[threadId].welcomeGroup` (`group-settings.json`). Khởi tạo mặc định `false` (`command.js:284`).

### 22.4 Tác động
`groupSettings[threadId].welcomeGroup = newStatus` (`welcome-bye.js:40`); persist qua `shouldPersistGroupSettings` (`group-interaction-policy.js:103-109`).

### 22.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Option lạ | `Cú pháp không hợp lệ..!` | false | mặc định | `welcome-bye.js:27-32` |
| Không xác định được settingKey | `Cú pháp không hợp lệ. Vui lòng sử dụng '!welcome', '!bye' hoặc '!updategroup' cùng với [on/off]` | false | mặc định | `18-24` |
| Thành công | `Đã <bật|tắt> chức năng chào mừng thành viên mới!` | theo `newStatus` | 300000 | `41-64` |

`featureName`: `welcomeGroup` → `chào mừng thành viên mới`; `byeGroup` → `tạm biệt thành viên rời nhóm`; `updateGroup` → `thông báo cập nhật nhóm` (`welcome-bye.js:44-56`).

### 22.6 Trường hợp lỗi / miễn trừ
- Text `"Cú pháp không hợp lệ..!"` có **hai dấu chấm** — nguyên văn V3 (`welcome-bye.js:30`).
- Toggle không đọc giá trị mặc định nếu thiếu key (dùng `!undefined === true`).
- Tên lệnh `!welcome` luôn ánh xạ `welcomeGroup` bất kể alias gọi (`welcome-command.js:1-7`).

---

## 23. `bye`

### 23.1 Cú pháp V3
```
!bye            → toggle
!bye on|off
```
`permission: "adminBox"`, `type: 3`, `countdown: 1`, `scope: "group"` (`command-registry.js:431` vùng; handler `457`). Policy: `bye: BOX("group","sensitive")` (`command-permission-policy.js:131`).

Cùng handler `handleWelcomeBye(..., "bye")` (`welcome-bye.js:5`).

### 23.2 Điều kiện & quyền
- `adminBox` trở lên (registry + policy `BOX("group","sensitive")`).
- `settingKey = getWelcomeSettingKey("bye")` → `"byeGroup"` (`welcome-command.js:5, 9-18`).
- `option === "on"` → `true`; `"off"` → `false`; không option → **toggle** (`welcome-bye.js:12-25`); option khác → `Cú pháp không hợp lệ..!` (`27-32`).

### 23.3 Nguồn dữ liệu
`groupSettings[threadId].byeGroup` trong `group-settings.json`; mặc định `false` (`command.js:285`, `group-settings-store.js:58`).

### 23.4 Tác động
`groupSettings[threadId].byeGroup = newStatus` (`welcome-bye.js:40`); persist qua `shouldPersistGroupSettings` khi handler trả `true` (`group-interaction-policy.js:103-109`).

Hiệu ứng khi bật: event `LEAVE` gửi ảnh goodbye hoặc fallback text `👋 <tên> vừa rời khỏi nhóm.`, bỏ qua khi chính bot rời (`src/automations/events-group.js:229-246`).

### 23.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Thành công | `Đã <bật|tắt> chức năng tạm biệt thành viên rời nhóm!` | theo `newStatus` | 300000 | `welcome-bye.js:41-64` |
| Option lạ | `Cú pháp không hợp lệ..!` | false | mặc định | `27-32` |

### 23.6 Trường hợp lỗi / miễn trừ
Như §22.6: text lỗi có hai dấu chấm (`..!`), toggle dựa trên `!undefined`, và tên lệnh luôn ánh xạ `byeGroup` bất kể alias.

---

## 24. `approve` (alias `duyetmem`)

### 24.1 Cú pháp V3
```
!approve            → toggle
!approve on|off
```
`permission: "adminBox"`, `type: 3`, `countdown: 1`, `scope: "group"` (`command-registry.js:511`). Policy: `approve: BOX("group")` (`command-permission-policy.js:162`). Trong `ANTI_MANAGEMENT_COMMANDS` (`group-interaction-policy.js:12`).

Handler: `handleApprove` (`welcome-bye.js:69`).

### 24.2 Điều kiện & quyền
- `adminBox` trở lên.
- `option === "on"` → true; `"off"` → false; không option → toggle (`welcome-bye.js:73-88`).
- Option khác → `Cú pháp Không hợp lệ. Vui lòng sử dụng '!approve [on/off]'.` (`82-87`).

### 24.3 Nguồn dữ liệu
`groupSettings[threadId].memberApprove`; mặc định `false` (`command.js:292`).

### 24.4 Tác động
1. `groupSettings[threadId].memberApprove = newStatus` (`welcome-bye.js:90`).
2. **Nếu bật** → gọi ngay `api.handleGroupPendingMembers(threadId, true)` để duyệt toàn bộ yêu cầu đang chờ (`94-96`).

### 24.5 Phản hồi
`Đã <bật|tắt> chức năng tự động phê duyệt thành viên mới!` với `state = newStatus`, TTL 300000 (`welcome-bye.js:92-93`).

### 24.6 Trường hợp lỗi / miễn trừ
- Bật `approve` **duyệt ngay lập tức** mọi yêu cầu đang chờ (side effect ngoài việc đổi cờ) — V4 phải tái tạo.
- Khi `memberApprove` bật, event `JOIN_REQUEST` cũng tự duyệt (`src/automations/events-group.js:180-184`).
- Lỗi từ `handleGroupPendingMembers` **không được bắt** → có thể ném ra ngoài.

---

## 25. `target` (`add|list|remove`)

### 25.1 Cú pháp V3
```
!target add @user|UID [UID2 …]
!target list
!target remove <số thứ tự>
!target remove all
```
`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"` (`command-registry.js:648`). Policy: `target: HIGH("group","critical")` (`command-permission-policy.js:204`). Trong `HIGH_RISK_COMMANDS` (`high-risk-policy.js:17`).

Handler: `handleTargetCommand` (`nqduan-bridge.js:469`).

### 25.2 Điều kiện & quyền
- `adminLevelHigh` + high-risk throw.
- **Kiểm tra thêm**: `isAdmin(senderId, threadId)` phải true → nếu không `Bạn không có quyền sử dụng lệnh này!` (`nqduan-bridge.js:480-483`).
- Action lạ → in hướng dẫn (`505-507`).

### 25.3 Nguồn dữ liệu
- Store: `path.join(stateDir, "target-list.json")` (`nqduan-bridge.js:24-30`).
- Hình dạng: `{ [threadId]: { targetList: [{ idUserZalo, senderName }] } }` (`305-310`, `397`, `426-427`).
- `message.data.mentions`; `getUserInfoData` để lấy tên khi nhập UID (`361-363`).

### 25.4 Tác động

**`add`** (`nqduan-bridge.js:328-414`):
1. Mention: bỏ qua nếu `isAdmin(userId, threadId)` → `Đại Ca không thể target quản trị viên: <tên|uid>` (`339-342`).
2. Nhập UID: phải khớp `/^\d+$/` → nếu không `"<uid>" không phải là UID hợp lệ.` (`351-354`); bỏ qua admin (`355-358`); `getUserInfoData` throw → `Không tìm thấy tài khoản với UID: <uid>` (`360-366`).
3. Không có đích → `Đại Ca muốn target ai? Hãy @tag hoặc nhập UID.` (`368-371`).
4. `api.blockUsers(threadId, uidsToBlock)` **một lần**; throw → coi tất cả là `errorMembers` (`375-383`).
5. Ghi vào `targetList` (bỏ qua nếu đã có) (`390-402`); `writeTargetList` nếu có thay đổi (`404`).
6. Báo cáo nhiều dòng (`406-413`):
   - `✅ Đã target và chặn thành công: <danh sách>`
   - `⚠️ Không tìm thấy trong nhóm nhưng đã thêm vào target: <danh sách>`
   - `❌ Đã target từ trước: <danh sách>`
   `state=true`, TTL 300000.

**`list`** (`416-431`):
- Rỗng → `✅ Nhóm này chưa target ai.` (state=true, TTL 300000).
- Có → `📋 Danh sách target:\n1. <tên> (<uid>)\n…`, **tối đa 50 dòng** (`.slice(0, 50)`, `428`).

**`remove <index>`** (`433-453`):
- Index không hợp lệ → `Vui lòng nhập số thứ tự hợp lệ để xóa.\nDùng !target list để xem số.` (`437-440`).
- Index > độ dài → `Số thứ tự <n> không có trong danh sách.` (`444-447`).
- Thành công → `✅ Đã xóa '<tên>' (STT <n>) khỏi danh sách target.` (`452`).

**`remove all`** (`455-467`):
- Rỗng → `✅ Danh sách target đã trống.` (`459-462`).
- Thành công → `✅ Đã xóa toàn bộ <n> người dùng khỏi danh sách target.` (`464-466`).

**Hướng dẫn** (`312-326`, `state=false`):
```
🚨 Sai cú pháp!
• !target add @user|UID
• !target list
• !target remove [số thứ tự]
• !target remove all
```

### 25.5 Phản hồi (nguyên văn)
| Tình huống | Text | state | TTL | Nguồn |
|---|---|---|---|---|
| Sai cú pháp / action lạ | `🚨 Sai cú pháp!\n• !target add @user\|UID\n• !target list\n• !target remove [số thứ tự]\n• !target remove all` | false | mặc định | `nqduan-bridge.js:312-326` |
| Không có quyền | `Bạn không có quyền sử dụng lệnh này!` | false | mặc định | `481` |
| Target admin (mention) | `Đại Ca không thể target quản trị viên: <tên\|uid>` | false | mặc định | `340` |
| Target admin (UID) | `Đại Ca không thể target quản trị viên: <uid>` | false | mặc định | `356` |
| UID không hợp lệ | `"<uid>" không phải là UID hợp lệ.` | false | mặc định | `352` |
| Không tìm thấy UID | `Không tìm thấy tài khoản với UID: <uid>` | false | mặc định | `365` |
| Không có đích | `Đại Ca muốn target ai? Hãy @tag hoặc nhập UID.` | false | mặc định | `369` |
| `add` — chặn được | `✅ Đã target và chặn thành công: <ds>` | true | 300000 | `407`, `412` |
| `add` — không có trong nhóm | `⚠️ Không tìm thấy trong nhóm nhưng đã thêm vào target: <ds>` | true | 300000 | `408`, `412` |
| `add` — đã target | `❌ Đã target từ trước: <ds>` | true | 300000 | `409`, `412` |
| `list` rỗng | `✅ Nhóm này chưa target ai.` | true | 300000 | `422` |
| `list` có dữ liệu | `📋 Danh sách target:\n1. <tên> (<uid>)\n…` (tối đa 50) | true | 300000 | `426-430` |
| `remove` index sai | `Vui lòng nhập số thứ tự hợp lệ để xóa.\nDùng !target list để xem số.` | false | mặc định | `438` |
| `remove` index vượt | `Số thứ tự <n> không có trong danh sách.` | false | mặc định | `445` |
| `remove` thành công | `✅ Đã xóa '<tên>' (STT <n>) khỏi danh sách target.` | true | 300000 | `452` |
| `remove all` khi rỗng | `✅ Danh sách target đã trống.` | true | 300000 | `460` |
| `remove all` thành công | `✅ Đã xóa toàn bộ <n> người dùng khỏi danh sách target.` | true | 300000 | `466` |

### 25.6 Auto-block khi join (`handleTargetOnJoin`, `nqduan-bridge.js:512-534`)
- Chỉ khi có `updateMembers` (`514-515`).
- Bot **phải là admin nhóm**: `getGroupAdmins(groupInfo).includes(botId)` → nếu không `return false` (`517-520`).
- Với mỗi member có trong target list (`isUserTagged`, `305-310`):
  - `api.blockUsers(threadId, [userId])` (lỗi nuốt, `529`).
  - Gửi `🚨 <tên> đã bị chặn tự động do nằm trong danh sách target!` (`530`).
- Được gọi trong event JOIN trước welcome (`events-group.js:204-206`); nếu handled thì **return sớm**, không chạy welcome.

### 25.7 Trường hợp lỗi / miễn trừ
- Hai cơ chế target song song: `nqduan-bridge.js` dùng `stateDir/target-list.json` với `targetList`, còn `group-manage.js:1224-1249` dùng `dataDir/tagetList.json` với `tagetList` (dùng bởi `handleMemberJoin`). **V4 nên hợp nhất** nhưng phải giữ tương thích đọc cả hai.
- `handleTargetRemove` không kiểm tra `targetData[threadId]` tồn tại → có thể throw nếu thread chưa có.
- `list` cắt 50 nhưng `remove <index>` cho phép index tới độ dài thực (có thể > 50) → không nhất quán.

---

## 26. `scold` (alias `reo`, `var`, `chui`, `sold`)

### 26.1 Cú pháp V3
```
!scold @mention [delayMs]
!scold <tha|stop|dung|dừng|off|tat|tắt>
```
`permission: "adminBox"`, `type: 3`, `countdown: 1`, `scope: "group"`, `minArgs: 1` (`command-registry.js:510`). Policy: `scold: BOX("group")` (`command-permission-policy.js:161`).

Handler: `scoldUser` (`src/service-debug/chat-bot/scold-user/scold-user.js:221`).

### 26.2 Điều kiện & quyền
- `callerLevel = getUserRoleLevel(senderId, threadId, groupAdmins)`; `groupAdmins` lấy từ tham số hoặc `getEffectiveGroupAdmins(api, threadId)` (`scold-user.js:228-233`).
- **Dừng**: `isStopCommand` khớp các biến thể `!scold <kw>`, `scold <kw>`, `...scold <kw>`, `!sold/reo/var/chui <kw>`, hoặc chuỗi đúng bằng `<kw>` (`235-251`). Nếu `callerLevel >= 1` và đang có session → `stopScolding` (`253-259`), ngược lại im lặng.
- `callerLevel < 1` → gửi `formatPermissionDenied("adminBox")` (`261-275`).
- Không mention → `":D Đại ca muốn em chửi ai? 🚀"` (`292-299`).
- Target là chính bot → `Không thể ra lệnh chửi Bot. 🚫` (`301-309`).
- `targetLevel >= callerLevel` → `Không thể ra lệnh chửi người có cấp bậc quản trị bằng hoặc cao hơn bạn. 🚫` (`310-323`).
- Đang chửi rồi → `Người này đang bị chửi.` (`325-338`).
- `delay` = tham số số đầu tiên, clamp `[1000, 10000]`, mặc định 1000 (`277-290`).

### 26.3 Nguồn dữ liệu
`message.data.mentions[0].uid` (`scold-user.js:301`); `scoldUsers` (Set UID đang bị chửi, `325`); `activeSessions` (Map theo thread, `62`); `scoldMessages` (mảng câu chửi, từ `341`); `appContext.uid` (`302`).

### 26.4 Tác động
- Gửi caption mở đầu: `"Tao chuẩn bị mắng yêu "` + tag (`scold-user.js:2060`).
- Vòng lặp `setTimeout` với `delay` ms, lần lượt gửi các câu trong `scoldMessages` theo chu kỳ (`2082-2136`).
- Dừng: `stopScolding(api, message)` (`141`), text `"Dạ Đại Ca em sẽ tha cho nó."` (`170`).
- `handleForgive` (`102`) — text `117`.

### 26.5 Phản hồi (nguyên văn)
| Tình huống | Text | Nguồn |
|---|---|---|
| Thiếu quyền | `formatPermissionDenied("adminBox")` | `263-270` |
| Thiếu mention | `:D Đại Ca muốn em chửi ai? 🚀` | `294` |
| Target là bot | `Không thể ra lệnh chửi Bot. 🚫` | `304` |
| Target ≥ caller | `Không thể ra lệnh chửi người có cấp bậc quản trị bằng hoặc cao hơn bạn. 🚫` | `315` |
| Đang bị chửi | `Người này đang bị chửi.` | `329` |
| Dừng | `Dạ Đại Ca em sẽ tha cho nó.` | `170` |
| Mở đầu | `Tao chuẩn bị mắng yêu <tag>` | `2060` |

### 26.6 Trường hợp lỗi / miễn trừ
- **Dừng bằng chat tự do**: `handleScoldFreeChat` (`189-219`) — chỉ cần `senderLevel >= 1` và nội dung chứa từ `tha` độc lập (`/(?<!\p{L})tha(?!\p{L})/ui`, `211`) khi có session đang chạy → `stopScolding`.
- Không giới hạn thời gian chửi; chỉ dừng khi có admin nói `tha` hoặc `!scold stop`.
- Nhiều thread có thể chửi song song (`activeSessions` theo thread).
- `scoldUsers` là Set toàn cục theo UID → một UID bị chửi ở nhóm A thì ở nhóm B cũng bị coi là "đang bị chửi".

---

## 27. `spamgroup` (alias `spamgr`)

### 27.1 Cú pháp V3
```
!spamgroup <nội dung>|<delay>|<số lần>
!spamgroup delay|<ms>
!spamgroup set|<ttl ms>
!spamgroup stop
```
`permission: "adminLevelHigh"`, `type: 3`, `countdown: 1`, `scope: "group"`, `minArgs: 1`, `risk: "critical"` (`command-registry.js:509`). Policy: `spamgroup: HIGH("multiGroup","critical")` (`command-permission-policy.js:160`). High-risk (`high-risk-policy.js:5`).

Handler: `spamgroup` (`src/commands/bot-manager/spamgroup.js:62`).

### 27.2 Điều kiện & quyền
- `adminLevelHigh` + high-risk throw.
- Hằng số: `MIN_DELAY_MS = 1000`, `MAX_REPEAT = 20` (`spamgroup.js:7-8`).
- Không tham số → in cú pháp (`83-85`).
- `delay|<ms>`: phải `>= 1`, thực tế `Math.max(raw, MIN_DELAY_MS)` → tối thiểu 1000 ms (`111-125`).
- `set|<ttl>`: phải `>= 0` (`127-134`).
- `<nội dung>|<delay>[|<n>]`: cần `msgContent` không rỗng và `delay` là số (`136-143`).
- `maxRepeat = clamp(n, 1, 20)`; mặc định 20 (`140`, `147`).

### 27.3 Nguồn dữ liệu
- `spamSessions` — Map theo `threadId` (`spamgroup.js:6, 89-101`); mỗi session `{isSpamming, text, delay, ttl, sentCount, maxRepeat, interval}` (`91-99`), mặc định `ttl = 10000` (`95`).
- Pending task persistence: `addPendingTask({id: "spamgroup_<threadId>", type: "spamgroup", status: "pending", data: {threadId, text, delay, ttl}})`, xóa bằng `removePendingTask` (`spamgroup.js:20, 151-161`; `src/skills/task-persistence.js`).
- Khôi phục sau restart: `resumeSpamSessions(api)` đọc tasks `type === "spamgroup" && status === "pending"`, `maxRepeat` reset về `MAX_REPEAT` (`43-60`).

### 27.4 Tác động
- `startBoundedSpamLoop` (`23-41`): `setInterval(session.delay)`; mỗi tick, nếu `!isSpamming || sentCount >= maxRepeat` → `stopSpamSession`; ngược lại `sentCount += 1`, `sendSpam(...)`, và dừng khi đạt `maxRepeat` (`29-39`). Timer được `unref()` (`40`).
- `sendSpam` → `api.sendMessage({msg: text, ttl}, threadId, MessageType.GroupMessage)` (`176-183`).
- `stopSpamSession` → `clearInterval`, `isSpamming = false`, `sentCount = 0`, `removePendingTask` (`10-21`).
- Đổi `delay` khi đang chạy → khởi động lại vòng lặp với `delay` mới và `sentCount` reset về 0 (`116-119`).

### 27.5 Phản hồi (nguyên văn)
Cú pháp (`spamgroup.js:67-81`, TTL 60000):
```
⚠️ Cú pháp sai. Dùng:
- !spamgroup <nội dung>|<delay >= 1000ms>[|<số lần <= 20>]
- !spamgroup delay|<giá trị mới >= 1000>
- !spamgroup set|<ttl (ms)>
- !spamgroup stop
```

| Tình huống | Text | Nguồn |
|---|---|---|
| `stop` khi đang chạy | `✅ Đã dừng spam.` | `106` |
| `stop` khi không chạy | `⚠️ Không có spam nào đang chạy.` | `108` |
| `delay` không hợp lệ | `⚠️ Delay không hợp lệ.` | `114` |
| `delay` hợp lệ | `✅ Đã đổi delay thành <N>ms.` | `121` |
| `set` không hợp lệ | `⚠️ TTL không hợp lệ.` | `130` |
| `set` hợp lệ | `✅ TTL đã đặt thành <N>ms.` | `133` |
| Bắt đầu | `✅ Bắt đầu gửi lặp:\n"<nội dung>"\n⏱ Delay: <N>ms \| Tối đa: <M> lần\n🕒 TTL: <T>ms` | `163-170` |

Tất cả dùng `api.sendMessage({msg, quote: message}, threadId, message.type)` — **có quote**, **không** TTL (trừ cú pháp 60000).

### 27.6 Trường hợp lỗi / miễn trừ
- Giới hạn cứng **20 lần** và **1000 ms** — không thể vượt (`8, 116, 147`).
- `sentCount` reset về 0 khi đổi delay giữa chừng → tổng số tin thực tế có thể vượt `maxRepeat` (`116-119, 28`).
- `restart` bot → phiên spam tiếp tục (resume), `maxRepeat` quay về 20 (`43-60`).
- Chỉ một session / thread; gọi lại `spamgroup <nội dung>|…` khi đang chạy sẽ **restart** vòng lặp với nội dung mới (`149`).
- Timer `unref()` nên không giữ process sống (`40`).

---

## 28. `setting` — **KHÔNG TỒN TẠI**

### 28.1 Cú pháp V3
Không có. `!setting` không phải lệnh.

### 28.2 Điều kiện & quyền
Không áp dụng — không có handler, không có policy, không có entry registry.

### 28.3 Nguồn dữ liệu
Không áp dụng.

### 28.4 Tác động
Không áp dụng.

### 28.5 Phản hồi
Không có phản hồi riêng. `!setting` được xử lý như một lệnh không tồn tại: `checkNotFindCommand(...)` (`command.js:1031-1036`) — chỉ chạy khi `groupSettings[threadId].activeBot === true` hoặc `callerIsBotAdmin`, ngược lại **im lặng**.

### 28.6 Trường hợp lỗi / miễn trừ
Xem §28.3 (Bằng chứng) và §28.4 (Hệ quả cho V4) bên dưới.

### 28.7 Bằng chứng
- `assets/json-data/command.json` có **0** entry `name === "setting"` và **0** alias `setting`.
- Registry không có key `setting`; chỉ có `settinggroup` với alias `stg`, `stgr` (`command-registry.js:373`).
- `handleSettingGroupCommand` chỉ được gắn cho `settinggroup` (`command-registry.js:392`).
- Grep toàn bộ `src/commands/command-registry.js` cho `setting` chỉ trả về `settinggroup`, `name`/`mysetting` (lệnh `name`, `command-registry.js:17`) và các tên biến `groupSettings`.

### 28.8 Hệ quả cho V4
- **Không** implement lệnh `setting`.
- `!setting …` phải rơi vào nhánh "không tìm thấy lệnh": `checkNotFindCommand(...)` (`command.js:1031-1036`, `src/commands/bot-manager/utilities.js:282`).
- Mọi nhu cầu "cài đặt nhóm" đều đi qua `settinggroup` (§21).

---

## 29. `admin` (`list|add|remove`, tier `box|qtv`)

### 29.1 Cú pháp V3
```
!admin                                   → hướng dẫn
!admin list        |  !admin ls          → xem danh sách
!listadmin                               → tương đương !admin list
!admin add <@user|UID>                   → thêm admin bot đa-nhóm (adminBot)
!admin remove <@user|UID> | rm | del     → xóa admin bot đa-nhóm
!admin add box <@user|UID>               → thêm adminBox của NHÓM HIỆN TẠI
!admin remove box <@user|UID>
!admin add qtv <@user|UID>               → thêm adminLevelHigh (nguồn COMMAND)
!admin remove qtv <@user|UID>
```
`permission: "adminBot"`, `type: 3`, `countdown: 1`, `scope: "both"` (`command-registry.js:728`, handler `779`).

Parser: `parseAdminCommand` (`src/utils/admin-command-parser.js:19-108`; wrapper `admin-manager.js:84-86`).
- `REMOVE_ALIASES = {rm, del}`, `LIST_ALIASES = {ls}` (`admin-command-parser.js:1-2`).
- `RESERVED_TOKENS = {admin, list, ls, add, remove, rm, del, listadmin, qtv, box}` (`3-5`).
- `resolveTargetTier`: `box` → tier `box`; `qtv` → tier `high`; còn lại → `bot` (`12-17, 48-54`).
- `TIER_ROLES = { bot: adminBot, box: adminBox, high: adminLevelHigh }` (`6-10`).
- **Bare `!add` / `!remove` KHÔNG còn được nhận** (`45-46`).
- `rootVerb === "listadmin"` → action `list` (`30-31`).
- `rootVerb` khác `admin`/`listadmin` → action `guide` (`27`).
- Sub không thuộc `{list, ls, add, remove, rm, del}` → action `unknown` (`41-43`).

### 29.2 Điều kiện & quyền

**Theo policy** (`src/commands/command-permission-policy.js:243, 257-260, 304-312`):
| Alias | requiredRole | effectScope | risk |
|---|---|---|---|
| `admin add/remove <uid>` (tier `bot`) | `adminLevelHigh` | global | sensitive |
| `admin add/remove box` | `adminBot` | group | sensitive |
| `admin add/remove qtv` | `adminLevelHigh` | global | critical |

**Theo handler** (`admin-manager.js`):
- `isCallerHigh = authorizationSnapshot.isAdminLevelHigh`, `isCallerAtLeastBot = authorizationSnapshot.isBotAdmin` (`152-153`).
- Tier `bot`: nếu `!isCallerHigh` → `Chỉ quản trị viên tối cao mới được thêm/xóa admin bot đa-nhóm!` (`491-495`).
- Tier `box`: nếu `isPrivate` → `Lệnh "box" chỉ dùng trong nhóm. Hãy vào nhóm cần cấp quyền rồi dùng lại.` (`441-444`); nếu `!isCallerAtLeastBot` → `Chỉ quản trị bot trở lên mới được quản lý adminBox của nhóm này!` (`445-448`).
- Tier `high`: nếu `!isCallerHigh` → `Chỉ quản trị viên tối cao mới được sử dụng lệnh này!` (`584-587`); **trên bot chính**, nếu caller là admin tối cao **nguồn COMMAND** → `Admin tối cao nguồn COMMAND không được phép quản lý cùng cấp (chỉ admin tối cao nguồn FILE).` (`588-591`).
- Không có target → cú pháp theo tier (`429-438`).
- Target là chính bot → `Không thể thao tác trên UID của chính bot!` (`500-503`, `596-599`).
- Trên bot con, target là Main-bot UID: `add` → `Bot Admin (<tên>) đã có quyền Quản trị Tối cao mặc định trên bot con rồi!`; `remove` → `Không thể xóa Quản trị Tối cao mặc định (<tên>) của bot con!` (`504-510`, `600-606`).

### 29.3 Nguồn dữ liệu & nơi lưu

| Tier | Đường dẫn (main) | Đường dẫn (child) | Nguồn |
|---|---|---|---|
| `high` (FILE) | `assets/data/list_admin_high.json` | — | `src/utils/admin-role-store.js:71-92` |
| `high` (COMMAND) | `assets/data/list_admin_high_command.json` | `<instance>/data/admin-high.json` | `admin-role-store.js:71-92`, `admin-manager.js:610-644` |
| `bot` | `mybot/instances/<uid>/data/admin-list.json` | như main | `src/utils/bot-runtime-context.js:199-240` |
| `box` | `groupSettings[threadId].adminList` (khóa = UID, value = tên) | như main | `admin-manager.js:200-204`, `group-settings-store.js:58` |

Audit log: `logs/admin-role-audit.jsonl` (`admin-manager.js:130`), mỗi bản ghi `{ts, pid, action, tier, actorId, targetUid, botUid, threadId, source, result, detail, cacheVersionAfter}` (`admin-role-store.js:158-174`).

### 29.4 Tác động

**`list`** (`admin-manager.js:183-423`):
- `listInstanceSupremeAdmins({instanceUid, instanceKind, mainBotUid, projectRoot, overrides})` → `allHighUids` + `source` (`184-195`).
- `botAdminUids` từ `botAdminsPath`, loại chính bot và UID đã là high (`197-199`).
- `groupAdminEntries` từ `groupSettings[threadId].adminList`, loại bot/high/bot-admin (`200-204`).
- Làm giàu tên/avatar từ `api.getUserInfo`, `mybot/credentials/<uid>.json`, `mybot/state/<uid>.json` (`206-333`).
- Render ảnh PNG nếu khả dụng; gửi kèm `ttl: 600000`, xóa file sau 30 s (`396-419`). Fallback text thuần `ttl: 600000` (`421-422`).

**`add`/`remove box`** → `mutateBoxAdmin(...)` ghi `groupSettings` với rollback (`admin-manager.js:450-486`).

**`add`/`remove bot`** → `mutateBotAdmin(...)` trên `admin-list.json` của bot hiện tại (`497-573`). Sau khi `remove`, handler **tính lại quyền** của target; nếu vẫn `adminLevelHigh` từ nguồn khác → `Đã xóa <tên> (<uid>) khỏi admin bot đa-nhóm, nhưng UID vẫn còn quyền Tối cao từ nguồn khác (<source>).` (`524-552`).

**`add`/`remove qtv`**:
- Bot con → `mutateChildHighAdmin(...)` → `admin-high.json` riêng của bot con (`609-644`).
- Bot chính → `addHighAdminViaCommand` / `removeHighAdminViaCommand` → `list_admin_high_command.json` (`646-683`).
- Bảo vệ: `FILE_SOURCE_PROTECTED` → `<tên> (<uid>) thuộc nguồn FILE — chỉ sửa trực tiếp trong file.`; `LAST_ADMIN_PROTECTED` → `Phải còn ít nhất một quản trị tối cao hiệu lực sau thao tác!` (`685-692`).

**Cơ chế an toàn ghi file** (`admin-role-store.js:176-271`): khóa file (`lockFile`), đọc snapshot, ghi atomic, **đọc lại để verify**, rollback về snapshot nếu verify fail, ghi audit `ok`/`failed`, `invalidateAdminRoleCache()`.

**Chống thao tác lên cấp cao hơn** (`assertManageableTarget`, `admin-role-store.js:292-302`): target là UID bot → `BOT_PROTECTED` ("Không thể thao tác trên UID của bot"); `ROLE_LEVELS[caller] <= ROLE_LEVELS[target]` → `TARGET_PROTECTED` ("Không thể thao tác trên mục tiêu cùng cấp hoặc cao hơn").

### 29.5 Phản hồi (nguyên văn)

**Hướng dẫn** (`admin-manager.js:168-178`, không state, quote):
```
📌 HƯỚNG DẪN QUẢN LÝ ADMIN
- !admin list: Xem danh sách admin.
- !admin add @user|UID: Thêm admin bot đa-nhóm (chỉ admin tối cao).
- !admin remove @user|UID: Xóa admin bot đa-nhóm (chỉ admin tối cao).
- !admin add box @user|UID: Thêm quản trị nhóm này (admin trở lên).
- !admin remove box @user|UID: Xóa quản trị nhóm này (admin trở lên).
- !admin add qtv @user|UID: Thêm quản trị tối cao nguồn COMMAND.
- !admin remove qtv @user|UID: Xóa quản trị tối cao nguồn COMMAND.
```

**Sub không tồn tại** (`157-166`): `Không tồn tại lệnh "!admin <sub>". Dùng "!admin" để xem hướng dẫn.`

**Danh sách** (`admin-manager.js:335-373`):
```
📋 DANH SÁCH QUẢN TRỊ VIÊN BOT
━━━━━━━━━━━━━━━━━━
👑 QUẢN TRỊ TỐI CAO:
  1. <tên> (<uid>) - Quản trị Tối cao [<nguồn>]
  (Chưa có)

🛡️ QUẢN TRỊ BOT ĐA-NHÓM:
  1. <tên> (<uid>) - Quản trị Bot đa-nhóm
  (Chưa có)

🏷️ QUẢN TRỊ NHÓM (adminBox):
  1. <tên> (<uid>) - Quản trị Nhóm
  (Chưa có)
```
Trong chat riêng, khối `adminBox` thay bằng `(Danh sách quản trị nhóm chỉ xem được trong nhóm.)` (`368-371`).

**Cú pháp thiếu target** (`429-438`):
- tier `high` → `Vui lòng nhập UID: !admin <action> qtv <@user|UID>`
- tier `bot` → `Vui lòng nhập UID: !admin <action> <@user|UID>`
- tier `box` → `Vui lòng đề cập (@mention) hoặc nhập UID: !admin <action> box <@user|UID>`

Text nhãn tier: `Quản trị Tối cao` / `Quản trị Bot đa-nhóm` / `Quản trị Nhóm` (`admin-manager.js:88-92`).

### 29.6 Trường hợp lỗi / miễn trừ
- **Cô lập theo phiên (bot con)**: `admin-list.json`, `admin-high.json`, `profile.json`, `admin-identity-audit.json` đọc theo `mybot/instances/<uid>/…` (`instance-authorization.js:539-570`, `bot-runtime-context.js:199-240`). **Không** merge danh sách admin toàn cục của Main vào bot con (`bot-runtime-context.js` comment "Do NOT merge main bot UID or global admin lists into child bot!").
- **Fail-closed khi `identityPending`**: UID từ state dùng chung không cấp quyền (`instance-authorization.js:552-562`).
- `init-admin` seeding (`src/commands/bot-manager/init-admin.js:55-145`):
  - Bot con: resolve động (`resolveChildAdminIdentities`); **mọi lỗi** → `fallbackWriteChildAdmins` ghi **chỉ UID của chính bot** với `identityPending: true` (`init-admin.js:17-53, 65-84`); **không bao giờ** chặn khởi động (`74-83`).
  - Bot chính: hợp nhất `adminFilePath` + `adminListPath` + `getInitialAdminList(...)`, bỏ literal `"admin"` (`86-131`), ghi ra cả hai đường dẫn nếu khác nhau (`133-144`).
- Ghi file thất bại → gửi `Thao tác thất bại, đã phục hồi dữ liệu gốc. (<mã lỗi|ERROR>)` (`481-484`, `569-572`, `693-695`).
- `add` khi đã tồn tại → `<tên> (<uid>) đã có trong danh sách quản trị nhóm này.` / `… đã là admin bot đa-nhóm.` / `… đã có trong danh sách quản trị tối cao.` (không phải lỗi, `result.changed === false`).
- `remove` khi không tồn tại → `<tên> (<uid>) không có trong danh sách quản trị nhóm này.` / `… không phải admin bot đa-nhóm.` / `… không có trong quản trị tối cao nguồn COMMAND.`
- `!listadmin` là **bí danh** của `!admin list` (`command-registry.js:375, 394`; parser `admin-command-parser.js:30-31`), không phải lệnh riêng.

---

## Bất biến an toàn

Các bất biến sau là **hợp đồng an toàn** giữa V3 và V4. Bản Rust **KHÔNG ĐƯỢC** vi phạm bất kỳ điều nào; mỗi bất biến đều có test tương ứng cần có.

### B1 — `locmem` chỉ chạy khi có đủ 7 ngày lịch hoàn chỉnh, liền trước hôm nay
`getQualified7DayWindow` yêu cầu `completeSet.size === 7 && missingDays.length === 0` trên đúng 7 ngày lịch trước hôm nay theo `Asia/Ho_Chi_Minh` (`locmem-store.js:510-537`, `time-util.js:9, 71`). `getInactiveCandidates` **trả `[]`** nếu thiếu bất kỳ snapshot ngày nào (`locmem-store.js:546-576`). Không có đường tắt, không có fallback "gần đủ 7 ngày", không có chế độ bỏ qua.

### B2 — `locmem` xác nhận chỉ bằng reaction TIM (❤️) trong nhóm, atomic, một lần
Chỉ `rType === 5` (`locmem-service.js:480-482`), chỉ trong nhóm (`485-488`), phải có pending khớp `threadId:serverMsgId` (`505-507`), phải được `takeRequest` **atomic xóa trước khi trả** (`532-535`, `locmem-pending.js:114-142`). Pending là in-memory → restart tự hủy (`locmem-pending.js:1-11`). Người xác nhận phải là `adminLevelHigh` **tại thời điểm thả reaction** (`locmem-service.js:513-529`).

### B3 — `locmem` tái kiểm tra quyền admin của bot ngay trước khi kick, với dữ liệu tươi
Re-fetch `api.getGroupInfo(threadId)` **bypass cache** (`locmem-service.js:548-571`); nếu không fetch được → **hủy toàn bộ** (`560-571`); nếu bot không còn là chủ/admin → **hủy toàn bộ** (`601-623`). Không được dùng `groupInfo` cũ/cached để quyết định kick.

### B4 — `locmem` luôn giao lại (intersection) với danh sách preview và loại trừ admin
Chỉ kick UID nằm trong `request.candidates` (`locmem-service.js:648`), sau khi loại: đã rời nhóm, được bổ nhiệm QTV/chủ nhóm, bot hệ thống, `isAdminLevelHigh`/`isBotAdmin`, và **vừa tương tác sau preview** (recheck 7 ngày + activity hôm nay) (`644-686`). Danh sách loại trừ gốc gồm chủ nhóm, admin native, bot hiện tại, mọi bot đã đăng ký, adminBot, adminLevelHigh (`311-340`).

### B5 — `locmem` dừng ngay (fail-closed) khi có bất kỳ dấu hiệu bất thường
Abort khi: quá deadline 45 s (kiểm tra 4 lần: `227-236, 300-309, 371-380, 386-395`), `api.removeUserFromGroup` không tồn tại (`696-699`), một lô ném lỗi (`706-712`), schema trả về sai (`errorMembers` không phải Array) (`715-721`). Trong các trường hợp đó, các lô **chưa/đang** xử lý được báo là `unprocessed` — **không** được thử lại, **không** được "cố gắng tiếp".

### B6 — `kickall`/`blockall` không bao giờ tác động lên chủ nhóm, admin native, admin bot, hoặc chính bot
`handleKickAll` lọc `uid !== creatorId && uid !== botId && !groupAdminSet.has(uid) && !isAdmin(uid, threadId)` (`group-manage.js:154-156`); `handleBlockAll` lọc tương tự (`347-349`). Nếu `getGroupInfo` throw, thiếu `gridInfoMap[threadId]`, hoặc `memVerList` rỗng → **abort, không gọi API phá hoại** (`132-152`, `323-344`).

### B7 — `leavelock` không bao giờ rời nhóm mà bot là admin/chủ nhóm
`if (groupAdmins.includes(String(botId))) continue;` (`nqduan-bridge.js:143-144`). Chỉ rời nhóm có `lockSendMsg === 1` ở **gốc hoặc trong `setting`** (`140`).

### B8 — `leaveallbox` không bao giờ rời box đang gọi lệnh
`if (group.groupId === commandBoxId) continue;` (`nqduan-bridge.js:187`).

### B9 — High-risk commands yêu cầu top-level admin và tuân thủ kill switch
`resolveHighRiskPolicy`: `killSwitch` → deny; không phải `isMainBotAdmin`/`isAdminLevelHighest`/`permissionLevel === "adminlevelhigh"` → deny (`high-risk-policy.js:45-70`). Áp dụng cho `kickall, blockall, leave, kickallmember, blockallmember, leaveallbox, leavelock, dispersegroup, kickimg, blockimg, target, key, locmem, spamgroup` (`3-20`). Không có ngoại lệ cho bot con, không có ngoại lệ cho "đang khẩn cấp".

### B10 — Phân quyền fail-closed khi danh tính bot con chưa xác minh
`childIdentityIsPending()` = true → UID quan sát từ state dùng chung của Main **không** được cấp `adminLevelHigh` (`instance-authorization.js:517-526, 552-562`). `listInstanceSupremeAdmins` cũng loại Main-bot UID khỏi danh sách hiển thị khi pending (`660-662`). `fallbackWriteChildAdmins` chỉ ghi UID của chính bot con, không suy diễn UID người vận hành (`init-admin.js:17-53`).

### B11 — Cô lập admin theo phiên bot
Mỗi bot con đọc/ghi danh sách admin **của riêng nó** (`mybot/instances/<uid>/data/…`); **không** merge danh sách admin toàn cục của Main vào bot con (`bot-runtime-context.js:199-240`, `instance-authorization.js:565-584`). `!admin add/remove qtv` trên bot con chỉ sửa `admin-high.json` của bot con (`admin-manager.js:609-644`).

### B12 — Mọi thay đổi quyền admin phải atomic, verify, và rollback được
`mutateListFileTransaction`: khóa → snapshot → ghi atomic → **đọc lại verify** → rollback về snapshot nếu verify fail → audit (`admin-role-store.js:176-271`). Không được ghi trực tiếp không khóa. Không được bỏ bước verify.

### B13 — Không thể leo thang quyền hoặc thao tác lên cấp ngang/cao hơn
`assertManageableTarget`: target = UID bot → `BOT_PROTECTED`; `ROLE_LEVELS[caller] <= ROLE_LEVELS[target]` → `TARGET_PROTECTED` (`admin-role-store.js:292-302`). Trên bot chính, admin tối cao **nguồn COMMAND** không được quản lý admin tối cao (`admin-manager.js:588-591`). Nguồn FILE được bảo vệ khỏi ghi qua lệnh (`685-688`). Không được phép xóa admin tối cao cuối cùng (`689-691`).

### B14 — `dispersegroup` yêu cầu quyền admin nhóm thực tế và chỉ trong nhóm
`message.type !== GroupMessage` → từ chối (`nqduan-bridge.js:105-108`); `!isAdmin(senderId, threadId)` → từ chối (`110-113`). Không có đường nào gọi `disperseGroup` mà chưa qua hai cổng này.

### B15 — `scold` không thể nhắm vào bot hoặc người ngang/cao cấp hơn
`String(userId) === String(appContext.uid)` → `Không thể ra lệnh chửi Bot. 🚫` (`scold-user.js:301-309`); `targetLevel >= callerLevel` → từ chối (`310-323`). `callerLevel < 1` → từ chối (`261-275`). Và luôn dừng được bằng `tha` từ admin (`189-219`).

### B16 — `target` không thể nhắm vào quản trị viên
`isAdmin(userId, threadId)` → bỏ qua kèm `Đại Ca không thể target quản trị viên: …` (`nqduan-bridge.js:339-342, 355-358`). Auto-block khi join chỉ chạy khi bot là admin nhóm (`517-520`).

### B17 — Mọi giới hạn số lần gửi phải được clamp cứng
`spamgroup`: `MAX_REPEAT = 20`, `MIN_DELAY_MS = 1000`, clamp `[1, 20]` và `>= 1000` (`spamgroup.js:7-8, 116, 147`). `sendp`: cap 20 cho non-admin rồi clamp `[1, 50]` (`utilities.js:683-686`). `senduser`: `delay ∈ [500, 10000]`, `repeat ∈ [1, 20]`, tối đa 20 dòng file (`nqduan-phase5.js:19, 51, 74-75`). `todo`: cap 3 lần cho non-admin (`utilities.js:115-117`). Không được nâng các hằng số này mà không có yêu cầu rõ ràng.

### B18 — Không lệnh nào được giả mạo quyền bằng cách sửa `groupSettings` cục bộ
`groupSettings[threadId].adminList` là nguồn `adminBox` duy nhất từ nhóm (`role-policy.js:47-55`, `instance-authorization.js:579-584`); `adminBox` **không** đủ cho high-risk (`high-risk-policy.js:65-67`), **không** đủ cho `!admin add/remove` (`admin-manager.js:491-495`), **không** đủ cho `!locmem` (`locmem-service.js:186-195`), **không** đủ cho `kickall`/`blockall`/`key*` (`command-registry.js:573-577, 643-647`). Việc bật `activeBot` chỉ mở cổng tương tác (`group-interaction-policy.js:88-92`), **không** cấp quyền.

---

## Phụ lục A — Bảng tổng hợp quyền & phạm vi

| Lệnh | permission (registry) | type | countdown | scope | risk | High-risk? |
|---|---|---|---|---|---|---|
| `kickall` / `kickallmember` | `adminLevelHigh` | 3 | 1 | group | critical | ✅ |
| `blockall` / `blockallmember` | `adminLevelHigh` | 3 | 1 | group | critical | ✅ |
| `locmem` | `adminLevelHigh` | 1 | 30 | group | critical | ✅ |
| `leaveallbox` | `adminLevelHigh` | 3 | 1 | both | — | ✅ |
| `leavelock` | `adminLevelHigh` | 3 | 1 | both | — | ✅ |
| `dispersegroup` | `adminLevelHigh` | 1 | 1 | group | — | ✅ |
| `leave` | `adminLevelHigh` | 3 | 1 | group | critical | ✅ |
| `undo` | `adminBox` | 3 | 1 | group | — | ❌ |
| `deletemessage` | `adminBox` | 3 | 1 | group | — | ❌ |
| `join` | `adminBot` | 3 | 1 | both | — | ❌ |
| `listgroups` | `adminBot` | 3 | 1 | both | — | ❌ |
| `scangroups` | `adminBot` | 3 | 1 | group | — | ❌ |
| `todo` | `adminBot` | 3 | 1 | both | — | ❌ |
| `sendp` | `adminLevelHigh` | 3 | 1 | group | high | ❌ (policy HIGH) |
| `senduser` | `adminLevelHigh` | 1 | **120** | both | — | ❌ (policy HIGH) |
| `keygold` / `keysilver` / `unkey` | `adminLevelHigh` | 3 | 1 | group | critical | ⚠️ chỉ `key` |
| `keylist` | `adminBox` | 1 | 1 | group | — | ❌ |
| `key` | `adminLevelHigh` | 3 | 1 | group | — | ✅ |
| `settinggroup` | `adminBox` | 3 | **0** | group | — | ❌ |
| `welcome` / `bye` | `adminBox` | 3 | 1 | group | — | ❌ |
| `approve` | `adminBox` | 3 | 1 | group | — | ❌ |
| `target` | `adminLevelHigh` | 3 | 1 | group | — | ✅ |
| `scold` | `adminBox` | 3 | 1 | group | — | ❌ |
| `spamgroup` | `adminLevelHigh` | 3 | 1 | group | critical | ✅ |
| `admin` | `adminBot` | 3 | 1 | both | — | ❌ |

Nguồn: `command-registry.js:373, 431, 457-458, 509-519, 573-582, 591, 643-649, 728, 731, 739`.

## Phụ lục B — Danh sách alias cần giữ

| Chuẩn | Alias |
|---|---|
| `kickall` | `cútall` |
| `blockall` | `biếnall` |
| `keygold` | `keyvang` |
| `keysilver` | `keybac` |
| `unkey` | `xoakey` |
| `undo` | `un` |
| `join` | `thamgianhom` |
| `leave` | `out` |
| `listgroups` | `lgr` |
| `scangroups` | `scgr` |
| `deletemessage` | `delmsg`, `del` |
| `keylist` | `listkey` |
| `settinggroup` | `stg`, `stgr` |
| `welcome` | `wl`, `wlc` |
| `approve` | `duyetmem` |
| `scold` | `reo`, `var`, `chui`, `sold` |
| `spamgroup` | `spamgr` |
| `sendp` | `sendprivate` |
| `admin` | `listadmin` (chỉ hành động `list`) |

Nguồn: `command-registry.js:373, 509-519, 573-582, 591, 431`; `welcome-command.js:1-7`; `admin-command-parser.js:30-31`.
