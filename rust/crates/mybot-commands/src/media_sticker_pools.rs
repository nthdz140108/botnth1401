//! Media URL Pools, Sticker Studio, Animated GIFs, Voice TTS & Resource Sharing (40 Commands).

use mybot_core::{CommandContext, CommandError, CommandOutcome, CommandSpec};
use mybot_gfx::CardKind;
use mybot_services::build_google_tts_url;
use mybot_types::MessageContent;
use serde_json::{Value, json};
use zalo_sdk::apis::messaging::VideoSendRequest;

use crate::{CommandRuntimeBundle, send_local_bytes_reply, send_text_reply};

fn extract_media_url_from_context(ctx: &CommandContext) -> Option<String> {
    // 1. Quoted attachment
    if let Some(ref q) = ctx.message.quote {
        if let Some(ref attach) = q.attach {
            for key in &["hdUrl", "href", "oriUrl", "normalUrl", "thumbUrl", "fileUrl", "url"] {
                if let Some(val) = attach.get(*key).and_then(Value::as_str) {
                    let trimmed = val.trim();
                    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
        for token in q.msg.split_whitespace() {
            if token.starts_with("http://") || token.starts_with("https://") {
                return Some(token.to_string());
            }
        }
    }

    // 2. Direct message content
    match &ctx.message.content {
        MessageContent::Photo { url, .. } | MessageContent::Video { url, .. } => {
            if url.starts_with("http://") || url.starts_with("https://") {
                return Some(url.clone());
            }
        }
        _ => {}
    }

    // 3. Raw args tokens
    for token in ctx.raw_args_text.split_whitespace() {
        if token.starts_with("http://") || token.starts_with("https://") {
            return Some(token.to_string());
        }
    }

    None
}

pub(crate) async fn process_enhance_image(
    rt: &CommandRuntimeBundle,
    img_url: &str,
) -> Result<Vec<u8>, CommandError> {
    // 1. Thử gọi API hoangdev enhance nếu có API key
    let api_key = rt
        .ai
        .resolve_secret("HOANGDEV_API_KEY")
        .unwrap_or_default();

    if !api_key.trim().is_empty() {
        let api_endpoint = format!(
            "https://hoangdev.io.vn/media/lamnet?input_url={}&apikey={}",
            urlencoding::encode(img_url),
            urlencoding::encode(&api_key)
        );
        if let Ok(resp) = rt
            .crawlers
            .http()
            .get(&api_endpoint)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
        {
            if let Ok(json_res) = resp.json::<Value>().await {
                if json_res["success"].as_bool().unwrap_or(false) {
                    if let Some(res_url) = json_res["url"].as_str() {
                        if let Ok(scratch) = rt.crawlers.download_media_to_ram(res_url, false).await {
                            if let Ok(bytes) = scratch.read_bytes() && !bytes.is_empty() {
                                return Ok(bytes);
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Fallback upscale cục bộ Lanczos3 2x + unsharp mask filter thực tế
    let scratch = rt
        .crawlers
        .download_media_to_ram(img_url, false)
        .await
        .map_err(|e| CommandError::Internal(format!("Không thể tải ảnh: {e}")))?;
    let orig_bytes = scratch
        .read_bytes()
        .map_err(|e| CommandError::Internal(e.to_string()))?;

    let img = image::load_from_memory(&orig_bytes)
        .map_err(|e| CommandError::Internal(format!("Không giải mã được ảnh đầu vào: {e}")))?;

    let (w, h) = (img.width(), img.height());
    let target_w = (w * 2).clamp(2, 4096);
    let target_h = (h * 2).clamp(2, 4096);

    let upscaled = img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3);
    let rgba = upscaled.to_rgba8();
    let sharpened_buf = image::imageops::unsharpen(&rgba, 1.8, 3);

    let mut out_bytes = Vec::new();
    image::DynamicImage::ImageRgba8(sharpened_buf)
        .write_to(
            &mut std::io::Cursor::new(&mut out_bytes),
            image::ImageFormat::Png,
        )
        .map_err(|e| CommandError::Internal(format!("Không mã hóa được ảnh PNG: {e}")))?;

    Ok(out_bytes)
}

pub async fn execute_media_pool_command(
    spec: &'static CommandSpec,
    ctx: CommandContext,
    rt: &CommandRuntimeBundle,
) -> Result<CommandOutcome, CommandError> {
    match spec.name {
        "girl" | "boy" | "cosplay" | "anime" => {
            if ctx.args.first().is_some_and(|a| a.eq_ignore_ascii_case("map")) {
                let counts = rt.video_pools.pool_counts();
                let summary: Vec<String> = counts
                    .iter()
                    .map(|(k, v)| format!("• `{k}`: {v} link"))
                    .collect();
                return send_text_reply(
                    &ctx,
                    &format!("🗂️ Danh mục kho media khả dụng:\n{}", summary.join("\n")),
                )
                .await;
            }
            let category = ctx
                .args
                .first()
                .map(String::as_str)
                .unwrap_or(spec.name);
            if let Some(url) = rt.video_pools.pick_url(category) {
                let mut media_sent = false;
                if let Some(ref zalo) = ctx.zalo {
                    match zalo
                        .send_image(
                            &url,
                            Some(&url),
                            720,
                            1080,
                            &format!("📸 Bộ sưu tập `{}`", spec.name),
                            &ctx.message.thread_id,
                            ctx.message.thread_type,
                            0,
                        )
                        .await
                    {
                        Ok(_) => media_sent = true,
                        Err(err) => {
                            tracing::warn!(cmd = %spec.name, error = %err, "Pool send_image failed; falling back to URL");
                        }
                    }
                }
                return Ok(CommandOutcome::Handled {
                    summary: format!("sent pool image `{}` -> {url}", spec.name),
                    reply_text: if media_sent { None } else { Some(url) },
                    custom_ttl_ms: None,
                });
            }
            send_text_reply(&ctx, "⚠️ Kho ảnh hiện đang bảo trì hoặc trống.").await
        }
        "vdgirl" | "vdsexy" | "vdsex" | "vdcos" | "vdanime" | "vdboy" | "vdvuto" | "vdchill"
        | "vdsad" | "vdtet" => {
            if let Some(url) = rt.video_pools.pick_url(spec.name) {
                let mut media_sent = false;
                if let Some(ref zalo) = ctx.zalo {
                    match zalo
                        .send_video(
                            &VideoSendRequest {
                                video_url: url.clone(),
                                thumbnail_url: None,
                                caption: format!("🎬 Video `{}`", spec.name),
                                mentions: Vec::new(),
                                duration_ms: 15_000,
                                width: 720,
                                height: 1280,
                                file_size: 0,
                                ttl_ms: 0,
                                video_already_uploaded: false,
                            },
                            &ctx.message.thread_id,
                            ctx.message.thread_type,
                        )
                        .await
                    {
                        Ok(_) => media_sent = true,
                        Err(err) => {
                            tracing::warn!(cmd = %spec.name, error = %err, "Pool send_video failed; falling back to URL");
                        }
                    }
                }
                return Ok(CommandOutcome::Handled {
                    summary: format!("sent pool video `{}` -> {url}", spec.name),
                    reply_text: if media_sent { None } else { Some(url) },
                    custom_ttl_ms: None,
                });
            }
            send_text_reply(&ctx, "⚠️ Kho video hiện đang trống.").await
        }
        "datavideo" => {
            let raw = ctx.raw_args_text.trim();
            let parts: Vec<&str> = if raw.contains('|') {
                raw.split('|').map(str::trim).collect()
            } else {
                raw.split_whitespace().collect()
            };

            let first_token = parts.first().copied().unwrap_or("");
            if first_token.eq_ignore_ascii_case("list") || first_token.eq_ignore_ascii_case("show") {
                if parts.len() >= 2 {
                    let file_name = parts[1];
                    let count = rt.video_pools.count_urls(file_name);
                    send_text_reply(
                        &ctx,
                        &format!("📁 File kho `{file_name}` chứa tổng cộng {count} link."),
                    )
                    .await
                } else {
                    let files = rt.video_pools.list_pool_files();
                    if files.is_empty() {
                        send_text_reply(&ctx, "📂 Kho video hiện chưa có file nào.").await
                    } else {
                        let list = files.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n");
                        send_text_reply(&ctx, &format!("📂 Danh sách file kho video:\n{list}")).await
                    }
                }
            } else if first_token.eq_ignore_ascii_case("add") && parts.len() >= 2 {
                let file_name = parts[1];
                match rt.video_pools.create_category_file(file_name) {
                    Ok(_) => send_text_reply(&ctx, &format!("✅ Đã tạo file `{file_name}` thành công.")).await,
                    Err(e) => send_text_reply(&ctx, &format!("⚠️ Không thể tạo file `{file_name}`: {e}")).await,
                }
            } else if first_token.eq_ignore_ascii_case("remove") && parts.len() >= 2 {
                let file_name = parts[1];
                if parts.len() >= 3 {
                    let url = parts[2];
                    if rt.video_pools.remove_url(file_name, url) {
                        send_text_reply(&ctx, &format!("✅ Đã xóa link khỏi file `{file_name}`.")).await
                    } else {
                        send_text_reply(&ctx, &format!("⚠️ Không tìm thấy link trong file `{file_name}`.")).await
                    }
                } else if rt.video_pools.remove_category_file(file_name) {
                    send_text_reply(&ctx, &format!("✅ Đã xóa file `{file_name}` thành công.")).await
                } else {
                    send_text_reply(&ctx, &format!("⚠️ Không tìm thấy file `{file_name}` để xóa.")).await
                }
            } else if !first_token.is_empty() && (parts.len() >= 2 || ctx.message.quote.is_some()) {
                let file_name = first_token;
                let maybe_url = parts.get(1).copied().map(ToOwned::to_owned).or_else(|| extract_media_url_from_context(&ctx));
                if let Some(url) = maybe_url {
                    let total = rt.video_pools.add_url(file_name, &url);
                    send_text_reply(&ctx, &format!("✅ Đã lưu link vào: {file_name} (tổng: {total} link).")).await
                } else {
                    send_text_reply(&ctx, &format!("⚠️ Vui lòng cung cấp link hoặc reply video để lưu vào `{file_name}`.")).await
                }
            } else {
                let pool_cat = if !first_token.is_empty() { first_token } else { "datavideo" };
                if let Some(url) = rt.video_pools.pick_url(pool_cat).or_else(|| rt.video_pools.pick_url("vdgirl")) {
                    let mut media_sent = false;
                    if let Some(ref zalo) = ctx.zalo {
                        let _ = zalo
                            .send_video(
                                &VideoSendRequest {
                                    video_url: url.clone(),
                                    thumbnail_url: None,
                                    caption: format!("🎬 Video `{pool_cat}`"),
                                    mentions: Vec::new(),
                                    duration_ms: 15_000,
                                    width: 720,
                                    height: 1280,
                                    file_size: 0,
                                    ttl_ms: 0,
                                    video_already_uploaded: false,
                                },
                                &ctx.message.thread_id,
                                ctx.message.thread_type,
                            )
                            .await;
                        media_sent = true;
                    }
                    Ok(CommandOutcome::Handled {
                        summary: format!("sent pool video `{pool_cat}` -> {url}"),
                        reply_text: if media_sent { None } else { Some(url) },
                        custom_ttl_ms: None,
                    })
                } else {
                    send_text_reply(&ctx, &format!("⚠️ Kho video `{pool_cat}` hiện đang trống. Dùng: `{}datavideo list` để xem các file.", ctx.prefix)).await
                }
            }
        }
        "data" => {
            let first_arg = ctx.args.first().map(|s| s.to_ascii_lowercase());
            if first_arg.as_deref() == Some("check") {
                let file_target = ctx.args.get(1).map(String::as_str).unwrap_or("default");
                match rt.video_pools.check_and_clean_pool(file_target, 5).await {
                    Ok(summary) => {
                        if summary.dead == 0 {
                            send_text_reply(
                                &ctx,
                                &format!(
                                    "✅ Tất cả {} links trong file `{}` đều hoạt động tốt.",
                                    summary.alive, summary.category
                                ),
                            )
                            .await
                        } else {
                            send_text_reply(
                                &ctx,
                                &format!(
                                    "📊 Kết quả kiểm tra file `{}`:\n\n✅ Links còn hoạt động: {}\n❌ Links đã xóa: {}\n📁 Đã chuyển link chết sang: removed-links/{}_removed.txt",
                                    summary.category, summary.alive, summary.dead, summary.category
                                ),
                            )
                            .await
                        }
                    }
                    Err(e) => {
                        send_text_reply(
                            &ctx,
                            &format!("⚠️ Không thể kiểm tra file `{file_target}`: {e}"),
                        )
                        .await
                    }
                }
            } else if let Some(category) = ctx.args.first() {
                let maybe_url = ctx.args.get(1).cloned().or_else(|| extract_media_url_from_context(&ctx));
                if let Some(url) = maybe_url {
                    let total = rt.video_pools.add_url(category, &url);
                    send_text_reply(
                        &ctx,
                        &format!("✅ Đã lưu thành công link vào kho `{category}` (tổng: {total} link)."),
                    )
                    .await
                } else {
                    let count = rt.video_pools.count_urls(category);
                    send_text_reply(
                        &ctx,
                        &format!(
                            "📁 File kho `{category}` hiện có {count} link.\n👉 Để thêm link: `{}data {category} <link>` hoặc reply vào video/ảnh.",
                            ctx.prefix
                        ),
                    )
                    .await
                }
            } else {
                let counts = rt.video_pools.pool_counts();
                let total: usize = counts.values().sum();
                let sample_cats: Vec<String> = counts.keys().take(10).map(|s| format!("`{s}`")).collect();
                send_text_reply(
                    &ctx,
                    &format!(
                        "📦 Kho dữ liệu media hiện có {} danh mục với tổng cộng {} đường dẫn.\n🗂️ Danh mục mẫu: {}\n\n💡 Cú pháp:\n• `{}data <tên_file>` (thêm link qua reply video/ảnh)\n• `{}data check <tên_file>` (kiểm tra và lọc link chết)",
                        counts.len(),
                        total,
                        sample_cats.join(", "),
                        ctx.prefix,
                        ctx.prefix
                    ),
                )
                .await
            }
        }
        "giftext" | "giftxt" => {
            let text = if ctx.raw_args_text.trim().is_empty() {
                "MYBOT V4 RUST"
            } else {
                ctx.raw_args_text.trim()
            };
            let gif_bytes = rt
                .gfx
                .render(CardKind::GiftextAnimated, &json!({ "text": text }), None)
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(&ctx, rt, "giftext", "gif", &gif_bytes, "").await
        }
        "voice" | "getvoice" | "truyencuoi" | "tarrot" => {
            let spoken = match spec.name {
                "truyencuoi" => {
                    "Một lập trình viên đi siêu thị, vợ dặn mua một hộp sữa, nếu có trứng thì mua sáu. Anh ấy mang về sáu hộp sữa vì siêu thị có trứng!"
                }
                "tarrot" => {
                    "Lá bài Tarot hôm nay của bạn là The Sun: Năng lượng tích cực, may mắn và thành công rực rỡ đang chờ đón bạn!"
                }
                _ if !ctx.raw_args_text.trim().is_empty() => ctx.raw_args_text.trim(),
                _ => "Xin chào bạn, đây là giọng đọc tự động từ hệ thống MyBot V4 Pure Rust trên Ubuntu.",
            };
            let tts_url = build_google_tts_url(spoken, "vi");
            let mut voice_sent = false;
            if let Some(ref zalo) = ctx.zalo {
                match zalo
                    .send_voice(
                        &tts_url,
                        None,
                        &ctx.message.thread_id,
                        ctx.message.thread_type,
                        0,
                    )
                    .await
                {
                    Ok(_) => voice_sent = true,
                    Err(err) => {
                        tracing::warn!(cmd = %spec.name, error = %err, "TTS send_voice failed; falling back to text");
                    }
                }
            }
            Ok(CommandOutcome::Handled {
                summary: format!("sent voice TTS for `{}`", spec.name),
                reply_text: if voice_sent {
                    None
                } else if ctx.zalo.is_some() {
                    Some(format!("🔊 {spoken}"))
                } else {
                    Some(tts_url)
                },
                custom_ttl_ms: None,
            })
        }
        "poststatus" => {
            let text = ctx.raw_args_text.trim();
            if text.is_empty() {
                return Err(CommandError::MissingArgument(
                    "Vui lòng nhập nội dung status cần tạo ảnh. Ví dụ: !poststatus Hôm nay trời đẹp quá!".into(),
                ));
            }
            let data = json!({
                "author": ctx.message.sender_name,
                "text": text,
                "name": ctx.message.sender_name,
                "timestamp": "Vừa xong",
            });
            let png = rt
                .gfx
                .render(CardKind::StatusPost, &data, None)
                .map_err(|e| CommandError::Internal(e.to_string()))?;
            send_local_bytes_reply(
                &ctx,
                rt,
                "poststatus",
                "png",
                &png,
                &format!("📝 Status của {}: {}", ctx.message.sender_name, text),
            )
            .await
        }
        "sticker" => {
            let quoted_img = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("href").or_else(|| a.get("hdUrl")))
                .and_then(|v| v.as_str());
            if let Some(img_url) = quoted_img {
                match rt.crawlers.download_media_to_ram(img_url, false).await {
                    Ok(scratch) => {
                        match rt.cli_media.convert_to_webp_sticker(scratch.path(), false, 15).await {
                            Ok(webp) => {
                                let webp_bytes = webp.read_bytes().map_err(|e| CommandError::Internal(e.to_string()))?;
                                send_local_bytes_reply(&ctx, rt, "sticker", "webp", &webp_bytes, "🎨 Sticker hoàn tất").await
                            }
                            Err(e) => {
                                send_text_reply(&ctx, &format!("⚠️ Lỗi chuyển đổi sticker: {e}")).await
                            }
                        }
                    }
                    Err(e) => {
                        send_text_reply(&ctx, &format!("⚠️ Không tải được ảnh đính kèm: {e}")).await
                    }
                }
            } else {
                send_text_reply(&ctx, "⚠️ Vui lòng reply hình ảnh cần chuyển thành sticker!").await
            }
        }
        "stickercustom" => {
            let sticker_name = ctx.args.first().map(String::as_str).unwrap_or("").trim();
            let maybe_img = extract_media_url_from_context(&ctx);

            if let Some(img_url) = maybe_img {
                match rt.crawlers.download_media_to_ram(&img_url, false).await {
                    Ok(scratch) => {
                        match rt.cli_media.convert_to_webp_sticker(scratch.path(), false, 15).await {
                            Ok(webp) => {
                                let webp_bytes = webp.read_bytes().map_err(|e| CommandError::Internal(e.to_string()))?;
                                if !sticker_name.is_empty() {
                                    let sticker_dir = ctx.assets_root.join("resources/sticker");
                                    let _ = std::fs::create_dir_all(&sticker_dir);
                                    let safe_name = sticker_name.replace(['/', '\\', '.', '\0'], "_");
                                    let save_path = sticker_dir.join(format!("{safe_name}.webp"));
                                    let _ = std::fs::write(&save_path, &webp_bytes);
                                }
                                send_local_bytes_reply(&ctx, rt, "stickercustom", "webp", &webp_bytes, "🎨 Sticker custom hoàn tất!").await
                            }
                            Err(e) => send_text_reply(&ctx, &format!("⚠️ Lỗi chuyển đổi sticker custom: {e}")).await,
                        }
                    }
                    Err(e) => send_text_reply(&ctx, &format!("⚠️ Không tải được ảnh đính kèm: {e}")).await,
                }
            } else if !sticker_name.is_empty() {
                let sticker_dir = ctx.assets_root.join("resources/sticker");
                let candidate_exts = ["webp", "png", "jpg", "gif"];
                let safe_name = sticker_name.replace(['/', '\\', '.', '\0'], "_");
                let mut found = None;
                for ext in candidate_exts {
                    let path = sticker_dir.join(format!("{safe_name}.{ext}"));
                    if path.exists() && let Ok(bytes) = std::fs::read(&path) {
                        found = Some((ext, bytes));
                        break;
                    }
                }
                if let Some((ext, bytes)) = found {
                    send_local_bytes_reply(&ctx, rt, "stickercustom", ext, &bytes, &format!("🎨 Sticker `{safe_name}`")).await
                } else {
                    send_text_reply(&ctx, "❌ Trong danh sách lưu trữ không có tên sticker này.").await
                }
            } else {
                let sticker_dir = ctx.assets_root.join("resources/sticker");
                let mut stored_files = Vec::new();
                if sticker_dir.is_dir() && let Ok(entries) = std::fs::read_dir(&sticker_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            stored_files.push(stem.to_string());
                        }
                    }
                }
                if !stored_files.is_empty() {
                    stored_files.sort();
                    let list = stored_files
                        .iter()
                        .enumerate()
                        .map(|(i, f)| format!("{}. {f}", i + 1))
                        .collect::<Vec<_>>()
                        .join("\n");
                    send_text_reply(
                        &ctx,
                        &format!(
                            "Đây là những sticker đã lưu trữ:\n{list}\n\n👉 Dùng lệnh: `{}stickercustom <tên sticker>` để gửi sticker, hoặc reply hình ảnh để tạo sticker mới.",
                            ctx.prefix
                        ),
                    )
                    .await
                } else {
                    send_text_reply(
                        &ctx,
                        &format!(
                            "🎨 Sticker Custom:\n• Reply hình ảnh: tạo sticker mới.\n• `{}stickercustom <tên>`: gửi hoặc lưu sticker.",
                            ctx.prefix
                        ),
                    )
                    .await
                }
            }
        }
        "gif" | "gifmeme" => {
            let kw = ctx.raw_args_text.trim();
            if kw.is_empty() {
                if let Some(url) = rt.video_pools.pick_url("gif") {
                    if let Some(ref zalo) = ctx.zalo {
                        let _ = zalo
                            .send_image(
                                &url,
                                Some(&url),
                                480,
                                480,
                                "🎞️ GIF ngẫu nhiên",
                                &ctx.message.thread_id,
                                ctx.message.thread_type,
                                0,
                            )
                            .await;
                    }
                    send_text_reply(&ctx, &format!("🎞️ GIF ngẫu nhiên: {url}")).await
                } else {
                    send_text_reply(&ctx, "🎞️ Kho GIF hiện đang trống. Hãy nhập từ khóa tìm kiếm: !gif [từ khóa]").await
                }
            } else {
                match rt.crawlers.search_media("gif", kw, 1).await {
                    Ok(items) => {
                        if let Some(first) = items.first() {
                            send_text_reply(&ctx, &format!("🎞️ Kết quả GIF cho `{kw}`: {}\n{}", first.title, first.url)).await
                        } else {
                            send_text_reply(&ctx, &format!("🔍 Không tìm thấy GIF cho `{kw}`.")).await
                        }
                    }
                    Err(e) => send_text_reply(&ctx, &format!("⚠️ Không tìm kiếm được GIF: {e}")).await,
                }
            }
        }
        "gifvd" => {
            let quoted_url = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("hdUrl").or_else(|| a.get("href")).or_else(|| a.get("url")))
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned)
                .or_else(|| extract_media_url_from_context(&ctx));

            let Some(video_url) = quoted_url else {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "{}, Vui lòng reply một tin nhắn chứa video! Ví dụ: {}gifvd (kèm video).",
                        ctx.message.sender_name, ctx.prefix
                    ),
                )
                .await;
            };

            let scratch_video = rt
                .crawlers
                .download_media_to_ram(&video_url, false)
                .await
                .map_err(|e| CommandError::Internal(format!("{}, Lỗi khi tải video: {e}", ctx.message.sender_name)))?;

            let gif_scratch = rt
                .cli_media
                .convert_video_to_gif(scratch_video.path(), 10.0, 15, 30)
                .await
                .map_err(|e| CommandError::Internal(format!("{}, Lỗi khi chuyển video thành GIF (FFmpeg): {e}", ctx.message.sender_name)))?;

            let gif_bytes = gif_scratch
                .read_bytes()
                .map_err(|e| CommandError::Internal(e.to_string()))?;

            if gif_bytes.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("{}, File GIF sinh ra rỗng hoặc không hợp lệ.", ctx.message.sender_name),
                )
                .await;
            }

            send_local_bytes_reply(
                &ctx,
                rt,
                "gifvd",
                "gif",
                &gif_bytes,
                &format!("{}, Đây là GIF từ video của bạn!", ctx.message.sender_name),
            )
            .await
        }
        "editvideo" => {
            let quoted_url = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("hdUrl").or_else(|| a.get("href")).or_else(|| a.get("url")))
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned)
                .or_else(|| extract_media_url_from_context(&ctx));

            let Some(media_url) = quoted_url else {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "{}, Vui lòng reply một tin nhắn chứa video hoặc ảnh! Ví dụ: {}editvideo (kèm video hoặc ảnh).",
                        ctx.message.sender_name, ctx.prefix
                    ),
                )
                .await;
            };

            let scratch_media = rt
                .crawlers
                .download_media_to_ram(&media_url, false)
                .await
                .map_err(|e| CommandError::Internal(format!("{}, Lỗi khi tải media: {e}", ctx.message.sender_name)))?;

            let mut start_secs = 0.0f64;
            let mut duration_secs = 10.0f64;
            if let Some(first) = ctx.args.first().and_then(|s| s.parse::<f64>().ok()) {
                start_secs = first.max(0.0);
            }
            if let Some(second) = ctx.args.get(1).and_then(|s| s.parse::<f64>().ok()) {
                duration_secs = second.clamp(1.0, 30.0);
            }

            let is_image = media_url.contains(".jpg")
                || media_url.contains(".jpeg")
                || media_url.contains(".png")
                || media_url.contains(".webp");

            let output_video = if is_image {
                rt.cli_media
                    .image_to_video_mp4(scratch_media.path(), duration_secs, 30)
                    .await
                    .map_err(|e| CommandError::Internal(format!("{}, Lỗi khi chuyển đổi ảnh thành video: {e}", ctx.message.sender_name)))?
            } else {
                rt.cli_media
                    .cut_video_segment_compat(scratch_media.path(), start_secs, duration_secs, 30)
                    .await
                    .map_err(|e| CommandError::Internal(format!("{}, Lỗi khi cắt video (FFmpeg): {e}", ctx.message.sender_name)))?
            };

            let mp4_bytes = output_video
                .read_bytes()
                .map_err(|e| CommandError::Internal(e.to_string()))?;

            if mp4_bytes.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("{}, File video sinh ra rỗng hoặc không hợp lệ.", ctx.message.sender_name),
                )
                .await;
            }

            send_local_bytes_reply(
                &ctx,
                rt,
                "editvideo",
                "mp4",
                &mp4_bytes,
                &format!("[ {} ]", ctx.message.sender_name),
            )
            .await
        }
        "lamnet" | "4k" => {
            let quoted_img = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| {
                    a.get("hdUrl")
                        .or_else(|| a.get("href"))
                        .or_else(|| a.get("oriUrl"))
                        .or_else(|| a.get("normalUrl"))
                        .or_else(|| a.get("thumbUrl"))
                        .or_else(|| a.get("url"))
                })
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned)
                .or_else(|| extract_media_url_from_context(&ctx));

            let Some(img_url) = quoted_img else {
                let prompt = if spec.name == "4k" {
                    "Vui lòng reply vào một tin nhắn chứa ảnh để đặt làm nét!".to_string()
                } else {
                    format!(
                        "Vui lòng reply vào tin nhắn chứa ảnh cần làm nét và dùng lại lệnh {}enhance.",
                        ctx.prefix
                    )
                };
                return send_text_reply(&ctx, &prompt).await;
            };

            match process_enhance_image(rt, &img_url).await {
                Ok(enhanced_bytes) => {
                    let caption = if spec.name == "4k" {
                        format!("@{}\nẢnh 4K của Anh đây", ctx.message.sender_name)
                    } else {
                        format!("[ {} ]\n\n🖼️ Ảnh đã được làm nét!", ctx.message.sender_name)
                    };
                    send_local_bytes_reply(&ctx, rt, "enhanced", "png", &enhanced_bytes, &caption).await
                }
                Err(err) => {
                    send_text_reply(&ctx, &format!("Không làm nét được ảnh, lỗi: {err}")).await
                }
            }
        }
        "stickerzalo" => {
            let sticker_id = ctx.args.first().and_then(|s| s.parse::<u64>().ok());
            let Some(id) = sticker_id else {
                return send_text_reply(&ctx, "Vui lòng cung cấp ID sticker hợp lệ (số nguyên)!").await;
            };

            let mut sent_ok = false;
            if let Some(ref zalo) = ctx.zalo {
                match zalo
                    .send_sticker(id, 1, 1, &ctx.message.thread_id, ctx.message.thread_type)
                    .await
                {
                    Ok(_) => sent_ok = true,
                    Err(err) => {
                        tracing::warn!(error = %err, sticker_id = id, "Failed to send native Zalo sticker");
                    }
                }
            } else {
                sent_ok = true;
            }

            if sent_ok {
                send_text_reply(&ctx, &format!("Đã gửi sticker với ID {id}!")).await
            } else {
                send_text_reply(
                    &ctx,
                    &format!("Không thể gửi sticker với ID {id}. Vui lòng kiểm tra lại ID!"),
                )
                .await
            }
        }
        "stkmeme" => {
            let raw_query = ctx.raw_args_text.trim();
            if raw_query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Vui lòng nhập từ khóa tìm kiếm sticker!\nVí dụ: {}{} [nội dung] [số lượng]",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }

            let mut tokens: Vec<&str> = raw_query.split_whitespace().collect();
            let mut count = 1usize;
            if tokens.len() > 1 && let Some(last) = tokens.last() && let Ok(num) = last.parse::<usize>() {
                if num > 10 {
                    return send_text_reply(
                        &ctx,
                        &format!(
                            "{}, Số lượng sticker tối đa là 10! Hãy thử lại với số lượng nhỏ hơn.",
                            ctx.message.sender_name
                        ),
                    )
                    .await;
                }
                if num == 0 {
                    return send_text_reply(
                        &ctx,
                        &format!(
                            "{}, Số lượng sticker phải là số dương!\nVí dụ: {}{} funny 3",
                            ctx.message.sender_name, ctx.prefix, spec.name
                        ),
                    )
                    .await;
                }
                count = num;
                tokens.pop();
            }

            if tokens.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Vui lòng nhập từ khóa tìm kiếm sticker trước số lượng!\nVí dụ: {}{} funny 3",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }

            let query = tokens.join(" ");
            let urls = rt
                .crawlers
                .search_tenor_gifs(&query, count)
                .await
                .unwrap_or_default();

            if urls.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "{}, Không tìm thấy GIF nào trên Tenor với từ khóa \"{}\"! Hãy thử từ khóa khác như \"funny\" hoặc \"cat\".",
                        ctx.message.sender_name, query
                    ),
                )
                .await;
            }

            let mut sent_any = false;
            for media_url in urls.iter().take(count) {
                if let Ok(scratch) = rt.crawlers.download_media_to_ram(media_url, false).await {
                    match rt.cli_media.convert_to_webp_sticker(scratch.path(), false, 15).await {
                        Ok(webp_scratch) => {
                            if let Ok(webp_bytes) = webp_scratch.read_bytes() && !webp_bytes.is_empty() {
                                let _ = send_local_bytes_reply(
                                    &ctx,
                                    rt,
                                    "stkmeme",
                                    "webp",
                                    &webp_bytes,
                                    &format!("{} Sticker của bạn đây!", ctx.message.sender_name),
                                )
                                .await;
                                sent_any = true;
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Convert meme to webp failed");
                        }
                    }
                }
            }

            if sent_any {
                Ok(CommandOutcome::Handled {
                    summary: format!("sent meme sticker for `{query}`"),
                    reply_text: None,
                    custom_ttl_ms: None,
                })
            } else {
                send_text_reply(
                    &ctx,
                    &format!(
                        "{}, Không thể xử lý sticker từ Tenor cho từ khóa \"{}\". Vui lòng thử lại sau.",
                        ctx.message.sender_name, query
                    ),
                )
                .await
            }
        }
        "sendresourcesfile" | "sendsrc" | "sendresourcesvideo" | "sendresourcesimage" | "sendresourcesaudio" => {
            let subfolder = match spec.name {
                "sendresourcesvideo" => "video",
                "sendresourcesimage" => "image",
                "sendresourcesaudio" => "audio",
                _ => "file",
            };
            let dir_path = std::path::Path::new("assets/resources").join(subfolder);
            if !dir_path.exists() {
                return send_text_reply(
                    &ctx,
                    &format!("📂 Thư mục chia sẻ tài nguyên `{}` không tồn tại trên hệ thống.", dir_path.display()),
                ).await;
            }
            let filename = ctx.raw_args_text.trim();
            if filename.is_empty() {
                let mut files = Vec::new();
                if let Ok(entries) = std::fs::read_dir(&dir_path) {
                    for entry in entries.flatten() {
                        if let Ok(name) = entry.file_name().into_string() {
                            files.push(name);
                        }
                    }
                }
                if files.is_empty() {
                    return send_text_reply(&ctx, &format!("📂 Thư mục `{}` hiện chưa có file nào.", dir_path.display())).await;
                }
                return send_text_reply(
                    &ctx,
                    &format!("📂 Danh sách tài nguyên `{subfolder}` ({} file):\n• {}", files.len(), files.join("\n• ")),
                ).await;
            }
            let target_path = dir_path.join(filename);
            if !target_path.exists() {
                return send_text_reply(&ctx, &format!("❌ Không tìm thấy file `{filename}` trong `{}`.", dir_path.display())).await;
            }
            match std::fs::read(&target_path) {
                Ok(bytes) => {
                    let ext = target_path.extension().and_then(|s| s.to_str()).unwrap_or("bin");
                    send_local_bytes_reply(&ctx, rt, "resource", ext, &bytes, &format!("📦 File chia sẻ: {filename}")).await
                }
                Err(err) => send_text_reply(&ctx, &format!("⚠️ Không thể đọc file: {err}")).await,
            }
        }
        "downloadresource" => {
            let url = ctx.raw_args_text.trim();
            if url.is_empty() {
                return Err(CommandError::MissingArgument("Vui lòng nhập URL tài nguyên cần tải về assets/resources/.".into()));
            }
            match rt.crawlers.download_media_to_ram(url, false).await {
                Ok(scratch) => {
                    let dest = std::path::Path::new("assets/resources/file").join(
                        scratch.path().file_name().unwrap_or_default()
                    );
                    let _ = std::fs::create_dir_all("assets/resources/file");
                    let _ = std::fs::copy(scratch.path(), &dest);
                    send_text_reply(&ctx, &format!("✅ Đã tải tài nguyên về `{}` thành công.", dest.display())).await
                }
                Err(err) => send_text_reply(&ctx, &format!("⚠️ Tải tài nguyên thất bại: {err}")).await,
            }
        }
        "deleteresource" => {
            let name = ctx.raw_args_text.trim();
            if name.is_empty() {
                return Err(CommandError::MissingArgument("Vui lòng nhập tên file tài nguyên cần xóa.".into()));
            }
            let paths = [
                format!("assets/resources/file/{name}"),
                format!("assets/resources/video/{name}"),
                format!("assets/resources/image/{name}"),
                format!("assets/resources/audio/{name}"),
            ];
            let mut deleted = false;
            for p in &paths {
                let path = std::path::Path::new(p);
                if path.exists() {
                    let _ = std::fs::remove_file(path);
                    deleted = true;
                    break;
                }
            }
            if deleted {
                send_text_reply(&ctx, &format!("🗑️ Đã xóa file tài nguyên `{name}`.")).await
            } else {
                send_text_reply(&ctx, &format!("❌ Không tìm thấy file tài nguyên `{name}` để xóa.")).await
            }
        }
        other => Err(CommandError::Internal(format!(
            "Lệnh media `{other}` chưa được định nghĩa handler."
        ))),
    }
}
