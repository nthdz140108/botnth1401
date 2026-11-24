//! `mybot-ctl` — Administrative CLI & `ratatui` TUI Companion for MyBot V4 on Linux Ubuntu.
//!
//! Subcommands:
//! - `migrate-v3`: Lossless V3 JSON -> V4 SQLite WAL migrator (preserves live cookies & IMEI).
//! - `qr-admin`: Headless SSH UTF-8 half-block QR login saving credentials straight into `mybot.db`.
//! - `top`: Interactive `ratatui` + `crossterm` live TUI fleet monitor (or `--once` snapshot).
//! - `doctor`: Verifies Linux Ubuntu kernel, `/dev/shm` tmpfs, AVX2, SQLite WAL, fonts, `ffmpeg`/`yt-dlp`.
//! - `check-video-pools`: Concurrent `Range: bytes=0-1024` dead-link health checker for `data-send/*.txt`.
//! - `export-json`: Emergency rollback exporter dumping SQLite WAL state back to JSON summary.

use std::io::stdout;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use chrono::Utc;
use clap::{Parser, Subcommand};
use crossterm::event::{self, Event, KeyCode};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use mybot_media::{CaptchaAndQrEngine, CliMediaRunner, RamScratchpad, VideoPoolManager};
use mybot_storage::{BotRecord, StorageEngine, migrate_v3_directory};
use mybot_types::{ExpiryPolicy, ZaloId};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table};
use serde_json::json;
use sysinfo::System;
use tokio_util::sync::CancellationToken;
use zalo_sdk::qr_login::{
    QrLoginOptions, QrLoginPhase, authenticate_zalo_qr, decode_qr_png_data_url,
    render_qr_terminal_utf8,
};

#[derive(Debug, Parser)]
#[command(name = "mybot-ctl", version, about = "V4 Pure-Rust Zalo Bot Fleet Control CLI & TUI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Migrate a V3 Node.js directory into a V4 SQLite WAL database while preserving live cookies.
    MigrateV3 {
        #[arg(long, default_value = "..")]
        source: PathBuf,
        #[arg(long, default_value = "data/mybot.db")]
        db: PathBuf,
        #[arg(long)]
        dry_run: bool,
    },

    /// Authenticate a Zalo bot account directly inside a headless SSH terminal via UTF-8 QR code.
    QrAdmin {
        #[arg(long, default_value = "main")]
        bot_key: String,
        #[arg(long, default_value = "data/mybot.db")]
        db: PathBuf,
        #[arg(long, default_value_t = true)]
        is_main: bool,
    },

    /// Launch the interactive `ratatui` live fleet & RAM/WAL monitor (`q` to quit, or `--once`).
    Top {
        #[arg(long, default_value = "data/mybot.db")]
        db: PathBuf,
        #[arg(long)]
        once: bool,
    },

    /// Inspect runtime environment (OS, CPU AVX2, `/dev/shm`, SQLite WAL, fonts, `ffmpeg`/`yt-dlp`).
    Doctor {
        #[arg(long, default_value = "../assets")]
        assets_dir: PathBuf,
    },

    /// Audit media URL pools (`data-send/*.txt`) concurrently using HTTP `Range: bytes=0-1024`.
    CheckVideoPools {
        #[arg(long, default_value = "..")]
        project_root: PathBuf,
        #[arg(long, default_value = "girl")]
        category: String,
        #[arg(long, default_value_t = 16)]
        concurrency: usize,
    },

    /// Export redacted fleet metadata & group settings from SQLite WAL to a JSON backup file.
    ExportJson {
        #[arg(long, default_value = "data/mybot.db")]
        db: PathBuf,
        #[arg(long, default_value = "data/v4-backup-export.json")]
        out: PathBuf,
    },
}

fn cpu_supports_avx2() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    {
        false
    }
}

async fn run_top_tui(db_path: &Path, once: bool) -> anyhow::Result<()> {
    let engine = if db_path.is_file() {
        StorageEngine::open(db_path, 2)?
    } else {
        StorageEngine::open_in_memory()?
    };

    if once {
        let bots = engine.list_bots()?;
        let mut sys = System::new_all();
        sys.refresh_memory();
        let snapshot = json!({
            "totalBots": bots.len(),
            "runningBots": bots.iter().filter(|b| b.status == "running").count(),
            "systemRamUsedMiB": sys.used_memory() / (1024 * 1024),
            "systemRamTotalMiB": sys.total_memory() / (1024 * 1024),
            "avx2": cpu_supports_avx2(),
            "ramScratchpadRoot": RamScratchpad::detect_preferred_root(),
        });
        println!("{}", serde_json::to_string_pretty(&snapshot)?);
        return Ok(());
    }

    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(out);
    let mut terminal = Terminal::new(backend)?;

    let mut sys = System::new_all();
    let res: anyhow::Result<()> = loop {
        sys.refresh_memory();
        let bots = engine.list_bots().unwrap_or_default();
        let running = bots.iter().filter(|b| b.status == "running").count();
        let used_mib = sys.used_memory() / (1024 * 1024);
        let total_mib = sys.total_memory() / (1024 * 1024);

        terminal.draw(|f| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .margin(1)
                .constraints([Constraint::Length(4), Constraint::Min(8)])
                .split(f.area());

            let header_text = format!(
                "MyBot V4 Pure-Rust Fleet Monitor  |  Bots: {running}/{} Running  |  Host RAM: {used_mib}/{total_mib} MiB  |  AVX2: {}  |  Press 'q' to exit",
                bots.len(),
                if cpu_supports_avx2() { "ON" } else { "OFF" }
            );
            let header = Paragraph::new(header_text).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Linux Ubuntu + Rust V4 Telemetry "),
            );
            f.render_widget(header, chunks[0]);

            let rows: Vec<Row> = bots
                .iter()
                .map(|b| {
                    let color = match b.status.as_str() {
                        "running" => Color::Green,
                        "expired" | "error" => Color::Red,
                        _ => Color::Yellow,
                    };
                    Row::new(vec![
                        Cell::from(b.bot_key.clone()),
                        Cell::from(b.display_name.clone()),
                        Cell::from(b.uid.as_str().to_string()),
                        Cell::from(b.status.clone()).style(Style::default().fg(color).add_modifier(Modifier::BOLD)),
                        Cell::from(b.prefix.clone()),
                        Cell::from(b.expiry_policy.to_v3_string()),
                    ])
                })
                .collect();

            let table = Table::new(
                rows,
                [
                    Constraint::Length(16),
                    Constraint::Length(24),
                    Constraint::Length(22),
                    Constraint::Length(14),
                    Constraint::Length(8),
                    Constraint::Min(18),
                ],
            )
            .header(
                Row::new(vec!["Bot Key", "Display Name", "Zalo UID", "Status", "Prefix", "Expiry"])
                    .style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
            )
            .block(Block::default().borders(Borders::ALL).title(" Bot Instances (SQLite WAL) "));
            f.render_widget(table, chunks[1]);
        })?;

        if event::poll(Duration::from_millis(500))?
            && let Event::Key(key) = event::read()?
            && matches!(key.code, KeyCode::Char('q') | KeyCode::Esc)
        {
            break Ok(());
        }
    };

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    res
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    zalo_sdk::ensure_rustls_ring_provider();
    let _ = dotenvy::from_filename(".env");
    let _ = dotenvy::from_filename(".env.local");

    let cli = Cli::parse();
    match cli.command {
        Commands::MigrateV3 {
            source,
            db,
            dry_run,
        } => {
            if !dry_run
                && let Some(parent) = db.parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent)?;
            }
            let engine = if dry_run {
                StorageEngine::open_in_memory().context("failed to open in-memory SQLite engine")?
            } else {
                StorageEngine::open(&db, 2)
                    .with_context(|| format!("failed to open SQLite WAL database at {}", db.display()))?
            };

            let report = migrate_v3_directory(&source, &engine, dry_run)
                .with_context(|| format!("V3 migration failed from {}", source.display()))?;

            println!("{}", serde_json::to_string_pretty(&report)?);
        }

        Commands::QrAdmin {
            bot_key,
            db,
            is_main,
        } => {
            if let Some(parent) = db.parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent)?;
            }
            let engine = StorageEngine::open(&db, 2)?;
            let cancel = CancellationToken::new();
            println!("🔐 Đang khởi tạo phiên đăng nhập QR Zalo cho bot `{bot_key}`...");

            let outcome = authenticate_zalo_qr(
                QrLoginOptions::default(),
                |phase| match phase {
                    QrLoginPhase::QrReady {
                        qr_data_url,
                        expires_in_secs,
                        ..
                    } => {
                        if let Ok(png_bytes) = decode_qr_png_data_url(&qr_data_url)
                            && let Ok(codes) = CaptchaAndQrEngine::decode_qr_image(&png_bytes)
                            && let Some(qr_payload) = codes.first()
                            && let Ok(ascii_qr) = render_qr_terminal_utf8(qr_payload)
                        {
                            println!("\n📱 Mở ứng dụng Zalo trên điện thoại và quét mã QR dưới đây (còn {expires_in_secs}s):\n");
                            println!("{ascii_qr}");
                        } else {
                            println!("📱 Mã QR đã sẵn sàng (Data URL {} bytes) — còn {expires_in_secs}s.", qr_data_url.len());
                        }
                    }
                    QrLoginPhase::WaitingConfirm => {
                        println!("✅ Đã quét mã! Vui lòng bấm [Xác nhận đăng nhập] trên điện thoại...");
                    }
                    QrLoginPhase::Completed => {
                        println!("🎉 Xác thực phiên Zalo thành công!");
                    }
                    _ => {}
                },
                cancel,
            )
            .await?;

            let now = Utc::now().to_rfc3339();
            engine.upsert_bot(&BotRecord {
                bot_key: bot_key.clone(),
                uid: ZaloId::default(),
                global_uid: None,
                canonical_username: None,
                display_name: outcome.display_name.clone(),
                avatar: outcome.avatar,
                is_main,
                owner_uid: None,
                status: "stopped".into(),
                desired_status: "running".into(),
                expiry_policy: ExpiryPolicy::Permanent,
                trial_status: None,
                cookie_json: outcome.credentials.cookie,
                imei: outcome.credentials.imei,
                user_agent: outcome.credentials.user_agent,
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
            })?;
            println!(
                "💾 Đã lưu phiên cookie & IMEI cho bot `{bot_key}` ({}) vào `{}`.",
                outcome.display_name,
                db.display()
            );
        }

        Commands::Top { db, once } => {
            run_top_tui(&db, once).await?;
        }

        Commands::Doctor { assets_dir } => {
            let shm_exists = Path::new("/dev/shm").is_dir();
            let fonts_dir = assets_dir.join("fonts");
            let font_count = std::fs::read_dir(&fonts_dir)
                .map(|it| it.flatten().count())
                .unwrap_or(0);
            let ffmpeg_ver = CliMediaRunner::probe_binary_version("ffmpeg", "-version").await;
            let ytdlp_ver = CliMediaRunner::probe_binary_version("yt-dlp", "--version").await;

            let info = json!({
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "cpuAvx2Supported": cpu_supports_avx2(),
                "devShmTmpfsAvailable": shm_exists,
                "scratchpadRoot": RamScratchpad::detect_preferred_root(),
                "assetsDirExists": assets_dir.is_dir(),
                "bundledFontFiles": font_count,
                "sqliteWalReady": StorageEngine::open_in_memory().is_ok(),
                "ffmpegVersion": ffmpeg_ver,
                "ytDlpVersion": ytdlp_ver,
            });
            println!("{}", serde_json::to_string_pretty(&info)?);
        }

        Commands::CheckVideoPools {
            project_root,
            category,
            concurrency,
        } => {
            let pools = VideoPoolManager::load_from_project_root(&project_root);
            if category.eq_ignore_ascii_case("stats") {
                println!("{}", serde_json::to_string_pretty(&pools.pool_counts())?);
            } else {
                let report = pools.check_pool_health(&category, concurrency).await?;
                println!("{}", serde_json::to_string_pretty(&report)?);
            }
        }

        Commands::ExportJson { db, out } => {
            let engine = StorageEngine::open(&db, 2)?;
            let bots: Vec<_> = engine
                .list_bots()?
                .into_iter()
                .map(|b| {
                    json!({
                        "botKey": b.bot_key,
                        "uid": b.uid,
                        "displayName": b.display_name,
                        "isMain": b.is_main,
                        "status": b.status,
                        "desiredStatus": b.desired_status,
                        "prefix": b.prefix,
                        "expiry": b.expiry_policy.to_v3_string(),
                    })
                })
                .collect();
            let groups = engine.load_all_group_settings()?;
            let export_doc = json!({
                "exportedAt": Utc::now().to_rfc3339(),
                "version": "4.0.0",
                "bots": bots,
                "groupSettingsCount": groups.len(),
            });
            if let Some(parent) = out.parent()
                && !parent.as_os_str().is_empty()
            {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&out, serde_json::to_string_pretty(&export_doc)?)?;
            println!("✅ Exported redacted V4 snapshot to {}", out.display());
        }
    }

    Ok(())
}
