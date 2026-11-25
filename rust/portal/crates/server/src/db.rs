use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}
pub async fn tenant(pool: &PgPool, id: Uuid) -> Result<Transaction<'_, Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('portal.tenant_id',$1,true)")
        .bind(id.to_string())
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
