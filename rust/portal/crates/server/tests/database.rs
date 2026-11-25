//! Real PostgreSQL tests; require PORTAL_TEST_DATABASE_URL, never silently skip.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use mybot_portal_server::{api, auth, db};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    csrf: &str,
    key: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        req = req.header("cookie", format!("mybot_portal={token}"));
    }
    if !csrf.is_empty() {
        req = req.header("x-csrf-token", csrf);
    }
    if !key.is_empty() {
        req = req.header("Idempotency-Key", key);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let data = to_bytes(res.into_body(), 16 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&data).unwrap_or(json!({})))
}
async fn session(pool: &PgPool, id: Uuid) -> (String, String) {
    let token = auth::random_token();
    let csrf = auth::random_token();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')").bind(auth::digest(&token)).bind(id).bind(&csrf).execute(pool).await.unwrap();
    (token, csrf)
}

#[tokio::test]
async fn database_money_capacity_rls_and_authorization() {
    let admin_url = std::env::var("PORTAL_TEST_DATABASE_URL")
        .expect("Set PORTAL_TEST_DATABASE_URL to an isolated PostgreSQL admin database");
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&admin_url)
        .await
        .unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let name = format!("portal_test_{suffix}");
    let role = format!("portal_role_{suffix}");
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(&format!(
        "CREATE ROLE {role} NOLOGIN NOSUPERUSER NOBYPASSRLS"
    ))
    .execute(&admin)
    .await
    .unwrap();
    let base = admin_url.rsplit_once('/').unwrap().0;
    let url = format!("{base}/{name}");
    let owner = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::migrate(&owner).await.unwrap();
    sqlx::query(&format!("GRANT USAGE ON SCHEMA public TO {role}"))
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query(&format!(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO {role}"
    ))
    .execute(&owner)
    .await
    .unwrap();
    let role_clone = role.clone();
    let app_pool = PgPoolOptions::new()
        .max_connections(12)
        .after_connect(move |c, _| {
            let q = format!("SET ROLE {role_clone}");
            Box::pin(async move {
                sqlx::query(&q).execute(c).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    let (a, activation) = api::provision_user(&owner, "tenant_a", "customer")
        .await
        .unwrap();
    let (b, _) = api::provision_user(&owner, "tenant_b", "customer")
        .await
        .unwrap();
    let (op, _) = api::provision_user(&owner, "operator", "operator")
        .await
        .unwrap();
    let ta: Uuid = sqlx::query_scalar("SELECT tenant_id FROM users WHERE id=$1")
        .bind(a)
        .fetch_one(&owner)
        .await
        .unwrap();
    let tb: Uuid = sqlx::query_scalar("SELECT tenant_id FROM users WHERE id=$1")
        .bind(b)
        .fetch_one(&owner)
        .await
        .unwrap();
    let (at, ac) = session(&owner, a).await;
    let (bt, bc) = session(&owner, b).await;
    let (ot, oc) = session(&owner, op).await;
    sqlx::query("UPDATE settings SET unit_price=1000,capacity=2")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE wallets SET balance=30000 WHERE tenant_id=$1")
        .bind(ta)
        .execute(&owner)
        .await
        .unwrap();
    let app = mybot_portal_server::router(app_pool.clone()).await.unwrap();
    // Customer cannot access operator or mutate without CSRF.
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/operator/v1/users",
            &at,
            &ac,
            "",
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/customer/v1/wallet/topups",
            &at,
            "",
            "",
            json!({"amount":1000})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    // Direct SQL RLS remains effective even if API forgot an ownership predicate.
    let mut tenant_tx = db::tenant(&app_pool, tb).await.unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM wallets WHERE tenant_id=$1")
        .bind(ta)
        .fetch_one(&mut *tenant_tx)
        .await
        .unwrap();
    assert_eq!(visible, 0);
    tenant_tx.rollback().await.unwrap();
    // A single-use token cannot be replayed, and consumes all existing sessions.
    let (s, _) = request(
        &app,
        "POST",
        "/api/customer/v1/auth/activate",
        "",
        "",
        "",
        json!({"token":activation,"password":"a-very-long-password"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/customer/v1/auth/activate",
            "",
            "",
            "",
            json!({"token":activation,"password":"other-long-password"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "GET", "/api/customer/v1/me", &at, &ac, "", json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (at, ac) = session(&owner, a).await;
    // Two simultaneous orders share a global capacity lock; exactly one reserves two slots.
    let mut quotes = Vec::new();
    for _ in 0..2 {
        let (s, v) = request(
            &app,
            "POST",
            "/api/customer/v1/rental-quotes",
            &at,
            &ac,
            "",
            json!({"kind":"purchase","quantity":2,"days":10}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        quotes.push(v["data"]["id"].clone());
    }
    let f1 = request(
        &app,
        "POST",
        "/api/customer/v1/orders",
        &at,
        &ac,
        "purchase-key-1",
        json!({"quote_id":quotes[0]}),
    );
    let f2 = request(
        &app,
        "POST",
        "/api/customer/v1/orders",
        &at,
        &ac,
        "purchase-key-2",
        json!({"quote_id":quotes[1]}),
    );
    let (r1, r2) = tokio::join!(f1, f2);
    assert_eq!(
        [r1.0, r2.0]
            .iter()
            .filter(|s| **s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [r1.0, r2.0]
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(ta)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(balance, 10000);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM slots WHERE tenant_id=$1")
        .bind(ta)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let idx = if r1.0 == StatusCode::OK { 0 } else { 1 };
    let k = if idx == 0 {
        "purchase-key-1"
    } else {
        "purchase-key-2"
    };
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/customer/v1/orders",
            &at,
            &ac,
            k,
            json!({"quote_id":quotes[idx]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ledger WHERE tenant_id=$1 AND kind='rental'")
            .bind(ta)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let sid: Uuid = sqlx::query_scalar("SELECT id FROM slots WHERE tenant_id=$1 LIMIT 1")
        .bind(ta)
        .fetch_one(&owner)
        .await
        .unwrap();
    // IDOR protections cover slot, QR, config, rosters, operations and uploads.
    for tail in ["", "/connection", "/config", "/rosters", "/logs"] {
        let path = format!("/api/customer/v1/slots/{sid}{tail}");
        assert_eq!(
            request(&app, "GET", &path, &bt, &bc, "", json!({})).await.0,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    let (s, v) = request(
        &app,
        "POST",
        &format!("/api/customer/v1/slots/{sid}/connections"),
        &at,
        &ac,
        "",
        json!({}),
    )
    .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let oid = v["data"]["operation_id"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/customer/v1/operations/{oid}"),
            &bt,
            &bc,
            "",
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let expires: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT expires_at FROM slots WHERE id=$1")
            .bind(sid)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(expires.is_none(), "QR start must not activate rental");
    // Concurrent manual approvals are credited once; bank reference globally unique.
    let (s, v) = request(
        &app,
        "POST",
        "/api/customer/v1/wallet/topups",
        &bt,
        &bc,
        "",
        json!({"amount":5000}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let top = v["data"]["id"].as_str().unwrap();
    let path = format!("/api/operator/v1/topups/{top}/approve");
    let f1 = request(
        &app,
        "POST",
        &path,
        &ot,
        &oc,
        "approval-key-1",
        json!({"amount":5000,"bank_reference":"BANK-TXN-001"}),
    );
    let f2 = request(
        &app,
        "POST",
        &path,
        &ot,
        &oc,
        "approval-key-1",
        json!({"amount":5000,"bank_reference":"BANK-TXN-001"}),
    );
    let (r1, r2) = tokio::join!(f1, f2);
    assert_eq!(r1.0, StatusCode::OK);
    assert_eq!(r2.0, StatusCode::OK);
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(tb)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(balance, 5000);
    let entry: Uuid = sqlx::query_scalar("SELECT id FROM ledger WHERE tenant_id=$1")
        .bind(tb)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(
        sqlx::query("UPDATE ledger SET amount=999 WHERE id=$1")
            .bind(entry)
            .execute(&owner)
            .await
            .is_err()
    );
    // Distinct quotes racing for the last wallet funds never create a negative balance.
    sqlx::query("UPDATE settings SET capacity=30")
        .execute(&owner)
        .await
        .unwrap();
    let mut qs = Vec::new();
    for _ in 0..2 {
        let (_, v) = request(
            &app,
            "POST",
            "/api/customer/v1/rental-quotes",
            &bt,
            &bc,
            "",
            json!({"kind":"purchase","quantity":1,"days":5}),
        )
        .await;
        qs.push(v["data"]["id"].clone())
    }
    let f1 = request(
        &app,
        "POST",
        "/api/customer/v1/orders",
        &bt,
        &bc,
        "balance-key-1",
        json!({"quote_id":qs[0]}),
    );
    let f2 = request(
        &app,
        "POST",
        "/api/customer/v1/orders",
        &bt,
        &bc,
        "balance-key-2",
        json!({"quote_id":qs[1]}),
    );
    let (r1, r2) = tokio::join!(f1, f2);
    assert_eq!(
        [r1.0, r2.0]
            .iter()
            .filter(|s| **s == StatusCode::OK)
            .count(),
        1
    );
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(tb)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(balance, 0);
    // Foreign upload/campaign IDs cannot be used to access another tenant's data.
    let upload_id = Uuid::new_v4();
    sqlx::query("INSERT INTO uploads(id,tenant_id,mime,data) VALUES($1,$2,'image/png',$3)")
        .bind(upload_id)
        .bind(tb)
        .bind(b"\x89PNG\r\n\x1a\n".as_slice())
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/customer/v1/uploads/{upload_id}"),
            &at,
            &ac,
            "",
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let path = format!("/api/customer/v1/slots/{sid}/campaigns");
    let body = json!({"kind":"group","content":{"text":"hello","interval_seconds":5},"recipients":["123"],"schedule":{"mode":"interval","seconds":3600}});
    let (status, campaign) = request(&app, "POST", &path, &at, &ac, "", body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let cid = campaign["data"]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/customer/v1/campaigns/{cid}"),
            &bt,
            &bc,
            "",
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut foreign = body;
    foreign["content"]["upload_ids"] = json!([upload_id]);
    assert_eq!(
        request(&app, "POST", &path, &at, &ac, "", foreign).await.0,
        StatusCode::BAD_REQUEST
    );
    // Tenant may not elevate permissions through configurable command fields.
    let path = format!("/api/customer/v1/slots/{sid}/commands");
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            &at,
            &ac,
            "",
            json!({"revision":0,"config":{"ping":{"permission":3}}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // Bridge envelopes are unwrapped before exposing command/group collections.
    let operation_id = Uuid::parse_str(oid).unwrap();
    let payload: Value = sqlx::query_scalar("SELECT payload FROM operations WHERE id=$1")
        .bind(operation_id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        payload,
        json!({}),
        "QR engine contract accepts only an empty payload"
    );
    for (kind, result) in [
        (
            "commands",
            json!({"commands":[{"name":"ping","active":true,"countdown":2,"response":"pong"}]}),
        ),
        (
            "groups",
            json!({"groups":[{"id":"123","name":"Test group"}]}),
        ),
    ] {
        sqlx::query("INSERT INTO operations(id,tenant_id,slot_id,kind,status,binding_revision,result) VALUES($1,$2,$3,$4,'succeeded',1,$5)").bind(Uuid::new_v4()).bind(ta).bind(sid).bind(kind).bind(json!({"operation_id":"bridge-operation","status":"succeeded","result":result})).execute(&owner).await.unwrap();
    }
    let (_, v) = request(
        &app,
        "GET",
        &format!("/api/customer/v1/slots/{sid}/commands"),
        &at,
        &ac,
        "",
        json!({}),
    )
    .await;
    assert_eq!(v["data"]["registry"]["commands"][0]["name"], "ping");
    let (_, v) = request(
        &app,
        "GET",
        &format!("/api/customer/v1/slots/{sid}/groups"),
        &at,
        &ac,
        "",
        json!({}),
    )
    .await;
    assert_eq!(v["data"]["groups"][0]["id"], "123");
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/customer/v1/slots/{sid}/actions"),
            &at,
            &ac,
            "",
            json!({"action":"stop"})
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let state: String = sqlx::query_scalar("SELECT status FROM slots WHERE id=$1")
        .bind(sid)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(state, "awaiting_activation");
    let state: String = sqlx::query_scalar("SELECT status FROM operations WHERE id=$1")
        .bind(operation_id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(state, "cancelled");
    let path = format!("/api/customer/v1/slots/{sid}/commands");
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            &at,
            &ac,
            "",
            json!({"revision":0,"config":{"ping":{"values":{"handlerRef":"internal"}}}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "PUT",
            &path,
            &at,
            &ac,
            "",
            json!({"revision":0,"config":{"ping":{"values":{"platform.owner":"me"}}}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(request(&app,"PUT",&path,&at,&ac,"",json!({"revision":0,"config":{"ping":{"active":true,"permission":"all","values":{"operation.enabled":true,"responses.templates.onSuccess":"pong","restrictions.allowedUsers":[{"userId":"123"}]}}}})).await.0,StatusCode::ACCEPTED);
    // Operator login requires TOTP and prevents reusing the same time step.
    let secret = b"12345678901234567890";
    let password = auth::hash_password("operator-long-password").unwrap();
    sqlx::query("UPDATE users SET password_hash=$2,totp_secret=$3 WHERE id=$1")
        .bind(op)
        .bind(password)
        .bind(hex::encode(secret))
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/customer/v1/auth/login",
            "",
            "",
            "",
            json!({"username":"operator","password":"operator-long-password"})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let code = auth::totp(secret, (chrono::Utc::now().timestamp() / 30) as u64);
    let login = json!({"username":"operator","password":"operator-long-password","totp":code});
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/customer/v1/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(login.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("Secure"));
    assert!(cookie.contains("SameSite=Strict"));
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/customer/v1/auth/login",
            "",
            "",
            "",
            login
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // A bank reference cannot credit another request, even across tenant boundaries.
    let (_, v) = request(
        &app,
        "POST",
        "/api/customer/v1/wallet/topups",
        &at,
        &ac,
        "",
        json!({"amount":5000}),
    )
    .await;
    let id = v["data"]["id"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/operator/v1/topups/{id}/approve"),
            &ot,
            &oc,
            "different-approval-key",
            json!({"amount":5000,"bank_reference":"BANK-TXN-001"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(ta)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(balance, 10000);

    // Health check, receipt confirmation ("Tôi đã chuyển"), rejection notification, campaign clone,
    // expired renewal -> paused + lease, and 100 concurrent web sessions / 30 slots P95 < 200ms.
    assert_eq!(
        request(&app, "GET", "/health", "", "", "", json!({})).await.0,
        StatusCode::OK
    );
    let my_upload = Uuid::new_v4();
    sqlx::query("INSERT INTO uploads(id,tenant_id,mime,data) VALUES($1,$2,'image/png',$3)")
        .bind(my_upload)
        .bind(ta)
        .bind(b"\x89PNG\r\n\x1a\n".as_slice())
        .execute(&owner)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/customer/v1/wallet/topups/{id}/confirm"),
            &at,
            &ac,
            "",
            json!({"proof_upload_id": my_upload, "transfer_note": "Chuyển khoản VCB"}),
        )
        .await
        .0,
        StatusCode::OK
    );
    let balance_after_confirm: i64 =
        sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
            .bind(ta)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(
        balance_after_confirm, 10000,
        "Confirming transfer with receipt must never auto-credit wallet"
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/operator/v1/uploads/{my_upload}"),
            &ot,
            &oc,
            "",
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/operator/v1/topups/{id}/reject"),
            &ot,
            &oc,
            "",
            json!({"reason": "Chưa nhận được giao dịch trên sao kê"}),
        )
        .await
        .0,
        StatusCode::OK
    );
    let rejected_notes: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE tenant_id=$1 AND kind='topup_rejected'",
    )
    .bind(ta)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(rejected_notes, 1);

    // Clone campaign to second slot requires audience re-selection before start.
    let sid2: Uuid =
        sqlx::query_scalar("SELECT id FROM slots WHERE tenant_id=$1 AND id<>$2 LIMIT 1")
            .bind(ta)
            .bind(sid)
            .fetch_one(&owner)
            .await
            .unwrap();
    let (clone_st, cloned) = request(
        &app,
        "POST",
        &format!("/api/customer/v1/campaigns/{cid}/clone"),
        &at,
        &ac,
        "",
        json!({"target_slot_id": sid2}),
    )
    .await;
    assert_eq!(clone_st, StatusCode::OK);
    let cloned_id = cloned["data"]["id"].as_str().unwrap();
    assert_eq!(cloned["data"]["status"], "needs_review");
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/api/customer/v1/campaigns/{cloned_id}/actions"),
            &at,
            &ac,
            "",
            json!({"action": "start"}),
        )
        .await
        .0,
        StatusCode::CONFLICT
    );

    // Renewing an expired slot sets status to 'paused' (never auto-resuming campaigns) and queues lease.
    sqlx::query("UPDATE slots SET activated_at=now()-interval '10 days',expires_at=now()-interval '1 hour',status='expired',binding_revision=1 WHERE id=$1")
        .bind(sid2)
        .execute(&owner)
        .await
        .unwrap();
    let (_, rq) = request(
        &app,
        "POST",
        "/api/customer/v1/rental-quotes",
        &at,
        &ac,
        "",
        json!({"kind":"renew","days":5,"slot_ids":[sid2]}),
    )
    .await;
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/customer/v1/orders",
            &at,
            &ac,
            "renew-expired-key",
            json!({"quote_id": rq["data"]["id"]}),
        )
        .await
        .0,
        StatusCode::OK
    );
    let renewed_status: String = sqlx::query_scalar("SELECT status FROM slots WHERE id=$1")
        .bind(sid2)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(renewed_status, "paused");

    // Scale & P95 latency gate: 100 sessions across 30 active simulated slots.
    let cur_slots: i64 = sqlx::query_scalar("SELECT count(*) FROM slots").fetch_one(&owner).await.unwrap();
    for idx in cur_slots..30 {
        sqlx::query("INSERT INTO slots(id,tenant_id,label,status,purchased_days,purchase_amount,activation_deadline,activated_at,expires_at,binding_revision,zalo_uid) VALUES($1,$2,$3,'active',30,30000,now()+interval '7 days',now(),now()+interval '30 days',1,$4)")
            .bind(Uuid::new_v4())
            .bind(if idx % 2 == 0 { ta } else { tb })
            .bind(format!("Bot tải #{idx}"))
            .bind(format!("840000{idx:03}"))
            .execute(&owner)
            .await
            .unwrap();
    }
    let mut load_sessions = Vec::with_capacity(100);
    for idx in 0..100 {
        load_sessions.push(session(&owner, if idx % 2 == 0 { a } else { b }).await);
    }
    let mut handles = Vec::with_capacity(100);
    for (idx, (tok, cs)) in load_sessions.into_iter().enumerate() {
        let router_clone = app.clone();
        let uri = match idx % 4 {
            0 => "/api/customer/v1/me",
            1 => "/api/customer/v1/wallet",
            2 => "/api/customer/v1/slots",
            _ => "/api/customer/v1/pricing",
        };
        handles.push(tokio::spawn(async move {
            let started = std::time::Instant::now();
            let (st, _) = request(&router_clone, "GET", uri, &tok, &cs, "", json!({})).await;
            assert_eq!(st, StatusCode::OK);
            started.elapsed().as_secs_f64() * 1000.0
        }));
    }
    let mut latencies = Vec::with_capacity(100);
    for h in handles {
        latencies.push(h.await.unwrap());
    }
    latencies.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let p95 = latencies[94];
    assert!(p95 < 200.0, "Expected P95 < 200ms for 100 concurrent sessions, got {p95:.2}ms");

    app_pool.close().await;
    owner.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(&format!("DROP ROLE {role}"))
        .execute(&admin)
        .await
        .unwrap();
}
