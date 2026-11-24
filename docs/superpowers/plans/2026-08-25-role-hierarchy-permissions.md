# Plan: Phân quyền toàn bộ command và thiết kế lại lệnh `admin`

> Nguồn: plan do người dùng cung cấp ngày 2026-08-25. Chính sách bốn tầng:
> `adminLevelHigh > adminBot > adminBox > member`.
> Trưởng/phó nhóm Zalo không tạo ra quyền bot. Ba loại admin có storage riêng,
> hiệu lực ngay sau khi dùng lệnh, không cần restart.

## 1. Policy và interface chung

Thêm resolver duy nhất:

```js
resolveRequiredRole({ canonicalName, alias, args, scope, definition })
```

Mỗi action được gắn:

```js
{
  requiredRole: "member" | "adminBox" | "adminBot" | "adminLevelHigh",
  effectScope: "user" | "group" | "multiGroup" | "global",
  risk: "normal" | "sensitive" | "high" | "critical"
}
```

Quy tắc bắt buộc:

- `group` mutation → tối thiểu `adminBox`.
- `multiGroup` của một instance bot → tối thiểu `adminBot`.
- `global`, tài khoản bot, runtime, filesystem, database chung, cấp key Zalo,
  bulk destructive, `high/critical` → `adminLevelHigh`.
- Alias phải resolve về canonical command trước khi xét quyền.
- Command có nhiều action như `admin`, `group`, `mybot`, `name` dùng action-level policy.
- Route legacy chưa có policy phải bị từ chối fail-closed.

## 2. Ma trận quyền

### Admin tối cao (adminLevelHigh)

- High-risk/bulk: `spamsms`, `spamjoin`, `spamgroup`, `kickall`, `blockall`,
  `kickimg`, `blockimg`, `kickallmember`, `blockallmember`, `leave`,
  `leaveallbox`, `leavelock`, `dispersegroup`, `target`, `key`, `ngl`, `call`, `sendp`.
- Runtime/tài nguyên: action quản trị `mybot`, `data`, đổi tài khoản trong `name`,
  `prefix`, `setcmd`, `restart`, `alias`, download/delete/send resource, `sendsrc`,
  `datavideo`, `scanapi`, `cpus`, `benchmark`, `showcode`, `poststatus`.
- Tài khoản/bạn bè: `ketban/kb`, add/remove/undo/reject/list friend, `senduser`.
- Dữ liệu nhạy cảm/toàn cục: `ban`, `unban`, `buff`, `mybank`, `acclq`,
  `dinhgiasim`, `fakecccd`.
- `autojoin`, tạo/invite/autolock group.
- Cấp/xóa key Zalo: `keygold/keyvang`, `keysilver/keybac`, `unkey`.
- Thêm/xóa admin thường và admin tối cao.

### Admin thường đa-group (adminBot)

Có quyền trên mọi group của đúng instance bot và kế thừa toàn bộ quyền adminBox.

Quyền riêng:

- `join`, `listgroups`, `scangroups`.
- `blockbot`, `unblockbot`, `listblockbot`.
- `todo`.
- `admin add/remove box` (quản lý adminBox).
- Không được restart, đổi prefix/alias, quản lý resource/account,
  sửa dữ liệu toàn cục, cấp key Zalo hoặc dùng bulk destructive.

### AdminBox

Chỉ có hiệu lực đúng `threadId` được cấp:

- Vận hành nhóm: `bot`, `gameactive`, `autodownload`, `manager`, `listmute`,
  `settinggroup`, `changelink`.
- Lịch và nội dung nhóm: `prservice`, `sendtext`, `sendstk`, `sendtask`.
- Welcome: `welcome`, `bye`, `updategroup`, `approve`, `prwelcome`.
- Toàn bộ anti-service và `whitelist`.
- Học/phản hồi: `learn`, `learnnow`, `unlearn`, `reply`, `autoreply`.
- Moderation một mục tiêu: `mute`, `unmute`, `kick`, `block`, `taget`,
  `deletemessage`, `scold`.
- Tiện ích nhóm: `undo`, `tagall`, `replytag`, `keylist`.
- Không được dùng `kickall/blockall`, cấp key, làm bot rời nhóm hoặc tác động ngoài nhóm.

### Member

Các lệnh nội dung, media, AI, tìm kiếm, tải công khai, game và thông tin còn lại.
`pinterest` và `googlesearchai` trở thành lệnh user thường.

## 3. Storage ba tầng admin

- Tối cao nguồn FILE: `assets/data/list_admin_high.json`; chỉ sửa trực tiếp trong file.
- Tối cao nguồn COMMAND: file dùng chung mới (`assets/data/list_admin_high_command.json`),
  do `admin add/remove qtv` quản lý.
- Admin thường: `mybot/instances/<botUid>/data/admin-list.json`.
- AdminBox: `groupSettings[threadId].adminList`; giữ nguyên toàn bộ dữ liệu hiện có.
- Resolver hợp nhất hai nguồn tối cao thành cùng role `adminLevelHigh`.
- Nếu UID nằm ở nhiều tầng, role cao nhất thắng nhưng từng danh sách nguồn vẫn giữ nguyên.

## 4. Hợp đồng lệnh `admin`

```text
admin add <mention|UID>          # thêm admin thường đa-group (cần tối cao)
admin remove <mention|UID>
admin add box <mention|UID>      # thêm adminBox group hiện tại (cần ≥ adminBot)
admin remove box <mention|UID>   # từ chối trong private
admin add qtv <mention|UID>      # thêm admin tối cao nguồn COMMAND (mọi tối cao)
admin remove qtv <mention|UID>   # không xóa được UID thuộc nguồn FILE
```

- Cho phép tự xóa nguồn COMMAND nếu sau thao tác vẫn còn ít nhất một admin tối cao hiệu lực.
- UID bot luôn được bảo vệ.

Alias tương thích:

- `add` → `admin add`.
- `remove` → `admin remove`.
- `listadmin` → `admin list`.
- Plain `admin add` không còn thêm adminBox.

## 5. `admin list`

Trong group hiển thị đủ ba phần:

1. Quản trị tối cao, kèm nhãn `FILE` hoặc `COMMAND`.
2. Admin thường đa-group của bot hiện tại.
3. AdminBox của group hiện tại.

Trong private chỉ hiển thị tối cao và admin thường; ghi rõ adminBox chỉ xem được
trong group. Không dedupe dữ liệu nguồn; UID trùng nhiều danh sách được đánh dấu
role hiệu lực cao nhất. Canvas và text fallback phải có cùng nội dung.

## 6. Hiệu lực tức thì

Mỗi mutation thực hiện transaction:

1. Kiểm tra role người gọi và target.
2. Khóa đúng file/store.
3. Ghi atomic.
4. Invalidate role/policy cache.
5. Đọc lại storage.
6. Gọi resolver xác nhận role mới.
7. Chỉ gửi thành công sau khi verify.

Nếu verify thất bại: rollback snapshot, không trả thành công giả, ghi audit log
(actor, target, bot, group, role, source, kết quả).

## 7. Loại quyền key Zalo

- `groupAdmins`, `adminIds`, `creatorId`, key vàng/key bạc không được dùng để suy
  caller role hoặc target role.
- Key holder không bypass bot-off, cooldown, menu admin, reply/reaction/free-chat
  hay command legacy.
- Dữ liệu key chỉ được dùng trong thao tác quản lý/hiển thị key và thông tin nhóm.
- UID giữ key chỉ có quyền bot nếu UID đồng thời tồn tại trong một storage admin hợp lệ.

## 8. Kiểm thử và nghiệm thu

- Inventory đủ 241 canonical command; mọi alias/action có policy.
- Test từng tầng với user, adminBox nhóm A/B, adminBot và hai nguồn adminLevelHigh.
- Test high-risk luôn từ chối adminBot trở xuống.
- Test adminBot kế thừa adminBox ở nhiều group nhưng không dùng được command global.
- Test adminBox không có hiệu lực chéo group.
- Test parser đầy đủ cho `admin add/remove`, `box`, `qtv`, mention, UID và alias cũ.
- Test nguồn FILE không thể xóa bằng command; nguồn COMMAND thêm/xóa được.
- Test `admin list` group có ba phần, private có hai phần.
- Test mutation thành công ngay không restart; test rollback khi write/re-read/verify lỗi.
- Test key vàng/key bạc vẫn resolve thành member.
- Static audit thất bại nếu handler tự kiểm tra quyền ngoài resolver chung.
