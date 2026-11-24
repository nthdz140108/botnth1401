//! AI Provider Clients (`Gemini`, `Imagen`, `GPT/OpenAI`, `DeepSeek`, `HuggingFace FLUX`, `SimSimi` & Learned Q&A).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine as _;
use mybot_storage::HotStorageCaches;
use serde_json::{Value, json};

use crate::ServiceError;

#[derive(Clone)]
pub struct AiServiceHub {
    caches: HotStorageCaches,
    http: reqwest::Client,
    gemini_cursor: std::sync::Arc<AtomicUsize>,
}

impl std::fmt::Debug for AiServiceHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiServiceHub").finish()
    }
}

impl AiServiceHub {
    pub fn new(caches: HotStorageCaches) -> Self {
        zalo_sdk::ensure_rustls_ring_provider();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .user_agent("MyBotV4-AiEngine/4.0 (Linux; x86_64)")
            .build()
            .unwrap_or_default();
        Self {
            caches,
            http,
            gemini_cursor: std::sync::Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn resolve_secret(&self, key: &str) -> Option<String> {
        if let Ok(Some(val)) = self.caches.engine().get_provider_secret(key)
            && !val.trim().is_empty()
        {
            return Some(val);
        }
        std::env::var(key)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn pick_gemini_key(&self) -> Option<String> {
        let raw = self
            .resolve_secret("GEMINI_API_KEYS")
            .or_else(|| self.resolve_secret("GEMINI_API_KEY"))?;
        let keys: Vec<&str> = raw
            .split([',', ';', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if keys.is_empty() {
            return None;
        }
        let idx = self.gemini_cursor.fetch_add(1, Ordering::Relaxed) % keys.len();
        Some(keys[idx].to_string())
    }

    /// Queries Gemini (`gemini-2.0-flash`) with optional multimodal image URL (`!gemini`, `!analysis-image`, `!genminiv1`).
    pub async fn ask_gemini(
        &self,
        prompt: &str,
        image_url: Option<&str>,
    ) -> Result<String, ServiceError> {
        let Some(api_key) = self.pick_gemini_key() else {
            return Err(ServiceError::MissingSecret("GEMINI_API_KEYS".into()));
        };

        let mut parts = vec![json!({ "text": prompt })];
        if let Some(url) = image_url
            && let Ok(resp) = self.http.get(url).send().await
            && resp.status().is_success()
        {
            let mime = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            if let Ok(bytes) = resp.bytes().await {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                parts.push(json!({
                    "inline_data": {
                        "mime_type": mime,
                        "data": b64
                    }
                }));
            }
        }

        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}"
        );
        let body = json!({
            "contents": [{ "parts": parts }],
            "generationConfig": { "temperature": 0.7, "maxOutputTokens": 2048 }
        });

        let resp = self.http.post(&endpoint).json(&body).send().await?;
        if !resp.status().is_success() {
            return Err(ServiceError::Upstream(format!(
                "Gemini HTTP {}",
                resp.status().as_u16()
            )));
        }
        let payload: Value = resp.json().await?;
        let text = payload["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or("Không có phản hồi từ Gemini.")
            .trim()
            .to_string();
        Ok(text)
    }

    /// Queries OpenAI-compatible chat completions (`!gpt`, `!deepseek`, `!dich`, `!googlesearchai`).
    pub async fn ask_chat_llm(
        &self,
        provider_hint: &str,
        prompt: &str,
    ) -> Result<String, ServiceError> {
        let (base_url, api_key, model) = if provider_hint.eq_ignore_ascii_case("deepseek") {
            let key = self
                .resolve_secret("DEEPSEEK_API_KEY")
                .or_else(|| self.resolve_secret("KIRA_API_KEY"))
                .or_else(|| self.resolve_secret("OPENAI_API_KEY"));
            (
                self.resolve_secret("DEEPSEEK_BASE_URL")
                    .unwrap_or_else(|| "https://api.deepseek.com/v1".into()),
                key,
                "deepseek-chat",
            )
        } else {
            let key = self
                .resolve_secret("OPENAI_API_KEY")
                .or_else(|| self.resolve_secret("KIRA_API_KEY"));
            (
                self.resolve_secret("OPENAI_BASE_URL")
                    .unwrap_or_else(|| "https://api.openai.com/v1".into()),
                key,
                "gpt-4o-mini",
            )
        };

        let Some(api_key) = api_key else {
            // Try Gemini seamless fallback if configured!
            if self.pick_gemini_key().is_some() {
                return self.ask_gemini(prompt, None).await;
            }
            return Err(ServiceError::MissingSecret("OPENAI_API_KEY / KIRA_API_KEY".into()));
        };

        let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(&endpoint)
            .bearer_auth(api_key)
            .json(&json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": "Bạn là trợ lý AI MyBot V4 tốc độ cao trên Zalo, trả lời ngắn gọn, chính xác bằng tiếng Việt." },
                    { "role": "user", "content": prompt }
                ],
                "temperature": 0.7
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(ServiceError::Upstream(format!(
                "LLM HTTP {}",
                resp.status().as_u16()
            )));
        }
        let body: Value = resp.json().await?;
        Ok(body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("Không có phản hồi.")
            .trim()
            .to_string())
    }

    /// Generates an AI image (`!gemini make`, `!create-image`, `!createimageai`, `!sticker ai`).
    pub async fn generate_ai_image(&self, prompt: &str) -> Result<Vec<u8>, ServiceError> {
        // 1. HuggingFace Inference API (`HF_TOKEN` / `HUGGINGFACE_API_KEY`) if present
        if let Some(hf_key) = self
            .resolve_secret("HUGGINGFACE_API_KEY")
            .or_else(|| self.resolve_secret("HF_TOKEN"))
        {
            let resp = self
                .http
                .post("https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell")
                .bearer_auth(hf_key)
                .json(&json!({ "inputs": prompt }))
                .send()
                .await?;
            if resp.status().is_success() {
                let bytes = resp.bytes().await?;
                if bytes.len() > 512 {
                    return Ok(bytes.to_vec());
                }
            }
        }

        // 2. Zero-key Pollinations FLUX HTTP endpoint fallback
        let url = format!(
            "https://image.pollinations.ai/prompt/{}?width=1024&height=1024&nologo=true",
            urlencoding::encode(prompt)
        );
        let resp = self.http.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(ServiceError::Upstream(format!(
                "Image Gen HTTP {}",
                resp.status().as_u16()
            )));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    /// Resolves learned Q&A (`!learn` / `!learnnow`) first, then SimSimi API (`!simsimi`).
    pub async fn chat_simsimi_or_learned(
        &self,
        bot_key: &str,
        group_id: &str,
        text: &str,
    ) -> Result<String, ServiceError> {
        let norm_q = text.trim().to_lowercase();
        if let Ok(Some(answers)) = self
            .caches
            .engine()
            .lookup_learned_qa(bot_key, group_id, &norm_q)
            && let Some(first) = answers.first()
        {
            return Ok(first.clone());
        }

        if let Some(sim_key) = self.resolve_secret("SIMSIMI_API_KEY") {
            let resp = self
                .http
                .post("https://wsapi.simsimi.com/190410/talk")
                .header("x-api-key", sim_key)
                .json(&json!({ "utext": text, "lang": "vn" }))
                .send()
                .await?;
            if resp.status().is_success()
                && let Ok(body) = resp.json::<Value>().await
                && let Some(atext) = body["atext"].as_str()
            {
                return Ok(atext.to_string());
            }
        }

        Ok(format!(
            "💬 SimSimi V4: Mình đã nhận được tin \"{}\" của bạn! Dùng lệnh learnnow để dạy mình câu trả lời riêng nhé.",
            text.chars().take(80).collect::<String>()
        ))
    }
}
