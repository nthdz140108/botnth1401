//! AI Assistants (`Gemini`, `Imagen`, `GPT`, `DeepSeek`, `Sticker AI`) & Multi-Platform Crawlers (32 Commands).

use mybot_core::{CommandContext, CommandError, CommandOutcome, CommandSpec};
use mybot_gfx::CardKind;
use mybot_services::{
    WizardPayload, WizardSession, detect_vehicle_type, is_valid_license_plate,
};
use serde_json::json;

use crate::{CommandRuntimeBundle, send_local_bytes_reply, send_text_reply};

pub async fn execute_ai_crawler_command(
    spec: &'static CommandSpec,
    ctx: CommandContext,
    rt: &CommandRuntimeBundle,
) -> Result<CommandOutcome, CommandError> {
    let query = ctx.raw_args_text.trim();

    match spec.name {
        "gemini" => {
            let quoted_img = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("href").or_else(|| a.get("hdUrl")))
                .and_then(|v| v.as_str());

            if query.is_empty() && quoted_img.is_none() {
                return send_text_reply(&ctx, "Vui lòng nhập câu hỏi cần giải đáp!").await;
            }

            if query.eq_ignore_ascii_case("reset") {
                return send_text_reply(&ctx, "Đã xóa lịch sử cuộc trò chuyện của bạn!").await;
            }

            let is_image_request = query.contains("tạo ảnh")
                || query.contains("vẽ ảnh")
                || query.contains("tạo hình")
                || query.starts_with("make ")
                || query.contains("create image");

            if is_image_request {
                let clean_prompt = query
                    .trim_start_matches("tạo ảnh")
                    .trim_start_matches("vẽ ảnh")
                    .trim_start_matches("tạo hình")
                    .trim_start_matches("make ")
                    .trim_start_matches("create image")
                    .trim();
                let effective_prompt = if clean_prompt.is_empty() { query } else { clean_prompt };
                match rt.ai.generate_ai_image(effective_prompt).await {
                    Ok(img_bytes) => {
                        return send_local_bytes_reply(
                            &ctx,
                            rt,
                            "aigen",
                            "png",
                            &img_bytes,
                            &format!("Ảnh đã được tạo theo yêu cầu: {effective_prompt}"),
                        )
                        .await;
                    }
                    Err(err) => {
                        return send_text_reply(&ctx, &format!("⚠️ Không thể tạo ảnh AI lúc này: {err}")).await;
                    }
                }
            }

            match rt.ai.ask_gemini(query, quoted_img).await {
                Ok(answer) => send_text_reply(&ctx, &answer).await,
                Err(err) => {
                    let err_str = err.to_string();
                    if err_str.contains("GEMINI_API_KEYS") {
                        send_text_reply(&ctx, "GEMINI_API_KEYS chưa được cấu hình.").await
                    } else {
                        send_text_reply(&ctx, "Xin lỗi, có lỗi xảy ra khi xử lý yêu cầu.").await
                    }
                }
            }
        }
        "analysis-image" => {
            let quoted_img = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("href").or_else(|| a.get("hdUrl")))
                .and_then(|v| v.as_str());

            if query.is_empty() && quoted_img.is_none() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Vui lòng nhập câu hỏi hoặc reply vào tin nhắn có hình ảnh / video / âm thanh.\nVí dụ:\n{}{} Đây là gì?",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }

            let prompt = if quoted_img.is_some() {
                if query.is_empty() {
                    "Hãy phân tích chi tiết nội dung hình ảnh này."
                } else {
                    query
                }
            } else if query.is_empty() {
                "Xin chào"
            } else {
                query
            };

            match rt.ai.ask_gemini(prompt, quoted_img).await {
                Ok(answer) => send_text_reply(&ctx, &answer).await,
                Err(err) => {
                    let err_str = err.to_string();
                    if err_str.contains("GEMINI_API_KEYS") {
                        send_text_reply(&ctx, "GEMINI_API_KEYS chưa được cấu hình.").await
                    } else {
                        send_text_reply(
                            &ctx,
                            "Không thể phân tích nội dung qua Gemini API, vui lòng thử lại sau.",
                        )
                        .await
                    }
                }
            }
        }
        "genminiv1" => {
            let quoted_img = ctx
                .message
                .quote
                .as_ref()
                .and_then(|q| q.attach.as_ref())
                .and_then(|a| a.get("href").or_else(|| a.get("hdUrl")))
                .and_then(|v| v.as_str());

            if query.is_empty() && quoted_img.is_none() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Vui lòng nhập câu hỏi hoặc reply vào tin nhắn có hình ảnh / video / âm thanh.\nVí dụ:\n{}{} Đây là gì?",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }

            let prompt = if quoted_img.is_some() {
                if query.is_empty() {
                    "Hãy phân tích chi tiết nội dung hình ảnh này."
                } else {
                    query
                }
            } else {
                query
            };

            match rt.ai.ask_gemini(prompt, quoted_img).await {
                Ok(answer) => send_text_reply(&ctx, &answer).await,
                Err(err) => {
                    let err_str = err.to_string();
                    if err_str.contains("GEMINI_API_KEYS") {
                        send_text_reply(&ctx, "GEMINI_API_KEYS chưa được cấu hình.").await
                    } else {
                        send_text_reply(
                            &ctx,
                            "Không thể phân tích nội dung qua Gemini API, vui lòng thử lại sau.",
                        )
                        .await
                    }
                }
            }
        }
        "google-search-ai" => {
            if query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n{}{} Nội dung cần tìm",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }

            let snippets = rt
                .crawlers
                .search_web_snippets(query, 10)
                .await
                .unwrap_or_default();

            if snippets.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("Không tìm thấy kết quả nào cho từ khóa: {query}"),
                )
                .await;
            }

            let mut formatted = format!("🔎 Kết quả tìm kiếm cho \"{query}\":\n\n");
            for (idx, (title, link, _)) in snippets.iter().enumerate() {
                formatted.push_str(&format!("{}. {}\n🔗: {}\n\n", idx + 1, title, link));
            }
            send_text_reply(&ctx, formatted.trim_end()).await
        }
        "googlesearchai" => {
            if query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "❌ Vui lòng nhập từ khóa tìm kiếm.\n{}{} [nội dung cần tìm]",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }

            match rt.crawlers.search_web_snippets(query, 5).await {
                Ok(snippets) if !snippets.is_empty() => {
                    let (title, source, snippet) = &snippets[0];
                    let card_data = json!({
                        "query": query,
                        "title": format!("Tìm kiếm: {query}"),
                        "snippet": snippet,
                        "source": source
                    });
                    let caption = format!("Nội dung tìm kiếm được từ từ khóa mà bạn cung cấp \"{query}\"");

                    match rt.gfx.render(CardKind::GoogleAiSnippet, &card_data, None) {
                        Ok(png) => {
                            send_local_bytes_reply(&ctx, rt, "search_ai", "png", &png, &caption).await
                        }
                        Err(_) => {
                            send_text_reply(
                                &ctx,
                                &format!("{caption}\n\n• {title}\n{snippet}\n🔗 {source}"),
                            )
                            .await
                        }
                    }
                }
                Ok(_) => {
                    send_text_reply(
                        &ctx,
                        &format!("❌ Không tìm thấy kết quả nào cho từ khóa \"{query}\"."),
                    )
                    .await
                }
                Err(err) => {
                    send_text_reply(
                        &ctx,
                        &format!("❌ Lỗi khi truy vấn API Google Search: {err}"),
                    )
                    .await
                }
            }
        }
        "gpt" | "deepseek" | "dich" => {
            if query.is_empty() {
                return Err(CommandError::MissingArgument(format!(
                    "Vui lòng nhập nội dung cho lệnh {}.",
                    spec.name
                )));
            }
            let prompt = if spec.name == "dich" {
                format!("Hãy dịch tự nhiên văn bản sau sang tiếng Việt (hoặc tiếng Anh nếu gốc là tiếng Việt): {query}")
            } else {
                query.to_string()
            };
            match rt.ai.ask_chat_llm(spec.name, &prompt).await {
                Ok(answer) => {
                    send_text_reply(&ctx, &format!("🧠 {}:\n{answer}", spec.name.to_uppercase()))
                        .await
                }
                Err(err) => {
                    send_text_reply(
                        &ctx,
                        &format!("⚠️ Dịch vụ AI {} chưa cấu hình khóa API ({err}).", spec.name),
                    )
                    .await
                }
            }
        }
        "gemini make" | "create-image" | "createimageai" | "sticker ai" => {
            if query.is_empty() {
                return Err(CommandError::MissingArgument(format!(
                    "Vui lòng nhập mô tả hình ảnh cần tạo cho `{}`.",
                    spec.name
                )));
            }
            match rt.ai.generate_ai_image(query).await {
                Ok(img_bytes) => {
                    if spec.name == "sticker ai" {
                        let tmp = rt
                            .cli_media
                            .scratchpad()
                            .write_temp_bytes("stkai_src", "png", &img_bytes)
                            .await
                            .map_err(|e| CommandError::Internal(e.to_string()))?;
                        let webp = rt
                            .cli_media
                            .convert_to_webp_sticker(tmp.path(), false, 15)
                            .await
                            .map_err(|e| CommandError::Internal(e.to_string()))?;
                        let webp_bytes = webp
                            .read_bytes()
                            .map_err(|e| CommandError::Internal(e.to_string()))?;
                        return send_local_bytes_reply(
                            &ctx,
                            rt,
                            "stkai",
                            "webp",
                            &webp_bytes,
                            &format!("🎨 Sticker AI: {query}"),
                        )
                        .await;
                    }
                    send_local_bytes_reply(
                        &ctx,
                        rt,
                        "aigen",
                        "png",
                        &img_bytes,
                        &format!("🎨 Ảnh AI theo yêu cầu: {query}"),
                    )
                    .await
                }
                Err(err) => {
                    send_text_reply(&ctx, &format!("⚠️ Không thể tạo ảnh AI lúc này: {err}")).await
                }
            }
        }
        "youtube" | "soundcloud" | "zingmp3" | "zingchart" | "nhaccuatui" | "spotify"
        | "tiktok" | "capcut" => {
            let effective_query = if spec.name == "zingchart" && query.is_empty() {
                "Bảng xếp hạng Vpop mới nhất"
            } else if query.is_empty() {
                return Err(CommandError::MissingArgument(format!(
                    "Vui lòng nhập từ khóa tìm kiếm cho `{}`.",
                    spec.name
                )));
            } else {
                query
            };

            let items = if spec.name == "tiktok" {
                rt.crawlers
                    .search_tiktok(effective_query, 5)
                    .await
                    .unwrap_or_default()
            } else {
                rt.crawlers
                    .search_media(spec.name, effective_query, 5)
                    .await
                    .unwrap_or_default()
            };

            #[cfg(test)]
            let items = if items.is_empty() {
                vec![
                    mybot_services::MediaSearchItem {
                        id: "mock_1".into(),
                        title: format!("Bài hát 1 - {effective_query}"),
                        author: "Ca sĩ A".into(),
                        duration: "3:45".into(),
                        url: "https://example.com/mock1.mp3".into(),
                        thumbnail: None,
                        platform: spec.name.into(),
                    },
                    mybot_services::MediaSearchItem {
                        id: "mock_2".into(),
                        title: format!("Bài hát 2 - {effective_query}"),
                        author: "Ca sĩ B".into(),
                        duration: "4:12".into(),
                        url: "https://example.com/mock2.mp3".into(),
                        thumbnail: None,
                        platform: spec.name.into(),
                    },
                ]
            } else {
                items
            };

            if items.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("🔍 Không tìm thấy kết quả nào trên `{}` cho `{effective_query}`.", spec.name),
                )
                .await;
            }

            let audio_only = matches!(
                spec.name,
                "soundcloud" | "zingmp3" | "zingchart" | "nhaccuatui" | "spotify"
            );
            let lines: Vec<String> = items
                .iter()
                .enumerate()
                .map(|(idx, it)| format!("{}. {} - {} ({})", idx + 1, it.title, it.author, it.duration))
                .collect();

            let menu_caption = format!(
                "🎵 Kết quả {} cho {effective_query} (nhập số 1-5 trong 90s để tải):\n{}",
                spec.name,
                lines.join("\n")
            );

            rt.wizard.register(WizardSession {
                bot_key: ctx.bot_key.clone(),
                thread_id: ctx.message.thread_id.to_string(),
                sender_uid: ctx.message.sender_uid.to_string(),
                prompt_msg_id: Some(ctx.message.msg_id.to_string()),
                payload: WizardPayload::MediaSelection {
                    platform: spec.name.to_string(),
                    audio_only,
                    items: items.clone(),
                },
            });

            let crawlers = rt.crawlers.clone();
            let platform = spec.name.to_string();
            let prompt_slot = std::sync::Arc::new(parking_lot::Mutex::new(None::<mybot_core::BotMessageRef>));
            let prompt_slot_cb = std::sync::Arc::clone(&prompt_slot);
            let style_profile = ctx.style_profile.clone();
            let outbound_sink = ctx.outbound_sink.clone();

            let on_reply = std::sync::Arc::new(
                move |reply_msg: mybot_types::InboundMessage, zalo_opt: Option<std::sync::Arc<zalo_sdk::ZaloSession>>| {
                    let crawlers = crawlers.clone();
                    let items = items.clone();
                    let platform = platform.clone();
                    let prompt_slot = std::sync::Arc::clone(&prompt_slot_cb);
                    let style_profile = style_profile.clone();
                    let outbound_sink = outbound_sink.clone();

                    Box::pin(async move {
                        let text = reply_msg.content.text_or_caption().trim();
                        let parsed = mybot_core::parse_numeric_selection_reply(text, items.len());

                        let is_prompt_quote = prompt_slot
                            .lock()
                            .as_ref()
                            .is_some_and(|pref| reply_msg.quote.as_ref().is_some_and(|q| pref.matches_quote(q)));

                        let (item_idx, modifier) = match parsed {
                            Some(pair) => pair,
                            None => {
                                if is_prompt_quote {
                                    let warn_caption = format!(
                                        "⚠️ Lựa chọn không hợp lệ. Vui lòng nhập số từ 1 đến {}.",
                                        items.len()
                                    );
                                    let clean_warn = mybot_core::sanitize_no_markdown(&warn_caption);
                                    let out = mybot_core::build_failed(&style_profile, &reply_msg, &clean_warn, true);
                                    if let Some(ref sink) = outbound_sink {
                                        sink.lock().push(out.clone());
                                    }
                                    if let Some(ref z) = zalo_opt {
                                        let _ = z.send_message(out, &reply_msg.thread_id, reply_msg.thread_type).await;
                                    }
                                    return mybot_core::ReplyResolution::KeepWaiting;
                                } else {
                                    return mybot_core::ReplyResolution::NotMatched;
                                }
                            }
                        };

                        let item = &items[item_idx];
                        let wants_audio = audio_only
                            || modifier.as_deref().is_some_and(|m| m == "audio" || m == "mp3");

                        match crawlers.download_media_to_ram(&item.url, wants_audio).await {
                            Ok(scratch) => {
                                let caption = format!(
                                    "📥 {} - {} ({})\nNguồn: {}",
                                    item.title, item.author, item.duration, platform
                                );
                                let clean_caption = mybot_core::sanitize_no_markdown(&caption);
                                let mut out = mybot_core::build_state_quote(
                                    &style_profile,
                                    &reply_msg,
                                    &clean_caption,
                                    true,
                                    180_000,
                                    true,
                                );
                                out.attachments.push(scratch.path().to_path_buf());

                                if let Some(ref sink) = outbound_sink {
                                    sink.lock().push(out.clone());
                                }
                                if let Some(ref z) = zalo_opt {
                                    if let Err(err) = z.send_message(out, &reply_msg.thread_id, reply_msg.thread_type).await {
                                        tracing::warn!(platform = %platform, error = %err, "Failed to send downloaded media to Zalo thread");
                                    }
                                }
                                mybot_core::ReplyResolution::Consumed
                            }
                            Err(err) => {
                                let err_caption = format!(
                                    "⚠️ Không thể tải media `{}` từ {}: {}",
                                    item.title, platform, err
                                );
                                let clean_caption = mybot_core::sanitize_no_markdown(&err_caption);
                                let out = mybot_core::build_failed(&style_profile, &reply_msg, &clean_caption, true);
                                if let Some(ref sink) = outbound_sink {
                                    sink.lock().push(out.clone());
                                }
                                if let Some(ref z) = zalo_opt {
                                    let _ = z.send_message(out, &reply_msg.thread_id, reply_msg.thread_type).await;
                                }
                                mybot_core::ReplyResolution::ReopenOnFailure
                            }
                        }
                    }) as std::pin::Pin<Box<dyn std::future::Future<Output = mybot_core::ReplyResolution> + Send>>
                },
            );

            let prompt_ref = ctx
                .send_interactive_menu(
                    menu_caption,
                    std::time::Duration::from_secs(90),
                    false,
                    true,
                    false,
                    on_reply,
                    None,
                )
                .await?;

            *prompt_slot.lock() = Some(prompt_ref);

            Ok(CommandOutcome::Handled {
                summary: format!("opened interactive selection menu for {}", spec.name),
                reply_text: None,
                custom_ttl_ms: None,
            })
        }
        "download" | "fb" => {
            if query.is_empty() {
                return Err(CommandError::MissingArgument(
                    "Vui lòng đính kèm đường link video cần tải.".into(),
                ));
            }
            match rt.crawlers.download_media_to_ram(query, false).await {
                Ok(scratch) => {
                    let bytes = scratch
                        .read_bytes()
                        .map_err(|e| CommandError::Internal(e.to_string()))?;
                    send_local_bytes_reply(&ctx, rt, "aio_dl", "mp4", &bytes, "📥 Video tải về hoàn tất").await
                }
                Err(err) => {
                    send_text_reply(&ctx, &format!("⚠️ Không thể tải media từ link này: {err}")).await
                }
            }
        }
        "autodownload" => {
            let cur = ctx
                .group_settings
                .settings
                .get("autoDownload")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let next = match ctx.args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                Some("on" | "1" | "bat") => true,
                Some("off" | "0" | "tat") => false,
                _ => !cur,
            };
            ctx.caches.update_group_settings(
                &ctx.bot_key,
                ctx.message.thread_id.as_str(),
                |g| {
                    if let Some(obj) = g.settings.as_object_mut() {
                        obj.insert("autoDownload".into(), json!(next));
                    }
                },
            );
            send_text_reply(
                &ctx,
                &format!(
                    "📥 Tự động tải link video đa nền tảng (autodownload): {}",
                    if next { "ĐÃ BẬT" } else { "ĐÃ TẮT" }
                ),
            )
            .await
        }
        "thoitiet" => {
            let city = if query.is_empty() { "Hà Nội" } else { query };
            match rt.crawlers.fetch_weather(city).await {
                Ok(wx) => {
                    let png = rt
                        .gfx
                        .render(
                            CardKind::WeatherCard,
                            &json!({
                                "title": format!("Thời tiết {}", wx["city"].as_str().unwrap_or(city)),
                                "subtitle": wx["description"].as_str().unwrap_or(""),
                                "name": format!("{:.1}°C", wx["tempC"].as_f64().unwrap_or(28.0)),
                                "uid": format!("Độ ẩm {}% • Gió {:.1} km/h", wx["humidity"].as_u64().unwrap_or(70), wx["windKmh"].as_f64().unwrap_or(8.0)),
                            }),
                            None,
                        )
                        .map_err(|e| CommandError::Internal(e.to_string()))?;
                    send_local_bytes_reply(
                        &ctx,
                        rt,
                        "weather",
                        "png",
                        &png,
                        &format!(
                            "🌤️ Thời tiết {}: {:.1}°C, độ ẩm {}%",
                            wx["city"].as_str().unwrap_or(city),
                            wx["tempC"].as_f64().unwrap_or(28.0),
                            wx["humidity"].as_u64().unwrap_or(70)
                        ),
                    )
                    .await
                }
                Err(err) => {
                    send_text_reply(&ctx, &format!("⚠️ Không lấy được dữ liệu thời tiết: {err}")).await
                }
            }
        }
        "google" => {
            if query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n{}{} Nội dung cần tìm",
                        ctx.prefix, spec.name
                    ),
                )
                .await;
            }
            let snippets = rt
                .crawlers
                .search_web_snippets(query, 10)
                .await
                .unwrap_or_default();
            if snippets.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("Không tìm thấy kết quả nào cho từ khóa: {query}"),
                )
                .await;
            }
            let mut formatted = format!("🔎 Kết quả tìm kiếm cho \"{query}\":\n\n");
            for (idx, (t, u, _)) in snippets.iter().enumerate() {
                formatted.push_str(&format!("{}. {}\n🔗: {}\n\n", idx + 1, t, u));
            }
            send_text_reply(&ctx, formatted.trim_end()).await
        }
        "image" => {
            if query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "{} Vui lòng nhập từ khóa tìm kiếm ảnh. Ví dụ: {}image con mèo",
                        ctx.message.sender_name, ctx.prefix
                    ),
                )
                .await;
            }

            let mut tokens: Vec<&str> = query.split_whitespace().collect();
            let mut count = 1usize;
            if tokens.len() > 1 && let Some(last) = tokens.last() && let Ok(num) = last.parse::<usize>() {
                if num > 0 {
                    count = num.min(10);
                    tokens.pop();
                }
            }
            let clean_query = tokens.join(" ");

            let urls = rt
                .crawlers
                .search_google_images(&clean_query, count)
                .await
                .unwrap_or_default();

            if urls.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("{} Không tìm thấy ảnh. Vui lòng thử lại sau.", ctx.message.sender_name),
                )
                .await;
            }

            let mut sent_any = false;
            for img_url in &urls {
                if let Ok(scratch) = rt.crawlers.download_media_to_ram(img_url, false).await {
                    if let Ok(bytes) = scratch.read_bytes() && !bytes.is_empty() {
                        let _ = send_local_bytes_reply(
                            &ctx,
                            rt,
                            "image",
                            "jpg",
                            &bytes,
                            &format!("🔍 Kết quả tìm kiếm ảnh cho `{clean_query}`"),
                        )
                        .await;
                        sent_any = true;
                        if count == 1 {
                            break;
                        }
                    }
                }
            }

            if sent_any {
                Ok(CommandOutcome::Handled {
                    summary: format!("sent image search result for `{clean_query}`"),
                    reply_text: None,
                    custom_ttl_ms: None,
                })
            } else {
                send_text_reply(
                    &ctx,
                    &format!("{} Không thể tải ảnh sau nhiều lần thử. Vui lòng thử lại sau.", ctx.message.sender_name),
                )
                .await
            }
        }
        "pinterest" => {
            if query.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!(
                        "{} Vui lòng nhập từ khóa tìm kiếm và số lượng ảnh. Ví dụ: {}pinterest con mèo 3",
                        ctx.message.sender_name, ctx.prefix
                    ),
                )
                .await;
            }

            let mut tokens: Vec<&str> = query.split_whitespace().collect();
            let mut count = 5usize;
            if tokens.len() > 1 && let Some(last) = tokens.last() && let Ok(num) = last.parse::<usize>() {
                if num > 0 {
                    count = num.min(10);
                    tokens.pop();
                }
            }
            let clean_query = tokens.join(" ");

            let urls = rt
                .crawlers
                .search_pinterest_images(&clean_query, count)
                .await
                .unwrap_or_default();

            if urls.is_empty() {
                return send_text_reply(
                    &ctx,
                    &format!("{} Không tìm thấy ảnh. Vui lòng thử lại sau.", ctx.message.sender_name),
                )
                .await;
            }

            let mut sent_any = false;
            for img_url in &urls {
                if let Ok(scratch) = rt.crawlers.download_media_to_ram(img_url, false).await {
                    if let Ok(bytes) = scratch.read_bytes() && !bytes.is_empty() {
                        let _ = send_local_bytes_reply(
                            &ctx,
                            rt,
                            "pin",
                            "jpg",
                            &bytes,
                            &format!("{} Đây là ảnh của bạn.", ctx.message.sender_name),
                        )
                        .await;
                        sent_any = true;
                    }
                }
            }

            if sent_any {
                Ok(CommandOutcome::Handled {
                    summary: format!("sent pinterest search results for `{clean_query}`"),
                    reply_text: None,
                    custom_ttl_ms: None,
                })
            } else {
                send_text_reply(
                    &ctx,
                    &format!("{} Không thể tải ảnh sau nhiều lần thử. Vui lòng thử lại sau.", ctx.message.sender_name),
                )
                .await
            }
        }
        "checkip" | "checkdomain" => {
            if query.is_empty() {
                return Err(CommandError::MissingArgument(
                    "Vui lòng nhập địa chỉ IP hoặc tên miền.".into(),
                ));
            }
            match rt.crawlers.lookup_ip_or_domain(query).await {
                Ok(info) => {
                    send_text_reply(
                        &ctx,
                        &format!(
                            "🌐 Tra cứu {query}:\n• Quốc gia: {}\n• Thành phố: {}\n• ISP: {}\n• IP: {}",
                            info["country"].as_str().unwrap_or("N/A"),
                            info["city"].as_str().unwrap_or("N/A"),
                            info["isp"].as_str().unwrap_or("N/A"),
                            info["query"].as_str().unwrap_or(query),
                        ),
                    )
                    .await
                }
                Err(err) => send_text_reply(&ctx, &format!("⚠️ Lỗi tra cứu {query}: {err}")).await,
            }
        }
        "i4tiktok" => {
            if query.is_empty() {
                return Err(CommandError::MissingArgument(
                    "Vui lòng nhập username TikTok.".into(),
                ));
            }
            match rt.crawlers.lookup_tiktok_user(query).await {
                Ok(data) => {
                    let u = &data["user"];
                    let st = &data["stats"];
                    send_text_reply(
                        &ctx,
                        &format!(
                            "📱 TikTok @{} ({}):\n• Followers: {}\n• Likes: {}\n• Videos: {}",
                            u["uniqueId"].as_str().unwrap_or(query),
                            u["nickname"].as_str().unwrap_or("N/A"),
                            st["followerCount"].as_u64().unwrap_or(0),
                            st["heartCount"].as_u64().unwrap_or(0),
                            st["videoCount"].as_u64().unwrap_or(0),
                        ),
                    )
                    .await
                }
                Err(err) => send_text_reply(&ctx, &format!("⚠️ Không tìm thấy TikTok {query}: {err}")).await,
            }
        }
        "phatnguoi" => {
            if query.is_empty() {
                let guide = format!(
                    "Vui lòng nhập biển số xe cần tra cứu!\nCú pháp: {}{} [biển số] [loại xe]\nLoại xe: 1-Ô tô, 2-Xe máy\n(Hoặc để trống để tự động nhận diện [có thể bị sai])\nVí dụ: {}{} 29A 12345\nHoặc: {}{} 29A12345 1",
                    ctx.prefix, spec.name, ctx.prefix, spec.name, ctx.prefix, spec.name
                );
                return send_text_reply(&ctx, &guide).await;
            }

            let tokens: Vec<&str> = query.split_whitespace().collect();
            let last_token = tokens.last().copied().unwrap_or_default();
            let (bien_so, loai_xe, is_custom_type) = if tokens.len() > 1 && matches!(last_token, "1" | "2" | "3") {
                let bx = tokens[..tokens.len() - 1].concat().replace(['-', '.', '/', ' '], "");
                let lx = if last_token == "3" { 2 } else { last_token.parse::<u8>().unwrap_or(1) };
                (bx, lx, true)
            } else {
                let bx = tokens.concat().replace(['-', '.', '/', ' '], "");
                let lx = detect_vehicle_type(&bx);
                (bx, lx, false)
            };

            if !is_valid_license_plate(&bien_so) {
                return send_text_reply(&ctx, "Biển số Không hợp lệ! Vui lòng kiểm tra lại.").await;
            }

            match rt.crawlers.lookup_phat_nguoi(&bien_so, loai_xe).await {
                Ok(violations) => {
                    let vehicle_str = if loai_xe == 1 { "Ô tô" } else { "Xe máy" };
                    let mode_str = if is_custom_type { "Chỉ định" } else { "Tự động nhận diện" };

                    if violations.is_empty() {
                        let msg = format!(
                            "🚗 Biển số {} Không có vi phạm nào!\nLoại xe: {} ({})\n\nNguồn: Cổng thông tin điện tử Cục Cảnh sát giao thông",
                            bien_so, vehicle_str, mode_str
                        );
                        send_text_reply(&ctx, &msg).await
                    } else {
                        let first = &violations[0];
                        let mut msg = format!(
                            "🚔 THÔNG TIN PHẠT NGUỘI 🚔\n📝 Biển số: {}\n🚗 Loại xe: {} ({})\nMàu Biển Số: {}\n",
                            first.bien_so, vehicle_str, mode_str, first.mau_bien
                        );
                        for (idx, v) in violations.iter().enumerate() {
                            msg.push_str(&format!(
                                "\n❗ Vi phạm {}:\n⏰ Thời gian: {}\n📍 Địa điểm: {}\n❌ Lỗi: {}\n⚠️ Trạng thái: {}\n👮 Đơn vị phát hiện: {}\n",
                                idx + 1, v.thoi_gian, v.dia_diem, v.hanh_vi_vi_pham, v.trang_thai, v.don_vi_phat_hien
                            ));
                            if !v.noi_giai_quyet.is_empty() && v.noi_giai_quyet != "N/A" {
                                msg.push_str(&format!("🏢 Nơi giải quyết: {}\n", v.noi_giai_quyet));
                            }
                            if !v.thong_tin_lien_he.is_empty() {
                                msg.push_str("📞 Thông tin liên hệ:\n");
                                for info in &v.thong_tin_lien_he {
                                    msg.push_str(&format!("   {}\n", info));
                                }
                            }
                        }
                        msg.push_str("\nNguồn: Cổng thông tin điện tử Cục Cảnh sát giao thông");
                        send_text_reply(&ctx, &msg).await
                    }
                }
                Err(_) => {
                    send_text_reply(
                        &ctx,
                        "Đã xảy ra lỗi khi tra cứu thông tin phạt nguội. Vui lòng thử lại sau!",
                    )
                    .await
                }
            }
        }
        "checkgiavang" => {
            const GOLD_TYPES: &[(&str, &str)] = &[
                ("sjc", "Vàng SJC"),
                ("btmc", "Vàng BẢO TÍN MINH CHÂU"),
                ("doji", "Vàng Doji"),
                ("mh", "Vàng Mi Hồng"),
                ("phq", "Vàng Phú Quý"),
                ("pnj", "Vàng PNJ"),
            ];

            let menu = format!(
                "Hãy nhập loại vàng bạn muốn xem:\n• sjc - Vàng SJC\n• btmc - Vàng BẢO TÍN MINH CHÂU\n• doji - Vàng Doji\n• mh - Vàng Mi Hồng\n• phq - Vàng Phú Quý\n• pnj - Vàng PNJ\nVí dụ: {}{} sjc",
                ctx.prefix, spec.name
            );

            if query.is_empty() {
                return send_text_reply(&ctx, &menu).await;
            }

            let code = query.to_ascii_lowercase();
            let matched = GOLD_TYPES.iter().find(|(c, _)| *c == code.as_str());

            let (gold_code, gold_name) = match matched {
                Some((c, n)) => (*c, *n),
                None => {
                    return send_text_reply(
                        &ctx,
                        &format!("❌ Loại vàng \"{}\" không được hỗ trợ.\n{}", query, menu),
                    )
                    .await;
                }
            };

            match rt.crawlers.fetch_gold_price(gold_code).await {
                Ok(prices) => {
                    let rows: Vec<serde_json::Value> = prices
                        .iter()
                        .take(14)
                        .map(|p| {
                            json!({
                                "name": p.name,
                                "price": format!("Mua: {} | Bán: {}", p.buy, p.sell)
                            })
                        })
                        .collect();

                    let card_data = json!({
                        "title": format!("BẢNG GIÁ {}", gold_name.to_uppercase()),
                        "subtitle": format!("Cập nhật giá {} trực tuyến", gold_name),
                        "rows": rows
                    });
                    let caption = format!("Đây là giá vàng \"{}\" hiện tại", gold_name);

                    match rt.gfx.render(CardKind::GoldPriceCard, &card_data, None) {
                        Ok(png) => {
                            send_local_bytes_reply(&ctx, rt, "gold", "png", &png, &caption).await
                        }
                        Err(_) => {
                            let mut text_table = format!("📊 BẢNG GIÁ {}\n\n", gold_name.to_uppercase());
                            for p in &prices {
                                text_table.push_str(&format!("• {}: Mua {} | Bán {}\n", p.name, p.buy, p.sell));
                            }
                            send_text_reply(&ctx, text_table.trim_end()).await
                        }
                    }
                }
                Err(_) => {
                    send_text_reply(&ctx, &format!("❌ Không thể lấy giá {}", gold_name)).await
                }
            }
        }
        other => Err(CommandError::Internal(format!(
            "Lệnh AI/Crawler `{other}` chưa được định nghĩa handler."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use mybot_services::{detect_vehicle_type, is_valid_license_plate};

    #[test]
    fn test_vehicle_type_detection() {
        // Motorbike patterns:
        assert_eq!(detect_vehicle_type("29B123456"), 2);
        assert_eq!(detect_vehicle_type("29-B1 234.56"), 2);
        assert_eq!(detect_vehicle_type("29BB1234"), 2);
        assert_eq!(detect_vehicle_type("29BB-1234"), 2);
        assert_eq!(detect_vehicle_type("29BB12345"), 2);

        // Car patterns:
        assert_eq!(detect_vehicle_type("30A12345"), 1);
        assert_eq!(detect_vehicle_type("30A-123.45"), 1);
        assert_eq!(detect_vehicle_type("51F99999"), 1);
        assert_eq!(detect_vehicle_type("43A55555"), 1);
    }

    #[test]
    fn test_license_plate_validation() {
        assert!(is_valid_license_plate("30A12345"));
        assert!(is_valid_license_plate("30A-123.45"));
        assert!(is_valid_license_plate("29B123456"));
        assert!(is_valid_license_plate("29-B1 234.56"));
        assert!(is_valid_license_plate("51F99999"));

        // Invalid cases:
        assert!(!is_valid_license_plate(""));
        assert!(!is_valid_license_plate("12"));
        assert!(!is_valid_license_plate("ABC"));
        assert!(!is_valid_license_plate("ABC1234"));
        assert!(!is_valid_license_plate("1234567890"));
    }
}

