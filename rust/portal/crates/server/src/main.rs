use mybot_portal_server::{api, auth, db};
use sqlx::{Row, postgres::PgPoolOptions};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let admin = args
        .get(1)
        .is_some_and(|v| v == "migrate" || v == "bootstrap-operator");
    let url = if admin {
        std::env::var("PORTAL_MIGRATION_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))?
    } else {
        std::env::var("DATABASE_URL")?
    };
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&url)
        .await?;
    if args.get(1).is_some_and(|v| v == "migrate") {
        db::migrate(&pool).await?;
        println!("Migrations applied");
        return Ok(());
    }
    if args.get(1).is_some_and(|v| v == "bootstrap-operator") {
        let username = args
            .get(2)
            .ok_or_else(|| anyhow::anyhow!("bootstrap-operator USERNAME"))?;
        let secret = auth::random_token();
        let (id, token) = api::provision_user(&pool, username, "operator").await?;
        sqlx::query("UPDATE users SET totp_secret=$2 WHERE id=$1")
            .bind(id)
            .bind(&secret)
            .execute(&pool)
            .await?;
        println!("Activation token (24 hours, show once): {token}");
        let bytes = hex::decode(secret)?;
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let mut bits = 0u32;
        let mut count = 0;
        let mut base32 = String::new();
        for byte in bytes {
            bits = (bits << 8) | byte as u32;
            count += 8;
            while count >= 5 {
                count -= 5;
                base32.push(alphabet[((bits >> count) & 31) as usize] as char)
            }
        }
        if count > 0 {
            base32.push(alphabet[((bits << (5 - count)) & 31) as usize] as char)
        }
        println!("TOTP secret (store safely): {base32}");
        println!(
            "otpauth://totp/MYBOT:{username}?secret={base32}&issuer=MYBOT&algorithm=SHA1&digits=6&period=30"
        );
        return Ok(());
    }
    let r = sqlx::query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
        .fetch_one(&pool)
        .await?;
    anyhow::ensure!(
        !r.get::<bool, _>("rolsuper") && !r.get::<bool, _>("rolbypassrls"),
        "API DATABASE_URL must use a non-superuser, non-BYPASSRLS role"
    );
    let app = mybot_portal_server::router(pool).await?;
    let options = leptos::config::get_configuration(None)?.leptos_options;
    let site = options.site_root.to_string();
    let shell_options = options.clone();
    let app = app
        .fallback(leptos_axum::render_app_to_stream(move || {
            mybot_portal_web::shell(shell_options.clone())
        }))
        .nest_service(
            "/pkg",
            tower_http::services::ServeDir::new(format!("{site}/pkg")),
        )
        .nest_service(
            "/assets",
            tower_http::services::ServeDir::new(format!("{site}/assets")),
        );
    let addr = std::env::var("PORTAL_BIND").unwrap_or_else(|_| "127.0.0.1:4180".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("MYBOT Cloud listening on {addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
