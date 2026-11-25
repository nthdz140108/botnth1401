pub mod api;
pub mod auth;
pub mod db;
pub async fn router(pool: sqlx::PgPool) -> anyhow::Result<axum::Router> {
    api::router(pool).await
}
