# Báo cáo đối chiếu lệnh Node V3 và Rust mới — 05/11/2026 (Asia/Saigon)

## Kết luận

**Bản Rust chưa tương đương hành vi với Node V3.** Tên lệnh và alias đã được đăng ký đủ, nhưng nhiều nhánh xử lý vẫn khác đáng kể. Một số nhánh trả thông báo thành công hoặc đang xử lý dù chưa thực hiện tác vụ. Đặc biệt, `name` đổi nhầm tên nhóm thay vì tên tài khoản bot; `locmem` có khác biệt ở xác nhận reaction; `phatnguoi`/`checkgiavang` không tra cứu dữ liệu; `gifvd`/`editvideo` không tạo tệp đầu ra; `lamnet`/`4k` không làm nét ảnh.

Đây là **kiểm toán mã nguồn và metadata**, không phải chứng nhận 218 lệnh đã chạy thành công trên Zalo thật. Tôi không sửa runtime hoặc triển khai VPS trong lượt này. [Ma trận 218 lệnh](command-parity-catalog-matrix.csv) ghi từng tên lệnh, module Node, domain Rust và mọi chênh lệch metadata đã kiểm được. Ma trận không dùng chữ “đạt parity” cho một lệnh chỉ vì tên hoặc alias tồn tại.

## Phạm vi và cách kiểm

- Nguồn Node: `src/commands/command-registry.js`, `src/commands/command-router.js`, `src/commands/command.js` và handler mà registry trỏ tới. Nguồn Rust: `rust/crates/mybot-commands/src/catalog.rs`, năm domain handler, `rust/crates/mybot-core/src/pipeline.rs`/`interaction.rs`/`studio.rs`.
- Script [command-parity-catalog-compare.py](command-parity-catalog-compare.py) nạp registry Node thực, phân tích 218 `CommandSpec` Rust, rồi sinh CSV. Nó so từng lệnh về alias, quyền, phạm vi chat, phạm vi instance, lane, cooldown, minArgs, DB, secret, runtime dependency và cờ high risk.
- Graph codebase được lập chỉ mục trong lượt này. `check_index_coverage` báo nhiều file `metadata_changed`/`coverage_unavailable`; các kết luận trọng yếu dưới đây được đối chiếu lại bằng đọc mã nguồn trực tiếp. Không suy diễn sự vắng mặt từ graph.
- Working tree vốn đã có nhiều thay đổi chưa commit; Rust là thư mục untracked. Kết luận chỉ áp dụng cho snapshot tại thời điểm đọc. Không có phiên Zalo/VPS hoặc khóa API để xác nhận hành vi live.

## Kết quả toàn bộ catalog

| Hạng mục | Node V3 | Rust mới | Nhận xét |
|---|---:|---:|---|
| Lệnh chính | 218 | 218 | Đủ tên; chưa chứng minh logic |
| Alias | 181 | 181 | Danh sách alias khớp theo từng lệnh |
| Lookup key | 399 | 399 | Bằng chứng đăng ký |
| Quyền/phạm vi chat/phạm vi instance/cooldown mặc định | 218 khớp | 218 khớp | Metadata tĩnh; runtime có nhánh riêng |
| Lane thực thi khác | 91 lệnh | 91 lệnh | Có tác động vì Rust dùng `spec.lane` tại `pipeline.rs:1252-1258` |
| `minArgs` khác | 38 lệnh | 38 lệnh | Node từ chối tại `command-router.js:358-359`; Rust dùng `spec.min_args` tại `pipeline.rs:1123-1135` |
| `requiresDb` khác | Node false cả 218 | Rust true cả 218 | Ở Rust hiện thấy dùng để mô tả Studio (`studio.rs:1201,1274`), chưa thấy gate tương ứng trong `pipeline.rs`; chủ yếu là metadata sai lệch, chưa kết luận nó chặn runtime |
| Khai báo secret khác | 12 lệnh | 12 lệnh | Node có gate `requiredConfig`; Rust catalog để rỗng, dù một số handler tự xử lý lỗi API |
| Runtime dependency khác | 4 lệnh | 4 lệnh | `editvideo`, `giftext`, `gifvd`, `sendresourcesaudio`: Node yêu cầu `ffmpeg`; Rust catalog không khai báo |
| Cờ high risk khác | 9 lệnh | 9 lệnh | Cần kiểm riêng chính sách; không đồng nghĩa 9 lệnh đang bị mở quyền |

Các nhóm Rust thực tế trong catalog: Admin/Group 63, AI/Crawler 32, Media 40, Moderation 30, SaaS/Utilities 53. Comment ở `mybot-commands/src/lib.rs:3-8` ghi 59 và 57 cho hai nhóm tương ứng, nên số liệu trong comment không nên dùng làm báo cáo coverage.

## Chênh lệch hành vi đã xác nhận

| Ưu tiên | Lệnh | Node V3 | Rust mới | Tác động |
|---|---|---|---|---|
| P0 | `name` và 10 alias | Node yêu cầu admin rồi đổi **tên tài khoản bot** bằng `changeAccountSetting`; `myaccount`/`myacc` đọc thông tin; `mysetting` trả hướng dẫn; alias avatar gọi `changeAccountAvatar` (`account.js:40-121`). | Rust bỏ qua alias khi vào `spec.name == "name"`, lấy **tham số đầu tiên** và gọi `change_group_name` (`admin_and_group.rs:1701-1713`). Spec ghi quyền `All`, handler không có kiểm admin bổ sung. | Sai đối tượng và mất toàn bộ nhánh alias; người thường trong nhóm có thể khiến bot thử đổi tên nhóm nếu API cho phép. |
| P0 | `locmem` | Người xác nhận là **bất kỳ** adminLevelHigh hiện hành; kiểm tra quyền lúc reaction (`locmem-service.js:509-535`). | `send_reaction_menu` đặt `allowed_sender_uid` là UID người gọi (`studio.rs:344-387`), nên admin cao khác không xác nhận được. Callback `locmem.rs:527-545` bỏ qua `_react`; `InteractionEngine::try_handle_reaction` chỉ kiểm UID/icon, không đọc lại quyền (`interaction.rs:797-862`). | Trái lời nhắn “bất kỳ QTV cấp cao”; người gọi bị thu quyền sau khi mở phiên vẫn có thể xác nhận. |
| P0 | `locmem` lỗi gửi xác nhận | Node chỉ tạo pending khi `sendMessage` trả `serverMsgId` hợp lệ (`locmem-service.js:425-445`). | Rust thêm group vào `PENDING_LOCMEM_GROUPS` **trước** `send_reaction_menu` (`locmem.rs:516-518,699-707`). Nếu gửi thất bại, `?` thoát và không xóa pending. | Có thể khóa `locmem` của nhóm cho tới khi tiến trình khởi động lại. |
| P0 | `phatnguoi` | Chuẩn hóa/kiểm biển số, gọi `getPhatNguoiInfo`, trả vi phạm hoặc không vi phạm (`phatnguoi.js:210-321`). | Chỉ render `CardKind::SystemConfig` với title và query (`ai_and_crawlers.rs:486-501`); không gọi nguồn tra cứu. | Tạo thẻ trông như kết quả nhưng không có dữ liệu phạt nguội. |
| P0 | `checkgiavang` | Chọn loại vàng, `fetchGoldPrice`, dựng ảnh theo giá nhận được (`check-gia-vang.js:160-207`). | Render `GoldPriceCard` với title/query, không fetch giá (`ai_and_crawlers.rs:486-501`). | Không thể coi thẻ là giá vàng hiện tại. |
| P1 | `gifvd`, `editvideo` | Tải media, FFmpeg chuyển GIF/cắt video, kiểm file, gửi media (`gifvd.js:15-139`; `edit-video.js:17-154`). | Khi có quote, chỉ trả `⏳ Đang xử lý video bằng ffmpeg...` (`media_sticker_pools.rs:528-537`). | Không tạo/gửi sản phẩm; thông báo xử lý là kết thúc handler. |
| P1 | `lamnet`, `4k` | Gọi API làm nét, lấy ảnh kết quả rồi gửi (`enhance-image.js:91-129,176-231`; `nqduan-phase5.js:491-546`). | Tải URL ảnh gốc, đọc bytes đó và gửi lại với caption “Đã làm nét ảnh thành công” (`media_sticker_pools.rs:539-557`). | Ảnh không được làm nét nhưng người dùng nhận thông báo thành công. |
| P1 | `image`, `pinterest` | Tìm ảnh, tải và gửi đính kèm; Pinterest có nhánh số lượng và nguồn dự phòng (`google-image.js:197-266`; `pinterest-service.js:396-492`). | Cùng nhánh với `google`: gọi `search_web_snippets` rồi gửi danh sách text (`ai_and_crawlers.rs:408-435`). | Mất đầu ra ảnh và logic riêng của Pinterest. |
| P1 | `google-search-ai`, `googlesearchai`, `analysis-image`, `genminiv1` | Registry Node trỏ tới các handler khác nhau: Google search, Google search AI, phân tích ảnh/Gemini. | Gộp chung với `gemini` vào `ask_gemini(query, quoted_img)` (`ai_and_crawlers.rs:18-42`). | Nguồn dữ liệu, yêu cầu ảnh, định dạng đầu ra và lỗi không còn 1:1. Cần fixture riêng cho từng lệnh. |
| P1 | `stickerzalo`, `stkmeme` | `stickerzalo` nhận ID số và gọi `api.sendSticker` (`stickerlocal.js:6-64`); `stkmeme` dùng handler Tenor riêng theo registry. | Cùng nhánh `zalo.get_stickers(keyword)`, chỉ gửi kết quả dạng text (`media_sticker_pools.rs:559-571`). | Không gửi sticker như lệnh Node. |
| P1 | `cmdadd list` | Render danh sách thành ảnh, fallback sang text nhiều phần (`cmdadd-command.js:102-175`). | Tạo danh sách text (`saas_fun_utilities.rs:1491-1536`). | Khác trải nghiệm, định dạng và TTL. |
| P1 | `cmdadd` media | Node resolve media quote, lưu file cho lệnh tùy chỉnh (`cmdadd-command.js:49-100`; `custom-commands/media.js`). | Rust lưu metadata URL hoặc attach quote trong JSON; không tải/kiểm/lưu file media lúc tạo (`saas_fun_utilities.rs:1661-1759`). | Lệnh có media có thể lỗi khi URL hết hạn; chưa chứng minh cùng kiểu gửi lại. |
| P1 | `setcmd` | `on/off`, `p`, `cd` ghi `command.json`; `cd` sai số bị từ chối (`set-command.js:32-225`). | Ghi Studio bot layer, `cd` sai số rơi về **5 giây** rồi báo thành công; nhánh `p`/`cd` không kiểm tên lệnh như `on/off` (`admin_and_group.rs:358-464`). | Cấu hình sai vẫn được xác nhận; đường lưu trữ và hiệu lực khác. Lưu ý Node cũng ưu tiên quyền registry khi resolve (`command.js:194-203`), nên không khẳng định `p` của Node luôn hạ quyền thành công. |
| P1 | `restart`/`rs` | Node gửi thông báo, yêu cầu restart bot rồi lên lịch thoát tiến trình để supervisor khởi động lại (`util.js:87-101`). | Rust chỉ trả hướng dẫn dùng Dashboard hoặc `systemctl restart mybotd` (`admin_and_group.rs:1714-1719`). | Lệnh chat không còn thao tác restart. |
| P1 | `locmem` giới hạn quét | Node có deadline nội bộ 45 giây và kiểm trước khi tạo xác nhận (`locmem-service.js:213-226,385-445`). | Rust không có deadline quét tương đương trong `execute_locmem_command` (`locmem.rs:317-713`); lỗi flush/activity sau preview bị nuốt (`locmem.rs:380-381,571-576`). | Có thể giữ phiên lâu hoặc dùng dữ liệu hoạt động chưa ghi; cần test tải và lỗi DB. |
| P2 | Trả lời text/TTL nhiều lệnh | Handler Node đặt TTL riêng, ví dụ `setcmd` 300000ms, `phatnguoi` 30000–1800000ms. | `send_text_reply` qua pipeline luôn dùng 60000ms (`pipeline.rs:1277-1292`); media helper mặc định 180000ms (`mybot-commands/src/lib.rs:153-164`). | Dù nội dung gần giống, thời gian tồn tại/kiểu quote vẫn khác. |

## Những phần đã có, không cần làm lại từ đầu

- Rust có registry đủ 218/181; các trường quyền, scope, instance và cooldown mặc định khớp catalog Node theo phép so sánh tự động. Đó là **coverage tên và metadata**, chưa phải 218 handler tương đương.
- `setcmd on/off` đã ghi đúng `operation.enabled` mà pipeline đọc (`admin_and_group.rs:379-390`; `pipeline.rs:1056-1075`). Nghi vấn cũ “ghi `active` nên không có tác dụng” không còn đúng ở snapshot này.
- `cmdadd` mới đã ghi `content`, `responseContent`, `text`, là các khóa pipeline đọc (`saas_fun_utilities.rs:1739-1759`; `pipeline.rs:1421-1425`). Nghi vấn cũ “`replyText` không được đọc” không còn đúng.
- `locmem` Rust đã có mốc 7 ngày ICT, coverage gate, preview, reaction chờ 120 giây, lấy lại group info và lọc lại thành viên (`locmem.rs:377-713`). Các lỗi ở trên là khác biệt cụ thể trong luồng xác nhận và xử lý lỗi.

## Cách đọc ma trận 218 dòng

Mỗi dòng trong CSV là một lệnh chính, kèm alias, module Node, domain Rust, dòng `CommandSpec`, quyền/scope/lane/minArgs/cooldown của hai bản, chênh lệch khác và ghi chú hành vi. `node_source` là module lazy handler tính từ `src/commands/command-registry.js`; `rust_domain` trỏ tới một trong năm file domain tại `rust/crates/mybot-commands/src/`. CSV **không** đánh giá tự động hiệu quả API hoặc chất lượng đầu ra. Có 19 lệnh chính với chênh lệch hành vi được xác nhận trong báo cáo; các dòng còn lại ghi rõ chưa xác nhận tương đương. 91 chênh lệch lane, 38 minArgs và 12 secret có tên cụ thể trong từng dòng.

Các lệnh không xuất hiện trong bảng “chênh lệch hành vi đã xác nhận” vẫn có handler Rust, nhưng **chưa được kết luận tương đương logic**. Bài test `phase0_behavioral_matrix.rs:1058-1114` gọi trực tiếp mọi handler với input mặc định nhằm kiểm tra không panic; điều kiện chỉ yêu cầu ít nhất 170/218 handler trả `Handled`, nên không kiểm chức năng riêng, DB/Zalo/API, media, TTL hay kết quả thật của cả 218.

## Thứ tự hoàn thiện và tiêu chí nghiệm thu

1. **Chặn kết quả giả/sai và lệnh tác động nhầm:** `name`/alias phải đổi đúng tài khoản bot với quyền tương ứng; `phatnguoi`, `checkgiavang`, `lamnet`, `4k` phải dùng nguồn dữ liệu/ảnh thật như Node; thiếu API hoặc lỗi fetch phải báo lỗi rõ, không tạo thẻ/ảnh mang nhãn thành công. `gifvd`, `editvideo` phải tạo và gửi file thật hoặc trả lỗi, không kết thúc ở thông báo “đang xử lý”.
2. **Sửa `locmem` trước khi dùng live:** cho phép bất kỳ adminLevelHigh hiện hành xác nhận đúng ❤️ trên đúng message trong 120 giây; recheck quyền ở callback; dọn pending khi gửi/đăng ký reaction lỗi; giữ 7/7 ngày, preview, loại trừ và kiểm thành viên lại; thêm deadline và xử lý lỗi dữ liệu fail closed.
3. **Khôi phục lệnh đầu ra media/search:** `image`, `pinterest`, `stickerzalo`, `stkmeme`, các lệnh AI/search đã gộp phải có fixture riêng về input, API gọi, file gửi, caption, lỗi và TTL.
4. **Đồng bộ contract chung:** xử lý 91 lane và 38 minArgs theo chủ đích; khai báo dependency/secret chính xác; xác định rõ `setcmd` ghi nơi nào và hiệu lực tức thời ra sao; test `cmdadd` media sau khi URL gốc hết hạn.
5. **Kiểm thử 218 lệnh theo dữ liệu thật:** với mỗi dòng CSV, ít nhất một fixture thành công và các nhánh thiếu input, sai quyền/scope, lỗi dependency/API, DB effect, đầu ra Zalo (text/ảnh/video/sticker/TTL/mention/quote). Sau test local, thử DM, nhóm, bot chính/phụ, reconnect và reaction trên phiên Zalo thật. Chỉ đánh dấu đạt parity khi có bằng chứng cho từng nhánh cần thiết.

## Giới hạn của kết luận

Kiểm toán này tìm được sai khác chắc chắn ở các nhánh được trích dẫn và đối chiếu metadata của **toàn bộ** 218 lệnh. Nó chưa khẳng định mọi nhánh của mọi lệnh còn lại đã được so từng điều kiện với Node: các handler Node phân tán trên nhiều module, còn Rust gộp nhiều lệnh vào năm hàm lớn. Không chạy live Zalo, API bên ngoài, scheduler dài hạn hay VPS. Không lấy việc có catalog, không panic và test local làm chứng nhận sản phẩm hoàn tất.
