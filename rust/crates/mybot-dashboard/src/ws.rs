//! Socket.IO EIOv4 Real-Time Telemetry & Auth Handshake (`socketioxide` 0.16).
//!
//! Enforces `mybot_session` Cookie + `csrfToken` (`AUTH_REQUIRED` / `CSRF_REQUIRED` errors)
//! and broadcasts `dashboard:upstream`, `dashboard:status`, `dashboard:log`, and `dashboard:metrics`.

use axum::http::header;
use mybot_core::{FleetSupervisor, SupervisorEvent};
use serde_json::{Value, json};
use socketioxide::SocketIo;
use socketioxide::extract::{SocketRef, State, TryData};
use socketioxide::handler::ConnectHandler;
use socketioxide::layer::SocketIoLayer;

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::auth::{DashboardAuthManager, parse_cookie_header, timing_safe_str_eq};
use crate::bridge_client::BridgeFleetCache;

pub fn build_socketio_layer(
    auth: DashboardAuthManager,
    supervisor: FleetSupervisor,
    bridge_cache: Arc<RwLock<BridgeFleetCache>>,
) -> (SocketIoLayer, SocketIo) {
    let (layer, io) = SocketIo::builder()
        .with_state(auth)
        .with_state(supervisor.clone())
        .with_state(bridge_cache)
        .build_layer();

    io.ns("/", on_socket_connected.with(authorize_socket));

    // Bridge `FleetSupervisor` broadcast bus -> all connected Socket.IO dashboard clients
    let io_bridge = io.clone();
    let mut rx = supervisor.subscribe_events();
    let cancel = supervisor.cancellation_token();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                ev = rx.recv() => {
                    match ev {
                        Ok(SupervisorEvent::StatusChanged { .. }) => {
                            let overview = supervisor.fleet_overview_json();
                            let _ = io_bridge.emit("dashboard:status", &overview).await;
                        }
                        Ok(SupervisorEvent::Log(entry)) => {
                            let _ = io_bridge.emit("dashboard:log", &entry).await;
                        }
                        Ok(SupervisorEvent::MetricsTick { .. }) => {
                            let metrics = supervisor.system_metrics_json();
                            let _ = io_bridge.emit("dashboard:metrics", &metrics).await;
                        }
                        Ok(SupervisorEvent::AdminAlert {
                            bot_key,
                            message,
                            timestamp,
                        }) => {
                            let _ = io_bridge
                                .emit(
                                    "dashboard:admin_alert",
                                    &json!({
                                        "botKey": bot_key,
                                        "message": message,
                                        "timestamp": timestamp,
                                    }),
                                )
                                .await;
                        }
                        Ok(SupervisorEvent::AdminRecovery(payload)) => {
                            let _ = io_bridge.emit("dashboard:admin_recovery", &payload).await;
                        }
                        Ok(SupervisorEvent::BroadcastProgress(payload)) => {
                            let _ = io_bridge
                                .emit("dashboard:broadcast_progress", &payload)
                                .await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    });

    (layer, io)
}

fn authorize_socket(
    s: SocketRef,
    TryData(auth_payload): TryData<Value>,
    State(auth): State<DashboardAuthManager>,
) -> Result<(), String> {
    let headers = &s.req_parts().headers;

    // Enforce `DASHBOARD_ORIGIN` if configured
    if let Some(allowed) = &auth.config().allowed_origin {
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if origin != allowed {
            return Err("ORIGIN_NOT_ALLOWED".to_string());
        }
    }

    let cookie_raw = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let cookies = parse_cookie_header(cookie_raw);
    let Some(sid) = cookies.get("mybot_session") else {
        return Err("AUTH_REQUIRED".to_string());
    };
    let Some(session) = auth.get_valid_session(sid) else {
        return Err("AUTH_REQUIRED".to_string());
    };

    // Match `dashboard/server.js:185`:
    // `socket.handshake.auth?.csrfToken || socket.request.headers["x-csrf-token"] || cookies.mybot_csrf`
    let payload_csrf = auth_payload
        .ok()
        .and_then(|v| v.get("csrfToken").and_then(Value::as_str).map(ToOwned::to_owned));
    let header_csrf = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned);
    let cookie_csrf = cookies.get("mybot_csrf").cloned();

    let candidate = payload_csrf.or(header_csrf).or(cookie_csrf).unwrap_or_default();
    if candidate.is_empty() || !timing_safe_str_eq(&candidate, &session.csrf_token) {
        return Err("CSRF_REQUIRED".to_string());
    }

    Ok(())
}

async fn on_socket_connected(
    s: SocketRef,
    State(supervisor): State<FleetSupervisor>,
    State(bridge_cache): State<Arc<RwLock<BridgeFleetCache>>>,
) {
    let _ = s.emit(
        "dashboard:upstream",
        &json!({ "state": "online", "reason": "ready" }),
    );

    let cache_guard = bridge_cache.read().await;
    if cache_guard.last_seq > 0 || !cache_guard.bots.is_empty() {
        let _ = s.emit("dashboard:status", &cache_guard.overview);
    } else {
        let _ = s.emit("dashboard:status", &supervisor.fleet_overview_json());
    }
    drop(cache_guard);

    s.on("dashboard:ping", |sock: SocketRef| async move {
        let _ = sock.emit(
            "dashboard:pong",
            &json!({ "ts": chrono::Utc::now().timestamp_millis() }),
        );
    });
}
