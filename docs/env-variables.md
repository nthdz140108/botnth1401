# Biến Môi Trường Bổ Sung & Tùy Chọn (MYBOT V3/V4)

Tài liệu này liệt kê các biến môi trường AI, Media và API tùy chọn cho 219 lệnh (mặc định phần lớn các lệnh tiện ích như `thoitiet`, `dich`, `google`, `checkgiavang`, `reverse`, `qrheart`, `lamnet`, `4k`, `spotify`, `download` đã tự hoạt động **không cần API key**).

## 1. AI & Tạo Ảnh / Sticker
- `GEMINI_API_KEYS` hoặc `GEMINI_API_KEY`: Danh sách API key Google Gemini (phân tách bằng dấu phẩy) cho `gemini`, `analysis-image`, `genminiv1`, `autoreply`, `aisearch`.
- `KIRA_API_KEY`: API key KiraAI cho `gpt`, `deepseek`, `dich` (chế độ dịch AI), `aisearch`.
- `KIRA_BASE_URL`: Endpoint KiraAI (mặc định `https://kiraai.vn/v1`).
- `KIRA_MODEL`: Model mặc định cho `gpt` qua KiraAI.
- `KIRA_DEEPSEEK_MODEL`: Model ưu tiên cho `deepseek` qua KiraAI (mặc định `deepseek-chat`).
- `OPENAI_API_KEY` / `OPENAI_BASE_URL`: Tùy chọn gọi trực tiếp OpenAI tương thích cho `gpt`.
- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`: Tùy chọn gọi trực tiếp DeepSeek cho `deepseek`.
- `HF_TOKEN`: Hugging Face Inference token cho `gemini make`, `create-image`, `createimageai`, `sticker ai` và tầng AI upscale của `lamnet`.
- `HF_STICKER_T2I_MODEL` / `HF_STICKER_I2I_MODEL`: Tùy chỉnh model tạo/biến đổi ảnh Hugging Face.
- `HF_UPSCALE_MODEL`: Tùy chọn model AI upscale ảnh cho `lamnet` (nếu bỏ trống dùng engine `sharp` Lanczos3 4K offline).

## 2. Tra Cứu & Game (Tùy chọn)
- `PHATNGUOI_API_URL`: Endpoint JSON tra cứu phạt nguội ưu tiên trước khi fallback sang crawler `csgt.vn`.
- `FF_INFO_API_URL`: Endpoint tra cứu thông tin UID Free Fire tùy chỉnh cho `!ff`.
- `FF_EMOTE_API_URL`: Endpoint server bot hành động Free Fire cho `!emote` (nếu để trống, `!emote` hiển thị bảng tra cứu 20 mã hành động Evo LV7).
- `LQ_CHECK_API_URL`: Endpoint tự chủ của chủ bot cho `!checklq` (chỉ hoạt động trong chat riêng `DirectMessage`, tự động ẩn thông tin nhạy cảm).

## 3. Công Cụ Media Tự Động (`.runtime/bin`)
Chạy lệnh sau để tự động kiểm tra/tải `ffmpeg`, `ffprobe`, `yt-dlp` vào `.runtime/bin/`:
```bash
npm run setup:media
npm run seed:resources
```
