//! Media URL Pool Manager & Concurrent Health Checker (`data-send/*.txt`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use crate::{MediaError, ensure_rustls_provider};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolHealthReport {
    pub category: String,
    pub total_urls: usize,
    pub alive_urls: usize,
    pub dead_urls: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolCleanResult {
    pub category: String,
    pub total: usize,
    pub alive: usize,
    pub dead: usize,
    pub removed_file: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct VideoPoolManager {
    pool_dir: PathBuf,
    pools: Arc<DashMap<String, Vec<String>>>,
    cursors: Arc<DashMap<String, Arc<AtomicUsize>>>,
    http: reqwest::Client,
}

impl VideoPoolManager {
    pub fn load_from_project_root(project_root: &Path) -> Self {
        ensure_rustls_provider();
        let candidates = [
            project_root.join("src/service-debug/chat-zalo/chat-special/data-send"),
            PathBuf::from("src/service-debug/chat-zalo/chat-special/data-send"),
            PathBuf::from("../src/service-debug/chat-zalo/chat-special/data-send"),
            PathBuf::from("../../src/service-debug/chat-zalo/chat-special/data-send"),
            PathBuf::from("../../../src/service-debug/chat-zalo/chat-special/data-send"),
        ];
        let pool_dir = candidates
            .into_iter()
            .find(|p| p.is_dir())
            .unwrap_or_else(|| project_root.join("src/service-debug/chat-zalo/chat-special/data-send"));

        let pools = Arc::new(DashMap::new());
        let cursors = Arc::new(DashMap::new());

        if pool_dir.is_dir()
            && let Ok(entries) = fs::read_dir(&pool_dir)
        {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("txt") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let key = stem.to_ascii_lowercase();
                if key.ends_with("_backup") || key.ends_with("_deleted") || key == "help" {
                    continue;
                }
                if let Ok(raw) = fs::read_to_string(&path) {
                    let urls: Vec<String> = raw
                        .lines()
                        .map(str::trim)
                        .filter(|line| line.starts_with("http://") || line.starts_with("https://"))
                        .map(ToOwned::to_owned)
                        .collect();
                    if !urls.is_empty() {
                        cursors.insert(key.clone(), Arc::new(AtomicUsize::new(0)));
                        pools.insert(key, urls);
                    }
                }
            }
        }

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) MyBotV4PoolChecker/4.0")
            .build()
            .unwrap_or_default();

        Self {
            pool_dir,
            pools,
            cursors,
            http,
        }
    }

    pub fn normalize_category(raw: &str) -> &'static str {
        match raw.trim().to_ascii_lowercase().as_str() {
            "vdgirl" | "girl" | "gai" | "vdgai" => "girl",
            "vdsexy" | "sexy" | "girlsexy" => "girlsexy",
            "girllon" => "girllon",
            "girlnguc" | "du" | "zu" => "girlnguc",
            "girlnude" | "nude" => "girlnude",
            "zgirl" | "anhgirl" => "zgirl",
            "vdboy" | "boy" | "trai" => "boy",
            "boy6mui" | "6mui" => "boy6mui",
            "vdanime" | "anime" => "anime",
            "vdcos" | "cosplay" | "cos" => "cosplay",
            "vdtet" | "tet" => "vdtet",
            "vdvuto" | "vuto" => "vdvuto",
            "vdchill" | "chill" => "vdchill",
            "vdsad" | "sad" => "vdsad",
            "vdsex" => "vdsex",
            _ => "",
        }
    }

    pub fn pool_dir(&self) -> &Path {
        &self.pool_dir
    }

    pub fn pool_counts(&self) -> BTreeMap<String, usize> {
        let mut out = BTreeMap::new();
        for item in self.pools.iter() {
            out.insert(item.key().clone(), item.value().len());
        }
        out
    }

    /// Lock-free round-robin / jittered selection from a media URL pool.
    pub fn pick_url(&self, category_or_command: &str) -> Option<String> {
        let trimmed = category_or_command.trim().to_ascii_lowercase();
        let key = if self.pools.contains_key(&trimmed) {
            trimmed
        } else {
            let norm = Self::normalize_category(&trimmed);
            if norm.is_empty() || !self.pools.contains_key(norm) {
                return None;
            }
            norm.to_string()
        };
        let list = self.pools.get(&key)?;
        if list.is_empty() {
            return None;
        }
        let cursor = self
            .cursors
            .entry(key)
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone();
        let idx = cursor.fetch_add(1, Ordering::Relaxed) % list.len();
        list.get(idx).cloned()
    }

    pub fn add_url(&self, category: &str, url: &str) -> usize {
        let key = category.trim().to_ascii_lowercase();
        let trimmed = url.trim().to_string();
        if trimmed.is_empty() {
            return self.pools.get(&key).map(|v| v.len()).unwrap_or(0);
        }

        let mut entry = self.pools.entry(key.clone()).or_default();
        let added = if !entry.contains(&trimmed) {
            entry.push(trimmed.clone());
            true
        } else {
            false
        };
        let total = entry.len();
        drop(entry);

        if added {
            let file_path = self.pool_dir.join(format!("{key}.txt"));
            if let Some(parent) = file_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            use std::io::Write;
            if let Ok(mut file) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file_path)
            {
                let _ = writeln!(file, "{trimmed}");
            }
        }
        total
    }

    /// Probes every URL in a category with `Range: bytes=0-1024` (`mybot-ctl check-video-pools`).
    pub async fn check_pool_health(
        &self,
        category: &str,
        concurrency: usize,
    ) -> Result<PoolHealthReport, MediaError> {
        let key = category.trim().to_ascii_lowercase();
        let urls = self
            .pools
            .get(&key)
            .map(|v| v.clone())
            .unwrap_or_default();
        let total_urls = urls.len();
        let client = self.http.clone();

        let results: Vec<(String, bool)> = stream::iter(urls)
            .map(|url| {
                let client = client.clone();
                async move {
                    let ok = match client
                        .get(&url)
                        .header(reqwest::header::RANGE, "bytes=0-1024")
                        .send()
                        .await
                    {
                        Ok(resp) => resp.status().is_success() || resp.status().as_u16() == 206,
                        Err(_) => false,
                    };
                    (url, ok)
                }
            })
            .buffer_unordered(concurrency.clamp(1, 64))
            .collect()
            .await;

        let mut dead_urls = Vec::new();
        let mut alive_urls = 0usize;
        for (url, ok) in results {
            if ok {
                alive_urls += 1;
            } else {
                dead_urls.push(url);
            }
        }

        Ok(PoolHealthReport {
            category: key,
            total_urls,
            alive_urls,
            dead_urls,
        })
    }

    /// Sanitizes category/file name, stripping `.txt` and preventing path traversal (`data-manager.js::resolveSafeDataFilePath`).
    pub fn sanitize_category_name(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.contains("..")
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.contains('\0')
        {
            return None;
        }
        let clean = trimmed.strip_suffix(".txt").unwrap_or(trimmed).trim();
        if clean.is_empty() || clean == "." || clean == ".." {
            return None;
        }
        Some(clean.to_ascii_lowercase())
    }

    /// Lists all `.txt` pool files stored in `data-send/`.
    pub fn list_pool_files(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.pool_dir.is_dir()
            && let Ok(entries) = fs::read_dir(&self.pool_dir)
        {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("txt") {
                    continue;
                }
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    let lower = name.to_ascii_lowercase();
                    if !lower.ends_with("_backup.txt")
                        && !lower.ends_with("_deleted.txt")
                        && !lower.ends_with("_removed.txt")
                    {
                        out.push(name.to_string());
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// Number of URLs currently registered for a category.
    pub fn count_urls(&self, category: &str) -> usize {
        let key = category.trim().to_ascii_lowercase();
        self.pools.get(&key).map(|v| v.len()).unwrap_or(0)
    }

    /// In-memory snapshot of URLs for a category.
    pub fn get_urls(&self, category: &str) -> Vec<String> {
        let key = category.trim().to_ascii_lowercase();
        self.pools.get(&key).map(|v| v.clone()).unwrap_or_default()
    }

    /// Creates an empty pool file in `data-send/<category>.txt` and prepares an in-memory entry.
    pub fn create_category_file(&self, category: &str) -> Result<PathBuf, MediaError> {
        let key = Self::sanitize_category_name(category)
            .ok_or_else(|| MediaError::InvalidFormat("Tên danh mục / file không hợp lệ".into()))?;
        let _ = fs::create_dir_all(&self.pool_dir);
        let path = self.pool_dir.join(format!("{key}.txt"));
        if path.exists() {
            return Err(MediaError::InvalidFormat(format!("File '{key}.txt' đã tồn tại.")));
        }
        fs::write(&path, "")?;
        self.pools.entry(key.clone()).or_default();
        Ok(path)
    }

    /// Removes a URL from in-memory pool and rewrites the backing `.txt` file.
    pub fn remove_url(&self, category: &str, url: &str) -> bool {
        let key = category.trim().to_ascii_lowercase();
        let target = url.trim();
        let mut removed = false;
        if let Some(mut entry) = self.pools.get_mut(&key) {
            let before = entry.len();
            entry.retain(|u| u.trim() != target);
            if entry.len() < before {
                removed = true;
                let path = self.pool_dir.join(format!("{key}.txt"));
                let content = if entry.is_empty() {
                    String::new()
                } else {
                    format!("{}\n", entry.join("\n"))
                };
                let _ = fs::write(&path, content);
            }
        }
        removed
    }

    /// Deletes a category pool `.txt` file and removes it from RAM.
    pub fn remove_category_file(&self, category: &str) -> bool {
        let key = category.trim().to_ascii_lowercase();
        self.pools.remove(&key);
        self.cursors.remove(&key);
        let path = self.pool_dir.join(format!("{key}.txt"));
        if path.exists() {
            fs::remove_file(&path).is_ok()
        } else {
            false
        }
    }

    /// Concurrently checks links in `data-send/<file>.txt`, filters dead links,
    /// rewrites surviving links, updates RAM immediately, and saves dead links to `removed-links/<file>_removed.txt`.
    pub async fn check_and_clean_pool(
        &self,
        category_or_file: &str,
        concurrency: usize,
    ) -> Result<PoolCleanResult, MediaError> {
        let key = Self::sanitize_category_name(category_or_file)
            .ok_or_else(|| MediaError::InvalidFormat("Tên file/kho không hợp lệ".into()))?;

        let file_path = self.pool_dir.join(format!("{key}.txt"));
        let urls: Vec<String> = if file_path.exists() {
            let content = fs::read_to_string(&file_path)?;
            content
                .lines()
                .map(str::trim)
                .filter(|line| {
                    !line.is_empty()
                        && !line.starts_with('#')
                        && (line.starts_with("http://") || line.starts_with("https://"))
                })
                .map(ToOwned::to_owned)
                .collect()
        } else if let Some(in_mem) = self.pools.get(&key) {
            in_mem.clone()
        } else {
            return Err(MediaError::NotFound(format!("Không tìm thấy file {key}.txt")));
        };

        if urls.is_empty() {
            return Err(MediaError::InvalidFormat(format!("File {key}.txt không chứa link hợp lệ nào.")));
        }

        // Deduplicate links while preserving order
        let mut unique_urls = Vec::new();
        for u in urls {
            if !unique_urls.contains(&u) {
                unique_urls.push(u);
            }
        }
        let total = unique_urls.len();

        let client = self.http.clone();
        let results: Vec<(String, bool)> = stream::iter(unique_urls)
            .map(|url| {
                let client = client.clone();
                async move {
                    let ok = match client
                        .head(&url)
                        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (compatible; LinkChecker/1.0)")
                        .send()
                        .await
                    {
                        Ok(resp) => {
                            let s = resp.status();
                            if s.is_success() || s.is_redirection() {
                                true
                            } else if s.as_u16() == 405 || s.as_u16() == 403 {
                                match client
                                    .get(&url)
                                    .header(reqwest::header::RANGE, "bytes=0-1024")
                                    .send()
                                    .await
                                {
                                    Ok(get_resp) => {
                                        let gs = get_resp.status();
                                        gs.is_success() || gs.as_u16() == 206
                                    }
                                    Err(_) => false,
                                }
                            } else {
                                false
                            }
                        }
                        Err(_) => {
                            match client
                                .get(&url)
                                .header(reqwest::header::RANGE, "bytes=0-1024")
                                .send()
                                .await
                            {
                                Ok(get_resp) => {
                                    let gs = get_resp.status();
                                    gs.is_success() || gs.as_u16() == 206
                                }
                                Err(_) => false,
                            }
                        }
                    };
                    (url, ok)
                }
            })
            .buffer_unordered(concurrency.clamp(1, 32))
            .collect()
            .await;

        let mut alive_urls = Vec::new();
        let mut dead_urls = Vec::new();
        for (url, ok) in results {
            if ok {
                alive_urls.push(url);
            } else {
                dead_urls.push(url);
            }
        }

        let alive = alive_urls.len();
        let dead = dead_urls.len();

        // 1. Rewrite the pool file with alive urls
        let updated_content = if alive_urls.is_empty() {
            "# No valid links left\n".to_string()
        } else {
            format!("{}\n", alive_urls.join("\n"))
        };
        let _ = fs::write(&file_path, updated_content);

        // 2. Immediately update in-memory pool
        self.pools.insert(key.clone(), alive_urls);

        // 3. Save dead links to removed-links/<file>_removed.txt
        let removed_file = if !dead_urls.is_empty() {
            let removed_dir = self.pool_dir.join("removed-links");
            let _ = fs::create_dir_all(&removed_dir);
            let removed_path = removed_dir.join(format!("{key}_removed.txt"));
            use std::io::Write;
            if let Ok(mut rf) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&removed_path)
            {
                let _ = writeln!(rf, "# Links đã lọc từ file {key}.txt");
                for d in &dead_urls {
                    let _ = writeln!(rf, "{d}");
                }
            }
            Some(removed_path)
        } else {
            None
        };

        Ok(PoolCleanResult {
            category: key,
            total,
            alive,
            dead,
            removed_file,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::VideoPoolManager;

    #[test]
    fn added_local_pool_url_survives_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("src/service-debug/chat-zalo/chat-special/data-send");
        std::fs::create_dir_all(&dir).unwrap();
        let pools = VideoPoolManager::load_from_project_root(tmp.path());
        pools.add_url("vdtet", "https://example.test/tet.mp4");
        let reloaded = VideoPoolManager::load_from_project_root(tmp.path());
        assert_eq!(reloaded.pick_url("vdtet").as_deref(), Some("https://example.test/tet.mp4"));
    }

    #[test]
    fn absent_category_does_not_use_girl_pool() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("src/service-debug/chat-zalo/chat-special/data-send");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("girl.txt"), "https://example.test/girl.mp4\n").unwrap();
        let pools = VideoPoolManager::load_from_project_root(tmp.path());
        assert!(pools.pick_url("vdtet").is_none());
    }

    #[tokio::test]
    async fn pool_management_and_filter_dead_links_work() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("src/service-debug/chat-zalo/chat-special/data-send");
        std::fs::create_dir_all(&dir).unwrap();

        let pools = VideoPoolManager::load_from_project_root(tmp.path());

        // Sanitization
        assert_eq!(VideoPoolManager::sanitize_category_name("girl.txt").as_deref(), Some("girl"));
        assert_eq!(VideoPoolManager::sanitize_category_name("  Anime  ").as_deref(), Some("anime"));
        assert!(VideoPoolManager::sanitize_category_name("../etc/passwd").is_none());
        assert!(VideoPoolManager::sanitize_category_name("").is_none());

        // Create category
        let path = pools.create_category_file("testcat").unwrap();
        assert!(path.exists());
        assert!(pools.list_pool_files().contains(&"testcat.txt".to_string()));

        // Add URL
        let total = pools.add_url("testcat", "https://127.0.0.1:9/dead.mp4");
        assert_eq!(total, 1);
        assert_eq!(pools.count_urls("testcat"), 1);

        // Check & clean: unreachable 127.0.0.1:9 will be marked dead and moved
        let summary = pools.check_and_clean_pool("testcat", 2).await.unwrap();
        assert_eq!(summary.total, 1);
        assert_eq!(summary.alive, 0);
        assert_eq!(summary.dead, 1);
        assert_eq!(pools.count_urls("testcat"), 0);

        let removed_path = dir.join("removed-links/testcat_removed.txt");
        assert!(removed_path.exists());
        let removed_content = std::fs::read_to_string(&removed_path).unwrap();
        assert!(removed_content.contains("https://127.0.0.1:9/dead.mp4"));

        // Remove category
        assert!(pools.remove_category_file("testcat"));
        assert!(!path.exists());
    }
}
