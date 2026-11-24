//! Binary WebSocket Listener (`src/api-zalo/apis/listen.js` parity + restored `(1, 602, 0)` typing).
//!
//! Features:
//! - Binary frame wire codec: `[version: u8 = 1, cmd: u16_le, sub_cmd: u8] + UTF-8 JSON`.
//! - Hardware AES-GCM (`U16` 16-byte IV) + SIMD `flate2` payload decompression.
//! - Dual keep-alive: RFC 6455 `Ping` every `45s` (`15s` `Pong` deadline) + Zalo `(1, 2, 1)` frame every `90s`.
//! - `socket_generation: AtomicU64` guard so stale closed sockets never clobber an active connection.
//! - Automatic gateway rotation across `zpw_ws` (`ws1`, `ws2`, ...) and `(1, 3000, 0)` duplicate-session halt.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use http::Request;
use mybot_types::{
    GroupEvent, GroupEventMember, GroupEventType, InboundMessage, ReactionEvent, ThreadType,
    TypingEvent, UndoEvent, UploadDonePayload, ZaloId,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{Connector, connect_async_tls_with_config};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::crypto::decode_ws_event_payload;
use crate::error::ZaloApiError;
use crate::session::{ZaloSession, ensure_rustls_ring_provider};

#[derive(Debug, Clone)]
pub enum ZaloWsEvent {
    FrameReceived {
        generation: u64,
    },
    Ready {
        generation: u64,
        key_exchanged: bool,
    },
    Message(Box<InboundMessage>),
    Undo(UndoEvent),
    Reaction(ReactionEvent),
    GroupEvent(Box<GroupEvent>),
    Typing(TypingEvent),
    UploadDone(UploadDonePayload),
    DuplicateConnection {
        generation: u64,
    },
    Disconnected {
        generation: u64,
        reason: String,
        code: Option<u16>,
    },
}

#[derive(Debug, Clone)]
pub struct WsListenerConfig {
    pub handshake_timeout: Duration,
    pub ws_ping_interval: Duration,
    pub ws_pong_timeout: Duration,
    pub zalo_keepalive_interval: Duration,
}

impl Default for WsListenerConfig {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(15),
            ws_ping_interval: Duration::from_secs(45),
            ws_pong_timeout: Duration::from_secs(15),
            zalo_keepalive_interval: Duration::from_secs(90),
        }
    }
}

/// Encodes a Zalo binary WebSocket frame: `[version: u8, cmd_lo: u8, cmd_hi: u8, sub_cmd: u8] + json_bytes`.
pub fn encode_ws_binary_frame(version: u8, cmd: u16, sub_cmd: u8, json_payload: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(json_payload).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + body.len());
    let cmd_le = cmd.to_le_bytes();
    out.push(version);
    out.push(cmd_le[0]);
    out.push(cmd_le[1]);
    out.push(sub_cmd);
    out.extend_from_slice(&body);
    out
}

/// Decodes a 4-byte Zalo binary WebSocket header + UTF-8 JSON payload.
pub fn decode_ws_binary_frame(raw: &[u8]) -> Result<(u8, u16, u8, Value), ZaloApiError> {
    if raw.len() < 4 {
        return Err(ZaloApiError::WebSocket(format!(
            "binary frame shorter than 4-byte header ({})",
            raw.len()
        )));
    }
    let version = raw[0];
    let cmd = u16::from_le_bytes([raw[1], raw[2]]);
    let sub_cmd = raw[3];
    let payload_slice = &raw[4..];
    if payload_slice.is_empty() {
        return Ok((version, cmd, sub_cmd, Value::Null));
    }
    let parsed: Value = serde_json::from_slice(payload_slice)
        .map_err(|e| ZaloApiError::WebSocket(format!("invalid frame JSON: {e}")))?;
    Ok((version, cmd, sub_cmd, parsed))
}

pub struct ZaloWsListener {
    session: Arc<ZaloSession>,
    cfg: WsListenerConfig,
    generation_counter: AtomicU64,
    endpoint_index: AtomicU64,
}

#[derive(Default)]
struct WsHeartbeat {
    awaiting_since: Option<Instant>,
    pings_sent: u64,
    pongs_received: u64,
    binary_frames_received: u64,
    consecutive_missed_pongs: u8,
}

impl WsHeartbeat {
    fn sent_ping(&mut self, now: Instant) {
        self.awaiting_since = Some(now);
        self.pings_sent += 1;
    }

    fn received_pong(&mut self) {
        self.awaiting_since = None;
        self.pongs_received += 1;
        self.consecutive_missed_pongs = 0;
    }

    fn received_binary_frame(&mut self) {
        self.awaiting_since = None;
        self.binary_frames_received += 1;
        self.consecutive_missed_pongs = 0;
    }

    fn record_timeout(&mut self) -> bool {
        self.awaiting_since = None;
        self.consecutive_missed_pongs = self.consecutive_missed_pongs.saturating_add(1);
        self.consecutive_missed_pongs >= 3
    }

    fn is_timed_out(&self, now: Instant, timeout: Duration) -> bool {
        self.awaiting_since
            .is_some_and(|sent| now.saturating_duration_since(sent) >= timeout)
    }

    fn deadline(&self, timeout: Duration) -> Option<tokio::time::Instant> {
        self.awaiting_since
            .map(|sent| tokio::time::Instant::from_std(sent + timeout))
    }
}

impl ZaloWsListener {
    pub fn new(session: Arc<ZaloSession>, cfg: WsListenerConfig) -> Self {
        Self {
            session,
            cfg,
            generation_counter: AtomicU64::new(0),
            endpoint_index: AtomicU64::new(0),
        }
    }

    pub fn current_generation(&self) -> u64 {
        self.generation_counter.load(Ordering::Acquire)
    }

    fn next_ws_url(&self, rotate: bool) -> Result<String, ZaloApiError> {
        let keys = self.session.require_keys()?;
        let endpoints = if keys.ws_endpoints.is_empty() {
            vec![keys.ws_url]
        } else {
            keys.ws_endpoints
        };
        let idx = if rotate && endpoints.len() > 1 {
            self.endpoint_index.fetch_add(1, Ordering::Relaxed) as usize + 1
        } else {
            self.endpoint_index.load(Ordering::Relaxed) as usize
        };
        let chosen = &endpoints[idx % endpoints.len()];
        let mut parsed = Url::parse(chosen).map_err(|e| ZaloApiError::WebSocket(e.to_string()))?;
        let now_str = epoch_ms().to_string();
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .filter(|(k, _)| k != "t")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        parsed.query_pairs_mut().clear();
        {
            let mut qp = parsed.query_pairs_mut();
            for (k, v) in pairs {
                qp.append_pair(&k, &v);
            }
            qp.append_pair("t", &now_str);
        }
        Ok(parsed.to_string())
    }

    /// Connects once to the active Zalo WebSocket gateway and streams decoded `ZaloWsEvent`s until closed or cancelled.
    pub async fn run_connection_once(
        &self,
        rotate_endpoint: bool,
        event_tx: &mpsc::Sender<ZaloWsEvent>,
        cancel: CancellationToken,
    ) -> Result<(), ZaloApiError> {
        ensure_rustls_ring_provider();
        let generation = self.generation_counter.fetch_add(1, Ordering::AcqRel) + 1;
        let connect_url = self.next_ws_url(rotate_endpoint)?;

        let mut req: Request<()> = connect_url
            .as_str()
            .into_client_request()
            .map_err(|e| ZaloApiError::WebSocket(e.to_string()))?;

        let cookie_hdr = self.session.cookie_header_for_url(&connect_url);
        let headers = req.headers_mut();
        if let Ok(v) = self.session.origin.parse() {
            headers.insert("Origin", v);
        }
        if let Ok(v) = self.session.user_agent.parse() {
            headers.insert("User-Agent", v);
        }
        if let Ok(v) = cookie_hdr.parse() {
            headers.insert("Cookie", v);
        }
        headers.insert("Cache-Control", "no-cache".parse().unwrap());
        headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());

        let connector = build_rustls_connector();
        let (ws_stream, _) = tokio::time::timeout(
            self.cfg.handshake_timeout,
            connect_async_tls_with_config(req, None, true, Some(connector)),
        )
        .await
        .map_err(|_| ZaloApiError::WebSocket("WebSocket handshake timed out".into()))?
        .map_err(|e| ZaloApiError::WebSocket(e.to_string()))?;

        let (mut sink, mut stream) = ws_stream.split();
        let mut cipher_key: Option<String> = None;
        let mut ws_ping_tick = tokio::time::interval(self.cfg.ws_ping_interval);
        ws_ping_tick.tick().await;
        let mut zalo_ping_tick = tokio::time::interval(self.cfg.zalo_keepalive_interval);
        zalo_ping_tick.tick().await;
        let mut heartbeat = WsHeartbeat::default();

        loop {
            let pong_deadline = heartbeat.deadline(self.cfg.ws_pong_timeout);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    let _ = sink.close().await;
                    return Ok(());
                }
                _ = async {
                    if let Some(deadline) = pong_deadline {
                        tokio::time::sleep_until(deadline).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {
                    if heartbeat.is_timed_out(Instant::now(), self.cfg.ws_pong_timeout) {
                        let dead = heartbeat.record_timeout();
                        tracing::warn!(bot = %self.session.bot_key, generation, pings_sent = heartbeat.pings_sent, pongs_received = heartbeat.pongs_received, binary_frames_received = heartbeat.binary_frames_received, consecutive_missed_pongs = heartbeat.consecutive_missed_pongs, "Zalo WS pong deadline expired");
                        if dead {
                            let _ = event_tx.send(ZaloWsEvent::Disconnected {
                                generation,
                                reason: "WebSocket ping timeout (dead connection)".into(),
                                code: None,
                            }).await;
                            return Err(ZaloApiError::WebSocket("pong timeout".into()));
                        }
                    }
                }
                _ = ws_ping_tick.tick() => {
                    if heartbeat.awaiting_since.is_none() {
                        if let Err(e) = sink.send(WsMessage::Ping(Bytes::new())).await {
                            return Err(ZaloApiError::WebSocket(e.to_string()));
                        }
                        heartbeat.sent_ping(Instant::now());
                        tracing::info!(bot = %self.session.bot_key, generation, pings_sent = heartbeat.pings_sent, pongs_received = heartbeat.pongs_received, binary_frames_received = heartbeat.binary_frames_received, "Zalo WS heartbeat sent");
                    }
                }
                _ = zalo_ping_tick.tick(), if cipher_key.is_some() => {
                    let keepalive = encode_ws_binary_frame(1, 2, 1, &json!({ "eventId": epoch_ms() }));
                    if let Err(e) = sink.send(WsMessage::Binary(Bytes::from(keepalive))).await {
                        return Err(ZaloApiError::WebSocket(e.to_string()));
                    }
                }
                maybe_msg = stream.next() => {
                    match maybe_msg {
                        Some(Ok(WsMessage::Pong(_))) => {
                              heartbeat.received_pong();
                        }
                        Some(Ok(WsMessage::Ping(payload))) => {
                            let _ = sink.send(WsMessage::Pong(payload)).await;
                        }
                        Some(Ok(WsMessage::Binary(bytes))) => {
                              heartbeat.received_binary_frame();
                            let should_close = self.process_binary_frame(
                                generation,
                                &bytes,
                                &mut cipher_key,
                                event_tx,
                            ).await;
                            if should_close {
                                let _ = sink.close().await;
                                return Err(ZaloApiError::DuplicateConnection);
                            }
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            let (code, reason) = frame
                                .map(|f| (Some(f.code.into()), f.reason.to_string()))
                                .unwrap_or((None, "WebSocket closed".to_string()));
                            let _ = event_tx.send(ZaloWsEvent::Disconnected {
                                generation,
                                reason,
                                code,
                            }).await;
                            return Ok(());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => {
                            let msg = err.to_string();
                            let _ = event_tx.send(ZaloWsEvent::Disconnected {
                                generation,
                                reason: msg.clone(),
                                code: None,
                            }).await;
                            return Err(ZaloApiError::WebSocket(msg));
                        }
                        None => {
                            let _ = event_tx.send(ZaloWsEvent::Disconnected {
                                generation,
                                reason: "WebSocket stream ended".into(),
                                code: None,
                            }).await;
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    /// Processes a single Zalo binary frame; returns `true` only if `(1, 3000, 0)` duplicate session requires immediate close.
    pub async fn process_binary_frame(
        &self,
        generation: u64,
        raw: &[u8],
        cipher_key: &mut Option<String>,
        event_tx: &mpsc::Sender<ZaloWsEvent>,
    ) -> bool {
        let _ = event_tx.send(ZaloWsEvent::FrameReceived { generation }).await;
        let Ok((version, cmd, sub_cmd, parsed)) = decode_ws_binary_frame(raw) else {
            tracing::warn!(bot = %self.session.bot_key, "dropping malformed Zalo WS frame");
            return false;
        };
        if version != 1 {
            return false;
        }
        tracing::info!(bot = %self.session.bot_key, generation, cmd, sub_cmd, "Zalo WS binary frame observed");

        let self_listen = self.session.self_listen.load(Ordering::Relaxed);
        let self_uid = self.session.uid().unwrap_or_default();
        let received_at = epoch_ms() as i64;

        match (cmd, sub_cmd) {
            // (1, 1, 1) — Cipher key handshake
            (1, 1) => {
                if let Some(key) = parsed.get("key").and_then(|v| v.as_str()) {
                    *cipher_key = Some(key.to_string());
                    let _ = event_tx
                        .send(ZaloWsEvent::Ready {
                            generation,
                            key_exchanged: true,
                        })
                        .await;
                }
            }
            // (1, 501, 0) — Direct Messages & DM Undo
            (501, 0) => {
                let Some(ref ck) = *cipher_key else { return false };
                if let Some(inner) = decrypt_frame_data(&self.session.bot_key, cmd, sub_cmd, &parsed, ck)
                    && let Some(msgs) = inner.pointer("/data/msgs").and_then(|v| v.as_array())
                {
                    for msg in msgs {
                        if is_undo_payload(msg) {
                            if let Some(undo) = parse_undo_event(
                                &self.session.bot_key,
                                &self_uid,
                                msg,
                                ThreadType::User,
                                received_at,
                            ) && (!undo.is_self || self_listen)
                            {
                                let _ = event_tx.send(ZaloWsEvent::Undo(undo)).await;
                            }
                        } else if let Some(inbound) = InboundMessage::from_raw_zalo(
                            self.session.bot_key.as_str(),
                            &self_uid,
                            msg,
                            ThreadType::User,
                            received_at,
                        ) && (!inbound.is_self || self_listen)
                        {
                            let _ = event_tx.send(ZaloWsEvent::Message(Box::new(inbound))).await;
                        }
                    }
                }
            }
            // (1, 521, 0) — Group Messages & Group Undo
            (521, 0) => {
                let Some(ref ck) = *cipher_key else { return false };
                if let Some(inner) = decrypt_frame_data(&self.session.bot_key, cmd, sub_cmd, &parsed, ck)
                    && let Some(msgs) = inner.pointer("/data/groupMsgs").and_then(|v| v.as_array())
                {
                    for msg in msgs {
                        if is_undo_payload(msg) {
                            if let Some(undo) = parse_undo_event(
                                &self.session.bot_key,
                                &self_uid,
                                msg,
                                ThreadType::Group,
                                received_at,
                            ) && (!undo.is_self || self_listen)
                            {
                                let _ = event_tx.send(ZaloWsEvent::Undo(undo)).await;
                            }
                        } else if let Some(inbound) = InboundMessage::from_raw_zalo(
                            self.session.bot_key.as_str(),
                            &self_uid,
                            msg,
                            ThreadType::Group,
                            received_at,
                        ) && (!inbound.is_self || self_listen)
                        {
                            let _ = event_tx.send(ZaloWsEvent::Message(Box::new(inbound))).await;
                        }
                    }
                }
            }
            // (1, 601, 0) — Upload callbacks (`file_done`, `voice_aac_success`) & 17 `GroupEvent`s
            (601, 0) => {
                let Some(ref ck) = *cipher_key else { return false };
                if let Some(inner) = decrypt_frame_data(&self.session.bot_key, cmd, sub_cmd, &parsed, ck)
                    && let Some(controls) = inner.pointer("/data/controls").and_then(|v| v.as_array())
                {
                    for ctrl in controls {
                        let Some(content) = ctrl.get("content") else { continue };
                        let act_type = content
                            .get("act_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        match act_type {
                            "file_done" => {
                                let file_id = content
                                    .get("fileId")
                                    .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                                    .unwrap_or_default();
                                let file_url = content
                                    .pointer("/data/url")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let done = UploadDonePayload { file_id, file_url };
                                self.session.resolve_upload_callback(done.clone());
                                let _ = event_tx.send(ZaloWsEvent::UploadDone(done)).await;
                            }
                            "voice_aac_success" => {
                                let file_id = content
                                    .get("fileId")
                                    .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                                    .unwrap_or_default();
                                let file_url = content
                                    .pointer("/data/5")
                                    .or_else(|| content.pointer("/data/6"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let done = UploadDonePayload { file_id, file_url };
                                self.session.resolve_upload_callback(done.clone());
                                let _ = event_tx.send(ZaloWsEvent::UploadDone(done)).await;
                            }
                            "group" => {
                                let act = content
                                    .get("act")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                if act == "join_reject" {
                                    continue;
                                }
                                let raw_data = match content.get("data") {
                                    Some(Value::String(s)) => {
                                        serde_json::from_str::<Value>(s).unwrap_or(Value::Null)
                                    }
                                    Some(other) => other.clone(),
                                    None => Value::Null,
                                };
                                let ev = parse_group_event(
                                    &self.session.bot_key,
                                    &self_uid,
                                    act,
                                    raw_data,
                                    received_at,
                                );
                                if !ev.is_self || self_listen {
                                    let _ = event_tx.send(ZaloWsEvent::GroupEvent(Box::new(ev))).await;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            // (1, 602, 0) — Typing / Group-Typing (restored feature!)
            (602, 0) => {
                if let Some(data_str) = parsed.get("data").and_then(|v| v.as_str())
                    && let Ok(outer) = serde_json::from_str::<Value>(data_str)
                    && outer.get("error_code").and_then(|c| c.as_i64()) == Some(0)
                    && let Some(actions) = outer.pointer("/data/actions").and_then(|v| v.as_array())
                {
                    for action in actions {
                        if action.get("act_type").and_then(|v| v.as_str()) == Some("typing")
                            && let Some(act_data_str) = action.get("data").and_then(|v| v.as_str())
                            && let Ok(act_json) = serde_json::from_str::<Value>(act_data_str)
                        {
                            let user_id = act_json
                                .get("uid")
                                .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                                .unwrap_or_default();
                            if user_id.is_empty() {
                                continue;
                            }
                            let group_id = if action.get("act").and_then(|v| v.as_str()) == Some("gtyping") {
                                act_json
                                    .get("gid")
                                    .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                                    .filter(|g| !g.is_empty())
                            } else {
                                None
                            };
                            let ts = act_json
                                .get("ts")
                                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
                                .unwrap_or(received_at);
                            let is_pc = act_json
                                .get("isPC")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0)
                                != 0;
                            let _ = event_tx
                                .send(ZaloWsEvent::Typing(TypingEvent {
                                    user_id,
                                    group_id,
                                    timestamp_ms: ts,
                                    is_pc,
                                }))
                                .await;
                        }
                    }
                }
            }
            // (1, 612, 0) — Message Reactions
            (612, 0) => {
                let Some(ref ck) = *cipher_key else { return false };
                if let Some(inner) = decrypt_frame_data(&self.session.bot_key, cmd, sub_cmd, &parsed, ck) {
                    for (ptr, t_type) in [
                        ("/data/reacts", ThreadType::User),
                        ("/data/reactGroups", ThreadType::Group),
                    ] {
                        if let Some(arr) = inner.pointer(ptr).and_then(|v| v.as_array()) {
                            for item in arr {
                                if let Some(ev) = parse_reaction_event(
                                    &self.session.bot_key,
                                    &self_uid,
                                    item,
                                    t_type,
                                    received_at,
                                ) && (!ev.is_self || self_listen)
                                {
                                    let _ = event_tx.send(ZaloWsEvent::Reaction(ev)).await;
                                }
                            }
                        }
                    }
                }
            }
            // (1, 3000, 0) — Duplicate Zalo Web Session Kick
            (3000, 0) => {
                let _ = event_tx
                    .send(ZaloWsEvent::DuplicateConnection { generation })
                    .await;
                return true;
            }
            _ => {}
        }
        false
    }
}

fn build_rustls_connector() -> Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls_cfg = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Connector::Rustls(Arc::new(tls_cfg))
}

fn decrypt_frame_data(bot_key: &str, cmd: u16, sub_cmd: u8, parsed: &Value, cipher_key: &str) -> Option<Value> {
    let data_str = parsed.get("data")?.as_str()?;
    let bytes = match decode_ws_event_payload(data_str, cipher_key) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(
                bot = %bot_key,
                cmd = cmd,
                sub_cmd = sub_cmd,
                error = %err,
                "failed to decrypt Zalo WS frame payload"
            );
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(val) => Some(val),
        Err(err) => {
            tracing::warn!(
                bot = %bot_key,
                cmd = cmd,
                sub_cmd = sub_cmd,
                error = %err,
                "failed to parse decrypted Zalo WS frame JSON"
            );
            None
        }
    }
}

fn is_undo_payload(msg: &Value) -> bool {
    msg.get("content")
        .and_then(|c| c.as_object())
        .is_some_and(|obj| obj.contains_key("deleteMsg"))
}

fn parse_undo_event(
    bot_key: &str,
    self_uid: &ZaloId,
    raw: &Value,
    thread_type: ThreadType,
    ws_received_at_ms: i64,
) -> Option<UndoEvent> {
    let obj = raw.as_object()?;
    let uid_from = obj
        .get("uidFrom")
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let id_to = obj
        .get("idTo")
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let is_self = uid_from.as_str() == "0" || (!self_uid.is_empty() && &uid_from == self_uid);
    let sender_uid = if uid_from.as_str() == "0" && !self_uid.is_empty() {
        self_uid.clone()
    } else {
        uid_from
    };
    let norm_id_to = if id_to.as_str() == "0" && !self_uid.is_empty() {
        self_uid.clone()
    } else {
        id_to
    };
    let thread_id = if thread_type.is_group() || is_self {
        norm_id_to
    } else {
        sender_uid.clone()
    };

    let del = obj.get("content")?.get("deleteMsg")?;
    let global_msg_id = del
        .get("globalMsgId")
        .or_else(|| obj.get("msgId"))
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let cli_msg_id = del
        .get("cliMsgId")
        .or_else(|| obj.get("cliMsgId"))
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let timestamp_ms = obj
        .get("ts")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or(ws_received_at_ms);

    Some(UndoEvent {
        bot_key: bot_key.into(),
        thread_id,
        thread_type,
        sender_uid,
        is_self,
        global_msg_id,
        cli_msg_id,
        timestamp_ms,
        ws_received_at_ms,
    })
}

fn parse_reaction_event(
    bot_key: &str,
    self_uid: &ZaloId,
    raw: &Value,
    thread_type: ThreadType,
    ws_received_at_ms: i64,
) -> Option<ReactionEvent> {
    let obj = raw.as_object()?;
    let uid_from = obj
        .get("uidFrom")
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let id_to = obj
        .get("idTo")
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let is_self = uid_from.as_str() == "0" || (!self_uid.is_empty() && &uid_from == self_uid);
    let sender_uid = if uid_from.as_str() == "0" && !self_uid.is_empty() {
        self_uid.clone()
    } else {
        uid_from
    };
    let norm_id_to = if id_to.as_str() == "0" && !self_uid.is_empty() {
        self_uid.clone()
    } else {
        id_to
    };
    let thread_id = if thread_type.is_group() || is_self {
        norm_id_to
    } else {
        sender_uid.clone()
    };

    let content_val = match obj.get("content") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok()?,
        Some(other) => other.clone(),
        None => return None,
    };
    let r_icon = content_val
        .get("rIcon")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .into();
    let r_type = content_val
        .get("rType")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let msg_id = content_val
        .pointer("/rMsg/0/gMsgID")
        .or_else(|| obj.get("msgId"))
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let cli_msg_id = content_val
        .pointer("/rMsg/0/cMsgID")
        .or_else(|| obj.get("cliMsgId"))
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let timestamp_ms = obj
        .get("ts")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or(ws_received_at_ms);

    Some(ReactionEvent {
        bot_key: bot_key.into(),
        thread_id,
        thread_type,
        sender_uid,
        is_self,
        msg_id,
        cli_msg_id,
        r_icon,
        r_type,
        timestamp_ms,
        ws_received_at_ms,
    })
}

fn parse_group_event(
    bot_key: &str,
    self_uid: &ZaloId,
    act: &str,
    raw_data: Value,
    ws_received_at_ms: i64,
) -> GroupEvent {
    let event_type = GroupEventType::from_act(act);
    let group_id = raw_data
        .get("groupId")
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let group_name = raw_data
        .get("groupName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let source_id = raw_data
        .get("sourceId")
        .or_else(|| raw_data.get("creatorId"))
        .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
        .unwrap_or_default();
    let target_members = raw_data
        .get("updateMembers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let obj = m.as_object()?;
                    Some(GroupEventMember {
                        id: obj
                            .get("id")
                            .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                            .unwrap_or_default(),
                        display_name: obj
                            .get("dName")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        avatar: obj.get("avatar").and_then(|v| v.as_str()).map(ToOwned::to_owned),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let is_self = (!self_uid.is_empty() && &source_id == self_uid)
        || target_members.iter().any(|m| !self_uid.is_empty() && &m.id == self_uid);

    GroupEvent {
        bot_key: bot_key.into(),
        group_id,
        group_name,
        event_type,
        source_id,
        target_members,
        is_self,
        ws_received_at_ms,
        raw_data,
    }
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::encode_ws_event_payload;
    use base64::Engine as _;
    use mybot_types::{CredentialsBundle, DEFAULT_ZALO_USER_AGENT};

    #[test]
    fn heartbeat_deadline_is_independent_of_next_ping_tick() {
        let start = Instant::now();
        let mut heartbeat = WsHeartbeat::default();
        heartbeat.sent_ping(start);
        assert!(!heartbeat.is_timed_out(start + Duration::from_secs(14), Duration::from_secs(15)));
        assert!(heartbeat.is_timed_out(start + Duration::from_secs(15), Duration::from_secs(15)));
        heartbeat.received_pong();
        assert!(!heartbeat.is_timed_out(start + Duration::from_secs(90), Duration::from_secs(15)));
    }

    #[test]
    fn inbound_binary_frame_proves_socket_is_alive_without_control_pong() {
        let start = Instant::now();
        let mut heartbeat = WsHeartbeat::default();
        heartbeat.sent_ping(start);
        heartbeat.received_binary_frame();
        assert!(!heartbeat.is_timed_out(start + Duration::from_secs(60), Duration::from_secs(15)));
    }

    #[test]
    fn one_missed_pong_does_not_disconnect_a_flaky_gateway() {
        let start = Instant::now();
        let mut heartbeat = WsHeartbeat::default();
        heartbeat.sent_ping(start);
        assert!(!heartbeat.record_timeout());
        heartbeat.sent_ping(start + Duration::from_secs(45));
        assert!(!heartbeat.record_timeout());
        heartbeat.sent_ping(start + Duration::from_secs(90));
        assert!(heartbeat.record_timeout());
        heartbeat.received_pong();
        heartbeat.sent_ping(start + Duration::from_secs(135));
        assert!(!heartbeat.record_timeout());
    }

    #[tokio::test]
    async fn binary_frame_key_exchange_and_encrypted_group_msg_dispatch() {
        let creds = CredentialsBundle {
            imei: "test-imei".into(),
            user_agent: DEFAULT_ZALO_USER_AGENT.into(),
            cookie: json!("zpw_sek=abc"),
            language: "vi".into(),
            proxy_url: None,
        };
        let session = ZaloSession::new("admin", true, &creds, false).unwrap();
        let listener = ZaloWsListener::new(Arc::clone(&session), WsListenerConfig::default());
        let (tx, mut rx) = mpsc::channel(16);
        let mut cipher_key = None;

        // 1. Key exchange (1, 1, 1)
        let key_b64 = base64::engine::general_purpose::STANDARD.encode([0x55u8; 16]);
        let hs = encode_ws_binary_frame(1, 1, 1, &json!({ "key": key_b64 }));
        assert!(!listener.process_binary_frame(1, &hs, &mut cipher_key, &tx).await);
        assert!(matches!(rx.recv().await, Some(ZaloWsEvent::FrameReceived { generation: 1 })));
        assert!(matches!(rx.recv().await, Some(ZaloWsEvent::Ready { key_exchanged: true, .. })));

        // 2. Group message (1, 521, 0)
        let payload = br#"{"data":{"groupMsgs":[{"msgId":"1001","cliMsgId":"2001","uidFrom":"849111","idTo":"777888","dName":"Alice","msgType":"webchat","content":"!ping"}]}}"#;
        let enc = encode_ws_event_payload(payload, &key_b64, &[9u8; 16], &[3u8; 16]).unwrap();
        let frame = encode_ws_binary_frame(1, 521, 0, &json!({ "data": enc }));
        assert!(!listener.process_binary_frame(1, &frame, &mut cipher_key, &tx).await);
        assert!(matches!(rx.recv().await, Some(ZaloWsEvent::FrameReceived { generation: 1 })));
        match rx.recv().await {
            Some(ZaloWsEvent::Message(m)) => {
                assert_eq!(m.thread_id.as_str(), "777888");
                assert_eq!(m.content.text_or_caption(), "!ping");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
