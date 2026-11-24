# Hướng dẫn Vận hành Pool Video Local

Tài liệu này mô tả cách quản lý và vận hành pool video local cho toàn bộ lệnh `vd*` và SendTask video sau khi hệ thống chuyển sang chế độ **chỉ local** (không còn URL online, không còn health store).

---

## 1. Cấu trúc Pool Canonical

Toàn bộ 10 pool video được quét đệ quy tại `<project-root>/video/<tên-pool>/`:

| Folder          | Lệnh tương ứng    | Thể loại               | TTL mặc định |
| :-------------- | :---------------- | :--------------------- | :----------- |
| `vdgirl/`       | `vdgirl`, `vdgai` | Gái                    | 1 giờ        |
| `vdsexy/`       | `vdsexy`          | Sexy                   | 1 giờ        |
| `vdsex/`        | `vdsex`           | 18+ / Sex (đã local)   | 1 giờ        |
| `vdcos/`        | `vdcos`           | Cosplay                | 1 giờ        |
| `vdanime/`      | `vdanime`         | Anime                  | 1 giờ        |
| `vdboy/`        | `vdboy`           | Boy                    | 1 giờ        |
| `vdchill/`      | `vdchill`         | Chill                  | 1 giờ        |
| `vdsad/`        | `vdsad`           | Tâm trạng / Sad        | 1 giờ        |
| `vdtet/`        | `vdtet`           | Tết                    | ~3.9 ngày    |
| `vdvuto/`       | `vdvuto`          | Vuto                   | 1 giờ        |

> [!IMPORTANT]
> - Thư mục `video/` nằm trong `.gitignore` — operator đồng bộ riêng lên VPS bằng `rsync`/`scp`, không commit MP4 lên repo.
> - Mỗi folder chỉ chứa file `.mp4`; mọi file phụ (`.jpg`, `.pdf`, `.part`, audio, crawler output) bị bỏ qua tự động.

---

## 2. Mapping Command → Pool

| Lệnh      | Pool     | TTL       | Variant keyword      |
| :-------- | :------- | :-------- | :------------------- |
| `vdgirl`  | `vdgirl` | 1 giờ     | mặc định             |
| `vdgai`   | `vdgirl` | 1 giờ     | mặc định             |
| `vdsexy`  | `vdsexy` | 1 giờ      | mặc định             |
| `vdsex`   | `vdsex`  | 1 giờ     | mặc định             |
| `vdcos`   | `vdcos`  | 1 giờ     | mặc định             |
| `vdanime` | `vdanime`| 1 giờ     | mặc định             |
| `vdboy`   | `vdboy`  | 1 giờ     | mặc định             |
| `vdchill` | `vdchill`| 1 giờ     | mặc định             |
| `vdsad`   | `vdsad`  | 1 giờ     | mặc định             |
| `vdtet`   | `vdtet`  | ~3.9 ngày | mặc định             |
| `vdvuto`  | `vdvuto` | 1 giờ     | mặc định             |

SendTask video đi qua cùng mapping: `category=sex` → folder `vdsex`; `category=sexy` → `vdsexy`; v.v. Enum `SENDTASK_GIRL_CATEGORIES = ["default","sexy","cosplay","anime","sex"]` được định nghĩa trong `src/commands/studio/sendtask-defaults.js`.

Lệnh `girl` (mặc định) có variant `sexy` được chọn tự động khi caption chứa keyword `sexy | hot | gợi cảm` (`KEYWORD_MAPPING`).

---

## 3. Không còn Health Store / Sidecar / URL Scanning

Hệ thống cũ đã được gỡ:

- ❌ `src/.../send-video/video-health-store.js` — xóa.
- ❌ `src/.../send-video/video-health-checker.js` — xóa.
- ❌ `assets/data/video-source-health.json` — không còn sinh ra.
- ❌ `scripts/check-video-pools.js`, `scripts/rebuild-video-pools.js`, `scripts/maintain-video-pools.mjs` — xóa.
- ❌ `check-video-pools.bat` — xóa.
- ❌ `src/.../data-send/vdsex.txt` — xóa.
- ❌ `loadVideoPool()`, `sendVideoWithFallback()`, `REMOTE_URL_POOL_FILES`, `REMOTE_URL_FILE` — đã gỡ khỏi runtime.

Nếu cần kiểm tra sức khỏe file local, dùng trực tiếp `ffprobe` hoặc `find`/`du` thay vì script URL.

---

## 4. Vận hành Hằng ngày

### Bổ sung video mới

```bash
# Ví dụ đồng bộ folder nội bộ lên VPS
rsync -av --include='*/' --include='*.mp4' --exclude='*' \
  ./local-clips/ user@vps:/path/to/project/video/vdsex/
```

Không cần restart bot — mỗi lượt lệnh/SendTask quét lại.

### Kiểm tra nhanh trên VPS

```bash
ls -lh /path/to/project/video/vdsex/
# Thấy ít nhất một .mp4
ffprobe -v error -show_entries stream=width,height,duration /path/to/project/video/vdsex/clip.mp4
```

### Khi pool thiếu/rỗng

Bot gửi đúng một thông báo:

```
Nguồn video "video/<pool>" đang thiếu hoặc trống. Vui lòng bổ sung file .mp4 rồi thử lại sau.
```

### Restart đúng tiến trình PM2

```bash
pm2 restart <bot-id>
pm2 logs <bot-id> --lines 200 | grep -E "vdsex\.txt|videoHealthStore|sendVideoWithFallback"
# Phải trả về 0 dòng — runtime không còn đọc URL/health.
```

Sau đó gửi thử `!vdsex` trên Zalo và xác nhận file MP4 thực sự được upload + gửi.

---

## 5. Structured Logging tại Runtime

```
[vd-video] stage=scan            pool=vdsex candidates=8 action=scan
[vd-video] stage=prepare         pool=vdsex source_kind=local-directory candidates=8 attempt=1 limit=8
[vd-video] stage=video-upload    pool=vdsex action=done status=200 file=clip-001.mp4 attempt=1 limit=8
[vd-video] stage=thumbnail-upload pool=vdsex action=done status=200 attempt=1 limit=8
[vd-video] stage=delivery        pool=vdsex action=success status=200 file=clip-001.mp4 attempt=1 limit=8
```

Bot chỉ ghi basename, không log đường dẫn máy.

---

## 6. Công cụ đã lược bỏ

| Đường dẫn                                                | Lý do gỡ                        |
| :-------------------------------------------------------- | :------------------------------- |
| `src/.../send-video/video-health-store.js`                | Local pool không cần health store |
| `src/.../send-video/video-health-checker.js`              | URL probing không còn dùng       |
| `src/.../data-send/vdsex.txt`                              | `vdsex` đã chuyển sang local      |
| `scripts/check-video-pools.js`                            | Chỉ phục vụ URL pool             |
| `scripts/rebuild-video-pools.js`                          | Chỉ phục vụ URL pool             |
| `scripts/maintain-video-pools.mjs`                        | Chỉ phục vụ URL pool             |
| `check-video-pools.bat`                                   | Wrapper của các script trên      |

Giữ lại `src/api-zalo/media/video-temp-file.js` (cleanup thumbnail tạm cho local pipeline) và `src/.../send-video/video-media-prepare.js` (ffprobe/ffmpeg wrapper).
