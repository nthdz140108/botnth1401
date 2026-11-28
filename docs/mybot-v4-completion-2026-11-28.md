# Bot con mybot và dashboard V4 — 2026-11-28

## Phạm vi và kết quả

- Giữ Node vận hành bot và Rust dashboard V4. Bot mới dùng bot_<uuid>, giữ khóa bot cũ; tài khoản, chủ Main và admin trong bot con tách riêng.
- QR/cookie/cập nhật dùng chung credential normalizer và worker đăng nhập riêng, xác minh tài khoản trước lưu; QR60s từ khi hiển thị, verify30s riêng, hủy trong khởi tạo rollback. QR dashboard là draft trong RAM tới khi verify thành công.
- Đăng nhập lại giữ cấu hình/hạn dùng/chủ. Chặn Main/trùng tài khoản/sai tài khoản/khác chủ; credential mới có hiệu lực sau restart riêng.
- Registry ghi có khóa giữa tiến trình, fail-closed khi bận/hỏng, journal riêng tư0600 từ lúc tạo; phục hồi trước mọi writer. Dedupe cũng khóa. Cổng kiểm tra bind thật.
- Readiness cần botKey/tài khoản/PID/listener. Token operation lưu bền để stop/delete hủy start giữa Main và bridge. Trial/paid activation bắt đầu sau readiness; rollback không ghi đè thay đổi của bot khác hoặc thao tác cấu hình mới hơn. desiredStatus giữ ý định dừng qua reboot.
- Hybrid config chuyển về dịch vụ Node; operation có endpoint theo dõi. QR modal không reset khi fleet refresh. Cấp admin dùng danh sách bạn bè gắn với đúng process/tài khoản của bot con.
- Migration scripts/migrate-bot-management-v4.mjs mặc định dry-run; --apply có backup, giữ khóa/chủ/hạn/trial/config, đánh dấu pending khi thiếu bằng chứng. Không nhập bot từ file rơi/SQLite.

## Xác minh

- Lượt full suite: 2.420 tests; 2.363 pass,34 fail,23 skip. Chạy với giới hạn90s mỗi file vì timer leak QR nền; leak đã sửa.
- Sau sửa hồi quy: suite liên quan677 tests,676 pass,0 fail,1 skip (mode0600 cần Linux). Các fixture cũ theo hành vi tự phục hồi bot dừng/nhận port mở/UID path đã cập nhật sang yêu cầu mới.
- Root/runtime/registry tests63,62 pass,1 skip; Rust mybot-dashboard7/7; npm run lint và npm run dashboard:build pass.
- Đã chạy riêng118 tests trên checkout gốc7300554:96 pass,22 fail.22 lỗi nền ngoài phạm vi liệt kê bên dưới; không tuyên bố full suite xanh.
- Review phát hiện các blocker về cancellation bền, dedupe, crash recovery, quyền journal, QR draft, admin binding và rollback; đã sửa và có kiểm thử hồi quy.

## Triển khai và nghiệm thu

VPS trước cập nhật:3327e71; chỉ có admin trong registry. Backup trước cập nhật: /opt/mybot/backups/management-v4-20261128. Báo cáo đối chiếu release không tìm thấy bot rơi cần chuyển.

Đã push nhánh codex/locmem-recovery lên nthdz140108/botnth1401. VPS đã chuyển release11013a8d4a8fdca9f0ee5f179c9cae2e85f24062 bằng updater (bản triển khai chính f90fce6 build Rust/dashboard thành công; patch11013a8 chuẩn hóa migration Main một lần).

Xác minh sau cập nhật: Main PM2 online, PID và tài khoản khớp registry, listenerConnected=true; Node bridge health=ok, GET profile và endpoint operation phản hồi đúng; dashboard HTTP200 phục vụ bundle index-psyjR9uY.js mới. Không coi những probe này là đã xác nhận gửi/nhận tin nhắn Zalo thật.

38/38 kiểm thử Linux chạy qua trên source release với dữ liệu tạm riêng, gồm quyền journal/credential0600, split runtime root, cancellation giữa hai Node process và rollback. Hai lần chạy migration --apply sau cập nhật đều changed=[]; đối chiếu backup xác nhận giữ khóa/chủ/hạn dùng; không có journal dở cần phục hồi.

Bổ sung triển khai: bộ đóng gói bỏ qua dashboard/dist sinh tự động, build từ dashboard/src trong staging trước khi Rust embed SPA;25 kiểm thử updater qua,7 case theo Linux bị skip trên Windows. Sửa bổ sung handshake/reload/PM2/trial dùng runtime root:19 kiểm thử qua. Regression Main migration mới qua cùng bộ registry10 pass/1 Windows-only permission skip (đã kiểm tra lại trên Linux). Updater chuyển release/rollback, giữ shared storage; rollback mã bằng node deploy/incremental-vps.mjs --rollback. Không khôi phục toàn registry từ backup khi có thay đổi mới; dùng journal theo thao tác.

Theo lựa chọn của người dùng: triển khai trước, nghiệm thu tài khoản thử cùng người dùng sau. Chưa xác nhận tạo bot QR/cookie thật, nhận/trả lời chat riêng+nhóm, đổi credential thật và reboot thật. Không coi daemon/port/PM2 online hay unit test là nghiệm thu Zalo.

## 22 lỗi nền đã xác minh ở7300554

- `tests\anti-service\anti-zalo-regression-fixes.test.js:788:1` — 10a. anti-bot ignores standard Zalo human disappearing message TTL presets while catching short bot TTLs (1.9816ms)
- `tests\auto-download-youtube.test.js:15:1` — YouTube autodownload owns its single confirmation reaction (8.9796ms)
- `tests\auto-download-youtube.test.js:71:1` — TikTok autodownload reacts before requesting video data (2.1184ms)
- `tests\command-dependency.test.js:6:1` — gemini returns MISSING_DEPENDENCY without invoking its handler (7.5803ms)
- `tests\command-dependency.test.js:48:1` — spamjoin retains a critical-risk registry guard without provider retries (0.9483ms)
- `tests\commands\commands-services-regression-fixes.test.js:213:1` — active-bot: restricts privatebot/nameserver/rs to adminLevelHigh and matches exact rs token (6.9384ms)
- `tests\free-form-selection-youtube-tiktok.test.js:437:1` — youtube consume enforces the 30 minute limit using duration in seconds for non-admins (18.7693ms)
- `tests\free-form-selection-youtube-tiktok.test.js:543:1` — youtube consume classifies download/upload/send/unavailable/auth/runtime/timeout errors (6.1021ms)
- `tests\free-form-selection-youtube-tiktok.test.js:752:1` — youtube search caption explains direct number sending without quote (4.4828ms)
- `tests\latency-tracker.test.js:5:1` — latency tracker records all required phases and computes percentiles (7.8769ms)
- `tests\phase-4-new-zalo-apis.test.js:217:1` — new HHH Zalo APIs surface ZaloApiError when the backend reports an error (7.7564ms)
- `tests\phase-5-contract.test.js:50:1` — Phase 5 lazy handlers load the expected exports with the expected arguments (3.4168ms)
- `tests\phase-5-contract.test.js:146:1` — input-required Phase 5 commands reject missing arguments without invoking overrides (1.5283ms)
- `tests\phase-6-contract.test.js:28:1` — Phase 6 lazy adapters preserve existing handler exports and arguments (6.4862ms)
- `tests\phase-7-contract.test.js:37:1` — Phase 7 lazy handlers load the expected exports and arguments (3.1227ms)
- `tests\phase-8-contract.test.js:10:1` — Phase 8 lazy handlers load the expected exports and arguments (2.6043ms)
- `tests\phase-9-contract.test.js:36:1` — Phase 9 lazy adapters preserve handler exports and argument order (2.2614ms)
- `tests\reply-workflow-access.test.js:39:1` — group reply dispatch uses pre-command message eligibility (4.0732ms)
- `tests\restart-supervisor-transaction.test.js:89:1` — restartSelf on child bot requests restart and exits with RESTART_EXIT_CODE=10 (8.7379ms)
- `tests\terminal-log.test.js:73:1` — uses ansi colors only when enabled and never when NO_COLOR or redirected (1.4468ms)
- `tests\terminal-log.test.js:103:1` — allows managed listener pipes to color when the supervising terminal opted in (0.7666ms)
- `tests\terminal-log.test.js:120:1` — colors event branches and labels by field tone for easier scanning (1.0076ms)

## Hotfix QR readiness — 2026-11-28

Trên VPS tái hiện Main PM2 online, runtime đúng PID và listenerConnected=true nhưng registry.admin.pid=null. Gate QR cũ dùng riêng PID cache nên trả process_stopped. Bản vá dùng PID hiện tại từ PM2 và shared readiness để kiểm tra botKey/tài khoản/PID/listener; vẫn chặn cookie chết, sai danh tính và API chưa sẵn sàng. Không sửa tay PID registry để vượt gate.

Hai regression mới đã RED→GREEN;68 kiểm thử QR/runtime liên quan qua, ESLint và diff check qua. Review scoped xác nhận phù hợp lỗi PID trống/cũ. Nghiệm thu nhận/quét QR thật trong chat cần người dùng xác nhận; không suy ra từ unit test.
