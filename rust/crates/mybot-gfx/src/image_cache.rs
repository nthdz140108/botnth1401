//! Bounded in-memory LRU + async HTTP image fetcher (`ImageCache`) for `mybot-gfx`.
//!
//! Fetches Zalo avatars, group covers, music/video thumbnails, and `img.vietqr.io` QR images
//! concurrently before rendering 2D Canvas cards, with graceful fallback offline.

use std::path::Path;
use std::sync::{Arc, Once};
use std::time::Duration;

use futures::future::join_all;
use moka::sync::Cache;
use serde_json::Value;

static GFX_RUSTLS_INIT: Once = Once::new();

fn ensure_gfx_rustls() {
    GFX_RUSTLS_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

const IMAGE_JSON_KEYS: &[&str] = &[
    "avatar",
    "avatarUrl",
    "avatar_url",
    "avt",
    "cover",
    "photo",
    "thumbnail",
    "thumbnailM",
    "thumbnailPath",
    "userAvatar",
    "qrImageUrl",
    "logo",
    "iconUrl",
    "backgroundUrl",
];

#[derive(Clone)]
pub struct ImageCache {
    cache: Cache<String, Arc<Vec<u8>>>,
    http: reqwest::Client,
}

impl Default for ImageCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageCache {
    pub fn new() -> Self {
        ensure_gfx_rustls();
        let cache = Cache::builder()
            .max_capacity(512)
            .time_to_live(Duration::from_secs(30 * 60))
            .build();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .connect_timeout(Duration::from_secs(3))
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            )
            .build()
            .unwrap_or_default();
        Self { cache, http }
    }

    pub fn insert_bytes(&self, key: impl Into<String>, bytes: Vec<u8>) {
        self.cache.insert(key.into(), Arc::new(bytes));
    }

    /// Synchronous lookup from in-memory cache or local filesystem path.
    pub fn get_sync(&self, src: &str) -> Option<Arc<Vec<u8>>> {
        let trimmed = src.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(hit) = self.cache.get(trimmed) {
            return Some(hit);
        }
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            let p = Path::new(trimmed);
            if p.is_file()
                && let Ok(bytes) = std::fs::read(p)
                && !bytes.is_empty()
            {
                let arc = Arc::new(bytes);
                self.cache.insert(trimmed.to_string(), Arc::clone(&arc));
                return Some(arc);
            }
        }
        None
    }

    /// Fetches a single URL (or local file) asynchronously with 2-attempt retry and caches it.
    pub async fn fetch_one(&self, src: &str) -> Option<Arc<Vec<u8>>> {
        let trimmed = src.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(hit) = self.get_sync(trimmed) {
            return Some(hit);
        }
        if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
            return None;
        }
        for attempt in 0..2 {
            if let Ok(resp) = self.http.get(trimmed).send().await
                && resp.status().is_success()
                && let Ok(bytes) = resp.bytes().await
                && bytes.len() > 64
                && bytes.len() <= 12 * 1024 * 1024
            {
                let arc = Arc::new(bytes.to_vec());
                self.cache.insert(trimmed.to_string(), Arc::clone(&arc));
                return Some(arc);
            }
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        None
    }

    /// Collects up to 36 image URLs referenced inside `data` and prefetches missing ones concurrently.
    pub async fn prefetch_json_urls(&self, data: &Value) {
        let mut urls = Vec::new();
        collect_urls(data, 0, &mut urls);
        urls.sort();
        urls.dedup();
        urls.truncate(36);

        let missing: Vec<String> = urls
            .into_iter()
            .filter(|u| self.cache.get(u.as_str()).is_none())
            .collect();
        if missing.is_empty() {
            return;
        }
        let futs = missing.iter().map(|u| self.fetch_one(u));
        let _ = join_all(futs).await;
    }
}

fn collect_urls(v: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 5 || out.len() >= 48 {
        return;
    }
    match v {
        Value::Object(map) => {
            for (k, val) in map {
                if let Some(s) = val.as_str() {
                    let st = s.trim();
                    if (st.starts_with("http://") || st.starts_with("https://"))
                        && IMAGE_JSON_KEYS.iter().any(|ik| ik.eq_ignore_ascii_case(k))
                    {
                        out.push(st.to_string());
                    }
                } else {
                    collect_urls(val, depth + 1, out);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr.iter().take(36) {
                collect_urls(item, depth + 1, out);
            }
        }
        _ => {}
    }
}
