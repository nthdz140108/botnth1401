# Tài liệu Vận hành: Pool Video Local (`video/<pool>/`)

Tài liệu này mô tả cấu trúc, cơ chế hoạt động và cách vận hành hệ thống pool video local cho toàn bộ lệnh `vd*` và SendTask video. Kể từ khi chuyển sang local-only, **mọi pool video đều đọc trực tiếp file `.mp4` trong `<project-root>/video/<tên-pool>/`**; không còn URL online, không còn health store, không còn fallback.

---

## 1. Tổng quan Kiến trúc

```
[User Trigger /vd*] / [SendTask girl-video]
        │
        ▼
[handleVideoCommand / sendRandomGirlVideo]
        │
        ▼
[resolveVideoPoolConfig]  →  kind=LOCAL_DIRECTORY, source=<tên-pool>
        │
        ▼
[listLocalVideoCandidates(source)]  quét đệ quy video/<source>/**/*.mp4
        │
        ▼
[sendLocalVideoWithFallback]  chuẩn bị metadata (ffprobe) + frame JPEG (ffmpeg)
        │                  ├── upload video qua api.uploadAttachment
        │                  ├── upload thumbnail qua api.uploadAttachment
        │                  └── api.sendVideo({ videoAlreadyUploaded: true, ... })
        │
        ▼
[Zalo gửi video]
```

---

## 2. Các nguyên tắc bất biến (Invariants)

1. **Chỉ local:** Mọi lệnh `vd*` (gồm `vdsex`) và mọi danh mục SendTask video đều ánh xạ `kind: "local-directory"` tới folder dưới `<project-root>/video/<tên-pool>/`. Không còn nhánh URL online, không còn fallback sang URL.
2. **Folder ngoài Git:** Thư mục `video/` nằm trong `.gitignore`. Người vận hành đồng bộ riêng folder này lên VPS (rsync/scp), không commit MP4 lên repo.
3. **Quét mỗi lượt:** `listLocalVideoCandidates` được gọi mỗi lần lệnh/SendTask chạy, nên thêm/xóa file MP4 có hiệu lực ở lượt kế tiếp — không cần restart bot.
4. **MP4 đuôi chuẩn:** Chỉ nhận file có đuôi `.mp4` (không phân biệt hoa/thường). Bỏ qua symlink, thư mục ẩn, `node_modules`, mọi file `.part`/audio/crawler.
5. **Candidate ≤ 12:** Mỗi lượt gửi thử tối đa 12 file MP4 (giới hạn cứng trong `sendLocalVideoWithFallback`). Lấy candidate bằng Fisher-Yates shuffle.
6. **Tên pool hợp lệ:** Tên pool phải khớp `[a-z0-9_-]+` (hàm `sanitizeLocalPoolDir`). Mọi tên khác bị bỏ — chặn path traversal và tên tùy ý.

---

## 3. Ánh xạ Lệnh → Pool

| Lệnh     | Pool       | TTL mặc định | Ghi chú                          |
|----------|------------|--------------|----------------------------------|
| `vdgirl` | `vdgirl`   | 1 giờ        |                                  |
| `vdsexy` | `vdsexy`   | 1 giờ        |                                  |
| `vdsex`  | `vdsex`    | 1 giờ        | Chuyển từ URL online sang local  |
| `vdcos`  | `vdcos`    | 1 giờ        |                                  |
| `vdanime`| `vdanime`  | 1 giờ        |                                  |
| `vdboy`  | `vdboy`    | 1 giờ        |                                  |
| `vdchill`| `vdchill`  | 1 giờ        |                                  |
| `vdsad`  | `vdsad`    | 1 giờ        |                                  |
| `vdtet`  | `vdtet`    | ~3.9 ngày    | Tăng TTL cho dịp lễ Tết          |
| `vdvuto` | `vdvuto`   | 1 giờ        |                                  |

SendTask video dùng cùng ánh xạ qua `resolveVideoPoolConfig` (`src/service-debug/chat-zalo/chat-special/send-video/send-video.js`). Enum `SENDTASK_GIRL_CATEGORIES` (`src/commands/studio/sendtask-defaults.js`) liệt kê `default/sexy/cosplay/anime/sex` — chỉ `sex` đọc folder `video/vdsex`.

---

## 4. Schema dữ liệu Video Local

Không có sidecar JSON. Bot chỉ đọc filesystem:

```
<project-root>/video/
├── vdgirl/
│   └── clip-001.mp4
├── vdsexy/
│   └── ...
├── vdsex/
│   └── clip-001.mp4      ← nguồn duy nhất cho !vdsex và SendTask category "sex"
├── vdcos/
├── vdanime/
├── vdboy/
├── vdchill/
├── vdsad/
├── vdtet/
└── vdvuto/
```

### Quy tắc đặt tên file

- Đuôi `.mp4` (không phân biệt hoa/thường).
- Tên file chỉ chứa ký tự an toàn cho filesystem của bạn; bot không đọc metadata tên.
- Dedupe case-insensitive trên Windows: `CLIP.mp4` và `clip.mp4` chỉ tính một lần.

---

## 5. Luồng Chuẩn bị → Upload → Gửi

Mỗi candidate MP4 đi qua 4 stage (`stage=` log):

1. **prepare** — `ffprobe` đọc metadata (`duration`, `width`, `height`, `fileSize`); `ffmpeg` trích frame đầu ra JPEG làm thumbnail tạm.
   - Thiếu `ffmpeg`/`ffprobe` → dừng cả lượt (`VideoToolMissingError`).
   - File hỏng/không đọc được → bỏ qua file đó, thử candidate tiếp theo.
2. **video-upload** — `api.uploadAttachment([filePath], threadId, threadType)`. Lỗi upload = lỗi chung (endpoint/transport/Zalo) → dừng cả lượt, không đốt 12 candidate trên cùng lỗi.
3. **thumbnail-upload** — Upload JPEG thumbnail tạm. Lỗi = dừng cả lượt.
4. **delivery** — `api.sendVideo({ videoAlreadyUploaded: true, thumbnail, duration, width, height, fileSize, ttl })`. Zalo từ chối → dừng ngay, không gửi thêm video nào.

Thumbnail tạm luôn được dọn trong `finally` bằng `removeTemporaryFile` (`src/api-zalo/media/video-temp-file.js`).

---

## 6. Structured Logging

Bot ghi log có cấu trúc với tiền tố `[vd-video]` và stage:

```
[vd-video] stage=scan            pool=vdsex candidates=8 action=scan
[vd-video] stage=prepare         pool=vdsex source_kind=local-directory candidates=8 attempt=1 limit=8
[vd-video] stage=video-upload    pool=vdsex action=done status=200 file=clip-001.mp4 attempt=1 limit=8
[vd-video] stage=thumbnail-upload pool=vdsex action=done status=200 attempt=1 limit=8
[vd-video] stage=delivery        pool=vdsex action=success status=200 file=clip-001.mp4 attempt=1 limit=8
```

Chỉ ghi basename, không log đường dẫn máy.

---

## 7. Vận hành hằng ngày

### Bổ sung video mới

```bash
mkdir -p <project-root>/video/vdsex
rsync -av --include='*/' --include='*.mp4' --exclude='*' ./local-clips/ <project-root>/video/vdsex/
```

Không cần restart bot — quét lại ở lệnh/SendTask kế tiếp.

### Lệnh thiếu pool / pool rỗng

Khi `video/<pool>/` không tồn tại hoặc không có `.mp4`, bot gửi đúng một thông báo:

```
Nguồn video "video/<pool>" đang thiếu hoặc trống. Vui lòng bổ sung file .mp4 rồi thử lại sau.
```

### Triển khai lên VPS

- Repo clone chỉ chứa code; folder `video/` là ngoài Git.
- Đồng bộ folder `video/<pool>/` riêng bằng `rsync`/`scp` từ máy local lên VPS (cùng cấu trúc thư mục).
- Trước khi restart bot, đảm bảo `<project-root>/video/vdsex/` có ít nhất một MP4 hợp lệ.

### Công cụ vận hành

Không còn. Hệ thống cũ có:
- `scripts/check-video-pools.js`, `scripts/rebuild-video-pools.js`, `scripts/maintain-video-pools.mjs`, `check-video-pools.bat`
- `src/.../send-video/video-health-store.js`, `video-health-checker.js`
- `src/.../data-send/vdsex.txt`

Tất cả đã được gỡ khi chuyển sang local. Nếu cần di chuyển/sao lưu video, dùng trực tiếp lệnh shell (`cp`, `rsync`, `find`).
