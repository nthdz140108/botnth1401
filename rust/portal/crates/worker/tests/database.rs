//! Real worker state transitions against an isolated PostgreSQL database and HTTP bridge.
use chrono::{Duration, Utc};
use mybot_portal_worker::{BridgeClient, Worker};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
use uuid::Uuid;

async fn bridge() -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let captured = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let captured = captured.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut header_end = None;
                let mut length = 0;
                loop {
                    let mut b = [0u8; 8192];
                    let n = socket.read(&mut b).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&b[..n]);
                    if header_end.is_none() {
                        if let Some(end) = buffer.windows(4).position(|v| v == b"\r\n\r\n") {
                            header_end = Some(end + 4);
                            let headers = String::from_utf8_lossy(&buffer[..end]);
                            assert!(
                                headers
                                    .to_ascii_lowercase()
                                    .contains("x-internal-signature:")
                            );
                            length = headers
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|s| s.trim().parse::<usize>().unwrap())
                                })
                                .unwrap_or(0);
                        }
                    }
                    if header_end.is_some_and(|end| buffer.len() >= end + length) {
                        break;
                    }
                }
                let value: Value = serde_json::from_slice(
                    &buffer[header_end.unwrap()..header_end.unwrap() + length],
                )
                .unwrap();
                captured.lock().await.push(value.clone());
                let result = match value["kind"].as_str().unwrap() {
                    "status" => json!({"authenticated":false,"listenerReady":false,"ready":false}),
                    "qr_status" => json!({"state":"pending"}),
                    "roster" => {
                        json!({"members":[{"uid":"1001"},{"uid":"1002"}],"completeness":"full","total":2})
                    }
                    "send" => json!({"apiConfirmed":true}),
                    _ => json!({}),
                };
                let status = if value["kind"] == "send" && value["payload"]["target_id"] == "9999" {
                    "unknown"
                } else {
                    "succeeded"
                };
                let response=json!({"success":true,"data":{"operation_id":value["operation_id"],"status":status,"result":result}}).to_string();
                let bytes = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response.len(),
                    response
                );
                socket.write_all(bytes.as_bytes()).await.unwrap();
            });
        }
    });
    (url, calls, task)
}
async fn tenant(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO tenants(id) VALUES($1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO wallets(tenant_id) VALUES($1)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}
async fn pending(pool: &PgPool, tenant: Uuid, deadline: chrono::DateTime<Utc>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO slots(id,tenant_id,status,purchased_days,purchase_amount,activation_deadline,binding_revision) VALUES($1,$2,'connecting',30,30000,$3,1)").bind(id).bind(tenant).bind(deadline).execute(pool).await.unwrap();
    id
}
async fn active(pool: &PgPool, tenant: Uuid, uid: &str) -> Uuid {
    let id = pending(pool, tenant, Utc::now() + Duration::days(7)).await;
    sqlx::query("UPDATE slots SET status='active',activated_at=now()-interval '18 days',expires_at=now()+interval '12 days',zalo_uid=$2,last_runtime_check_at=now() WHERE id=$1").bind(id).bind(uid).execute(pool).await.unwrap();
    id
}
async fn campaign(
    pool: &PgPool,
    tenant: Uuid,
    slot: Uuid,
    revision: i64,
    recipients: Value,
    content: Value,
    schedule: Value,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO campaigns(id,tenant_id,slot_id,binding_revision,kind,status,content,schedule,recipients,next_run_at) VALUES($1,$2,$3,$4,'group','running',$5,$6,$7,now())").bind(id).bind(tenant).bind(slot).bind(revision).bind(content).bind(schedule).bind(recipients).execute(pool).await.unwrap();
    id
}
async fn run(
    pool: &PgPool,
    tenant: Uuid,
    campaign: Uuid,
    slot: Uuid,
    revision: i64,
    recipient: &str,
    status: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    let delivery = Uuid::new_v4();
    sqlx::query("INSERT INTO campaign_runs(id,tenant_id,campaign_id,status,content,kind) VALUES($1,$2,$3,'running','{\"text\":\"immutable message\",\"interval_seconds\":5}','group')").bind(id).bind(tenant).bind(campaign).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO deliveries(id,tenant_id,run_id,slot_id,binding_revision,recipient,status,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,now()-interval '1 minute')").bind(delivery).bind(tenant).bind(id).bind(slot).bind(revision).bind(recipient).bind(status).execute(pool).await.unwrap();
    delivery
}

#[tokio::test]
async fn durable_worker_races_snapshots_unknown_and_revision_gates() {
    let admin_url = std::env::var("PORTAL_TEST_DATABASE_URL")
        .expect("Set PORTAL_TEST_DATABASE_URL to isolated PostgreSQL admin database");
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&admin_url)
        .await
        .unwrap();
    let name = format!("portal_worker_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    let url = format!("{}/{}", admin_url.rsplit_once('/').unwrap().0, name);
    let pool = PgPoolOptions::new()
        .max_connections(12)
        .connect(&url)
        .await
        .unwrap();
    sqlx::migrate!("../server/migrations")
        .run(&pool)
        .await
        .unwrap();
    let (base, calls, task) = bridge().await;
    let client =
        BridgeClient::new(base, "worker-test-secret-more-than-32-bytes-long".into()).unwrap();
    let worker = Worker {
        pool: pool.clone(),
        bridge: client.clone(),
    };
    let other = Worker {
        pool: pool.clone(),
        bridge: client,
    };
    let t = tenant(&pool).await;
    // Activation competes against refund on the same slot row near the seven-day boundary.
    let sid = pending(&pool, t, Utc::now() + Duration::milliseconds(10)).await;
    let (activation, sweep) = tokio::join!(worker.activate(sid, t, 1, "111111"), other.tick());
    sweep.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    worker.tick().await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM slots WHERE id=$1")
        .bind(sid)
        .fetch_one(&pool)
        .await
        .unwrap();
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(t)
        .fetch_one(&pool)
        .await
        .unwrap();
    let refunds: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ledger WHERE tenant_id=$1 AND kind='activation_refund'",
    )
    .bind(t)
    .fetch_one(&pool)
    .await
    .unwrap();
    if activation.is_ok() {
        assert_eq!(status, "active");
        assert_eq!(balance, 0);
        assert_eq!(refunds, 0)
    } else {
        assert_eq!(status, "refunded");
        assert_eq!(balance, 30000);
        assert_eq!(refunds, 1)
    }
    worker.tick().await.unwrap();
    let again: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(t)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(again, balance);
    // Replacement after eighteen days retains the exact original remaining twelve-day expiry.
    let swap = active(&pool, t, "222222").await;
    let expiry: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT expires_at FROM slots WHERE id=$1")
            .bind(swap)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE slots SET status='connecting',binding_revision=2 WHERE id=$1")
        .bind(swap)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(worker.activate(swap, t, 2, "333333").await.unwrap(), expiry);
    assert!(worker.activate(swap, t, 1, "444444").await.is_err());
    // A run freezes/deduplicates recipients, filters exclusions, and is unique across workers.
    let slot = active(&pool, t, "555555").await;
    let camp = campaign(
        &pool,
        t,
        slot,
        1,
        json!(["1001", "1001", "1002", "1003"]),
        json!({"text":"snapshot","interval_seconds":5}),
        json!({"mode":"interval","seconds":3600}),
    )
    .await;
    sqlx::query("UPDATE campaigns SET exclusions='[\"1003\"]' WHERE id=$1")
        .bind(camp)
        .execute(&pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(worker.tick(), other.tick());
    a.unwrap();
    b.unwrap();
    let deliveries:i64=sqlx::query_scalar("SELECT count(*) FROM deliveries WHERE run_id IN(SELECT id FROM campaign_runs WHERE campaign_id=$1)").bind(camp).fetch_one(&pool).await.unwrap();
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM campaign_runs WHERE campaign_id=$1")
        .bind(camp)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(deliveries, 2);
    assert_eq!(runs, 1);
    sqlx::query("UPDATE slots SET next_send_at=now()-interval '1 minute' WHERE id=$1")
        .bind(slot)
        .execute(&pool)
        .await
        .unwrap();
    worker.tick().await.unwrap();
    let sent = calls
        .lock()
        .await
        .iter()
        .filter(|v| v["kind"] == "send" && v["slot_id"] == json!(slot))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(sent.len(), 2);
    assert_ne!(
        sent[0]["payload"]["target_id"],
        sent[1]["payload"]["target_id"]
    );
    // Ambiguous sends survive restart as unknown and are never retried automatically.
    let unknown_slot = active(&pool, t, "666666").await;
    let unknown_camp = campaign(
        &pool,
        t,
        unknown_slot,
        1,
        json!(["9999"]),
        json!({"text":"ambiguous","interval_seconds":5}),
        json!({}),
    )
    .await;
    worker.tick().await.unwrap();
    worker.tick().await.unwrap();
    let unknown: i64 =
        sqlx::query_scalar("SELECT count(*) FROM deliveries WHERE slot_id=$1 AND status='unknown'")
            .bind(unknown_slot)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(unknown, 1);
    let count = calls
        .lock()
        .await
        .iter()
        .filter(|v| v["kind"] == "send" && v["slot_id"] == json!(unknown_slot))
        .count();
    assert_eq!(count, 1);
    let crash_camp = campaign(
        &pool,
        t,
        unknown_slot,
        1,
        json!(["8888"]),
        json!({"text":"crash","interval_seconds":5}),
        json!({}),
    )
    .await;
    sqlx::query("UPDATE campaigns SET status='paused',next_run_at=NULL WHERE id=$1")
        .bind(crash_camp)
        .execute(&pool)
        .await
        .unwrap();
    let crash = run(&pool, t, crash_camp, unknown_slot, 1, "8888", "sending").await;
    worker.tick().await.unwrap();
    let state: String = sqlx::query_scalar("SELECT status FROM deliveries WHERE id=$1")
        .bind(crash)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "unknown");
    // Old account revisions and stopped campaigns close the gate before another send.
    let gated_slot = active(&pool, t, "777777").await;
    let gated_camp = campaign(
        &pool,
        t,
        gated_slot,
        1,
        json!([]),
        json!({"text":"gate","interval_seconds":5}),
        json!({}),
    )
    .await;
    sqlx::query("UPDATE campaigns SET next_run_at=NULL WHERE id=$1")
        .bind(gated_camp)
        .execute(&pool)
        .await
        .unwrap();
    let gated = run(&pool, t, gated_camp, gated_slot, 0, "123123", "pending").await;
    worker.tick().await.unwrap();
    let state: String = sqlx::query_scalar("SELECT status FROM deliveries WHERE id=$1")
        .bind(gated)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "skipped");
    // Missed schedules do not send a catch-up burst after downtime.
    let missed = campaign(
        &pool,
        t,
        gated_slot,
        1,
        json!(["9000"]),
        json!({"text":"missed","interval_seconds":5}),
        json!({"mode":"interval","seconds":3600}),
    )
    .await;
    sqlx::query("UPDATE campaigns SET next_run_at=now()-interval '2 hours' WHERE id=$1")
        .bind(missed)
        .execute(&pool)
        .await
        .unwrap();
    worker.tick().await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM campaign_runs WHERE campaign_id=$1")
        .bind(missed)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let next: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT next_run_at FROM campaigns WHERE id=$1")
            .bind(missed)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(next > Utc::now());
    // Incomplete DM roster requires explicit acceptance and creates no deliveries.
    let dm = campaign(
        &pool,
        t,
        gated_slot,
        1,
        json!(["1001"]),
        json!({"text":"dm","interval_seconds":10}),
        json!({}),
    )
    .await;
    sqlx::query("UPDATE campaigns SET kind='dm' WHERE id=$1")
        .bind(dm)
        .execute(&pool)
        .await
        .unwrap();
    worker.tick().await.unwrap();
    let state: String = sqlx::query_scalar("SELECT status FROM campaigns WHERE id=$1")
        .bind(dm)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "needs_review");
    // Suppress unused identity deliberately retained for report checks.
    assert_ne!(unknown_camp, crash_camp);
    task.abort();
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
}
