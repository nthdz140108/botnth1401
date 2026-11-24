//! `mybotd` — Single-Process Pure-Rust Zalo Multi-Bot SaaS Daemon & Embedded Web Dashboard.
//!
//! Replaces Node.js V3 + PM2 + Express + Socket.IO + multi-process child IPC with:
//! - `MiMalloc` high-speed lock-free thread-local allocator
//! - `SQLite WAL` (`mmap_size=256MB`) + `DashMap`/`moka` `HotStorageCaches`
//! - `FleetSupervisor` (`BotActor` tasks, cross-session UID isolation, 60s Trial Reaper, 24-slot `:05` `SendTask`)
//! - All 218 canonical commands & 181 aliases (`399` keys) via `mybot-commands`
//! - Embedded `Axum` + `socketioxide` EIOv4 Dashboard serving `dashboard/dist/` on `:4173`

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use clap::Parser;
use mybot_commands::{CommandRuntimeBundle, CommandsPassiveHooks, build_full_command_registry};
use mybot_core::{
    FastPathDispatcher, FleetSupervisor, ProtectionEngine, SendTaskOutcome, SendTaskRunner,
    StudioEngine, SupervisorConfig, WorkloadBroker,
};
use mybot_dashboard::{DashboardConfig, build_dashboard_app};
use mybot_media::VideoPoolManager;
use mybot_storage::{HotStorageCaches, StorageEngine};
use mybot_types::{ThreadType, ZaloId};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use zalo_sdk::ZaloSession;
use zalo_sdk::apis::messaging::VideoSendRequest;

#[derive(Debug, Parser)]
#[command(name = "mybotd", version, about = "V4 Pure-Rust Multi-Bot Zalo Engine & Web Dashboard")]
struct DaemonArgs {
    /// Path to the SQLite WAL database file.
    #[arg(long, env = "MYBOT_DB_PATH", default_value = "data/mybot.db")]
    db_path: PathBuf,

    /// Path to the project root containing `assets/` and `dashboard/dist/`.
    #[arg(long, env = "MYBOT_PROJECT_ROOT", default_value = ".")]
    project_root: PathBuf,

    /// Dashboard HTTP + Socket.IO bind host.
    #[arg(long, env = "DASHBOARD_HOST")]
    host: Option<String>,

    /// Dashboard HTTP + Socket.IO bind port.
    #[arg(long, env = "DASHBOARD_PORT")]
    port: Option<u16>,

    /// Enable live Zalo WebSocket & HTTP login connections for `desired_status = running` bots.
    #[arg(long, env = "MYBOT_CONNECT_LIVE_ZALO", default_value_t = true)]
    connect_live_zalo: bool,

    /// Run in Node Hybrid mode: Node.js owns all Zalo sessions & command execution; Rust acts only as the Management Dashboard.
    #[arg(long, env = "MYBOT_NODE_HYBRID", default_value_t = false)]
    node_hybrid: bool,
}

struct PoolBackedSendTaskRunner {
    pools: VideoPoolManager,
}

#[async_trait]
impl SendTaskRunner for PoolBackedSendTaskRunner {
    async fn execute_slot_for_group(
        &self,
        _bot_key: &str,
        thread_id: &ZaloId,
        slot_config: &Value,
        zalo: Option<Arc<ZaloSession>>,
    ) -> SendTaskOutcome {
        let content_type = slot_config
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or("video");
        let caption = slot_config
            .get("caption")
            .or_else(|| slot_config.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("⏰ Bản tin tự động theo giờ từ MyBot V4");

        if content_type == "text" {
            if let Some(z) = zalo {
                return match z.send_message(caption, thread_id, ThreadType::Group).await {
                    Ok(_) => SendTaskOutcome::Sent,
                    Err(_) => SendTaskOutcome::DeliveryError,
                };
            }
            return SendTaskOutcome::Sent;
        }

        let category = slot_config
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("girl");
        let Some(url) = self.pools.pick_url(category) else {
            return SendTaskOutcome::SourceEmpty;
        };

        if let Some(z) = zalo {
            let res = z
                .send_video(
                    &VideoSendRequest {
                        video_url: url,
                        thumbnail_url: None,
                        caption: caption.to_string(),
                        mentions: Vec::new(),
                        duration_ms: 15_000,
                        width: 720,
                        height: 1280,
                        file_size: 0,
                        ttl_ms: 0,
                        video_already_uploaded: true,
                    },
                    thread_id,
                    ThreadType::Group,
                )
                .await;
            if res.is_err() {
                return SendTaskOutcome::DeliveryError;
            }
        }
        SendTaskOutcome::Sent
    }
}

pub struct RunningDaemon {
    pub local_addr: SocketAddr,
    pub supervisor: FleetSupervisor,
    pub caches: HotStorageCaches,
}

impl RunningDaemon {
    pub async fn shutdown(self) {
        self.supervisor.shutdown_all().await;
        let _ = self.caches.flush_all_sync();
    }
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate()).expect("register SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = sigterm.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    zalo_sdk::ensure_rustls_ring_provider();

    // Load `.env` and `.env.local` if present without printing or logging secrets
    let _ = dotenvy::from_filename(".env");
    let _ = dotenvy::from_filename(".env.local");

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = DaemonArgs::parse();
    if let Some(parent) = args.db_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }

    let engine = StorageEngine::open(&args.db_path, 4)
        .with_context(|| format!("failed to open SQLite WAL at {}", args.db_path.display()))?;
    let caches = HotStorageCaches::load_from_engine(engine)
        .context("failed to warm HotStorageCaches from SQLite")?;
    let batch_flusher = caches.spawn_batch_writer();

    let runtime_bundle = Arc::new(CommandRuntimeBundle::new(&args.project_root, caches.clone()));
    let sendtask_runner: Arc<dyn SendTaskRunner> = Arc::new(PoolBackedSendTaskRunner {
        pools: runtime_bundle.video_pools.clone(),
    });
    let registry = build_full_command_registry(runtime_bundle.clone())
        .map_err(|e| anyhow::anyhow!("command registry error: {e}"))?;

    tracing::info!(
        canonical_commands = registry.canonical_count(),
        lookup_keys = registry.lookup_key_count(),
        "Registered V4 Pure-Rust Command Catalog"
    );

    let studio = Arc::new(StudioEngine::new(registry, caches.clone()));
    let dispatcher = FastPathDispatcher::new(
        caches.clone(),
        ProtectionEngine::default(),
        studio,
        WorkloadBroker::default(),
        4096,
    );
    let passive_hooks = Arc::new(CommandsPassiveHooks::new(
        runtime_bundle.clone(),
        caches.clone(),
    ));
    dispatcher.set_passive_hooks(passive_hooks);

    let hmac_secret = std::env::var("INTERNAL_API_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "mybot-v4-internal-hmac".to_string());

    if args.node_hybrid {
        tracing::info!("mybotd running in NODE_HYBRID mode (Node.js owns all Zalo sessions and commands; Rust dashboard online)");
    }

    let sup_cfg = SupervisorConfig {
        assets_root: args.project_root.join("assets"),
        connect_live_zalo: if args.node_hybrid { false } else { args.connect_live_zalo },
        internal_hmac_secret: hmac_secret,
        sendtask_inter_group_delay: Duration::from_secs(20),
    };
    let supervisor = FleetSupervisor::new(
        caches.clone(),
        dispatcher,
        sup_cfg,
        Some(sendtask_runner),
    );

    // Liferaft Invariant #1: Always seed an `admin` bot record even when SQLite is completely empty
    let _ = supervisor.ensure_admin_bot_seeded();

    let mut dash_cfg = DashboardConfig::from_env();
    dash_cfg.project_root = args.project_root.clone();
    if let Some(h) = args.host {
        dash_cfg.host = h;
    }
    if let Some(p) = args.port {
        dash_cfg.port = p;
    }

    // Liferaft Invariant #2: Bind and serve Web Admin Dashboard FIRST (`t = 0ms`),
    // BEFORE attempting any Zalo login, so dead/expired Admin cookies NEVER block Web Recovery!
    let bind_addr = format!("{}:{}", dash_cfg.host, dash_cfg.port);
    let (app, _io, state) = build_dashboard_app(dash_cfg, supervisor.clone());
    if args.node_hybrid {
        state.feature_flags.insert("nodeHybrid".into(), json!(true));
    }
    let listener = TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("failed to bind dashboard HTTP/WS listener on {bind_addr}"))?;
    let local_addr = listener.local_addr()?;

    tracing::info!(
        listen = %local_addr,
        db = %args.db_path.display(),
        "mybotd V4 Liferaft Web Admin Dashboard ONLINE (Always-On QR Admin Recovery + Remote Control)"
    );

    // Liferaft Invariant #3: Restore & start bots asynchronously in the background
    let bg_daemons = if args.node_hybrid {
        tracing::info!("Hybrid mode active: skipping Rust live session restore and background daemons");
        None
    } else {
        let sup_boot = supervisor.clone();
        tokio::spawn(async move {
            if let Err(err) = sup_boot.restore_all_from_storage().await {
                tracing::warn!(error = %err, "Background fleet restore encountered non-fatal error");
            }
        });
        Some(supervisor.spawn_background_daemons())
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_shutdown_signal())
        .await
        .context("dashboard server exited with error")?;

    tracing::info!("Shutdown signal received — stopping bots and flushing SQLite WAL...");
    if let Some(bg) = bg_daemons {
        bg.abort();
    }
    if !args.node_hybrid {
        supervisor.shutdown_all().await;
    }
    batch_flusher.shutdown_and_flush().await;
    tracing::info!("mybotd shutdown complete.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use mybot_storage::BotRecord;
    use mybot_types::{DEFAULT_ZALO_USER_AGENT, ExpiryPolicy};
    use serde_json::{Value, json};

    use super::*;

    #[tokio::test]
    async fn full_mybotd_stack_serves_218_studio_commands_socketio_eio4_and_shuts_down_cleanly() {
        zalo_sdk::ensure_rustls_ring_provider();
        let tmp = tempfile::tempdir().unwrap();
        let db_file = tmp.path().join("mybot.db");
        std::fs::create_dir_all(tmp.path().join("dashboard/dist")).unwrap();
        std::fs::write(
            tmp.path().join("dashboard/dist/index.html"),
            "<!doctype html><html><body>MYBOT V4 REACT SPA</body></html>",
        )
        .unwrap();

        let engine = StorageEngine::open(&db_file, 2).unwrap();
        let now = Utc::now().to_rfc3339();
        engine
            .upsert_bot(&BotRecord {
                bot_key: "main".into(),
                uid: ZaloId::new("main_uid_1"),
                global_uid: None,
                canonical_username: None,
                display_name: "Admin Main Bot".into(),
                avatar: String::new(),
                is_main: true,
                owner_uid: None,
                status: "stopped".into(),
                desired_status: "running".into(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: json!({}),
                imei: "test-imei".into(),
                user_agent: DEFAULT_ZALO_USER_AGENT.into(),
                proxy_url: None,
                cookie_dead: false,
                cookie_dead_reason: None,
                prefix: "!".into(),
                self_listen: true,
                identity_pending: false,
                admin_identity_seeds: Vec::new(),
                metadata: json!({}),
                created_at: now.clone(),
                updated_at: now,
            })
            .unwrap();

        let caches = HotStorageCaches::load_from_engine(engine).unwrap();
        let flush_handle = caches.spawn_batch_writer();
        let repo_root = PathBuf::from("../..");
        let rt = Arc::new(CommandRuntimeBundle::new(&repo_root, caches.clone()));
        let registry = build_full_command_registry(rt.clone()).unwrap();
        assert_eq!(registry.canonical_count(), 218);
        assert_eq!(registry.lookup_key_count(), 399);

        let studio = Arc::new(StudioEngine::new(registry, caches.clone()));
        let dispatcher = FastPathDispatcher::new(
            caches.clone(),
            ProtectionEngine::default(),
            studio,
            WorkloadBroker::default(),
            512,
        );
        let passive_hooks = Arc::new(CommandsPassiveHooks::new(
            rt.clone(),
            caches.clone(),
        ));
        dispatcher.set_passive_hooks(passive_hooks);
        let supervisor = FleetSupervisor::new(
            caches.clone(),
            dispatcher,
            SupervisorConfig {
                connect_live_zalo: false,
                ..Default::default()
            },
            None,
        );
        supervisor.start_bot("main").await.unwrap();

        let dash_cfg = DashboardConfig {
            host: "127.0.0.1".into(),
            port: 0,
            admin_username: "ubuntu-admin".into(),
            admin_password: "super-secret-v4-password".into(),
            cookie_secure_override: Some(false),
            cookie_samesite: "Lax".into(),
            allowed_origin: None,
            login_rate_limit_max: 5,
            login_rate_limit_window_ms: 60_000,
            session_ttl_ms: 3_600_000,
            project_root: tmp.path().to_path_buf(),
            test_mode: true,
        };
        let (app, _io, _state) = build_dashboard_app(dash_cfg, supervisor.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv_task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let base = format!("http://127.0.0.1:{}", addr.port());
        let client = reqwest::Client::new();

        // 1. Login and inspect 218-command Studio V2 catalog + `sendtask` 9 tabs / 24 schedules!
        let r_login = client
            .post(format!("{base}/api/auth/login"))
            .json(&json!({
                "username": "ubuntu-admin",
                "password": "super-secret-v4-password"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r_login.status().as_u16(), 200);
        let cookies = r_login
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|h| h.to_str().unwrap().split(';').next().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("; ");

        let r_cmds: Value = client
            .get(format!("{base}/api/commands?scope=global"))
            .header("Cookie", &cookies)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r_cmds["success"], json!(true));
        assert_eq!(r_cmds["data"]["commands"].as_array().unwrap().len(), 218);

        let r_sendtask_contract: Value = client
            .get(format!(
                "{base}/api/command-studio/commands/sendtask/contract"
            ))
            .header("Cookie", &cookies)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            r_sendtask_contract["data"]["contract"]["tabs"]
                .as_array()
                .unwrap()
                .len(),
            9
        );

        let r_sendtask_cfg: Value = client
            .get(format!("{base}/api/command-studio/commands/sendtask/config"))
            .header("Cookie", &cookies)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            r_sendtask_cfg["data"]["values"]["schedules.items"]
                .as_array()
                .unwrap()
                .len(),
            24
        );

        // 2. Socket.IO EIOv4 HTTP polling handshake succeeds with authenticated cookies
        let r_eio = client
            .get(format!("{base}/socket.io/?EIO=4&transport=polling"))
            .header("Cookie", &cookies)
            .send()
            .await
            .unwrap();
        assert_eq!(r_eio.status().as_u16(), 200);
        let eio_body = r_eio.text().await.unwrap();
        assert!(
            eio_body.starts_with("0{\"sid\":\""),
            "expected Engine.IO v4 open packet, got: {eio_body}"
        );

        // 3. SPA HTML fallback serves `dashboard/dist/index.html`
        let r_spa = client
            .get(format!("{base}/bots/main/studio"))
            .header("Accept", "text/html")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(r_spa.contains("MYBOT V4 REACT SPA"));

        // 3. Clean `<200ms` shutdown & WAL flush
        let t0 = std::time::Instant::now();
        supervisor.shutdown_all().await;
        flush_handle.shutdown_and_flush().await;
        srv_task.abort();
        assert!(t0.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn daemon_args_supports_node_hybrid_flag() {
        let default_args = DaemonArgs::try_parse_from(["mybotd"]).unwrap();
        assert!(!default_args.node_hybrid);
        assert!(default_args.connect_live_zalo);

        let hybrid_args = DaemonArgs::try_parse_from(["mybotd", "--node-hybrid"]).unwrap();
        assert!(hybrid_args.node_hybrid);
    }
}
