//! Loopback HMAC Client for the Node.js Hybrid Bridge.
//!
//! When `MYBOT_NODE_HYBRID=true`, the Rust V4 Central Dashboard delegates bot execution,
//! lifecycle actions (start/stop/restart), group shield settings, and web command console
//! execution to the Node.js Bridge on `127.0.0.1:4174`.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures::StreamExt;
use mybot_core::sign_internal_payload;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::{Value, json};
use socketioxide::SocketIo;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct NodeBridgeClient {
    pub base_url: String,
    pub secret: String,
    pub client: reqwest::Client,
}

impl NodeBridgeClient {
    pub fn from_env() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let base_url = std::env::var("MYBOT_BRIDGE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:4174".to_string());
        let secret = std::env::var("INTERNAL_API_SECRET")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "mybot-v4-internal-hmac".to_string());

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            secret,
            client,
        }
    }

    /// Preserve the Node status and error envelope: hybrid configuration has one owner.
    pub async fn management_request(&self, method: reqwest::Method, route: &str, body: Option<&Value>) -> Result<(reqwest::StatusCode, Value), String> {
        if !route.starts_with("/bridge/") || route.contains("..") || route.contains('?') || route.contains('#') {
            return Err("Invalid bridge management path".into());
        }
        let bytes = match body { Some(value) => serde_json::to_vec(value).map_err(|e| e.to_string())?, None => Vec::new() };
        let response = self.client.request(method, format!("{}{route}", self.base_url))
            .headers(self.build_signed_headers(&bytes)).body(bytes).send().await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;
        let status = response.status();
        let value = response.json::<Value>().await.map_err(|e| format!("Invalid Node bridge response: {e}"))?;
        Ok((status, value))
    }

    pub fn build_signed_headers(&self, body_bytes: &[u8]) -> HeaderMap {
        let now_ms = Utc::now().timestamp_millis();
        let sig = sign_internal_payload(&self.secret, now_ms, body_bytes);
        let req_id = format!("rust_v4_{}", Uuid::new_v4());

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Ok(v) = HeaderValue::from_str(&sig) {
            headers.insert("x-internal-signature", v);
        }
        if let Ok(v) = HeaderValue::from_str(&now_ms.to_string()) {
            headers.insert("x-internal-timestamp", v);
        }
        if let Ok(v) = HeaderValue::from_str(&req_id) {
            headers.insert("x-request-id", v);
        }
        headers
    }

    pub async fn get_snapshot(&self) -> Result<Value, String> {
        let url = format!("{}/bridge/snapshot", self.base_url);
        let headers = self.build_signed_headers(b"");
        match self.client.get(&url).headers(headers).send().await {
            Ok(res) if res.status().is_success() => {
                let json_val = res
                    .json::<Value>()
                    .await
                    .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;
                Ok(json_val.get("data").cloned().unwrap_or(json_val))
            }
            _ => {
                // Fallback to /bridge/bots
                self.get_bots().await.map(|v| v.get("data").cloned().unwrap_or(v))
            }
        }
    }

    pub async fn get_status(&self) -> Result<Value, String> {
        let url = format!("{}/bridge/status", self.base_url);
        let headers = self.build_signed_headers(b"");
        let res = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        if !res.status().is_success() {
            return Err(format!("Bridge error HTTP {}", res.status()));
        }
        res.json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))
    }

    pub async fn get_bots(&self) -> Result<Value, String> {
        let url = format!("{}/bridge/bots", self.base_url);
        let headers = self.build_signed_headers(b"");
        let res = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        if !res.status().is_success() {
            return Err(format!("Bridge error HTTP {}", res.status()));
        }
        res.json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))
    }

    pub async fn execute_bot_action(
        &self,
        bot_id: &str,
        action: &str,
        body: &Value,
    ) -> Result<Value, String> {
        let url = format!("{}/bridge/bots/{}/action", self.base_url, bot_id);
        let mut payload = body.clone();
        if !payload.is_object() {
            payload = json!({});
        }
        if let Some(map) = payload.as_object_mut() {
            map.insert("action".into(), json!(action));
        }
        let body_bytes = serde_json::to_vec(&payload).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Action failed on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val)
    }

    pub async fn put_group_settings(
        &self,
        bot_id: &str,
        group_id: &str,
        name: Option<&str>,
        settings: &Value,
    ) -> Result<Value, String> {
        let url = format!(
            "{}/bridge/bots/{}/groups/{}/settings",
            self.base_url, bot_id, group_id
        );
        let payload = json!({
            "name": name,
            "settings": settings,
        });
        let body_bytes = serde_json::to_vec(&payload).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .put(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to save group settings in Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val)
    }

    pub async fn execute_command_console(
        &self,
        bot_id: &str,
        cmd_line: &str,
        deliver_to_zalo: bool,
    ) -> Result<Value, String> {
        let url = format!("{}/bridge/bots/{}/remote/execute-command", self.base_url, bot_id);
        let payload = json!({
            "commandLine": cmd_line,
            "deliverToZalo": deliver_to_zalo,
        });
        let body_bytes = serde_json::to_vec(&payload).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Command execution failed in Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val)
    }

    pub async fn create_bot(&self, payload: &Value) -> Result<Value, String> {
        let url = format!("{}/bridge/bots", self.base_url);
        let body_bytes = serde_json::to_vec(payload).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to create bot on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val.get("data").cloned().unwrap_or(json_val))
    }

    pub async fn get_bot_qr(&self, bot_id: &str) -> Result<Value, String> {
        let url = format!("{}/bridge/bots/{}/qr/status", self.base_url, bot_id);
        let headers = self.build_signed_headers(b"");

        let res = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to query bot QR on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val.get("data").cloned().unwrap_or(json_val))
    }

    pub async fn start_bot_qr(&self, bot_id: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}/bridge/bots/{}/qr/start", self.base_url, bot_id);
        let body_bytes = serde_json::to_vec(body).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to start bot QR on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val.get("data").cloned().unwrap_or(json_val))
    }

    pub async fn cancel_bot_qr(&self, bot_id: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}/bridge/bots/{}/qr/cancel", self.base_url, bot_id);
        let body_bytes = serde_json::to_vec(body).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to cancel bot QR on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val.get("data").cloned().unwrap_or(json_val))
    }

    pub async fn update_bot_credentials(&self, bot_id: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}/bridge/bots/{}/credentials", self.base_url, bot_id);
        let body_bytes = serde_json::to_vec(body).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to update bot credentials on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val.get("data").cloned().unwrap_or(json_val))
    }

    pub async fn reconcile_sqlite(&self, bots: &[Value]) -> Result<Value, String> {
        let url = format!("{}/bridge/reconcile-sqlite", self.base_url);
        let payload = json!({ "bots": bots });
        let body_bytes = serde_json::to_vec(&payload).unwrap_or_default();
        let headers = self.build_signed_headers(&body_bytes);

        let res = self
            .client
            .post(&url)
            .headers(headers)
            .body(body_bytes)
            .send()
            .await
            .map_err(|e| format!("Node bridge connection failed: {e}"))?;

        let status = res.status();
        let json_val = res
            .json::<Value>()
            .await
            .map_err(|e| format!("Failed to parse bridge JSON: {e}"))?;

        if !status.is_success() {
            let msg = json_val["error"]["message"]
                .as_str()
                .unwrap_or("Failed to reconcile SQLite bots on Node bridge");
            return Err(msg.to_string());
        }
        Ok(json_val.get("data").cloned().unwrap_or(json_val))
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BridgeFleetCache {
    pub boot_id: Option<String>,
    pub last_seq: u64,
    pub status_version: u64,
    pub last_seen_epoch_ms: i64,
    pub is_stale: bool,
    pub is_connected: bool,
    pub overview: Value,
    pub bots: Vec<Value>,
}

impl Default for BridgeFleetCache {
    fn default() -> Self {
        Self {
            boot_id: None,
            last_seq: 0,
            status_version: 0,
            last_seen_epoch_ms: Utc::now().timestamp_millis(),
            is_stale: false,
            is_connected: false,
            overview: json!({
                "totalBots": 0,
                "runningBots": 0,
                "stoppedBots": 0,
                "expiredBots": 0,
                "erroredBots": 0,
                "stale": false,
                "bridgeConnected": false,
                "bots": [],
            }),
            bots: Vec::new(),
        }
    }
}

impl BridgeFleetCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply_snapshot(&mut self, snapshot: &Value) {
        if let Some(boot_id) = snapshot.get("bootId").and_then(|v| v.as_str()) {
            self.boot_id = Some(boot_id.to_string());
        }
        if let Some(seq) = snapshot.get("seq").and_then(|v| v.as_u64()) {
            self.last_seq = seq;
        }
        if let Some(ver) = snapshot.get("statusVersion").and_then(|v| v.as_u64()) {
            self.status_version = ver;
        }
        if let Some(bots) = snapshot.get("bots").and_then(|v| v.as_array()) {
            self.bots = bots.clone();
        }
        if let Some(mut ov) = snapshot.get("overview").cloned() {
            if let Some(obj) = ov.as_object_mut() {
                obj.insert("stale".into(), json!(false));
                obj.insert("bridgeConnected".into(), json!(true));
                obj.insert("bots".into(), json!(self.bots));
                obj.insert("seq".into(), json!(self.last_seq));
                obj.insert("statusVersion".into(), json!(self.status_version));
            }
            self.overview = ov;
        } else {
            self.overview = json!({
                "totalBots": self.bots.len(),
                "stale": false,
                "bridgeConnected": true,
                "bots": self.bots,
                "seq": self.last_seq,
                "statusVersion": self.status_version,
            });
        }
        self.last_seen_epoch_ms = Utc::now().timestamp_millis();
        self.is_stale = false;
        self.is_connected = true;
    }

    pub fn apply_delta(&mut self, delta: &Value) {
        if let Some(seq) = delta.get("seq").and_then(|v| v.as_u64()) {
            self.last_seq = seq;
        }
        if let Some(ver) = delta.get("statusVersion").and_then(|v| v.as_u64()) {
            self.status_version = ver;
        }
        let target_id = delta
            .get("id")
            .or_else(|| delta.get("botId"))
            .or_else(|| delta.get("botKey"))
            .and_then(|v| v.as_str());

        if let Some(id) = target_id {
            for bot in &mut self.bots {
                let match_id = bot.get("id").or_else(|| bot.get("botKey")).and_then(|v| v.as_str());
                if match_id == Some(id) {
                    if let (Some(bot_obj), Some(delta_obj)) = (bot.as_object_mut(), delta.as_object()) {
                        for (k, v) in delta_obj {
                            bot_obj.insert(k.clone(), v.clone());
                        }
                    }
                    break;
                }
            }
        }
        if let Some(obj) = self.overview.as_object_mut() {
            obj.insert("stale".into(), json!(false));
            obj.insert("bridgeConnected".into(), json!(true));
            obj.insert("bots".into(), json!(self.bots));
            obj.insert("seq".into(), json!(self.last_seq));
            obj.insert("statusVersion".into(), json!(self.status_version));
        }
        self.last_seen_epoch_ms = Utc::now().timestamp_millis();
        self.is_stale = false;
        self.is_connected = true;
    }

    pub fn mark_stale(&mut self) {
        self.is_stale = true;
        self.is_connected = false;
        if let Some(obj) = self.overview.as_object_mut() {
            obj.insert("stale".into(), json!(true));
            obj.insert("bridgeConnected".into(), json!(false));
        }
        for bot in &mut self.bots {
            if let Some(obj) = bot.as_object_mut() {
                obj.insert("stale".into(), json!(true));
            }
        }
    }
}

pub fn spawn_bridge_relay(
    client: NodeBridgeClient,
    cache: Arc<RwLock<BridgeFleetCache>>,
    io: SocketIo,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        run_bridge_relay_loop(client, cache, io, cancel).await;
    })
}

async fn run_bridge_relay_loop(
    client: NodeBridgeClient,
    cache: Arc<RwLock<BridgeFleetCache>>,
    io: SocketIo,
    cancel: CancellationToken,
) {
    let mut stale_check_interval = tokio::time::interval(Duration::from_millis(500));
    stale_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let stream_client = reqwest::Client::builder()
        .tcp_keepalive(Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    loop {
        if cancel.is_cancelled() {
            break;
        }

        // 1. Initial snapshot fetch attempt on loop iteration
        if let Ok(snap) = client.get_snapshot().await {
            let mut w = cache.write().await;
            w.apply_snapshot(&snap);
            let ov = w.overview.clone();
            drop(w);
            let _ = io.emit("dashboard:status", &ov).await;
        }

        // 2. Connect to SSE stream
        let url = format!("{}/bridge/events", client.base_url);
        let headers = client.build_signed_headers(b"");

        match stream_client.get(&url).headers(headers).send().await {
            Ok(res) if res.status().is_success() => {
                let mut stream = res.bytes_stream();
                let mut buffer = String::new();

                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => return,
                        _ = stale_check_interval.tick() => {
                            let (last_seen, is_stale) = {
                                let r = cache.read().await;
                                (r.last_seen_epoch_ms, r.is_stale)
                            };
                            let elapsed = Utc::now().timestamp_millis() - last_seen;
                            if elapsed > 3000 && !is_stale {
                                tracing::warn!("Node bridge heartbeat not seen for >3s ({elapsed}ms) - marking fleet cache as STALE (preserving snapshot)");
                                let mut w = cache.write().await;
                                w.mark_stale();
                                let ov = w.overview.clone();
                                drop(w);
                                let _ = io.emit("dashboard:status", &ov).await;
                            }
                        }
                        chunk_opt = stream.next() => {
                            let Some(chunk_res) = chunk_opt else {
                                tracing::warn!("Node bridge event stream disconnected - attempting reconnect...");
                                break;
                            };
                            match chunk_res {
                                Ok(chunk) => {
                                    if let Ok(text) = std::str::from_utf8(&chunk) {
                                        buffer.push_str(text);
                                        while let Some(pos) = buffer.find("\n\n") {
                                            let frame = buffer[..pos].to_string();
                                            buffer = buffer[pos + 2..].to_string();
                                            process_sse_frame(&frame, &client, &cache, &io).await;
                                        }
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("Error reading bridge event stream: {e}");
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Ok(res) => {
                tracing::warn!("Bridge SSE returned status {}", res.status());
            }
            Err(e) => {
                tracing::debug!("Could not connect to bridge SSE ({e}) - retrying...");
            }
        }

        // If disconnected, wait up to 1-2s while continuing to check stale status
        let retry_deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
        while tokio::time::Instant::now() < retry_deadline {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = stale_check_interval.tick() => {
                    let (last_seen, is_stale) = {
                        let r = cache.read().await;
                        (r.last_seen_epoch_ms, r.is_stale)
                    };
                    let elapsed = Utc::now().timestamp_millis() - last_seen;
                    if elapsed > 3000 && !is_stale {
                        tracing::warn!("Node bridge disconnected for >3s - marking fleet cache as STALE (preserving snapshot)");
                        let mut w = cache.write().await;
                        w.mark_stale();
                        let ov = w.overview.clone();
                        drop(w);
                        let _ = io.emit("dashboard:status", &ov).await;
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }
}

async fn process_sse_frame(
    frame: &str,
    client: &NodeBridgeClient,
    cache: &Arc<RwLock<BridgeFleetCache>>,
    io: &SocketIo,
) {
    let mut event_type = "message";
    let mut data_lines = Vec::new();

    for line in frame.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("event:") {
            event_type = rest.trim();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim());
        }
    }

    if data_lines.is_empty() {
        return;
    }

    let raw_data = data_lines.join("\n");
    let Ok(payload) = serde_json::from_str::<Value>(&raw_data) else {
        return;
    };

    match event_type {
        "snapshot" => {
            let mut w = cache.write().await;
            w.apply_snapshot(&payload);
            let ov = w.overview.clone();
            drop(w);
            let _ = io.emit("dashboard:status", &ov).await;
        }
        "delta" => {
            let (current_seq, current_boot) = {
                let r = cache.read().await;
                (r.last_seq, r.boot_id.clone())
            };
            let incoming_seq = payload.get("seq").and_then(|v| v.as_u64());
            let incoming_boot = payload.get("bootId").and_then(|v| v.as_str());

            let boot_changed = incoming_boot.is_some() && current_boot.as_deref() != incoming_boot;
            let seq_gap = incoming_seq.is_some_and(|s| current_seq > 0 && s > current_seq + 1);

            if boot_changed || seq_gap {
                tracing::warn!(
                    current_seq,
                    incoming_seq,
                    boot_changed,
                    seq_gap,
                    "Gap/restart detected in delta event. Resyncing snapshot within 2s..."
                );
                if let Ok(snap) = client.get_snapshot().await {
                    let mut w = cache.write().await;
                    w.apply_snapshot(&snap);
                    let ov = w.overview.clone();
                    drop(w);
                    let _ = io.emit("dashboard:status", &ov).await;
                    return;
                }
            }

            let mut w = cache.write().await;
            w.apply_delta(&payload);
            let ov = w.overview.clone();
            drop(w);
            let _ = io.emit("dashboard:status", &ov).await;
        }
        "heartbeat" => {
            let mut w = cache.write().await;
            w.last_seen_epoch_ms = Utc::now().timestamp_millis();
            if w.is_stale {
                w.is_stale = false;
                w.is_connected = true;
                if let Some(obj) = w.overview.as_object_mut() {
                    obj.insert("stale".into(), json!(false));
                    obj.insert("bridgeConnected".into(), json!(true));
                }
                for bot in &mut w.bots {
                    if let Some(obj) = bot.as_object_mut() {
                        obj.insert("stale".into(), json!(false));
                    }
                }
                let ov = w.overview.clone();
                drop(w);
                let _ = io.emit("dashboard:status", &ov).await;
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn management_forwarding_preserves_status_and_error_stage() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        use axum::{Router, routing::put, Json};
        let app = Router::new().route("/bridge/bots/b/profile", put(|| async {
            (axum::http::StatusCode::CONFLICT, Json(json!({"success": false, "error": {"code": "REVISION_CONFLICT", "stage": "profile", "message": "Changed"}})))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let bridge = NodeBridgeClient { base_url: format!("http://{addr}"), secret: "secret".into(), client: reqwest::Client::new() };
        let (status, body) = bridge.management_request(reqwest::Method::PUT, "/bridge/bots/b/profile", Some(&json!({"nameServer":"B"}))).await.unwrap();
        assert_eq!(status, reqwest::StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "REVISION_CONFLICT");
        assert_eq!(body["error"]["stage"], "profile");
        server.abort();
    }

    #[test]
    fn bridge_client_signed_headers_are_generated() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = NodeBridgeClient {
            base_url: "http://127.0.0.1:4174".to_string(),
            secret: "test_secret_123".to_string(),
            client: reqwest::Client::new(),
        };

        let headers = client.build_signed_headers(b"{\"hello\":\"world\"}");
        assert!(headers.contains_key("x-internal-signature"));
        assert!(headers.contains_key("x-internal-timestamp"));
        assert!(headers.contains_key("x-request-id"));
        assert_eq!(headers.get("content-type").unwrap(), "application/json");
    }

    #[tokio::test]
    async fn bridge_client_fails_closed_when_service_down() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = NodeBridgeClient {
            base_url: "http://127.0.0.1:59999".to_string(), // unused port
            secret: "test_secret_123".to_string(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_millis(100))
                .build()
                .unwrap(),
        };

        let result = client.get_status().await;
        assert!(result.is_err(), "Must return Err when bridge is unreachable");
        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("Node bridge connection failed"));
    }

    #[test]
    fn test_bridge_cache_stale_detection_preserves_fleet() {
        let mut cache = BridgeFleetCache::new();
        let snapshot = json!({
            "bootId": "boot-1234",
            "seq": 1,
            "statusVersion": 1,
            "bots": [
                {
                    "id": "admin",
                    "botKey": "admin",
                    "displayName": "Admin Bot",
                    "status": "running",
                    "connected": true
                },
                {
                    "id": "child1",
                    "botKey": "child1",
                    "displayName": "Child Bot 1",
                    "status": "running",
                    "connected": true
                }
            ],
            "overview": {
                "totalBots": 2,
                "runningBots": 2,
                "stoppedBots": 0
            }
        });

        cache.apply_snapshot(&snapshot);
        assert_eq!(cache.bots.len(), 2);
        assert_eq!(cache.is_stale, false);
        assert_eq!(cache.is_connected, true);
        assert_eq!(cache.boot_id.as_deref(), Some("boot-1234"));
        assert_eq!(cache.last_seq, 1);

        // When bridge connection drops and stale is triggered:
        cache.mark_stale();

        assert_eq!(cache.is_stale, true);
        assert_eq!(cache.is_connected, false);
        // CRUCIAL: Bots list MUST be preserved, not emptied!
        assert_eq!(cache.bots.len(), 2);
        assert_eq!(cache.overview["stale"], true);
        assert_eq!(cache.overview["bridgeConnected"], false);
        assert_eq!(cache.bots[0]["stale"], true);
    }

    #[test]
    fn test_bridge_cache_apply_snapshot_and_delta() {
        let mut cache = BridgeFleetCache::new();
        let snapshot = json!({
            "bootId": "boot-5678",
            "seq": 10,
            "statusVersion": 3,
            "bots": [
                {
                    "id": "admin",
                    "status": "running",
                    "connected": true
                }
            ],
            "overview": {
                "totalBots": 1,
                "runningBots": 1
            }
        });

        cache.apply_snapshot(&snapshot);
        assert_eq!(cache.last_seq, 10);
        assert_eq!(cache.status_version, 3);
        assert_eq!(cache.bots[0]["status"], "running");

        // Delta updates bot status
        let delta = json!({
            "seq": 11,
            "statusVersion": 4,
            "id": "admin",
            "status": "stopped",
            "connected": false
        });

        cache.apply_delta(&delta);
        assert_eq!(cache.last_seq, 11);
        assert_eq!(cache.status_version, 4);
        assert_eq!(cache.bots[0]["status"], "stopped");
        assert_eq!(cache.bots[0]["connected"], false);
    }
}
