use mybot_portal_worker::{Worker,BridgeClient};
use sqlx::postgres::PgPoolOptions;
#[tokio::main]
async fn main()->anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let url=std::env::var("PORTAL_WORKER_DATABASE_URL")?;
    let pool=PgPoolOptions::new().max_connections(8).connect(&url).await?;
    let bridge=BridgeClient::new(std::env::var("MYBOT_BRIDGE_URL").unwrap_or_else(|_|"http://127.0.0.1:4174".into()),std::env::var("INTERNAL_API_SECRET")?)?;
    let worker=Worker{pool,bridge};let mut interval=tokio::time::interval(std::time::Duration::from_secs(1));
    loop {tokio::select!{_ = tokio::signal::ctrl_c()=>break,_=interval.tick()=>{if let Err(error)=worker.tick().await{tracing::error!(code="WORKER_TICK_FAILED",error=%error);}}}}
    Ok(())
}
