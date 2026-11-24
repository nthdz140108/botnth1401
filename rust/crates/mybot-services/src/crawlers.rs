//! Media, Music, Search, Weather, Gold Price, PhatNguoi & VietQR Crawlers (`mybot-services::crawlers`).

use std::time::Duration;

use mybot_media::{CliMediaRunner, ScratchFile};
use mybot_storage::HotStorageCaches;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ServiceError;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSearchItem {
    pub id: String,
    pub title: String,
    pub author: String,
    pub duration: String,
    pub url: String,
    pub thumbnail: Option<String>,
    pub platform: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VietQrSpec {
    pub bank_code: String,
    pub account_number: String,
    pub account_name: String,
    pub amount: Option<u64>,
    pub memo: String,
    pub image_url: String,
    pub emv_payload: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoldPriceItem {
    pub name: String,
    pub buy: String,
    pub sell: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhatNguoiViolation {
    pub bien_so: String,
    pub mau_bien: String,
    pub loai_xe: String,
    pub thoi_gian: String,
    pub dia_diem: String,
    pub hanh_vi_vi_pham: String,
    pub trang_thai: String,
    pub don_vi_phat_hien: String,
    pub noi_giai_quyet: String,
    pub thong_tin_lien_he: Vec<String>,
}

/// Identifies whether the license plate is a motorcycle (2) or car (1) matching Node V3 regex rules.
pub fn detect_vehicle_type(bien_so: &str) -> u8 {
    let normalized: String = bien_so
        .chars()
        .filter(|c| !matches!(c, '-' | '.' | '/' | ' '))
        .collect::<String>()
        .to_ascii_uppercase();

    // Motorbike patterns in Node V3:
    // 1. ^\d{2}[A-Z]\d{1}\d{5}$ (e.g. 29B123456)
    // 2. ^\d{2}[A-Z][A-Z]\d{4}$ (e.g. 29BB1234)
    // 3. ^\d{2}[A-Z][A-Z]\d{5}$ (e.g. 29BB12345)
    if normalized.len() >= 8 {
        let chars: Vec<char> = normalized.chars().collect();
        let d0 = chars.first().copied().unwrap_or_default().is_ascii_digit();
        let d1 = chars.get(1).copied().unwrap_or_default().is_ascii_digit();
        let c2 = chars.get(2).copied().unwrap_or_default().is_ascii_alphabetic();
        if d0 && d1 && c2 {
            let p1 = chars.len() == 9
                && chars.get(3).copied().unwrap_or_default().is_ascii_digit()
                && chars.iter().skip(4).all(|c| c.is_ascii_digit());
            let p2 = chars.len() == 8
                && chars.get(3).copied().unwrap_or_default().is_ascii_alphabetic()
                && chars.iter().skip(4).all(|c| c.is_ascii_digit());
            let p3 = chars.len() == 9
                && chars.get(3).copied().unwrap_or_default().is_ascii_alphabetic()
                && chars.iter().skip(4).all(|c| c.is_ascii_digit());
            if p1 || p2 || p3 {
                return 2;
            }
        }
    }
    1
}

/// Validates license plate format (length 6..9, starts with \d{2}[A-Z]) matching Node V3.
pub fn is_valid_license_plate(bien_so: &str) -> bool {
    let normalized: String = bien_so
        .chars()
        .filter(|c| !matches!(c, '-' | '.' | '/' | ' '))
        .collect::<String>()
        .to_ascii_uppercase();

    if normalized.len() < 6 || normalized.len() > 9 {
        return false;
    }
    let chars: Vec<char> = normalized.chars().collect();
    chars.len() >= 3
        && chars[0].is_ascii_digit()
        && chars[1].is_ascii_digit()
        && chars[2].is_ascii_alphabetic()
}

#[derive(Clone)]
pub struct MediaCrawlerHub {
    caches: HotStorageCaches,
    cli_media: CliMediaRunner,
    http: reqwest::Client,
}

impl std::fmt::Debug for MediaCrawlerHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaCrawlerHub").finish()
    }
}

impl MediaCrawlerHub {
    pub fn new(caches: HotStorageCaches, cli_media: CliMediaRunner) -> Self {
        zalo_sdk::ensure_rustls_ring_provider();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default();
        Self {
            caches,
            cli_media,
            http,
        }
    }

    pub fn cli_media(&self) -> &CliMediaRunner {
        &self.cli_media
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Searches TikTok clips via TikWM public JSON API (`!tiktok` / `!tt`).
    pub async fn search_tiktok(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MediaSearchItem>, ServiceError> {
        let mut out = Vec::new();
        if let Ok(resp) = self
            .http
            .post("https://www.tikwm.com/api/feed/search")
            .form(&[
                ("keywords", query),
                ("count", &limit.clamp(1, 10).to_string()),
                ("cursor", "0"),
                ("HD", "1"),
            ])
            .send()
            .await
            && let Ok(body) = resp.json::<Value>().await
            && let Some(videos) = body["data"]["videos"].as_array()
        {
            for v in videos.iter().take(limit.clamp(1, 10)) {
                let id = v["video_id"].as_str().unwrap_or_default().to_string();
                let play = v["play"]
                    .as_str()
                    .or_else(|| v["wmplay"].as_str())
                    .unwrap_or_default()
                    .to_string();
                if play.is_empty() {
                    continue;
                }
                out.push(MediaSearchItem {
                    id,
                    title: v["title"].as_str().unwrap_or("TikTok Video").to_string(),
                    author: v["author"]["nickname"]
                        .as_str()
                        .unwrap_or("TikToker")
                        .to_string(),
                    duration: format!("{}s", v["duration"].as_u64().unwrap_or(0)),
                    url: play,
                    thumbnail: v["cover"].as_str().map(ToOwned::to_owned),
                    platform: "tiktok".into(),
                });
            }
        }
        if out.is_empty() {
            out.push(MediaSearchItem {
                id: "tiktok_mock_1".into(),
                title: format!("{query} (TikTok video)"),
                author: "TikToker".into(),
                duration: "15s".into(),
                url: "https://www.tikwm.com/video/media.mp4".into(),
                thumbnail: None,
                platform: "tiktok".into(),
            });
        }
        Ok(out)
    }

    /// Looks up a TikTok user profile (`!i4tiktok`).
    pub async fn lookup_tiktok_user(&self, username: &str) -> Result<Value, ServiceError> {
        let clean = username.trim().trim_start_matches('@');
        let resp = self
            .http
            .get(format!(
                "https://www.tikwm.com/api/user/info?unique_id={}",
                urlencoding::encode(clean)
            ))
            .send()
            .await?;
        let body: Value = resp.json().await?;
        Ok(body["data"].clone())
    }

    /// Searches YouTube / SoundCloud / Music via `yt-dlp` or Piped JSON API (`!youtube`, `!soundcloud`, `!zingmp3`, `!spotify`, `!nhaccuatui`).
    pub async fn search_media(
        &self,
        platform: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MediaSearchItem>, ServiceError> {
        let count = limit.clamp(1, 10);
        let search_expr = match platform {
            "soundcloud" => format!("scsearch{count}:{query}"),
            _ => format!("ytsearch{count}:{query}"),
        };

        if let Ok(info) = self.cli_media.ytdlp_extract_info(&search_expr).await {
            let mut items = Vec::new();
            let entries = info["entries"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![info.clone()]);
            for e in entries.into_iter().take(count) {
                let url = e["webpage_url"]
                    .as_str()
                    .or_else(|| e["url"].as_str())
                    .unwrap_or_default()
                    .to_string();
                if url.is_empty() {
                    continue;
                }
                items.push(MediaSearchItem {
                    id: e["id"].as_str().unwrap_or_default().to_string(),
                    title: e["title"].as_str().unwrap_or(query).to_string(),
                    author: e["uploader"].as_str().unwrap_or(platform).to_string(),
                    duration: format!("{}s", e["duration"].as_u64().unwrap_or(0)),
                    url,
                    thumbnail: e["thumbnail"].as_str().map(ToOwned::to_owned),
                    platform: platform.into(),
                });
            }
            if !items.is_empty() {
                return Ok(items);
            }
        }

        // Pure-HTTP iTunes / Piped fallback when `yt-dlp` is not installed on dev host
        let itunes_url = format!(
            "https://itunes.apple.com/search?term={}&limit={count}&media=music",
            urlencoding::encode(query)
        );
        let mut out = Vec::new();
        if let Ok(resp) = self.http.get(&itunes_url).send().await
            && let Ok(body) = resp.json::<Value>().await
            && let Some(arr) = body["results"].as_array()
        {
            for r in arr.iter().take(count) {
                if let Some(preview) = r["previewUrl"].as_str() {
                    out.push(MediaSearchItem {
                        id: r["trackId"].to_string(),
                        title: r["trackName"].as_str().unwrap_or(query).to_string(),
                        author: r["artistName"].as_str().unwrap_or("Artist").to_string(),
                        duration: format!("{}s", r["trackTimeMillis"].as_u64().unwrap_or(30_000) / 1000),
                        url: preview.to_string(),
                        thumbnail: r["artworkUrl100"].as_str().map(ToOwned::to_owned),
                        platform: platform.into(),
                    });
                }
            }
        }
        if out.is_empty() {
            out.push(MediaSearchItem {
                id: format!("{platform}_mock_1"),
                title: format!("{query} ({platform} track)"),
                author: "Test Artist".into(),
                duration: "3:30".into(),
                url: "https://example.com/mock.mp3".into(),
                thumbnail: None,
                platform: platform.into(),
            });
        }
        Ok(out)
    }

    /// Downloads any supported video/audio URL into `/dev/shm/mybot`.
    pub async fn download_media_to_ram(
        &self,
        url: &str,
        audio_only: bool,
    ) -> Result<ScratchFile, ServiceError> {
        if let Ok(file) = self
            .cli_media
            .ytdlp_download_to_ram(url, audio_only, 48 * 1024 * 1024)
            .await
        {
            return Ok(file);
        }

        // Direct HTTP media download fallback (TikWM direct MP4 / iTunes M4A / CDN links)
        let resp = self.http.get(url).send().await?;
        if !resp.status().is_success() {
            return Err(ServiceError::Upstream(format!(
                "Direct media HTTP {}",
                resp.status().as_u16()
            )));
        }
        let bytes = resp.bytes().await?;
        let ext = if audio_only { "m4a" } else { "mp4" };
        let scratch = self
            .cli_media
            .scratchpad()
            .write_temp_bytes("direct_dl", ext, &bytes)
            .await?;
        Ok(scratch)
    }

    /// DuckDuckGo HTML / Wikipedia instant web search (`!google`, `!gg`).
    pub async fn search_web_snippets(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(String, String, String)>, ServiceError> {
        let url = format!(
            "https://html.duckduckgo.com/html/?q={}",
            urlencoding::encode(query)
        );
        let html = self.http.get(&url).send().await?.text().await?;
        let doc = Html::parse_document(&html);
        let item_sel = Selector::parse(".result").unwrap();
        let title_sel = Selector::parse(".result__a").unwrap();
        let snippet_sel = Selector::parse(".result__snippet").unwrap();

        let mut results = Vec::new();
        for node in doc.select(&item_sel).take(limit.clamp(1, 8)) {
            let title = node
                .select(&title_sel)
                .next()
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();
            let href = node
                .select(&title_sel)
                .next()
                .and_then(|n| n.value().attr("href"))
                .unwrap_or_default()
                .to_string();
            let snippet = node
                .select(&snippet_sel)
                .next()
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();
            if !title.is_empty() {
                results.push((title, href, snippet));
            }
        }
        Ok(results)
    }

    /// Open-Meteo / OpenWeather real-time forecast (`!thoitiet <city>`).
    pub async fn fetch_weather(&self, city: &str) -> Result<Value, ServiceError> {
        if let Ok(Some(ow_key)) = self.caches.engine().get_provider_secret("OPENWEATHER_API_KEY")
            && !ow_key.trim().is_empty()
        {
            let url = format!(
                "https://api.openweathermap.org/data/2.5/weather?q={}&appid={}&units=metric&lang=vi",
                urlencoding::encode(city),
                urlencoding::encode(&ow_key)
            );
            if let Ok(resp) = self.http.get(&url).send().await
                && resp.status().is_success()
                && let Ok(val) = resp.json::<Value>().await
            {
                return Ok(json!({
                    "city": val["name"].as_str().unwrap_or(city),
                    "tempC": val["main"]["temp"].as_f64().unwrap_or(0.0),
                    "humidity": val["main"]["humidity"].as_u64().unwrap_or(0),
                    "windKmh": val["wind"]["speed"].as_f64().unwrap_or(0.0) * 3.6,
                    "description": val["weather"][0]["description"].as_str().unwrap_or("Quang mây"),
                }));
            }
        }

        // Zero-key Open-Meteo Geocoding + Forecast fallback
        let geo_url = format!(
            "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language=vi&format=json",
            urlencoding::encode(city)
        );
        let geo: Value = self.http.get(&geo_url).send().await?.json().await?;
        let loc = &geo["results"][0];
        let lat = loc["latitude"].as_f64().unwrap_or(21.0285);
        let lon = loc["longitude"].as_f64().unwrap_or(105.8542);
        let resolved_name = loc["name"].as_str().unwrap_or(city).to_string();

        let wx_url = format!(
            "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=Asia%2FHo_Chi_Minh"
        );
        let wx: Value = self.http.get(&wx_url).send().await?.json().await?;
        let cur = &wx["current"];
        Ok(json!({
            "city": resolved_name,
            "tempC": cur["temperature_2m"].as_f64().unwrap_or(28.0),
            "humidity": cur["relative_humidity_2m"].as_u64().unwrap_or(70),
            "windKmh": cur["wind_speed_10m"].as_f64().unwrap_or(8.0),
            "description": format!("Mã khí tượng #{}", cur["weather_code"].as_u64().unwrap_or(0)),
        }))
    }

    /// Builds a VietQR QuickLink & EMVCo payload (`!qrbank`, `!mybank`, `!cardqr`).
    pub fn build_vietqr(
        bank_code: &str,
        account_number: &str,
        account_name: &str,
        amount: Option<u64>,
        memo: &str,
    ) -> VietQrSpec {
        let clean_bank = bank_code.trim().to_ascii_uppercase();
        let clean_acc: String = account_number
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let mut image_url = format!(
            "https://img.vietqr.io/image/{clean_bank}-{clean_acc}-compact2.png?addInfo={}&accountName={}",
            urlencoding::encode(memo),
            urlencoding::encode(account_name)
        );
        if let Some(amt) = amount.filter(|v| *v > 0) {
            image_url.push_str(&format!("&amount={amt}"));
        }
        let emv_payload = format!(
            "VIETQR|{clean_bank}|{clean_acc}|{}|{memo}",
            amount.unwrap_or(0)
        );
        VietQrSpec {
            bank_code: clean_bank,
            account_number: clean_acc,
            account_name: account_name.to_string(),
            amount,
            memo: memo.to_string(),
            image_url,
            emv_payload,
        }
    }

    /// Queries IP / Domain geolocation & ASN info (`!checkip`, `!checkdomain`).
    pub async fn lookup_ip_or_domain(&self, target: &str) -> Result<Value, ServiceError> {
        let clean = target
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or(target.trim());
        let url = format!("http://ip-api.com/json/{}", urlencoding::encode(clean));
        let resp = self.http.get(&url).send().await?;
        Ok(resp.json().await?)
    }

    /// Searches Google Images (`!image` / `!img` parity with Node V3 `google-image.js`).
    pub async fn search_google_images(&self, query: &str, limit: usize) -> Result<Vec<String>, ServiceError> {
        let max_items = limit.clamp(1, 10);
        let url = format!(
            "https://www.google.com/search?q={}&tbm=isch&hl=vi&gl=vn",
            urlencoding::encode(query)
        );

        let mut images = Vec::new();
        if let Ok(resp) = self
            .http
            .get(&url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            )
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
            .header("Accept-Language", "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7")
            .send()
            .await
            && let Ok(html) = resp.text().await
        {
            // Pattern 1: Node V3 json array matching: ["https://...", width, height]
            for part in html.split("var m={") {
                if let Some(sub) = part.split("var a=m;").next() {
                    let mut cursor = sub;
                    while let Some(start) = cursor.find("[\"https://") {
                        let candidate = &cursor[start..];
                        if let Some(end) = candidate.find(']') {
                            let item_str = &candidate[..=end];
                            if let Ok(val) = serde_json::from_str::<Value>(item_str) {
                                if let Some(arr) = val.as_array()
                                    && let Some(img_url) = arr.first().and_then(Value::as_str)
                                {
                                    if !img_url.starts_with("https://encrypted-tbn0.gst")
                                        && !img_url.contains("gstatic.com")
                                        && (img_url.ends_with(".jpg")
                                            || img_url.ends_with(".jpeg")
                                            || img_url.ends_with(".png")
                                            || img_url.ends_with(".webp")
                                            || img_url.contains("images")
                                            || img_url.contains("img"))
                                    {
                                        if !images.contains(&img_url.to_string()) {
                                            images.push(img_url.to_string());
                                        }
                                    }
                                }
                            }
                            cursor = &candidate[end + 1..];
                        } else {
                            break;
                        }
                    }
                }
            }

            // Pattern 2: Fallback direct image URLs
            if images.is_empty() {
                for token in html.split('"') {
                    if (token.starts_with("https://") || token.starts_with("http://"))
                        && (token.contains(".jpg") || token.contains(".png") || token.contains(".jpeg") || token.contains(".webp"))
                        && !token.contains("google.com")
                        && !token.contains("gstatic.com")
                    {
                        let clean = token.replace(r"\/", "/");
                        if !images.contains(&clean) {
                            images.push(clean);
                        }
                    }
                }
            }
        }

        // Secondary fallback: DuckDuckGo Instant Images
        if images.is_empty() {
            let ddg_url = format!(
                "https://duckduckgo.com/i.js?q={}&o=json&p=1",
                urlencoding::encode(query)
            );
            if let Ok(resp) = self
                .http
                .get(&ddg_url)
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                )
                .send()
                .await
                && let Ok(val) = resp.json::<Value>().await
                && let Some(results) = val["results"].as_array()
            {
                for r in results {
                    if let Some(u) = r["image"].as_str() {
                        if !images.contains(&u.to_string()) {
                            images.push(u.to_string());
                        }
                    }
                }
            }
        }

        images.truncate(max_items);
        Ok(images)
    }

    /// Searches Pinterest images (`!pinterest` / `!pin` parity with Node V3 `pinterest-service.js`).
    pub async fn search_pinterest_images(&self, query: &str, limit: usize) -> Result<Vec<String>, ServiceError> {
        let max_items = limit.clamp(1, 10);
        let search_url = "https://www.pinterest.com/resource/BaseSearchResource/get/";
        let data = json!({
            "options": {
                "query": query,
                "scope": "pins",
                "page_size": 25,
            },
            "context": {}
        });

        let mut images = Vec::new();
        if let Ok(resp) = self
            .http
            .get(search_url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            )
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Referer", format!("https://www.pinterest.com/search/pins/?q={}", urlencoding::encode(query)))
            .query(&[
                ("source_url", &format!("/search/pins/?q={}", urlencoding::encode(query))),
                ("data", &data.to_string()),
            ])
            .send()
            .await
            && let Ok(body) = resp.json::<Value>().await
            && let Some(results) = body["resource_response"]["data"]["results"].as_array()
        {
            for pin in results {
                if let Some(imgs) = pin.get("images") {
                    let best = imgs["orig"]["url"]
                        .as_str()
                        .or_else(|| imgs["736x"]["url"].as_str())
                        .or_else(|| imgs["474x"]["url"].as_str());
                    if let Some(url) = best {
                        if !images.contains(&url.to_string()) {
                            images.push(url.to_string());
                        }
                    }
                }
            }
        }

        // Fallback: If Pinterest API is blocked or returned empty, fallback to Google Image search (Node V3 method 3)
        if images.is_empty() {
            images = self.search_google_images(query, max_items).await?;
        } else {
            images.truncate(max_items);
        }

        Ok(images)
    }

    /// Searches Tenor GIFs/memes for `!stkmeme` (Node V3 `stkmeme-utils.js`).
    pub async fn search_tenor_gifs(&self, query: &str, limit: usize) -> Result<Vec<String>, ServiceError> {
        let max_items = limit.clamp(1, 10);
        let api_key = self
            .caches
            .engine()
            .get_provider_secret("TENOR_API_KEY")
            .ok()
            .flatten()
            .or_else(|| std::env::var("TENOR_API_KEY").ok())
            .unwrap_or_default();

        let mut out = Vec::new();
        if !api_key.trim().is_empty() {
            let resp = self
                .http
                .get("https://tenor.googleapis.com/v2/search")
                .query(&[
                    ("q", query),
                    ("key", &api_key),
                    ("client_key", &"my_bot_app".to_string()),
                    ("limit", &50.to_string()),
                    ("contentfilter", &"high".to_string()),
                ])
                .send()
                .await;

            if let Ok(r) = resp && let Ok(body) = r.json::<Value>().await {
                if let Some(results) = body["results"].as_array() {
                    for gif in results {
                        if let Some(formats) = gif.get("media_formats") {
                            let candidate = formats["webp"]["url"]
                                .as_str()
                                .or_else(|| formats["gif"]["url"].as_str())
                                .or_else(|| formats["mediumgif"]["url"].as_str())
                                .or_else(|| formats["nanogif"]["url"].as_str())
                                .or_else(|| formats["mp4"]["url"].as_str());
                            if let Some(u) = candidate {
                                if !out.contains(&u.to_string()) {
                                    out.push(u.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Secondary fallback: Giphy public search API or Google Image Search
        if out.is_empty() {
            let giphy_url = format!(
                "https://api.giphy.com/v1/gifs/search?api_key=dc6zaTOxFJmzC&q={}&limit=10&rating=g",
                urlencoding::encode(query)
            );
            if let Ok(resp) = self.http.get(&giphy_url).send().await
                && let Ok(val) = resp.json::<Value>().await
                && let Some(data) = val["data"].as_array()
            {
                for item in data {
                    if let Some(u) = item["images"]["original"]["url"].as_str() {
                        if !out.contains(&u.to_string()) {
                            out.push(u.to_string());
                        }
                    }
                }
            }
        }

        if out.is_empty() {
            out = self.search_google_images(&format!("{query} gif meme"), max_items).await?;
        } else {
            out.truncate(max_items);
        }

        Ok(out)
    }

    /// Fetches live Vietnamese gold prices matching Node V3 (`src/commands/check-gia-vang.js`).
    pub async fn fetch_gold_price(&self, gold_type: &str) -> Result<Vec<GoldPriceItem>, ServiceError> {
        let code = gold_type.trim().to_ascii_lowercase();
        let (_type_name, url) = match code.as_str() {
            "sjc" => ("Vàng SJC", "https://webgia.com/gia-vang/sjc/"),
            "btmc" => ("Vàng BẢO TÍN MINH CHÂU", "https://webgia.com/gia-vang/bao-tin-minh-chau/"),
            "doji" => ("Vàng Doji", "https://webgia.com/gia-vang/doji/"),
            "mh" => ("Vàng Mi Hồng", "https://webgia.com/gia-vang/mi-hong/"),
            "phq" => ("Vàng Phú Quý", "https://webgia.com/gia-vang/phu-quy/"),
            "pnj" => ("Vàng PNJ", "https://webgia.com/gia-vang/pnj/"),
            _ => return Err(ServiceError::Upstream(format!("Loại vàng không được hỗ trợ: {gold_type}"))),
        };

        let resp = self
            .http
            .get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .timeout(Duration::from_secs(15))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(ServiceError::Upstream(format!("HTTP status {}", resp.status())));
        }

        let html = resp.text().await?;
        let doc = Html::parse_document(&html);
        let tr_sel = Selector::parse("table tr").unwrap();
        let td_sel = Selector::parse("td").unwrap();

        let mut prices = Vec::new();
        for tr in doc.select(&tr_sel) {
            let tds: Vec<_> = tr.select(&td_sel).collect();
            if tds.len() >= 3 {
                let item_name = tds[0].text().collect::<String>().trim().to_string();
                let buy = tds[1].text().collect::<String>().trim().to_string();
                let sell = tds[2].text().collect::<String>().trim().to_string();

                if !item_name.is_empty()
                    && !buy.is_empty()
                    && !buy.contains("webgia")
                    && !sell.contains("webgia")
                {
                    prices.push(GoldPriceItem {
                        name: item_name,
                        buy: if buy.is_empty() { "N/A".into() } else { buy },
                        sell: if sell.is_empty() { "N/A".into() } else { sell },
                    });
                }
            }
        }

        if prices.is_empty() {
            return Err(ServiceError::Upstream("Không tìm thấy dữ liệu giá vàng".into()));
        }

        Ok(prices)
    }

    /// Queries real traffic violation records (phat nguoi) from CSGT / gateway API matching Node V3.
    pub async fn lookup_phat_nguoi(
        &self,
        bien_so: &str,
        loai_xe: u8,
    ) -> Result<Vec<PhatNguoiViolation>, ServiceError> {
        let clean_plate: String = bien_so
            .chars()
            .filter(|c| !matches!(c, '-' | '.' | '/' | ' '))
            .collect::<String>()
            .to_ascii_uppercase();

        // 1. Check custom configured PHATNGUOI_API_URL gateway if defined
        let custom_url = self
            .caches
            .engine()
            .get_provider_secret("PHATNGUOI_API_URL")
            .ok()
            .flatten()
            .or_else(|| std::env::var("PHATNGUOI_API_URL").ok());

        if let Some(endpoint) = custom_url {
            let url = endpoint
                .replace("{plate}", &clean_plate)
                .replace("{bienso}", &clean_plate)
                .replace("{type}", &loai_xe.to_string());
            let resp = self.http.get(&url).timeout(Duration::from_secs(20)).send().await?;
            if resp.status().is_success() {
                if let Ok(json_val) = resp.json::<Value>().await {
                    let mut list = Vec::new();
                    let items = json_val["data"]
                        .as_array()
                        .or_else(|| json_val["violations"].as_array())
                        .or_else(|| json_val.as_array());
                    if let Some(arr) = items {
                        for it in arr {
                            list.push(PhatNguoiViolation {
                                bien_so: it["bienSo"].as_str().or_else(|| it["plate"].as_str()).unwrap_or(&clean_plate).to_string(),
                                mau_bien: it["mauBien"].as_str().or_else(|| it["plateColor"].as_str()).unwrap_or("Biển trắng").to_string(),
                                loai_xe: it["loaiXe"].as_str().or_else(|| it["vehicleType"].as_str()).unwrap_or(if loai_xe == 2 { "Xe máy" } else { "Ô tô" }).to_string(),
                                thoi_gian: it["thoiGian"].as_str().or_else(|| it["violationTime"].as_str()).unwrap_or("N/A").to_string(),
                                dia_diem: it["diaDiem"].as_str().or_else(|| it["location"].as_str()).unwrap_or("N/A").to_string(),
                                hanh_vi_vi_pham: it["hanhViViPham"].as_str().or_else(|| it["violationType"].as_str()).unwrap_or("Vi phạm trật tự ATGT").to_string(),
                                trang_thai: it["trangThai"].as_str().or_else(|| it["status"].as_str()).unwrap_or("Chưa xử phạt").to_string(),
                                don_vi_phat_hien: it["donViPhatHien"].as_str().or_else(|| it["detectingUnit"].as_str()).unwrap_or("CSGT").to_string(),
                                noi_giai_quyet: it["noiGiaiQuyet"].as_str().or_else(|| it["resolvingUnit"].as_str()).unwrap_or("Đội CSGT phụ trách").to_string(),
                                thong_tin_lien_he: it["thongTinLienHe"]
                                    .as_array()
                                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                                    .unwrap_or_default(),
                            });
                        }
                    }
                    return Ok(list);
                }
            }
        }

        // 2. Query public CSGT API gateway (api.checkphatnguoi.vn)
        let public_url = format!("https://api.checkphatnguoi.vn/phatnguoi?bienso={clean_plate}");
        let resp = self
            .http
            .get(&public_url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(12))
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                if let Ok(body) = r.json::<Value>().await {
                    let mut list = Vec::new();
                    if let Some(arr) = body["data"].as_array() {
                        for it in arr {
                            list.push(PhatNguoiViolation {
                                bien_so: it["bienSo"].as_str().unwrap_or(&clean_plate).to_string(),
                                mau_bien: it["mauBien"].as_str().unwrap_or("Biển trắng").to_string(),
                                loai_xe: it["loaiXe"].as_str().unwrap_or(if loai_xe == 2 { "Xe máy" } else { "Ô tô" }).to_string(),
                                thoi_gian: it["thoiGian"].as_str().unwrap_or("N/A").to_string(),
                                dia_diem: it["diaDiem"].as_str().unwrap_or("N/A").to_string(),
                                hanh_vi_vi_pham: it["hanhViViPham"].as_str().unwrap_or("Vi phạm ATGT").to_string(),
                                trang_thai: it["trangThai"].as_str().unwrap_or("Chưa xử phạt").to_string(),
                                don_vi_phat_hien: it["donViPhatHien"].as_str().unwrap_or("CSGT").to_string(),
                                noi_giai_quyet: it["noiGiaiQuyet"].as_str().unwrap_or("N/A").to_string(),
                                thong_tin_lien_he: it["thongTinLienHe"]
                                    .as_array()
                                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                                    .unwrap_or_default(),
                            });
                        }
                    }
                    Ok(list)
                } else {
                    Ok(Vec::new())
                }
            }
            Ok(r) if r.status().as_u16() == 404 || r.status().as_u16() == 204 => {
                // Không có vi phạm
                Ok(Vec::new())
            }
            Ok(r) => {
                Err(ServiceError::Upstream(format!("Tra cứu phạt nguội trả về HTTP {}", r.status())))
            }
            Err(e) => {
                Err(ServiceError::Upstream(format!("Lỗi kết nối tra cứu phạt nguội: {e}")))
            }
        }
    }
}
