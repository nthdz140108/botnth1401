use crate::{auth, db};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ApiError>;

pub struct ApiError(StatusCode, &'static str);

fn error_message(code: &str) -> &'static str {
    match code {
        "UNAUTHENTICATED" => "Vui lòng đăng nhập để tiếp tục.",
        "CSRF_INVALID" => "Phiên bảo mật không hợp lệ, vui lòng tải lại trang.",
        "OPERATOR_REQUIRED" => "Chức năng này chỉ dành cho người vận hành.",
        "INVALID_CREDENTIALS" => "Tên đăng nhập hoặc mật khẩu không đúng.",
        "LOGIN_RATE_LIMIT" => "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.",
        "MFA_SETUP_REQUIRED" => "Tài khoản vận hành chưa thiết lập mã xác thực hai bước.",
        "MFA_REQUIRED" => "Tài khoản vận hành yêu cầu nhập mã xác thực 6 số (TOTP).",
        "MFA_INVALID" => "Mã xác thực hai bước không đúng.",
        "MFA_REPLAY" => "Mã xác thực này vừa được sử dụng, vui lòng chờ mã 30 giây tiếp theo.",
        "PASSWORD_POLICY" => "Mật khẩu phải từ 12 đến 1024 ký tự.",
        "TOKEN_INVALID" => "Liên kết kích hoạt không hợp lệ hoặc đã hết hạn 24 giờ.",
        "IDEMPOTENCY_KEY_REQUIRED" | "INVALID_IDEMPOTENCY_KEY" => "Thiếu khóa chống gửi trùng hợp lệ.",
        "IDEMPOTENCY_CONFLICT" => "Khóa giao dịch đã được dùng cho yêu cầu khác.",
        "INVALID_AMOUNT" => "Số tiền phải là số nguyên từ 1.000 đến 1.000.000.000 VND.",
        "INVALID_QUOTE" => "Yêu cầu báo giá không hợp lệ (1–365 ngày).",
        "DUPLICATE_SLOT" => "Danh sách suất gia hạn có mã bị trùng.",
        "INVALID_QUANTITY" => "Số lượng suất phải từ 1 đến 30.",
        "INVALID_RENEWAL_SLOTS" => "Chỉ được gia hạn các suất đã kích hoạt lần đầu và thuộc sở hữu của bạn.",
        "QUOTE_NOT_FOUND" => "Không tìm thấy báo giá.",
        "QUOTE_EXPIRED_OR_USED" => "Báo giá đã hết hiệu lực 10 phút hoặc đã được sử dụng.",
        "CAPACITY_EXCEEDED" => "Số suất mở bán hiện tại không đủ cho đơn này.",
        "CAPACITY_BELOW_RESERVATIONS" => "Không thể giảm giới hạn xuống thấp hơn số suất đang giữ chỗ.",
        "INSUFFICIENT_BALANCE" => "Số dư ví không đủ để thanh toán đơn này.",
        "SLOT_NOT_FOUND" => "Không tìm thấy suất thuê.",
        "SLOT_EXPIRED" => "Suất thuê đã hết hạn hoặc không còn hiệu lực.",
        "SLOT_NOT_ACTIVATED" => "Suất thuê chưa được kích hoạt lần đầu.",
        "ACTION_NOT_ALLOWED" => "Thao tác không được phép.",
        "REVISION_CONFLICT" => "Dữ liệu đã thay đổi ở phiên khác, vui lòng tải lại trước khi lưu.",
        "CONFIG_FIELD_FORBIDDEN" => "Trường cấu hình không nằm trong phạm vi người thuê được phép chỉnh.",
        "INVALID_CONFIG" => "Dữ liệu cấu hình không hợp lệ.",
        "INVALID_PREFIX" => "Prefix phải từ 1–8 ký tự và không chứa khoảng trắng.",
        "INVALID_LABEL" => "Tên hiển thị bot tối đa 80 ký tự.",
        "INVALID_GROUP_IDS" => "Danh sách nhóm cần quét không hợp lệ (tối đa 100 nhóm).",
        "INVALID_SCHEDULE" => "Cấu hình lịch gửi không hợp lệ.",
        "SCHEDULE_EXCEEDS_EXPIRY" => "Thời điểm kết thúc lịch vượt quá hạn thuê của suất.",
        "SCHEDULE_ENDED" => "Lịch gửi đã qua thời điểm kết thúc.",
        "INVALID_CAMPAIGN_KIND" => "Loại chiến dịch phải là gửi nhóm (group) hoặc gửi riêng (dm).",
        "INVALID_CONTENT_OR_RECIPIENTS" => "Kiểm tra lại nội dung (≤ 2.000 ký tự), ảnh (≤ 5 ảnh) và danh sách người nhận.",
        "PACING_TOO_FAST" => "Khoảng cách tối thiểu là 5 giây với tin nhóm và 10 giây với tin riêng.",
        "INVALID_UPLOAD" | "UPLOAD_NOT_FOUND" => "Tệp ảnh đính kèm không tồn tại hoặc không thuộc tài khoản của bạn.",
        "EMPTY_UPLOAD" => "Chưa chọn tệp ảnh tải lên.",
        "UNSUPPORTED_IMAGE" => "Chỉ hỗ trợ ảnh PNG, JPEG hoặc WebP.",
        "UPLOAD_TOO_LARGE" => "Mỗi ảnh đính kèm tối đa 10 MiB.",
        "INVALID_IMAGE" => "Nội dung tệp ảnh không hợp lệ.",
        "CAMPAIGN_NOT_FOUND" => "Không tìm thấy chiến dịch.",
        "AUDIENCE_REVIEW_REQUIRED" => "Tài khoản Zalo đã thay đổi hoặc chiến dịch cần chọn lại đối tượng nhận trước khi chạy.",
        "ACCOUNT_NOT_BOUND" => "Suất thuê chưa kết nối tài khoản Zalo.",
        "ACCOUNT_ALREADY_BOUND" => "Tài khoản Zalo này đang được gắn ở một suất khác.",
        "TOPUP_ALREADY_REVIEWED" => "Yêu cầu nạp tiền này đã được xử lý trước đó.",
        "REJECTION_REASON_REQUIRED" => "Vui lòng nhập lý do từ chối yêu cầu nạp.",
        "INVALID_BANK_REFERENCE_OR_AMOUNT" => "Vui lòng nhập mã giao dịch ngân hàng và số tiền thực nhận hợp lệ.",
        "USER_CREATION_FAILED" => "Không thể tạo tài khoản (tên đăng nhập không hợp lệ hoặc đã tồn tại).",
        "CANNOT_DISABLE_SELF" => "Không thể tự khóa tài khoản vận hành đang đăng nhập.",
        "USER_NOT_FOUND" => "Không tìm thấy tài khoản khách hàng.",
        "INVALID_SETTINGS" => "Đơn giá phải > 0 và số suất mở bán trong khoảng 0–30.",
        "INVALID_ADJUSTMENT" => "Thông tin điều chỉnh ngày/hoàn ví không hợp lệ.",
        "RESOURCE_NOT_FOUND" => "Không tìm thấy dữ liệu yêu cầu.",
        "CONFLICT" => "Dữ liệu bị trùng lặp hoặc xung đột trạng thái.",
        "DATABASE_ERROR" => "Lỗi cơ sở dữ liệu nội bộ.",
        _ => "Không thực hiện được yêu cầu.",
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":error_message(self.1)}})),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(ref d) = e {
            if d.is_unique_violation() {
                return Self(StatusCode::CONFLICT, "CONFLICT");
            }
        }
        eprintln!("portal database error: {e}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR")
    }
}

fn bad(c: &'static str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, c)
}
fn conflict(c: &'static str) -> ApiError {
    ApiError(StatusCode::CONFLICT, c)
}
fn ok(v: Value) -> Json<Value> {
    Json(json!({"data":v}))
}
fn cookie_security_attr() -> &'static str {
    if std::env::var("PORTAL_SECURE_COOKIE")
        .ok()
        .is_some_and(|v| v.eq_ignore_ascii_case("false") || v == "0")
    {
        ""
    } else {
        " Secure;"
    }
}

#[derive(Clone)]
struct Identity {
    id: Uuid,
    tenant_id: Uuid,
    username: String,
    role: String,
    csrf: String,
}

async fn identity(pool: &PgPool, h: &HeaderMap, write: bool, operator: bool) -> Result<Identity> {
    let token = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .find_map(|v| v.trim().strip_prefix("mybot_portal="))
        })
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED"))?;
    let r = sqlx::query(
        "SELECT u.id,u.tenant_id,u.username,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled",
    )
    .bind(auth::digest(token))
    .fetch_optional(pool)
    .await?
    .ok_or(ApiError(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED"))?;
    let i = Identity {
        id: r.get("id"),
        tenant_id: r.get("tenant_id"),
        username: r.get("username"),
        role: r.get("role"),
        csrf: r.get("csrf"),
    };
    if write && h.get("x-csrf-token").and_then(|v| v.to_str().ok()) != Some(&i.csrf) {
        return Err(ApiError(StatusCode::FORBIDDEN, "CSRF_INVALID"));
    }
    if operator && i.role != "operator" {
        return Err(ApiError(StatusCode::FORBIDDEN, "OPERATOR_REQUIRED"));
    }
    Ok(i)
}

fn key(h: &HeaderMap) -> Result<String> {
    let v = h
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or(bad("IDEMPOTENCY_KEY_REQUIRED"))?;
    if v.len() < 8 || v.len() > 128 {
        return Err(bad("INVALID_IDEMPOTENCY_KEY"));
    }
    Ok(v.into())
}

async fn health(State(p): State<PgPool>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&p).await {
        Ok(_) => (StatusCode::OK, Json(json!({"status":"ok"}))).into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"degraded"})),
        )
            .into_response(),
    }
}

pub async fn router(pool: PgPool) -> anyhow::Result<Router> {
    let customer = Router::new()
        .route("/auth/login", post(login))
        .route("/auth/activate", post(activate))
        .route("/auth/logout", post(logout))
        .route("/auth/password", post(change_password))
        .route("/auth/sessions", get(sessions).delete(revoke_sessions))
        .route("/me", get(me))
        .route("/pricing", get(pricing))
        .route("/wallet", get(wallet))
        .route("/wallet/entries", get(entries))
        .route("/wallet/topups", get(topups).post(create_topup))
        .route("/wallet/topups/{id}", get(topup))
        .route("/wallet/topups/{id}/confirm", post(confirm_topup))
        .route("/rental-quotes", post(quote))
        .route("/orders", get(orders).post(order))
        .route("/slots", get(slots))
        .route("/slots/{id}", get(slot))
        .route("/slots/{id}/connections", post(connect))
        .route("/slots/{id}/connection", get(connection).delete(disconnect))
        .route("/slots/{id}/actions", post(action))
        .route("/slots/{id}/config", get(config).put(save_config))
        .route("/slots/{id}/commands", get(commands).put(save_commands))
        .route("/slots/{id}/groups", get(groups).put(save_groups))
        .route("/slots/{id}/rosters", get(rosters).post(scan_roster))
        .route(
            "/slots/{id}/campaigns",
            get(slot_campaigns).post(create_campaign),
        )
        .route("/campaigns", get(campaigns))
        .route("/campaigns/{id}", get(campaign).put(update_campaign))
        .route("/campaigns/{id}/actions", post(campaign_action))
        .route("/campaigns/{id}/clone", post(clone_campaign))
        .route("/campaigns/{id}/runs", get(runs))
        .route("/campaigns/{id}/test", post(test_campaign))
        .route("/uploads", post(upload))
        .route("/uploads/{id}", get(download))
        .route("/operations/{id}", get(operation))
        .route("/notifications", get(notifications))
        .route("/events", get(events))
        .route("/slots/{id}/logs", get(slot_logs));
    let operator = Router::new()
        .route("/users", get(users).post(create_user))
        .route("/users/{id}", put(update_user))
        .route("/users/{id}/reset", post(reset_user))
        .route("/topups", get(operator_topups))
        .route("/topups/{id}/approve", post(approve_topup))
        .route("/topups/{id}/reject", post(reject_topup))
        .route("/uploads/{id}", get(operator_download))
        .route("/settings", get(operator_settings).put(save_settings))
        .route("/orders", get(operator_orders))
        .route("/slots", get(operator_slots))
        .route("/audit", get(operator_audit))
        .route("/slots/{id}/adjust", post(adjust_slot));
    Ok(Router::new()
        .nest("/api/customer/v1", customer)
        .nest("/api/operator/v1", operator)
        .route("/health", get(health))
        .route("/healthz", get(health))
        .layer(DefaultBodyLimit::max(11 * 1024 * 1024))
        .with_state(pool))
}

#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
    totp: Option<String>,
}
async fn login(State(p): State<PgPool>, Json(b): Json<Login>) -> Result<Response> {
    if b.username.len() > 80
        || b.password.len() > 1024
        || b.totp.as_ref().is_some_and(|v| !v.is_empty() && v.len() != 6)
    {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "INVALID_CREDENTIALS"));
    }
    let mut tx = p.begin().await?;
    sqlx::query("INSERT INTO login_attempts(username) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(&b.username)
        .execute(&mut *tx)
        .await?;
    let r =
        sqlx::query("SELECT attempts,window_at FROM login_attempts WHERE username=$1 FOR UPDATE")
            .bind(&b.username)
            .fetch_one(&mut *tx)
            .await?;
    let recent: chrono::DateTime<Utc> = r.get("window_at");
    if recent > Utc::now() - Duration::minutes(15) && r.get::<i32, _>("attempts") >= 10 {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "LOGIN_RATE_LIMIT"));
    }
    sqlx::query("UPDATE login_attempts SET attempts=CASE WHEN window_at<now()-interval '15 minutes' THEN 1 ELSE attempts+1 END,window_at=CASE WHEN window_at<now()-interval '15 minutes' THEN now() ELSE window_at END WHERE username=$1").bind(&b.username).execute(&mut *tx).await?;
    tx.commit().await?;
    let row = sqlx::query("SELECT * FROM users WHERE username=$1 AND NOT disabled")
        .bind(&b.username)
        .fetch_optional(&p)
        .await?;
    let valid = row
        .as_ref()
        .and_then(|r| r.get::<Option<String>, _>("password_hash"))
        .is_some_and(|hash| auth::verify_password(&b.password, &hash));
    if !valid {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "INVALID_CREDENTIALS"));
    }
    let r = row.unwrap();
    let id: Uuid = r.get("id");
    if r.get::<String, _>("role") == "operator" {
        let secret = r
            .get::<Option<String>, _>("totp_secret")
            .ok_or(ApiError(StatusCode::FORBIDDEN, "MFA_SETUP_REQUIRED"))?;
        let bytes = hex::decode(secret).map_err(|_| bad("MFA_INVALID"))?;
        let step = (Utc::now().timestamp() / 30) as u64;
        let code = b
            .totp
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "MFA_REQUIRED"))?;
        let matched = (step.saturating_sub(1)..=step + 1)
            .find(|s| auth::totp(&bytes, *s) == code)
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "MFA_INVALID"))?;
        if sqlx::query("UPDATE users SET last_totp_step=$2 WHERE id=$1 AND last_totp_step<$2")
            .bind(id)
            .bind(matched as i64)
            .execute(&p)
            .await?
            .rows_affected()
            != 1
        {
            return Err(ApiError(StatusCode::UNAUTHORIZED, "MFA_REPLAY"));
        }
    }
    let token = auth::random_token();
    let csrf = auth::random_token();
    sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')")
        .bind(auth::digest(&token))
        .bind(id)
        .bind(&csrf)
        .execute(&p)
        .await?;
    sqlx::query("DELETE FROM login_attempts WHERE username=$1")
        .bind(&b.username)
        .execute(&p)
        .await?;
    let sec = cookie_security_attr();
    Ok((
        [(
            header::SET_COOKIE,
            format!(
                "mybot_portal={token}; Path=/; HttpOnly;{sec} SameSite=Strict; Max-Age=43200"
            ),
        )],
        ok(json!({"csrf":csrf,"role":r.get::<String,_>("role")})),
    )
        .into_response())
}

#[derive(Deserialize)]
struct Activate {
    token: String,
    password: String,
}
async fn activate(State(p): State<PgPool>, Json(b): Json<Activate>) -> Result<Json<Value>> {
    let hash = auth::hash_password(&b.password).map_err(|_| bad("PASSWORD_POLICY"))?;
    let mut tx = p.begin().await?;
    let r = sqlx::query("UPDATE account_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() AND EXISTS(SELECT 1 FROM users WHERE users.id=account_tokens.user_id AND NOT disabled) RETURNING user_id")
        .bind(auth::digest(&b.token))
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(bad("TOKEN_INVALID"))?;
    let id: Uuid = r.get("user_id");
    sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1 AND NOT disabled")
        .bind(id)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"activated":true})))
}

async fn me(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    Ok(ok(
        json!({"id":i.id,"tenant_id":i.tenant_id,"username":i.username,"role":i.role,"csrf":i.csrf}),
    ))
}

async fn logout(State(p): State<PgPool>, h: HeaderMap) -> Result<Response> {
    let i = identity(&p, &h, true, false).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1 AND csrf=$2")
        .bind(i.id)
        .bind(i.csrf)
        .execute(&p)
        .await?;
    let sec = cookie_security_attr();
    Ok((
        [(
            header::SET_COOKIE,
            format!("mybot_portal=; Path=/;{sec} HttpOnly; SameSite=Strict; Max-Age=0"),
        )],
        ok(json!({"logged_out":true})),
    )
        .into_response())
}

#[derive(Deserialize)]
struct Password {
    current_password: String,
    password: String,
}
async fn change_password(
    State(p): State<PgPool>,
    h: HeaderMap,
    Json(b): Json<Password>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(i.id)
        .fetch_one(&p)
        .await?;
    if !auth::verify_password(&b.current_password, &hash) {
        return Err(bad("INVALID_CREDENTIALS"));
    }
    let hash = auth::hash_password(&b.password).map_err(|_| bad("PASSWORD_POLICY"))?;
    let mut tx = p.begin().await?;
    sqlx::query("UPDATE users SET password_hash=$2 WHERE id=$1")
        .bind(i.id)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(i.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"changed":true})))
}

async fn sessions(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let v: Value = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(jsonb_build_object('created_at',created_at,'expires_at',expires_at,'current',(csrf=$2))),'[]') FROM sessions WHERE user_id=$1 AND expires_at>now()",
    )
    .bind(i.id)
    .bind(i.csrf)
    .fetch_one(&p)
    .await?;
    Ok(ok(v))
}

async fn revoke_sessions(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(i.id)
        .execute(&p)
        .await?;
    Ok(ok(json!({"revoked":true})))
}

async fn resolved_settings(p: &PgPool) -> Result<Value> {
    let mut v: Value = sqlx::query_scalar("SELECT to_jsonb(s) FROM settings s WHERE id=1")
        .fetch_one(p)
        .await?;
    let used: i64 = sqlx::query_scalar("SELECT portal_used_capacity()")
        .fetch_one(p)
        .await?;
    let cap = v["capacity"].as_i64().unwrap_or(0);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("used".into(), json!(used));
        obj.insert("available".into(), json!((cap - used).max(0)));
        for (field, env_key) in [
            ("bank_name", "PORTAL_BANK_NAME"),
            ("bank_account", "PORTAL_BANK_ACCOUNT"),
            ("bank_holder", "PORTAL_BANK_HOLDER"),
            ("bank_qr_url", "PORTAL_BANK_QR_URL"),
            ("support_contact", "PORTAL_SUPPORT_CONTACT"),
        ] {
            if obj.get(field).and_then(Value::as_str).unwrap_or("").is_empty() {
                if let Ok(val) = std::env::var(env_key) {
                    if !val.trim().is_empty() {
                        obj.insert(field.into(), json!(val.trim()));
                    }
                }
            }
        }
    }
    Ok(v)
}

async fn pricing(State(p): State<PgPool>) -> Result<Json<Value>> {
    Ok(ok(resolved_settings(&p).await?))
}

async fn list(p: &PgPool, h: &HeaderMap, table: &str) -> Result<Json<Value>> {
    let i = identity(p, h, false, false).await?;
    let mut tx = db::tenant(p, i.tenant_id).await?;
    let q = format!(
        "SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT * FROM {table} WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500) t"
    );
    let v = sqlx::query_scalar(&q)
        .bind(i.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    Ok(ok(v))
}

async fn wallet(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let b: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(i.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    Ok(ok(json!({"balance":b,"currency":"VND"})))
}
async fn entries(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    list(&p, &h, "ledger").await
}
async fn topups(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    list(&p, &h, "topups").await
}
async fn orders(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    list(&p, &h, "orders").await
}
async fn notifications(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    list(&p, &h, "notifications").await
}

const ENRICHED_SLOTS_CTE: &str = "jsonb_build_object(
    'synced_groups_count', coalesce((
        SELECT CASE
            WHEN jsonb_typeof(o.result->'result'->'groups')='array' THEN jsonb_array_length(o.result->'result'->'groups')
            WHEN jsonb_typeof(o.result->'groups')='array' THEN jsonb_array_length(o.result->'groups')
            WHEN jsonb_typeof(o.result->'result')='object' THEN (SELECT count(*)::int FROM jsonb_object_keys(o.result->'result'))
            ELSE 0
        END
        FROM operations o
        WHERE o.slot_id=s.id AND o.tenant_id=s.tenant_id AND o.kind='groups' AND o.status='succeeded' AND o.binding_revision=s.binding_revision
        ORDER BY o.updated_at DESC LIMIT 1
    ), 0),
    'groups_synced_at', (
        SELECT o.updated_at FROM operations o
        WHERE o.slot_id=s.id AND o.tenant_id=s.tenant_id AND o.kind='groups' AND o.status='succeeded' AND o.binding_revision=s.binding_revision
        ORDER BY o.updated_at DESC LIMIT 1
    ),
    'active_campaigns_count', (
        SELECT count(*)::int FROM campaigns c
        WHERE c.slot_id=s.id AND c.tenant_id=s.tenant_id AND c.status='running'
    ),
    'last_error', (
        SELECT coalesce(o.result->>'code', o.result->'error'->>'code')
        FROM operations o
        WHERE o.slot_id=s.id AND o.tenant_id=s.tenant_id AND o.status='failed' AND o.binding_revision=s.binding_revision
        ORDER BY o.updated_at DESC LIMIT 1
    )
)";

async fn slots(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let q = format!(
        "SELECT coalesce(jsonb_agg(to_jsonb(s) || {ENRICHED_SLOTS_CTE}),'[]'::jsonb) FROM (SELECT * FROM slots WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500) s"
    );
    let v: Value = sqlx::query_scalar(&q)
        .bind(i.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    Ok(ok(v))
}

async fn slot(State(p): State<PgPool>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let q = format!(
        "SELECT to_jsonb(s) || {ENRICHED_SLOTS_CTE} FROM slots s WHERE s.id=$1 AND s.tenant_id=$2"
    );
    let v: Value = sqlx::query_scalar(&q)
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "SLOT_NOT_FOUND"))?;
    Ok(ok(v))
}

#[derive(Deserialize)]
struct Amount {
    amount: i64,
}
async fn create_topup(
    State(p): State<PgPool>,
    h: HeaderMap,
    Json(b): Json<Amount>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    if b.amount < 1000 || b.amount > 1_000_000_000 {
        return Err(bad("INVALID_AMOUNT"));
    }
    let info = resolved_settings(&p).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO topups(id,tenant_id,amount) VALUES($1,$2,$3)")
        .bind(id)
        .bind(i.tenant_id)
        .bind(b.amount)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let code = id.simple().to_string();
    let short_ref = &code[..10];
    Ok(ok(json!({
        "id": id,
        "amount": b.amount,
        "status": "pending",
        "transfer_content": format!("MYBOT {short_ref}"),
        "bank_name": info["bank_name"].as_str().unwrap_or_default(),
        "bank_account": info["bank_account"].as_str().unwrap_or_default(),
        "bank_holder": info["bank_holder"].as_str().unwrap_or_default(),
        "bank_qr_url": info["bank_qr_url"].as_str().unwrap_or_default(),
    })))
}

#[derive(Deserialize)]
struct ConfirmTopup {
    #[serde(default)]
    proof_upload_id: Option<Uuid>,
    #[serde(default)]
    transfer_note: Option<String>,
}
async fn confirm_topup(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<ConfirmTopup>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let note = b
        .transfer_note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if note.as_ref().is_some_and(|s| s.chars().count() > 500) {
        return Err(bad("INVALID_CONFIG"));
    }
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    if let Some(uid) = b.proof_upload_id {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM uploads WHERE id=$1 AND tenant_id=$2)")
                .bind(uid)
                .bind(i.tenant_id)
                .fetch_one(&mut *tx)
                .await?;
        if !exists {
            return Err(bad("INVALID_UPLOAD"));
        }
    }
    let r = sqlx::query("SELECT status FROM topups WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "RESOURCE_NOT_FOUND"))?;
    let current: String = r.get("status");
    if !matches!(current.as_str(), "pending" | "awaiting_review") {
        return Err(conflict("TOPUP_ALREADY_REVIEWED"));
    }
    sqlx::query(
        "UPDATE topups SET status='awaiting_review',proof_upload_id=coalesce($3,proof_upload_id),transfer_note=coalesce($4,transfer_note),submitted_at=coalesce(submitted_at,now()) WHERE id=$1 AND tenant_id=$2",
    )
    .bind(id)
    .bind(i.tenant_id)
    .bind(b.proof_upload_id)
    .bind(note)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"id": id, "status": "awaiting_review"})))
}

#[derive(Deserialize)]
struct Quote {
    kind: String,
    #[serde(default = "one")]
    quantity: i32,
    days: i32,
    #[serde(default)]
    slot_ids: Vec<Uuid>,
}
fn one() -> i32 {
    1
}
async fn quote(State(p): State<PgPool>, h: HeaderMap, Json(b): Json<Quote>) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    if !(1..=365).contains(&b.days) || !matches!(b.kind.as_str(), "purchase" | "renew") {
        return Err(bad("INVALID_QUOTE"));
    }
    let qty = if b.kind == "renew" {
        let set: std::collections::HashSet<_> = b.slot_ids.iter().collect();
        if set.len() != b.slot_ids.len() {
            return Err(bad("DUPLICATE_SLOT"));
        }
        b.slot_ids.len() as i32
    } else {
        b.quantity
    };
    if !(1..=30).contains(&qty) {
        return Err(bad("INVALID_QUANTITY"));
    }
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    if b.kind == "renew" {
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM slots WHERE id=ANY($1) AND tenant_id=$2 AND activated_at IS NOT NULL AND status NOT IN ('refunded','purged')",
        )
        .bind(&b.slot_ids)
        .bind(i.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
        if n != qty as i64 {
            return Err(bad("INVALID_RENEWAL_SLOTS"));
        }
    }
    let row = sqlx::query("SELECT unit_price,capacity FROM settings WHERE id=1")
        .fetch_one(&mut *tx)
        .await?;
    let price: i64 = row.get("unit_price");
    let capacity: i32 = row.get("capacity");
    let used: i64 = sqlx::query_scalar("SELECT portal_used_capacity()")
        .fetch_one(&mut *tx)
        .await?;
    if b.kind == "purchase" && used + (qty as i64) > (capacity as i64) {
        return Err(conflict("CAPACITY_EXCEEDED"));
    }
    let balance: i64 = sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1")
        .bind(i.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    let total = price
        .checked_mul(qty as i64)
        .and_then(|v| v.checked_mul(b.days as i64))
        .ok_or(bad("AMOUNT_OVERFLOW"))?;
    let id = Uuid::new_v4();
    let expires = Utc::now() + Duration::minutes(10);
    sqlx::query("INSERT INTO quotes(id,tenant_id,kind,quantity,days,slot_ids,unit_price,total,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(id)
        .bind(i.tenant_id)
        .bind(&b.kind)
        .bind(qty)
        .bind(b.days)
        .bind(&b.slot_ids)
        .bind(price)
        .bind(total)
        .bind(expires)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({
        "id": id,
        "quote_id": id,
        "kind": b.kind,
        "quantity": qty,
        "days": b.days,
        "unit_price": price,
        "total": total,
        "wallet_balance": balance,
        "balance_after": balance - total,
        "expires_at": expires,
    })))
}

#[derive(Deserialize)]
struct Order {
    quote_id: Uuid,
}
async fn order(State(p): State<PgPool>, h: HeaderMap, Json(b): Json<Order>) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let k = key(&h)?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    // Global capacity lock is acquired before all wallet/slot locks, including renewal.
    let capacity: i32 = sqlx::query_scalar("SELECT capacity FROM settings WHERE id=1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    if let Some(v) = sqlx::query_scalar::<_, Value>(
        "SELECT to_jsonb(o) FROM orders o WHERE tenant_id=$1 AND idempotency_key=$2",
    )
    .bind(i.tenant_id)
    .bind(&k)
    .fetch_optional(&mut *tx)
    .await?
    {
        if v["quote_id"] != json!(b.quote_id) {
            return Err(conflict("IDEMPOTENCY_CONFLICT"));
        }
        return Ok(ok(v));
    }
    let q = sqlx::query("SELECT * FROM quotes WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
        .bind(b.quote_id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(bad("QUOTE_NOT_FOUND"))?;
    if q.get::<Option<chrono::DateTime<Utc>>, _>("consumed_at")
        .is_some()
        || q.get::<chrono::DateTime<Utc>, _>("expires_at") <= Utc::now()
    {
        return Err(conflict("QUOTE_EXPIRED_OR_USED"));
    }
    let total: i64 = q.get("total");
    let qty: i32 = q.get("quantity");
    let days: i32 = q.get("days");
    let kind: String = q.get("kind");
    // Capacity is counted through a SECURITY DEFINER function, never through tenant RLS.
    let used: i64 = sqlx::query_scalar("SELECT portal_used_capacity()")
        .fetch_one(&mut *tx)
        .await?;
    let ids: Vec<Uuid> = q.get("slot_ids");
    let mut reclaimed = 0i64;
    let mut renewed_bindings: Vec<(Uuid, i64)> = Vec::new();
    if kind == "renew" {
        let rows = sqlx::query(
            "SELECT id,expires_at,activated_at,status,binding_revision FROM slots WHERE id=ANY($1) AND tenant_id=$2 ORDER BY id FOR UPDATE",
        )
        .bind(&ids)
        .bind(i.tenant_id)
        .fetch_all(&mut *tx)
        .await?;
        if rows.len() != ids.len() {
            return Err(bad("INVALID_RENEWAL_SLOTS"));
        }
        for s in rows {
            if s.get::<Option<chrono::DateTime<Utc>>, _>("activated_at")
                .is_none()
                || matches!(s.get::<String, _>("status").as_str(), "refunded" | "purged")
            {
                return Err(bad("INVALID_RENEWAL_SLOTS"));
            }
            if s.get::<Option<chrono::DateTime<Utc>>, _>("expires_at")
                .is_none_or(|v| v <= Utc::now())
            {
                reclaimed += 1;
            }
            let rev: i64 = s.get("binding_revision");
            if rev > 0 {
                renewed_bindings.push((s.get("id"), rev));
            }
        }
    }
    let needed = if kind == "purchase" {
        qty as i64
    } else {
        reclaimed
    };
    if used + needed > capacity as i64 {
        return Err(conflict("CAPACITY_EXCEEDED"));
    }
    let balance: i64 =
        sqlx::query_scalar("SELECT balance FROM wallets WHERE tenant_id=$1 FOR UPDATE")
            .bind(i.tenant_id)
            .fetch_one(&mut *tx)
            .await?;
    if balance < total {
        return Err(conflict("INSUFFICIENT_BALANCE"));
    }
    let id = Uuid::new_v4();
    sqlx::query("UPDATE wallets SET balance=balance-$2 WHERE tenant_id=$1")
        .bind(i.tenant_id)
        .bind(total)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO ledger(id,tenant_id,amount,kind,reference,idempotency_key) VALUES($1,$2,$3,'rental',$4,$5)")
        .bind(Uuid::new_v4())
        .bind(i.tenant_id)
        .bind(-total)
        .bind(id.to_string())
        .bind(format!("order:{k}"))
        .execute(&mut *tx)
        .await?;
    let mut created_slots = Vec::new();
    if kind == "purchase" {
        let existing_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM slots WHERE tenant_id=$1")
                .bind(i.tenant_id)
                .fetch_one(&mut *tx)
                .await?;
        for idx in 0..qty {
            let sid = Uuid::new_v4();
            let label = format!("Bot số {}", existing_count + (idx as i64) + 1);
            sqlx::query("INSERT INTO slots(id,tenant_id,label,purchased_days,purchase_amount,activation_deadline) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')")
                .bind(sid)
                .bind(i.tenant_id)
                .bind(label)
                .bind(days)
                .bind(total / (qty as i64))
                .execute(&mut *tx)
                .await?;
            created_slots.push(sid);
        }
    } else {
        sqlx::query("UPDATE slots SET expires_at=greatest(expires_at,now())+make_interval(days=>$3),status=CASE WHEN status='expired' THEN 'paused' ELSE status END,last_runtime_check_at=NULL WHERE id=ANY($1) AND tenant_id=$2")
            .bind(&ids)
            .bind(i.tenant_id)
            .bind(days)
            .execute(&mut *tx)
            .await?;
        for (sid, rev) in renewed_bindings {
            enqueue(&mut tx, i.tenant_id, sid, rev, "lease", json!({})).await?;
        }
    }
    sqlx::query(
        "INSERT INTO orders(id,tenant_id,quote_id,idempotency_key,total) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(id)
    .bind(i.tenant_id)
    .bind(b.quote_id)
    .bind(k)
    .bind(total)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE quotes SET consumed_at=now() WHERE id=$1")
        .bind(b.quote_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({
        "id": id,
        "kind": kind,
        "total": total,
        "slot_ids": if kind == "purchase" { created_slots } else { ids },
    })))
}

async fn owned_slot(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    id: Uuid,
    live: bool,
) -> Result<sqlx::postgres::PgRow> {
    let r = sqlx::query("SELECT * FROM slots WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
        .bind(id)
        .bind(tenant)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "SLOT_NOT_FOUND"))?;
    if live
        && (matches!(r.get::<String, _>("status").as_str(), "refunded" | "purged")
            || r.get::<Option<chrono::DateTime<Utc>>, _>("expires_at")
                .is_some_and(|v| v <= Utc::now())
            || (r
                .get::<Option<chrono::DateTime<Utc>>, _>("activated_at")
                .is_none()
                && r.get::<chrono::DateTime<Utc>, _>("activation_deadline") <= Utc::now()))
    {
        return Err(conflict("SLOT_EXPIRED"));
    }
    Ok(r)
}

async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    slot: Uuid,
    revision: i64,
    kind: &str,
    payload: Value,
) -> Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO operations(id,tenant_id,slot_id,kind,binding_revision,payload) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(id)
        .bind(tenant)
        .bind(slot)
        .bind(kind)
        .bind(revision)
        .bind(payload)
        .execute(&mut **tx)
        .await?;
    Ok(id)
}

fn accepted(id: Uuid) -> Response {
    (
        StatusCode::ACCEPTED,
        ok(json!({"operation_id":id,"status":"pending"})),
    )
        .into_response()
}

async fn resource(p: &PgPool, h: &HeaderMap, table: &str, id: Uuid) -> Result<Json<Value>> {
    let i = identity(p, h, false, false).await?;
    let mut tx = db::tenant(p, i.tenant_id).await?;
    let q = format!("SELECT to_jsonb(t) FROM {table} t WHERE id=$1 AND tenant_id=$2");
    let v = sqlx::query_scalar(&q)
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "RESOURCE_NOT_FOUND"))?;
    Ok(ok(v))
}

async fn connect(State(p): State<PgPool>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Response> {
    let i = identity(&p, &h, true, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, id, true).await?;
    let rev = s.get::<i64, _>("binding_revision") + 1;
    sqlx::query("UPDATE slots SET binding_revision=$2,status='connecting',zalo_name=NULL,zalo_avatar=NULL WHERE id=$1")
        .bind(id)
        .bind(rev)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE campaigns SET status='needs_review',next_run_at=NULL WHERE slot_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE deliveries SET status='skipped',result='{\"code\":\"ACCOUNT_CHANGED\"}' WHERE slot_id=$1 AND status='pending'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE operations SET status='cancelled' WHERE slot_id=$1 AND status='pending'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let op = enqueue(&mut tx, i.tenant_id, id, rev, "qr_start", json!({})).await?;
    tx.commit().await?;
    Ok(accepted(op))
}

async fn connection(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, id, false).await?;
    let v = sqlx::query_scalar::<_, Value>(
        "SELECT to_jsonb(o) FROM operations o WHERE slot_id=$1 AND tenant_id=$2 AND kind IN ('qr_start','qr_status') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(id)
    .bind(i.tenant_id)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or_else(|| json!({"status":"not_connected","slot_status":s.get::<String,_>("status")}));
    Ok(ok(v))
}

async fn disconnect(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    queue_action(&p, &h, id, "unlink", json!({})).await
}

#[derive(Deserialize)]
struct Action {
    action: String,
}
async fn action(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Action>,
) -> Result<Response> {
    if !matches!(
        b.action.as_str(),
        "start" | "stop" | "restart" | "groups" | "commands" | "qr_cancel"
    ) {
        return Err(bad("ACTION_NOT_ALLOWED"));
    }
    queue_action(&p, &h, id, &b.action, json!({})).await
}

async fn queue_action(
    p: &PgPool,
    h: &HeaderMap,
    id: Uuid,
    kind: &str,
    payload: Value,
) -> Result<Response> {
    let i = identity(p, h, true, false).await?;
    let mut tx = db::tenant(p, i.tenant_id).await?;
    let s = owned_slot(
        &mut tx,
        i.tenant_id,
        id,
        !matches!(kind, "stop" | "unlink" | "qr_cancel"),
    )
    .await?;
    if matches!(kind, "stop" | "unlink") {
        sqlx::query("UPDATE slots SET status=CASE WHEN status IN ('expired','refunded','purged') THEN status WHEN activated_at IS NULL THEN 'awaiting_activation' ELSE 'paused' END,zalo_uid=CASE WHEN $2='unlink' THEN NULL ELSE zalo_uid END,zalo_name=CASE WHEN $2='unlink' THEN NULL ELSE zalo_name END,zalo_avatar=CASE WHEN $2='unlink' THEN NULL ELSE zalo_avatar END WHERE id=$1")
            .bind(id)
            .bind(kind)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE operations SET status='cancelled',result='{\"code\":\"USER_STOPPED\"}' WHERE slot_id=$1 AND binding_revision=$2 AND kind IN ('qr_start','start','restart') AND status IN ('pending','running')")
            .bind(id)
            .bind(s.get::<i64, _>("binding_revision"))
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE campaigns SET status=CASE WHEN $2='unlink' THEN 'needs_review' ELSE 'paused' END,next_run_at=NULL WHERE slot_id=$1 AND status='running'")
            .bind(id)
            .bind(kind)
            .execute(&mut *tx)
            .await?;
        if kind == "unlink" {
            sqlx::query("UPDATE deliveries SET status='skipped',result='{\"code\":\"ACCOUNT_UNLINKED\"}' WHERE slot_id=$1 AND status='pending'")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    let op = enqueue(
        &mut tx,
        i.tenant_id,
        id,
        s.get("binding_revision"),
        kind,
        payload,
    )
    .await?;
    tx.commit().await?;
    Ok(accepted(op))
}

async fn config(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, id, false).await?;
    let mut cfg: Value = s.get("config");
    let label: String = s.get("label");
    if cfg.get("config").is_none() {
        cfg["config"] = json!({"prefix":"!","label":label});
    } else if let Some(obj) = cfg["config"].as_object_mut() {
        obj.entry("label".to_string()).or_insert_with(|| json!(label));
        obj.entry("prefix".to_string()).or_insert_with(|| json!("!"));
    }
    Ok(ok(
        json!({"revision":s.get::<i64,_>("config_revision"),"config":cfg}),
    ))
}

async fn commands(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, id, false).await?;
    let registry: Value = sqlx::query_scalar(
        "SELECT result FROM operations WHERE slot_id=$1 AND tenant_id=$2 AND kind='commands' AND status='succeeded' AND binding_revision=$3 ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(id)
    .bind(i.tenant_id)
    .bind(s.get::<i64, _>("binding_revision"))
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or_else(|| json!({"commands":[],"synced":false}));
    Ok(ok(json!({
        "revision": s.get::<i64, _>("config_revision"),
        "config": s.get::<Value, _>("config"),
        "registry": registry.get("result").unwrap_or(&registry),
    })))
}

async fn groups(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, id, false).await?;
    let v: Value = sqlx::query_scalar(
        "SELECT result FROM operations WHERE slot_id=$1 AND tenant_id=$2 AND kind='groups' AND status='succeeded' AND binding_revision=$3 ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(id)
    .bind(i.tenant_id)
    .bind(s.get::<i64, _>("binding_revision"))
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or_else(|| json!({"groups":[],"synced":false}));
    Ok(ok(v.get("result").cloned().unwrap_or(v)))
}

#[derive(Deserialize)]
struct Config {
    revision: i64,
    config: Value,
}

fn validate_config(section: &str, value: &Value) -> Result<()> {
    let object = value.as_object().ok_or(bad("INVALID_CONFIG"))?;
    if section == "commands" || section == "groups" {
        for (name, fields) in object {
            if name.is_empty() || name.len() > 128 {
                return Err(bad("INVALID_CONFIG"));
            }
            let fields = fields.as_object().ok_or(bad("INVALID_CONFIG"))?;
            for (field, v) in fields {
                let valid = if section == "commands" {
                    match field.as_str() {
                        "active" => v.is_boolean(),
                        "countdown" => v.as_i64().is_some_and(|n| (0..=86400).contains(&n)),
                        "response" => v.as_str().is_some_and(|s| s.chars().count() <= 2000),
                        "permission" => v.as_str().is_some_and(|s| {
                            matches!(s, "all" | "adminBox" | "adminBot" | "adminLevelHigh")
                        }),
                        "values" => valid_studio_values(v),
                        _ => false,
                    }
                } else {
                    matches!(
                        field.as_str(),
                        "welcome" | "antiSpam" | "antiLink" | "autoReply"
                    ) && v.is_boolean()
                };
                if !valid {
                    return Err(bad("CONFIG_FIELD_FORBIDDEN"));
                }
            }
        }
    }
    if section == "config" {
        if object.get("prefix").is_some_and(|v| {
            v.as_str().is_none_or(|s| {
                s.is_empty() || s.chars().count() > 8 || s.chars().any(char::is_whitespace)
            })
        }) {
            return Err(bad("INVALID_PREFIX"));
        }
        if object
            .get("label")
            .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty() || s.chars().count() > 80))
        {
            return Err(bad("INVALID_LABEL"));
        }
    }
    Ok(())
}

fn valid_studio_values(v: &Value) -> bool {
    let Some(values) = v.as_object() else {
        return false;
    };
    if values.len() > 20 {
        return false;
    }
    values.iter().all(|(key, v)| match key.as_str() {
        "operation.enabled" | "responses.useCustomTemplates" => v.is_boolean(),
        "operation.cooldownMode" | "restrictions.mode" => {
            v.as_str().is_some_and(|s| s.len() <= 64)
        }
        "operation.cooldownSeconds" | "operation.maxUsesPerHour" => {
            v.is_null() || v.as_i64().is_some_and(|n| (0..=86400).contains(&n))
        }
        "responses.templates.onSuccess"
        | "responses.templates.onCooldown"
        | "responses.templates.onPermissionDenied"
        | "responses.templates.onScopeDenied"
        | "responses.templates.onError"
        | "responses.templates.onKillSwitch" => {
            v.is_null() || v.as_str().is_some_and(|s| s.chars().count() <= 2000)
        }
        "restrictions.allowedThreads"
        | "restrictions.blockedThreads"
        | "restrictions.allowedUsers" => v.as_array().is_some_and(|a| {
            a.len() <= 1000
                && a.iter().all(|row| {
                    let field = if key == "restrictions.allowedUsers" {
                        "userId"
                    } else {
                        "threadId"
                    };
                    row.as_object().is_some_and(|o| {
                        o.len() == 1
                            && o.get(field)
                                .and_then(Value::as_str)
                                .is_some_and(mybot_portal_domain::valid_uid)
                    })
                })
        }),
        _ => false,
    })
}

async fn save_config(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Config>,
) -> Result<Response> {
    save_section(&p, &h, id, b, "config").await
}
async fn save_commands(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Config>,
) -> Result<Response> {
    save_section(&p, &h, id, b, "commands").await
}
async fn save_groups(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Config>,
) -> Result<Response> {
    save_section(&p, &h, id, b, "groups").await
}

async fn save_section(
    p: &PgPool,
    h: &HeaderMap,
    id: Uuid,
    b: Config,
    section: &str,
) -> Result<Response> {
    validate_config(section, &b.config)?;
    let i = identity(p, h, true, false).await?;
    if !b.config.is_object() || b.config.to_string().len() > 65536 {
        return Err(bad("INVALID_CONFIG"));
    }
    if section == "config" {
        for k in b.config.as_object().unwrap().keys() {
            if !matches!(k.as_str(), "prefix" | "label") {
                return Err(bad("CONFIG_FIELD_FORBIDDEN"));
            }
        }
    }
    let mut tx = db::tenant(p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, id, true).await?;
    if s.get::<i64, _>("config_revision") != b.revision {
        return Err(conflict("REVISION_CONFLICT"));
    }
    let mut cfg: Value = s.get("config");
    cfg[section] = b.config.clone();
    let new_label = if section == "config" {
        b.config.get("label").and_then(Value::as_str).map(str::trim)
    } else {
        None
    };
    sqlx::query(
        "UPDATE slots SET config=$2,label=coalesce($3,label),config_revision=config_revision+1 WHERE id=$1",
    )
    .bind(id)
    .bind(cfg)
    .bind(new_label)
    .execute(&mut *tx)
    .await?;
    let op = enqueue(
        &mut tx,
        i.tenant_id,
        id,
        s.get("binding_revision"),
        "configure",
        json!({"section":section,"config":b.config,"revision":b.revision+1}),
    )
    .await?;
    tx.commit().await?;
    Ok(accepted(op))
}

async fn operation(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    resource(&p, &h, "operations", id).await
}
async fn rosters(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    slot_list(&p, &h, "rosters", id).await
}
async fn scan_roster(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Value>,
) -> Result<Response> {
    if !b["group_ids"].is_array()
        || b["group_ids"].as_array().unwrap().is_empty()
        || b["group_ids"].as_array().unwrap().len() > 100
    {
        return Err(bad("INVALID_GROUP_IDS"));
    }
    queue_action(&p, &h, id, "roster", b).await
}

async fn slot_list(p: &PgPool, h: &HeaderMap, table: &str, id: Uuid) -> Result<Json<Value>> {
    let i = identity(p, h, false, false).await?;
    let mut tx = db::tenant(p, i.tenant_id).await?;
    owned_slot(&mut tx, i.tenant_id, id, false).await?;
    let q = format!(
        "SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (SELECT * FROM {table} WHERE slot_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 500) t"
    );
    let v = sqlx::query_scalar(&q)
        .bind(id)
        .bind(i.tenant_id)
        .fetch_one(&mut *tx)
        .await?;
    Ok(ok(v))
}

async fn campaigns(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    list(&p, &h, "campaigns").await
}
async fn slot_campaigns(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    slot_list(&p, &h, "campaigns", id).await
}
async fn campaign(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    resource(&p, &h, "campaigns", id).await
}

fn default_campaign_name() -> String {
    "Chiến dịch mới".into()
}

#[derive(Deserialize)]
struct Campaign {
    #[serde(default = "default_campaign_name")]
    name: String,
    kind: String,
    content: Value,
    #[serde(default)]
    schedule: Value,
    #[serde(default)]
    recipients: Vec<String>,
    #[serde(default)]
    exclusions: Vec<String>,
    #[serde(default)]
    revision: i64,
}

fn validate_campaign(b: &Campaign, slot_expires: Option<chrono::DateTime<Utc>>) -> Result<()> {
    if b.name.trim().is_empty() || b.name.chars().count() > 120 {
        return Err(bad("INVALID_CONTENT_OR_RECIPIENTS"));
    }
    if !b.schedule.is_null() && !b.schedule.as_object().is_some_and(|o| o.is_empty()) {
        let schedule: mybot_portal_domain::Schedule =
            serde_json::from_value(b.schedule.clone()).map_err(|_| bad("INVALID_SCHEDULE"))?;
        schedule.validate().map_err(|_| bad("INVALID_SCHEDULE"))?;
        let end_bound = match &schedule {
            mybot_portal_domain::Schedule::Once { at } => Some(*at),
            mybot_portal_domain::Schedule::Interval { until, .. } => *until,
            mybot_portal_domain::Schedule::Calendar { until, .. } => *until,
        };
        if let (Some(until), Some(exp)) = (end_bound, slot_expires) {
            if until > exp {
                return Err(bad("SCHEDULE_EXCEEDS_EXPIRY"));
            }
        }
    }
    if !matches!(b.kind.as_str(), "group" | "dm") {
        return Err(bad("INVALID_CAMPAIGN_KIND"));
    }
    let text = b.content["text"].as_str().unwrap_or("");
    let images = b.content["upload_ids"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    if text.chars().count() > 2000
        || images > 5
        || (text.is_empty() && images == 0)
        || b.recipients.is_empty()
        || b.recipients.len() > 10000
    {
        return Err(bad("INVALID_CONTENT_OR_RECIPIENTS"));
    }
    let min = if b.kind == "dm" { 10 } else { 5 };
    if b.content["interval_seconds"].as_u64().unwrap_or(min) < min {
        return Err(bad("PACING_TOO_FAST"));
    }
    if !b.schedule.is_null() && !b.schedule.as_object().is_some_and(|o| o.is_empty()) {
        match b.schedule["mode"].as_str() {
            Some("once") => {
                if b.schedule["at"]
                    .as_str()
                    .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
                    .is_none()
                {
                    return Err(bad("INVALID_SCHEDULE"));
                }
            }
            Some("interval") => {
                if b.schedule["seconds"].as_i64().unwrap_or(0) < 60 {
                    return Err(bad("INVALID_SCHEDULE"));
                }
            }
            Some("calendar") => {
                let times = b.schedule["times"]
                    .as_array()
                    .ok_or(bad("INVALID_SCHEDULE"))?;
                if times.is_empty()
                    || times.iter().any(|v| {
                        v.as_str()
                            .is_none_or(|s| chrono::NaiveTime::parse_from_str(s, "%H:%M").is_err())
                    })
                {
                    return Err(bad("INVALID_SCHEDULE"));
                }
            }
            _ => return Err(bad("INVALID_SCHEDULE")),
        }
    }
    Ok(())
}

async fn validate_uploads(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    content: &Value,
) -> Result<()> {
    if let Some(ids) = content["upload_ids"].as_array() {
        for id in ids {
            let id = Uuid::parse_str(id.as_str().ok_or(bad("INVALID_UPLOAD"))?)
                .map_err(|_| bad("INVALID_UPLOAD"))?;
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM uploads WHERE id=$1 AND tenant_id=$2)",
            )
            .bind(id)
            .bind(tenant)
            .fetch_one(&mut **tx)
            .await?;
            if !exists {
                return Err(bad("INVALID_UPLOAD"));
            }
        }
    }
    Ok(())
}

async fn create_campaign(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(slot): Path<Uuid>,
    Json(b): Json<Campaign>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let s = owned_slot(&mut tx, i.tenant_id, slot, true).await?;
    validate_campaign(&b, s.get("expires_at"))?;
    validate_uploads(&mut tx, i.tenant_id, &b.content).await?;
    let id = Uuid::new_v4();
    let deduped = mybot_portal_domain::recipient_snapshot(&b.recipients, &b.exclusions);
    if deduped.is_empty() {
        return Err(bad("INVALID_CONTENT_OR_RECIPIENTS"));
    }
    sqlx::query("INSERT INTO campaigns(id,tenant_id,slot_id,binding_revision,name,kind,content,schedule,recipients,exclusions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(id)
        .bind(i.tenant_id)
        .bind(slot)
        .bind(s.get::<i64, _>("binding_revision"))
        .bind(b.name.trim())
        .bind(b.kind)
        .bind(b.content)
        .bind(b.schedule)
        .bind(json!(deduped))
        .bind(json!(b.exclusions))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"name":b.name.trim(),"status":"draft","revision":0})))
}

async fn update_campaign(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Campaign>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    validate_uploads(&mut tx, i.tenant_id, &b.content).await?;
    let sid: Uuid =
        sqlx::query_scalar("SELECT slot_id FROM campaigns WHERE id=$1 AND tenant_id=$2")
            .bind(id)
            .bind(i.tenant_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(bad("CAMPAIGN_NOT_FOUND"))?;
    let slot = owned_slot(&mut tx, i.tenant_id, sid, true).await?;
    validate_campaign(&b, slot.get("expires_at"))?;
    let deduped = mybot_portal_domain::recipient_snapshot(&b.recipients, &b.exclusions);
    if deduped.is_empty() {
        return Err(bad("INVALID_CONTENT_OR_RECIPIENTS"));
    }
    let n = sqlx::query("UPDATE campaigns SET name=$3,kind=$4,content=$5,schedule=$6,recipients=$7,exclusions=$8,revision=revision+1,status='draft',binding_revision=$10 WHERE id=$1 AND tenant_id=$2 AND revision=$9 AND status NOT IN ('running')")
        .bind(id)
        .bind(i.tenant_id)
        .bind(b.name.trim())
        .bind(b.kind)
        .bind(b.content)
        .bind(b.schedule)
        .bind(json!(deduped))
        .bind(json!(b.exclusions))
        .bind(b.revision)
        .bind(slot.get::<i64, _>("binding_revision"))
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n != 1 {
        return Err(conflict("REVISION_CONFLICT"));
    }
    sqlx::query("UPDATE deliveries SET status='skipped',result='{\"code\":\"CAMPAIGN_EDITED\"}' WHERE run_id IN (SELECT id FROM campaign_runs WHERE campaign_id=$1 AND tenant_id=$2) AND tenant_id=$2 AND status='pending'")
        .bind(id)
        .bind(i.tenant_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE campaign_runs SET status='stopped',finished_at=now() WHERE campaign_id=$1 AND tenant_id=$2 AND status IN ('pending','running')")
        .bind(id)
        .bind(i.tenant_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"revision":b.revision+1})))
}

#[derive(Deserialize)]
struct CloneCampaign {
    target_slot_id: Uuid,
    #[serde(default)]
    name: Option<String>,
}
async fn clone_campaign(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<CloneCampaign>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let src = sqlx::query("SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2")
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(bad("CAMPAIGN_NOT_FOUND"))?;
    let target = owned_slot(&mut tx, i.tenant_id, b.target_slot_id, true).await?;
    let new_id = Uuid::new_v4();
    let src_name: String = src.get("name");
    let clone_name = b
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{src_name} (Bản sao)"));
    // Audience must be re-selected on the destination slot/Zalo account before starting.
    sqlx::query("INSERT INTO campaigns(id,tenant_id,slot_id,binding_revision,name,kind,status,content,schedule,recipients,exclusions) VALUES($1,$2,$3,$4,$5,$6,'needs_review',$7,$8,'[]'::jsonb,$9)")
        .bind(new_id)
        .bind(i.tenant_id)
        .bind(b.target_slot_id)
        .bind(target.get::<i64, _>("binding_revision"))
        .bind(&clone_name)
        .bind(src.get::<String, _>("kind"))
        .bind(src.get::<Value, _>("content"))
        .bind(src.get::<Value, _>("schedule"))
        .bind(src.get::<Value, _>("exclusions"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({
        "id": new_id,
        "slot_id": b.target_slot_id,
        "name": clone_name,
        "status": "needs_review",
    })))
}

async fn campaign_action(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Action>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let c = sqlx::query("SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(bad("CAMPAIGN_NOT_FOUND"))?;
    let slot: Uuid = c.get("slot_id");
    let mut slot_expires: Option<chrono::DateTime<Utc>> = None;
    let status = match b.action.as_str() {
        "start" | "resume" => {
            let s = owned_slot(&mut tx, i.tenant_id, slot, true).await?;
            slot_expires = s.get("expires_at");
            if s.get::<i64, _>("binding_revision") != c.get::<i64, _>("binding_revision")
                || c.get::<String, _>("status") == "needs_review"
            {
                return Err(conflict("AUDIENCE_REVIEW_REQUIRED"));
            }
            if c.get::<Value, _>("recipients")
                .as_array()
                .is_none_or(|a| a.is_empty())
            {
                return Err(conflict("AUDIENCE_REVIEW_REQUIRED"));
            }
            if s.get::<Option<String>, _>("zalo_uid").is_none() {
                return Err(conflict("ACCOUNT_NOT_BOUND"));
            }
            "running"
        }
        "pause" => "paused",
        "stop" => "stopped",
        "preview" => {
            let recipients: Vec<String> = c.get::<Value, _>("recipients")
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let exclusions: Vec<String> = c.get::<Value, _>("exclusions")
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let effective = mybot_portal_domain::recipient_snapshot(&recipients, &exclusions);
            return Ok(ok(json!({
                "name": c.get::<String, _>("name"),
                "kind": c.get::<String, _>("kind"),
                "content": c.get::<Value, _>("content"),
                "schedule": c.get::<Value, _>("schedule"),
                "recipients": recipients,
                "exclusions": exclusions,
                "effective_recipients": effective,
                "effective_count": effective.len(),
            })));
        }
        _ => return Err(bad("ACTION_NOT_ALLOWED")),
    };
    let mut due = None;
    if status == "running" {
        let schedule: Value = c.get("schedule");
        let now = Utc::now();
        let next_at = if schedule.is_null() || schedule.as_object().is_some_and(|o| o.is_empty()) {
            now
        } else {
            let schedule: mybot_portal_domain::Schedule =
                serde_json::from_value(schedule).map_err(|_| bad("INVALID_SCHEDULE"))?;
            match schedule {
                mybot_portal_domain::Schedule::Once { at } => at.max(now),
                mybot_portal_domain::Schedule::Interval { until, .. } => {
                    if until.is_some_and(|v| v <= now) {
                        return Err(bad("SCHEDULE_ENDED"));
                    }
                    now
                }
                ref other => other
                    .next_after(now, now, 0)
                    .map_err(|_| bad("INVALID_SCHEDULE"))?
                    .ok_or(bad("SCHEDULE_ENDED"))?,
            }
        };
        if slot_expires.is_some_and(|exp| next_at >= exp) {
            return Err(conflict("SLOT_EXPIRED"));
        }
        due = Some(next_at);
    }
    if status == "stopped" {
        sqlx::query("UPDATE deliveries SET status='skipped',result='{\"code\":\"USER_STOPPED\"}' WHERE run_id IN (SELECT id FROM campaign_runs WHERE campaign_id=$1 AND tenant_id=$2) AND tenant_id=$2 AND status='pending'")
            .bind(id)
            .bind(i.tenant_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE campaign_runs SET status='stopped',finished_at=now() WHERE campaign_id=$1 AND tenant_id=$2 AND status IN ('pending','running')")
            .bind(id)
            .bind(i.tenant_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE campaigns SET status=$3,next_run_at=$4,revision=revision+1 WHERE id=$1 AND tenant_id=$2")
        .bind(id)
        .bind(i.tenant_id)
        .bind(status)
        .bind(due)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"status":status,"next_run_at":due})))
}

async fn runs(State(p): State<PgPool>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let v = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object(
            'counts', (SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) AS n FROM deliveries d WHERE d.run_id=r.id AND d.tenant_id=$2 GROUP BY status) counts),
            'deliveries', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.created_at),'[]') FROM deliveries d WHERE d.run_id=r.id AND d.tenant_id=$2)
        ) ORDER BY r.scheduled_at DESC),'[]') FROM campaign_runs r WHERE campaign_id=$1 AND tenant_id=$2",
    )
    .bind(id)
    .bind(i.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    Ok(ok(v))
}

async fn topup(State(p): State<PgPool>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Json<Value>> {
    resource(&p, &h, "topups", id).await
}

async fn upload(
    State(p): State<PgPool>,
    h: HeaderMap,
    mut m: axum::extract::Multipart,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, false).await?;
    let f = m
        .next_field()
        .await
        .map_err(|_| bad("INVALID_UPLOAD"))?
        .ok_or(bad("EMPTY_UPLOAD"))?;
    let mime = f.content_type().unwrap_or("").to_string();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp") {
        return Err(bad("UNSUPPORTED_IMAGE"));
    }
    let data = f.bytes().await.map_err(|_| bad("UPLOAD_TOO_LARGE"))?;
    if data.len() > 10 * 1024 * 1024 || data.is_empty() {
        return Err(bad("UPLOAD_TOO_LARGE"));
    }
    let signature = match mime.as_str() {
        "image/png" => data.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => data.starts_with(b"\xff\xd8\xff"),
        _ => data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP"),
    };
    if !signature {
        return Err(bad("INVALID_IMAGE"));
    }
    let id = Uuid::new_v4();
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    sqlx::query("INSERT INTO uploads(id,tenant_id,mime,data) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(i.tenant_id)
        .bind(&mime)
        .bind(data.as_ref())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"mime":mime,"size":data.len()})))
}

async fn download(State(p): State<PgPool>, h: HeaderMap, Path(id): Path<Uuid>) -> Result<Response> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let r = sqlx::query("SELECT mime,data FROM uploads WHERE id=$1 AND tenant_id=$2")
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "UPLOAD_NOT_FOUND"))?;
    Ok((
        [
            (header::CONTENT_TYPE, r.get::<String, _>("mime")),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        r.get::<Vec<u8>, _>("data"),
    )
        .into_response())
}

async fn operator_download(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    identity(&p, &h, false, true).await?;
    let t = find_tenant(&p, "uploads", id).await?;
    let mut tx = db::tenant(&p, t).await?;
    let r = sqlx::query("SELECT mime,data FROM uploads WHERE id=$1 AND tenant_id=$2")
        .bind(id)
        .bind(t)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "UPLOAD_NOT_FOUND"))?;
    Ok((
        [
            (header::CONTENT_TYPE, r.get::<String, _>("mime")),
            (header::CACHE_CONTROL, "private, no-store".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        r.get::<Vec<u8>, _>("data"),
    )
        .into_response())
}

async fn events(State(p): State<PgPool>, h: HeaderMap) -> Result<Response> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let v: Value = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') FROM (SELECT * FROM notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50) n",
    )
    .bind(i.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    let digest: String = sqlx::query_scalar(
        "SELECT md5(concat_ws('|',
            (SELECT balance::text FROM wallets WHERE tenant_id=$1),
            (SELECT coalesce(string_agg(id::text||':'||status||':'||binding_revision::text||':'||coalesce(expires_at::text,''),',' ORDER BY id),'') FROM slots WHERE tenant_id=$1),
            (SELECT coalesce(max(updated_at)::text,'') FROM operations WHERE tenant_id=$1),
            (SELECT coalesce(string_agg(id::text||':'||status||':'||run_count::text,',' ORDER BY id),'') FROM campaigns WHERE tenant_id=$1),
            (SELECT coalesce(string_agg(id::text||':'||status,',' ORDER BY id),'') FROM topups WHERE tenant_id=$1),
            (SELECT count(*)::text FROM notifications WHERE tenant_id=$1)
        ))",
    )
    .bind(i.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    let snapshot = json!({"digest": digest, "count": v.as_array().map(Vec::len).unwrap_or(0)});
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        format!("event: snapshot\ndata: {snapshot}\n\nevent: notifications\ndata: {v}\n\nretry: 4000\n\n"),
    )
        .into_response())
}

async fn users(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    identity(&p, &h, false, true).await?;
    let v = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'tenant_id',tenant_id,'username',username,'role',role,'disabled',disabled,'activated',(password_hash IS NOT NULL),'created_at',created_at) ORDER BY created_at DESC),'[]') FROM users",
    )
    .fetch_one(&p)
    .await?;
    Ok(ok(v))
}

#[derive(Deserialize)]
struct NewUser {
    username: String,
}
pub async fn provision_user(
    p: &PgPool,
    username: &str,
    role: &str,
) -> anyhow::Result<(Uuid, String)> {
    if username.len() < 3
        || username.len() > 80
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-@.".contains(c))
    {
        anyhow::bail!("Invalid username")
    }
    let id = Uuid::new_v4();
    let tenant = Uuid::new_v4();
    let token = auth::random_token();
    let mut tx = p.begin().await?;
    sqlx::query("INSERT INTO tenants(id) VALUES($1)")
        .bind(tenant)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO users(id,tenant_id,username,role) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(tenant)
        .bind(username)
        .bind(role)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT set_config('portal.tenant_id',$1,true)")
        .bind(tenant.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO wallets(tenant_id) VALUES($1)")
        .bind(tenant)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO account_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')")
        .bind(auth::digest(&token))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((id, token))
}

async fn create_user(
    State(p): State<PgPool>,
    h: HeaderMap,
    Json(b): Json<NewUser>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, true).await?;
    let (id, token) = provision_user(&p, &b.username, "customer")
        .await
        .map_err(|_| conflict("USER_CREATION_FAILED"))?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    audit(
        &mut tx,
        i.tenant_id,
        i.id,
        "user_created",
        id,
        json!({"username": b.username}),
    )
    .await?;
    tx.commit().await?;
    Ok(ok(json!({
        "id": id,
        "username": b.username,
        "activation_token": token,
        "activation_path": format!("/activate?token={token}"),
        "expires_in_hours": 24,
    })))
}

#[derive(Deserialize)]
struct UserUpdate {
    disabled: bool,
}
async fn update_user(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<UserUpdate>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, true).await?;
    if id == i.id {
        return Err(bad("CANNOT_DISABLE_SELF"));
    }
    let mut tx = p.begin().await?;
    let n = sqlx::query("UPDATE users SET disabled=$2 WHERE id=$1 AND role='customer'")
        .bind(id)
        .bind(b.disabled)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n != 1 {
        return Err(bad("USER_NOT_FOUND"));
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut atx = db::tenant(&p, i.tenant_id).await?;
    audit(
        &mut atx,
        i.tenant_id,
        i.id,
        "user_status_changed",
        id,
        json!({"disabled": b.disabled}),
    )
    .await?;
    atx.commit().await?;
    Ok(ok(json!({"id":id,"disabled":b.disabled})))
}

async fn reset_user(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, true).await?;
    let token = auth::random_token();
    let mut tx = p.begin().await?;
    sqlx::query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query("INSERT INTO account_tokens(token_hash,user_id,expires_at) SELECT $1,id,now()+interval '24 hours' FROM users WHERE id=$2 AND role='customer'")
        .bind(auth::digest(&token))
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n != 1 {
        return Err(bad("USER_NOT_FOUND"));
    }
    tx.commit().await?;
    let mut atx = db::tenant(&p, i.tenant_id).await?;
    audit(&mut atx, i.tenant_id, i.id, "password_reset_issued", id, json!({})).await?;
    atx.commit().await?;
    Ok(ok(json!({
        "activation_token": token,
        "activation_path": format!("/activate?token={token}"),
        "expires_in_hours": 24,
    })))
}

async fn operator_aggregate(p: &PgPool, h: &HeaderMap, table: &str) -> Result<Json<Value>> {
    identity(p, h, false, true).await?;
    let rows = sqlx::query("SELECT u.tenant_id,u.username FROM users u")
        .fetch_all(p)
        .await?;
    let mut all = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for r in rows {
        let t: Uuid = r.get("tenant_id");
        if !seen.insert(t) {
            continue;
        }
        let username: String = r.get("username");
        let mut tx = db::tenant(p, t).await?;
        let q = format!(
            "SELECT to_jsonb(t) || jsonb_build_object('username',$2) FROM {table} t WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500"
        );
        all.extend(
            sqlx::query_scalar::<_, Value>(&q)
                .bind(t)
                .bind(&username)
                .fetch_all(&mut *tx)
                .await?,
        );
    }
    all.sort_by(|a, b| {
        b["created_at"]
            .as_str()
            .unwrap_or("")
            .cmp(a["created_at"].as_str().unwrap_or(""))
    });
    Ok(ok(json!(all)))
}
async fn operator_topups(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    operator_aggregate(&p, &h, "topups").await
}
async fn operator_orders(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    operator_aggregate(&p, &h, "orders").await
}
async fn operator_slots(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    operator_aggregate(&p, &h, "slots").await
}
async fn operator_audit(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    operator_aggregate(&p, &h, "audit").await
}

async fn slot_logs(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, false, false).await?;
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    owned_slot(&mut tx, i.tenant_id, id, false).await?;
    let v: Value = sqlx::query_scalar(
        "SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', id,
            'kind', kind,
            'status', status,
            'binding_revision', binding_revision,
            'code', coalesce(result->>'code', result->'error'->>'code'),
            'created_at', created_at,
            'updated_at', updated_at
        )),'[]'::jsonb) FROM (SELECT * FROM operations WHERE slot_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 200) o",
    )
    .bind(id)
    .bind(i.tenant_id)
    .fetch_one(&mut *tx)
    .await?;
    Ok(ok(v))
}

#[derive(Deserialize)]
struct TestRecipient {
    recipient_id: String,
}
async fn test_campaign(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<TestRecipient>,
) -> Result<Response> {
    let i = identity(&p, &h, true, false).await?;
    if !mybot_portal_domain::valid_uid(&b.recipient_id) {
        return Err(bad("INVALID_RECIPIENT"));
    }
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    let c = sqlx::query("SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2")
        .bind(id)
        .bind(i.tenant_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(bad("CAMPAIGN_NOT_FOUND"))?;
    let sid: Uuid = c.get("slot_id");
    let s = owned_slot(&mut tx, i.tenant_id, sid, true).await?;
    if s.get::<i64, _>("binding_revision") != c.get::<i64, _>("binding_revision") {
        return Err(conflict("AUDIENCE_REVIEW_REQUIRED"));
    }
    let op = enqueue(
        &mut tx,
        i.tenant_id,
        sid,
        s.get("binding_revision"),
        "send",
        json!({"recipient":b.recipient_id,"kind":c.get::<String,_>("kind"),"content":c.get::<Value,_>("content"),"test":true}),
    )
    .await?;
    tx.commit().await?;
    Ok(accepted(op))
}

async fn find_tenant(p: &PgPool, table: &str, id: Uuid) -> Result<Uuid> {
    let tenants = sqlx::query_scalar::<_, Uuid>("SELECT id FROM tenants")
        .fetch_all(p)
        .await?;
    for t in tenants {
        let mut tx = db::tenant(p, t).await?;
        let q = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1 AND tenant_id=$2)");
        if sqlx::query_scalar::<_, bool>(&q)
            .bind(id)
            .bind(t)
            .fetch_one(&mut *tx)
            .await?
        {
            return Ok(t);
        }
    }
    Err(ApiError(StatusCode::NOT_FOUND, "RESOURCE_NOT_FOUND"))
}

#[derive(Deserialize)]
struct Approve {
    amount: i64,
    bank_reference: String,
}
async fn approve_topup(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Approve>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, true).await?;
    let k = key(&h)?;
    if b.amount <= 0
        || b.amount > 1_000_000_000
        || b.bank_reference.trim().is_empty()
        || b.bank_reference.len() > 200
    {
        return Err(bad("INVALID_BANK_REFERENCE_OR_AMOUNT"));
    }
    let t = find_tenant(&p, "topups", id).await?;
    let mut tx = db::tenant(&p, t).await?;
    let r = sqlx::query("SELECT * FROM topups WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
        .bind(id)
        .bind(t)
        .fetch_one(&mut *tx)
        .await?;
    if r.get::<String, _>("status") == "approved" {
        if r.get::<Option<String>, _>("bank_reference").as_deref() != Some(b.bank_reference.trim())
            || r.get::<Option<i64>, _>("actual_amount") != Some(b.amount)
        {
            return Err(conflict("IDEMPOTENCY_CONFLICT"));
        }
        return Ok(ok(json!({"id":id,"status":"approved"})));
    }
    if !matches!(
        r.get::<String, _>("status").as_str(),
        "pending" | "awaiting_review"
    ) {
        return Err(conflict("TOPUP_ALREADY_REVIEWED"));
    }
    sqlx::query("UPDATE wallets SET balance=balance+$2 WHERE tenant_id=$1")
        .bind(t)
        .bind(b.amount)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO ledger(id,tenant_id,amount,kind,reference,idempotency_key) VALUES($1,$2,$3,'topup',$4,$5)")
        .bind(Uuid::new_v4())
        .bind(t)
        .bind(b.amount)
        .bind(id.to_string())
        .bind(format!("topup:{k}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE topups SET status='approved',actual_amount=$2,bank_reference=$3 WHERE id=$1",
    )
    .bind(id)
    .bind(b.amount)
    .bind(b.bank_reference.trim())
    .execute(&mut *tx)
    .await?;
    audit(
        &mut tx,
        t,
        i.id,
        "topup_approved",
        id,
        json!({"amount":b.amount,"bank_reference":b.bank_reference.trim()}),
    )
    .await?;
    sqlx::query(
        "INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'topup_approved',$3)",
    )
    .bind(Uuid::new_v4())
    .bind(t)
    .bind(json!({"amount":b.amount,"topup_id":id}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"status":"approved"})))
}

#[derive(Deserialize)]
struct Rejection {
    reason: String,
}
async fn reject_topup(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Rejection>,
) -> Result<Json<Value>> {
    if b.reason.trim().is_empty() || b.reason.chars().count() > 2000 {
        return Err(bad("REJECTION_REASON_REQUIRED"));
    }
    let i = identity(&p, &h, true, true).await?;
    let t = find_tenant(&p, "topups", id).await?;
    let mut tx = db::tenant(&p, t).await?;
    let n = sqlx::query(
        "UPDATE topups SET status='rejected',rejection_reason=$3 WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','awaiting_review')",
    )
    .bind(id)
    .bind(t)
    .bind(b.reason.trim())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n != 1 {
        return Err(conflict("TOPUP_ALREADY_REVIEWED"));
    }
    audit(
        &mut tx,
        t,
        i.id,
        "topup_rejected",
        id,
        json!({"reason":b.reason.trim()}),
    )
    .await?;
    sqlx::query(
        "INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'topup_rejected',$3)",
    )
    .bind(Uuid::new_v4())
    .bind(t)
    .bind(json!({"topup_id":id,"reason":b.reason.trim()}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"status":"rejected"})))
}

async fn operator_settings(State(p): State<PgPool>, h: HeaderMap) -> Result<Json<Value>> {
    identity(&p, &h, false, true).await?;
    pricing(State(p)).await
}

#[derive(Deserialize)]
struct Settings {
    unit_price: i64,
    capacity: i32,
    #[serde(default)]
    bank_name: Option<String>,
    #[serde(default)]
    bank_account: Option<String>,
    #[serde(default)]
    bank_holder: Option<String>,
    #[serde(default)]
    bank_qr_url: Option<String>,
    #[serde(default)]
    support_contact: Option<String>,
}
async fn save_settings(
    State(p): State<PgPool>,
    h: HeaderMap,
    Json(b): Json<Settings>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, true).await?;
    if b.unit_price < 1 || b.unit_price > 1_000_000_000 || !(0..=30).contains(&b.capacity) {
        return Err(bad("INVALID_SETTINGS"));
    }
    for text_field in [
        &b.bank_name,
        &b.bank_account,
        &b.bank_holder,
        &b.bank_qr_url,
        &b.support_contact,
    ] {
        if text_field.as_ref().is_some_and(|s| s.chars().count() > 500) {
            return Err(bad("INVALID_SETTINGS"));
        }
    }
    let mut tx = db::tenant(&p, i.tenant_id).await?;
    sqlx::query("SELECT id FROM settings WHERE id=1 FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let used: i64 = sqlx::query_scalar("SELECT portal_used_capacity()")
        .fetch_one(&mut *tx)
        .await?;
    if used > b.capacity as i64 {
        return Err(conflict("CAPACITY_BELOW_RESERVATIONS"));
    }
    sqlx::query(
        "UPDATE settings SET unit_price=$1,capacity=$2,bank_name=coalesce($3,bank_name),bank_account=coalesce($4,bank_account),bank_holder=coalesce($5,bank_holder),bank_qr_url=coalesce($6,bank_qr_url),support_contact=coalesce($7,support_contact) WHERE id=1",
    )
    .bind(b.unit_price)
    .bind(b.capacity)
    .bind(b.bank_name.as_deref().map(str::trim))
    .bind(b.bank_account.as_deref().map(str::trim))
    .bind(b.bank_holder.as_deref().map(str::trim))
    .bind(b.bank_qr_url.as_deref().map(str::trim))
    .bind(b.support_contact.as_deref().map(str::trim))
    .execute(&mut *tx)
    .await?;
    audit(
        &mut tx,
        i.tenant_id,
        i.id,
        "settings_updated",
        i.id,
        json!({"unit_price":b.unit_price,"capacity":b.capacity}),
    )
    .await?;
    tx.commit().await?;
    Ok(ok(resolved_settings(&p).await?))
}

#[derive(Deserialize)]
struct Adjust {
    #[serde(default)]
    days: i32,
    #[serde(default)]
    refund_amount: i64,
    reason: String,
}
async fn adjust_slot(
    State(p): State<PgPool>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Adjust>,
) -> Result<Json<Value>> {
    let i = identity(&p, &h, true, true).await?;
    let k = key(&h)?;
    if !(-365..=365).contains(&b.days)
        || b.refund_amount < 0
        || b.refund_amount > 1_000_000_000
        || b.reason.trim().is_empty()
        || (b.days == 0 && b.refund_amount == 0)
    {
        return Err(bad("INVALID_ADJUSTMENT"));
    }
    let t = find_tenant(&p, "slots", id).await?;
    let mut tx = db::tenant(&p, t).await?;
    sqlx::query("SELECT id FROM settings WHERE id=1 FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let s = owned_slot(&mut tx, t, id, false).await?;
    let previous: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(a) FROM audit a WHERE tenant_id=$1 AND details->>'idempotency_key'=$2 LIMIT 1",
    )
    .bind(t)
    .bind(&k)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(previous) = previous {
        if previous["resource_id"] != json!(id)
            || previous["details"]["days"] != json!(b.days)
            || previous["details"]["refund_amount"] != json!(b.refund_amount)
            || previous["details"]["reason"] != json!(b.reason)
        {
            return Err(conflict("IDEMPOTENCY_CONFLICT"));
        }
        return Ok(ok(json!({"id":id,"adjusted":true})));
    }
    if b.days != 0 {
        if matches!(s.get::<String, _>("status").as_str(), "refunded" | "purged") {
            return Err(bad("INVALID_SLOT_STATE"));
        }
        let expiry = s
            .get::<Option<chrono::DateTime<Utc>>, _>("expires_at")
            .ok_or(bad("SLOT_NOT_ACTIVATED"))?;
        if b.days > 0 && expiry <= Utc::now() {
            let used: i64 = sqlx::query_scalar("SELECT portal_used_capacity()")
                .fetch_one(&mut *tx)
                .await?;
            let cap: i32 = sqlx::query_scalar("SELECT capacity FROM settings WHERE id=1")
                .fetch_one(&mut *tx)
                .await?;
            if used >= cap as i64 {
                return Err(conflict("CAPACITY_EXCEEDED"));
            }
        }
        if b.days > 0 {
            sqlx::query("UPDATE slots SET expires_at=greatest(expires_at,now())+make_interval(days=>$2),status=CASE WHEN status='expired' THEN 'paused' ELSE status END,last_runtime_check_at=NULL WHERE id=$1")
                .bind(id)
                .bind(b.days)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("UPDATE slots SET expires_at=expires_at+make_interval(days=>$2),last_runtime_check_at=NULL WHERE id=$1")
                .bind(id)
                .bind(b.days)
                .execute(&mut *tx)
                .await?;
        }
        let rev: i64 = s.get("binding_revision");
        if rev > 0 {
            enqueue(&mut tx, t, id, rev, "lease", json!({})).await?;
        }
    }
    if b.refund_amount > 0 {
        sqlx::query("SELECT tenant_id FROM wallets WHERE tenant_id=$1 FOR UPDATE")
            .bind(t)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query("UPDATE wallets SET balance=balance+$2 WHERE tenant_id=$1")
            .bind(t)
            .bind(b.refund_amount)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO ledger(id,tenant_id,amount,kind,reference,idempotency_key) VALUES($1,$2,$3,'operator_refund',$4,$5)")
            .bind(Uuid::new_v4())
            .bind(t)
            .bind(b.refund_amount)
            .bind(id.to_string())
            .bind(format!("adjust:{k}"))
            .execute(&mut *tx)
            .await?;
    }
    audit(
        &mut tx,
        t,
        i.id,
        "slot_adjusted",
        id,
        json!({"days":b.days,"refund_amount":b.refund_amount,"reason":b.reason,"idempotency_key":k}),
    )
    .await?;
    sqlx::query(
        "INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'slot_adjusted',$3)",
    )
    .bind(Uuid::new_v4())
    .bind(t)
    .bind(json!({"slot_id":id,"days":b.days,"refund_amount":b.refund_amount,"reason":b.reason.trim()}))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ok(json!({"id":id,"adjusted":true})))
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    tenant: Uuid,
    actor: Uuid,
    action: &str,
    resource: Uuid,
    details: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO audit(id,tenant_id,actor_id,action,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(Uuid::new_v4())
        .bind(tenant)
        .bind(actor)
        .bind(action)
        .bind(resource)
        .bind(details)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
