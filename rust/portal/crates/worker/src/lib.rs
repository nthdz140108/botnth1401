use anyhow::{Result, anyhow, ensure};
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use mybot_portal_domain::{CampaignKind, Schedule, minimum_interval, recipient_snapshot};
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

pub fn bridge_signature(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts arbitrary keys");
    mac.update(format!("{timestamp}.").as_bytes());
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

pub fn should_skip_missed(due: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now - due > Duration::seconds(60)
}

pub fn terminal_send_status(result: &std::result::Result<Value, String>) -> &'static str {
    match result {
        Ok(v) if v["status"] == "unknown" => "unknown",
        Ok(v) if v["status"] == "skipped" => "skipped",
        Ok(v) if v["status"] == "rate_limited" => "rate_limited",
        Ok(v)
            if v["status"] == "succeeded"
                && (v["result"]["apiConfirmed"] == true
                    || v["result"]["api_acknowledged"] == true) =>
        {
            "api_confirmed"
        }
        Ok(_) => "failed",
        Err(e) if e.starts_with("HTTP:429:") => "rate_limited",
        Err(e) if e.starts_with("HTTP:4") => "failed",
        Err(_) => "unknown",
    }
}

#[derive(Clone)]
pub struct BridgeClient {
    base: String,
    secret: String,
    http: reqwest::Client,
}

impl BridgeClient {
    pub fn new(base: String, secret: String) -> Result<Self> {
        let url = reqwest::Url::parse(&base)?;
        ensure!(
            url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                && url.username().is_empty()
                && url.password().is_none(),
            "Bridge must be loopback HTTP"
        );
        ensure!(
            secret.len() >= 32 && secret != "mybot-v4-internal-hmac",
            "Configure a strong INTERNAL_API_SECRET"
        );
        Ok(Self {
            base: base.trim_end_matches('/').into(),
            secret,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(90))
                .build()?,
        })
    }

    pub async fn call(
        &self,
        id: &str,
        tenant: Uuid,
        slot: Uuid,
        revision: i64,
        expires: DateTime<Utc>,
        kind: &str,
        payload: Value,
    ) -> std::result::Result<Value, String> {
        let body = serde_json::to_vec(&json!({
            "operation_id": id,
            "tenant_id": tenant,
            "slot_id": slot,
            "binding_revision": revision,
            "expires_at": expires,
            "kind": kind,
            "payload": payload,
        }))
        .map_err(|e| e.to_string())?;
        let now = Utc::now().timestamp_millis();
        let res = self
            .http
            .post(format!("{}/bridge/portal/operations", self.base))
            .header("content-type", "application/json")
            .header("x-internal-timestamp", now.to_string())
            .header(
                "x-internal-signature",
                bridge_signature(&self.secret, now, &body),
            )
            .header("x-request-id", Uuid::new_v4().to_string())
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let data: Value = res.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "HTTP:{}:{}",
                status.as_u16(),
                data["error"]["code"].as_str().unwrap_or("BRIDGE_ERROR")
            ));
        }
        if data["success"] != true {
            return Err("BRIDGE_INVALID_ENVELOPE".into());
        }
        Ok(data["data"].clone())
    }
}

pub struct Worker {
    pub pool: PgPool,
    pub bridge: BridgeClient,
}

fn ident() -> String {
    Uuid::new_v4().to_string()
}

fn value_strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|v| {
            v.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn public_error(error: &str) -> Value {
    json!({
        "code": if error.starts_with("HTTP:") {
            error.split(':').nth(2).unwrap_or("BRIDGE_REJECTED")
        } else {
            "BRIDGE_UNAVAILABLE"
        }
    })
}

impl Worker {
    pub async fn tick(&self) -> Result<()> {
        self.recover().await?;
        self.expire_slots().await?;
        for _ in 0..10 {
            if !self.operation().await? {
                break;
            }
        }
        self.connections().await?;
        self.reconcile().await?;
        self.schedule().await?;
        for _ in 0..30 {
            if !self.delivery().await? {
                break;
            }
        }
        self.finish_runs().await?;
        Ok(())
    }

    async fn recover(&self) -> Result<()> {
        // A persisted sending marker is ambiguous after a crash. Never replay it.
        sqlx::query("UPDATE deliveries SET status='unknown',result='{\"code\":\"WORKER_LOST_AFTER_DISPATCH\"}' WHERE status='sending' AND lease_until<now()")
            .execute(&self.pool)
            .await?;
        sqlx::query("UPDATE operations SET status='unknown',result='{\"code\":\"WORKER_LOST_DURING_OPERATION\"}',updated_at=now() WHERE status='running' AND kind NOT IN ('qr_start','start','restart') AND lease_until<now()")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn expire_slots(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let rows = sqlx::query(
            "SELECT * FROM slots WHERE (activated_at IS NULL AND activation_deadline<=now() AND status IN ('awaiting_activation','connecting','login_required')) OR (expires_at<=now() AND status NOT IN ('expired','refunded','purged')) FOR UPDATE SKIP LOCKED LIMIT 100",
        )
        .fetch_all(&mut *tx)
        .await?;
        for s in rows {
            let id: Uuid = s.get("id");
            let tenant: Uuid = s.get("tenant_id");
            let rev: i64 = s.get("binding_revision");
            let refund = s.get::<Option<DateTime<Utc>>, _>("activated_at").is_none();
            if refund {
                sqlx::query("SELECT tenant_id FROM wallets WHERE tenant_id=$1 FOR UPDATE")
                    .bind(tenant)
                    .fetch_one(&mut *tx)
                    .await?;
                let amount: i64 = s.get("purchase_amount");
                let n = sqlx::query("INSERT INTO ledger(id,tenant_id,amount,kind,reference,idempotency_key) VALUES($1,$2,$3,'activation_refund',$4,$5) ON CONFLICT DO NOTHING")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(amount)
                    .bind(id.to_string())
                    .bind(format!("activation_refund:{id}"))
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
                if n == 1 {
                    sqlx::query("UPDATE wallets SET balance=balance+$2 WHERE tenant_id=$1")
                        .bind(tenant)
                        .bind(amount)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            sqlx::query("UPDATE slots SET status=$2 WHERE id=$1")
                .bind(id)
                .bind(if refund { "refunded" } else { "expired" })
                .execute(&mut *tx)
                .await?;
            let stopped_campaigns = sqlx::query("UPDATE campaigns SET status='expired',next_run_at=NULL WHERE slot_id=$1 AND status IN ('running','paused')")
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            sqlx::query("UPDATE deliveries SET status='skipped',result='{\"code\":\"SLOT_EXPIRED\"}' WHERE slot_id=$1 AND status='pending'")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE operations SET status='cancelled',result='{\"code\":\"SLOT_EXPIRED\"}' WHERE slot_id=$1 AND status IN ('pending','running')")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            if rev > 0 {
                sqlx::query("INSERT INTO operations(id,tenant_id,slot_id,kind,binding_revision) VALUES($1,$2,$3,$4,$5)")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(id)
                    .bind(if refund { "unlink" } else { "stop" })
                    .bind(rev)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,$3,$4)")
                .bind(Uuid::new_v4())
                .bind(tenant)
                .bind(if refund {
                    "activation_refunded"
                } else {
                    "slot_expired"
                })
                .bind(json!({"slot_id": id}))
                .execute(&mut *tx)
                .await?;
            if stopped_campaigns > 0 {
                sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'campaign_stopped',$3)")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(json!({"slot_id": id, "reason": "SLOT_EXPIRED"}))
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        // Warn once per expiry timestamp when an active slot has <= 24 hours left.
        let soon = sqlx::query(
            "UPDATE slots SET expiring_notified_for=expires_at WHERE status IN ('active','paused','login_required') AND expires_at>now() AND expires_at<=now()+interval '24 hours' AND expiring_notified_for IS DISTINCT FROM expires_at RETURNING id,tenant_id,expires_at",
        )
        .fetch_all(&self.pool)
        .await?;
        for r in soon {
            sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'slot_expiring_soon',$3)")
                .bind(Uuid::new_v4())
                .bind(r.get::<Uuid, _>("tenant_id"))
                .bind(json!({
                    "slot_id": r.get::<Uuid, _>("id"),
                    "expires_at": r.get::<DateTime<Utc>, _>("expires_at"),
                }))
                .execute(&self.pool)
                .await?;
        }
        // Purge private configuration only after the promised 30-day retention window.
        let purged = sqlx::query(
            "UPDATE slots SET status='purged',config='{}',zalo_uid=NULL,zalo_name=NULL,zalo_avatar=NULL WHERE status='expired' AND expires_at<now()-interval '30 days' RETURNING id,tenant_id,binding_revision",
        )
        .fetch_all(&self.pool)
        .await?;
        for r in purged {
            let rev: i64 = r.get("binding_revision");
            if rev > 0 {
                sqlx::query("INSERT INTO operations(id,tenant_id,slot_id,kind,binding_revision) VALUES($1,$2,$3,'unlink',$4)")
                    .bind(Uuid::new_v4())
                    .bind(r.get::<Uuid, _>("tenant_id"))
                    .bind(r.get::<Uuid, _>("id"))
                    .bind(rev)
                    .execute(&self.pool)
                    .await?;
            }
        }
        Ok(())
    }

    async fn operation(&self) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT o.*,s.expires_at,s.activation_deadline,s.status AS slot_status,s.binding_revision AS current_revision FROM operations o JOIN slots s ON s.id=o.slot_id AND s.tenant_id=o.tenant_id WHERE o.status='pending' ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = row else { return Ok(false) };
        let id: Uuid = row.get("id");
        sqlx::query("UPDATE operations SET status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let kind: String = row.get("kind");
        let payload: Value = row.get("payload");
        let result = self.execute_operation(&row, &kind, payload).await;
        let (status, value) = match result {
            Ok(value) => {
                let status = if matches!(kind.as_str(), "qr_start" | "start" | "restart")
                    && value["status"] == "succeeded"
                {
                    "running"
                } else if kind == "send" {
                    terminal_send_status(&Ok(value.clone()))
                } else {
                    value["status"].as_str().unwrap_or("succeeded")
                };
                (status.to_owned(), value)
            }
            Err(error) => {
                let error = error.to_string();
                (
                    if kind == "send" {
                        terminal_send_status(&Err(error.clone()))
                    } else {
                        "failed"
                    }
                    .into(),
                    public_error(&error),
                )
            }
        };
        if matches!(kind.as_str(), "start" | "restart") && status == "running" {
            sqlx::query("UPDATE slots SET status='connecting',last_runtime_check_at=NULL WHERE id=$1 AND binding_revision=$2 AND status NOT IN ('expired','refunded','purged')")
                .bind(row.get::<Uuid, _>("slot_id"))
                .bind(row.get::<i64, _>("binding_revision"))
                .execute(&self.pool)
                .await?;
        }
        sqlx::query("UPDATE operations SET status=$2,result=$3,updated_at=now() WHERE id=$1 AND status='running'")
            .bind(id)
            .bind(status)
            .bind(value)
            .execute(&self.pool)
            .await?;
        Ok(true)
    }

    async fn execute_operation(
        &self,
        row: &PgRow,
        kind: &str,
        mut payload: Value,
    ) -> Result<Value> {
        let id: Uuid = row.get("id");
        let tenant: Uuid = row.get("tenant_id");
        let slot: Uuid = row.get("slot_id");
        let rev: i64 = row.get("binding_revision");
        ensure!(
            rev == row.get::<i64, _>("current_revision"),
            "HTTP:409:REVISION_CONFLICT"
        );
        let expires = row
            .get::<Option<DateTime<Utc>>, _>("expires_at")
            .unwrap_or(row.get("activation_deadline"));
        if !["stop", "unlink", "qr_cancel"].contains(&kind) {
            ensure!(
                expires > Utc::now()
                    && !matches!(
                        row.get::<String, _>("slot_status").as_str(),
                        "refunded" | "purged" | "expired"
                    ),
                "HTTP:403:SLOT_EXPIRED"
            );
        }
        if kind == "qr_start" {
            self.bridge
                .call(&format!("{id}-bind"), tenant, slot, rev, expires, "bind", json!({}))
                .await
                .map_err(|e| anyhow!(e))?;
        }
        if matches!(kind, "start" | "restart") {
            let _ = self
                .bridge
                .call(&format!("{id}-lease"), tenant, slot, rev, expires, "lease", json!({}))
                .await;
        }
        if kind == "send" {
            payload = self
                .send_payload(
                    tenant,
                    payload["recipient"].as_str().unwrap_or_default(),
                    payload["kind"].as_str().unwrap_or("dm"),
                    &payload["content"],
                )
                .await?;
        }
        if matches!(
            kind,
            "qr_start"
                | "qr_cancel"
                | "start"
                | "stop"
                | "restart"
                | "unlink"
                | "lease"
                | "groups"
                | "commands"
                | "config"
        ) {
            payload = json!({});
        }
        let mut result = self
            .bridge
            .call(&id.to_string(), tenant, slot, rev, expires, kind, payload)
            .await
            .map_err(|e| anyhow!(e))?;
        if kind == "qr_start" {
            if let Some(image) = result["result"]["qrImage"].as_str().map(str::to_owned) {
                result["result"]["qr_data_url"] = json!(image);
            }
        }
        if kind == "roster" && result["status"] == "succeeded" {
            sqlx::query("INSERT INTO rosters(id,tenant_id,slot_id,binding_revision,result) VALUES($1,$2,$3,$4,$5)")
                .bind(Uuid::new_v4())
                .bind(tenant)
                .bind(slot)
                .bind(rev)
                .bind(result["result"].clone())
                .execute(&self.pool)
                .await?;
        }
        Ok(result)
    }

    async fn send_payload(
        &self,
        tenant: Uuid,
        target: &str,
        kind: &str,
        content: &Value,
    ) -> Result<Value> {
        let mut assets = Vec::new();
        if let Some(ids) = content["upload_ids"].as_array() {
            ensure!(ids.len() <= 5, "HTTP:400:TOO_MANY_IMAGES");
            for id in ids {
                let id: Uuid = id
                    .as_str()
                    .ok_or_else(|| anyhow!("HTTP:400:INVALID_UPLOAD"))?
                    .parse()?;
                let row =
                    sqlx::query("SELECT mime,data FROM uploads WHERE id=$1 AND tenant_id=$2")
                        .bind(id)
                        .bind(tenant)
                        .fetch_optional(&self.pool)
                        .await?
                        .ok_or_else(|| anyhow!("HTTP:404:UPLOAD_NOT_FOUND"))?;
                assets.push(json!({
                    "id": id,
                    "mime": row.get::<String, _>("mime"),
                    "data_base64": base64::engine::general_purpose::STANDARD.encode(row.get::<Vec<u8>, _>("data")),
                }));
            }
        }
        Ok(json!({
            "target_id": target,
            "target_type": kind,
            "text": content["text"].as_str().unwrap_or_default(),
            "assets": assets,
        }))
    }

    async fn connections(&self) -> Result<()> {
        let rows = sqlx::query(
            "SELECT s.*,o.id AS operation_id,o.kind AS operation_kind,o.created_at AS operation_created_at,o.payload AS operation_payload FROM slots s JOIN LATERAL (SELECT id,kind,payload,created_at FROM operations WHERE slot_id=s.id AND binding_revision=s.binding_revision AND kind IN ('qr_start','start','restart') AND status='running' ORDER BY created_at DESC LIMIT 1) o ON true WHERE s.status='connecting' AND (s.last_runtime_check_at IS NULL OR s.last_runtime_check_at<now()-interval '3 seconds') LIMIT 30",
        )
        .fetch_all(&self.pool)
        .await?;
        for s in rows {
            if let Err(error) = self.connection(&s).await {
                tracing::warn!(
                    code = "CONNECTION_CHECK_FAILED",
                    slot = %s.get::<Uuid, _>("id"),
                    error = %error
                );
            }
        }
        Ok(())
    }

    async fn connection(&self, s: &PgRow) -> Result<()> {
        let slot: Uuid = s.get("id");
        let tenant: Uuid = s.get("tenant_id");
        let rev: i64 = s.get("binding_revision");
        let op: Uuid = s.get("operation_id");
        let expires = s
            .get::<Option<DateTime<Utc>>, _>("expires_at")
            .unwrap_or(s.get("activation_deadline"));
        sqlx::query("UPDATE slots SET last_runtime_check_at=now() WHERE id=$1")
            .bind(slot)
            .execute(&self.pool)
            .await?;
        let state = self
            .bridge
            .call(&ident(), tenant, slot, rev, expires, "status", json!({}))
            .await
            .map_err(|e| anyhow!(e))?;
        let state = &state["result"];
        if state["authenticated"] == true && state["listenerReady"] == true && state["ready"] == true
        {
            let uid = state["uid"]
                .as_str()
                .ok_or_else(|| anyhow!("UID_NOT_VERIFIED"))?;
            ensure!(mybot_portal_domain::valid_uid(uid), "UID_NOT_VERIFIED");
            let zalo_name = state["displayName"]
                .as_str()
                .or_else(|| state["name"].as_str());
            let zalo_avatar = state["avatar"].as_str();
            let end = self
                .activate_with_profile(slot, tenant, rev, uid, zalo_name, zalo_avatar)
                .await?;
            self.bridge
                .call(&format!("{op}-lease"), tenant, slot, rev, end, "lease", json!({}))
                .await
                .map_err(|e| anyhow!(e))?;
            sqlx::query("UPDATE operations SET status='succeeded',result=$2,updated_at=now() WHERE id=$1 AND status='running'")
                .bind(op)
                .bind(json!({"status":"succeeded","result":state}))
                .execute(&self.pool)
                .await?;
            // Automatically trigger initial group and command contract sync for the bound account.
            for sync_kind in ["groups", "commands"] {
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM operations WHERE slot_id=$1 AND binding_revision=$2 AND kind=$3 AND status IN ('pending','running','succeeded'))",
                )
                .bind(slot)
                .bind(rev)
                .bind(sync_kind)
                .fetch_one(&self.pool)
                .await?;
                if !exists {
                    sqlx::query("INSERT INTO operations(id,tenant_id,slot_id,kind,binding_revision) VALUES($1,$2,$3,$4,$5)")
                        .bind(Uuid::new_v4())
                        .bind(tenant)
                        .bind(slot)
                        .bind(sync_kind)
                        .bind(rev)
                        .execute(&self.pool)
                        .await?;
                }
            }
            return Ok(());
        }
        if matches!(s.get::<String, _>("operation_kind").as_str(), "start" | "restart") {
            sqlx::query("UPDATE operations SET result=$2,updated_at=now(),lease_until=now()+interval '2 minutes' WHERE id=$1 AND status='running'")
                .bind(op)
                .bind(json!({"status":"running","result":state}))
                .execute(&self.pool)
                .await?;
            if Utc::now() - s.get::<DateTime<Utc>, _>("operation_created_at") > Duration::minutes(2)
            {
                sqlx::query("UPDATE operations SET status='failed',result='{\"code\":\"LISTENER_NOT_READY\"}' WHERE id=$1 AND status='running'")
                    .bind(op)
                    .execute(&self.pool)
                    .await?;
                sqlx::query("UPDATE slots SET status='login_required' WHERE id=$1 AND binding_revision=$2 AND status='connecting'")
                    .bind(slot)
                    .bind(rev)
                    .execute(&self.pool)
                    .await?;
                let _ = self
                    .bridge
                    .call(&ident(), tenant, slot, rev, expires, "stop", json!({}))
                    .await;
            }
            return Ok(());
        }
        let qr = self
            .bridge
            .call(&ident(), tenant, slot, rev, expires, "qr_status", json!({}))
            .await
            .map_err(|e| anyhow!(e))?;
        let mut result = qr["result"].clone();
        if let Some(image) = result["qrImage"].as_str().map(str::to_owned) {
            result["qr_data_url"] = json!(image);
        }
        sqlx::query("UPDATE operations SET result=$2,updated_at=now(),lease_until=now()+interval '2 minutes' WHERE id=$1 AND status='running'")
            .bind(op)
            .bind(json!({"status":"running","result":result}))
            .execute(&self.pool)
            .await?;
        let operation_payload: Value = s.get("operation_payload");
        if qr["result"]["credential_ready"] == true && operation_payload["_start_requested"] != true
        {
            self.bridge
                .call(&format!("{op}-start"), tenant, slot, rev, expires, "start", json!({}))
                .await
                .map_err(|e| anyhow!(e))?;
            sqlx::query("UPDATE operations SET payload=payload||'{\"_start_requested\":true}'::jsonb WHERE id=$1")
                .bind(op)
                .execute(&self.pool)
                .await?;
        }
        if matches!(
            qr["result"]["state"].as_str(),
            Some("failed" | "expired" | "cancelled")
        ) {
            sqlx::query("UPDATE operations SET status='failed',result=$2 WHERE id=$1")
                .bind(op)
                .bind(json!({"code":"QR_FAILED","result":result}))
                .execute(&self.pool)
                .await?;
            sqlx::query("UPDATE slots SET status=CASE WHEN activated_at IS NULL THEN 'awaiting_activation' ELSE 'login_required' END WHERE id=$1 AND binding_revision=$2 AND status='connecting'")
                .bind(slot)
                .bind(rev)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn activate(
        &self,
        slot: Uuid,
        tenant: Uuid,
        revision: i64,
        uid: &str,
    ) -> Result<DateTime<Utc>> {
        self.activate_with_profile(slot, tenant, revision, uid, None, None)
            .await
    }

    async fn activate_with_profile(
        &self,
        slot: Uuid,
        tenant: Uuid,
        revision: i64,
        uid: &str,
        zalo_name: Option<&str>,
        zalo_avatar: Option<&str>,
    ) -> Result<DateTime<Utc>> {
        let mut tx = self.pool.begin().await?;
        let s = sqlx::query("SELECT * FROM slots WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
            .bind(slot)
            .bind(tenant)
            .fetch_one(&mut *tx)
            .await?;
        ensure!(
            s.get::<i64, _>("binding_revision") == revision
                && s.get::<String, _>("status") == "connecting",
            "REVISION_CONFLICT"
        );
        let now = Utc::now();
        let activated: Option<DateTime<Utc>> = s.get("activated_at");
        let end = if activated.is_some() {
            let end = s
                .get::<Option<DateTime<Utc>>, _>("expires_at")
                .ok_or_else(|| anyhow!("SLOT_EXPIRED"))?;
            ensure!(end > now, "SLOT_EXPIRED");
            end
        } else {
            ensure!(
                s.get::<DateTime<Utc>, _>("activation_deadline") > now,
                "ACTIVATION_DEADLINE_PASSED"
            );
            now + Duration::days(s.get::<i32, _>("purchased_days").into())
        };
        sqlx::query("UPDATE slots SET status='active',zalo_uid=$2,zalo_name=coalesce($5,zalo_name),zalo_avatar=coalesce($6,zalo_avatar),activated_at=coalesce(activated_at,$3),expires_at=$4 WHERE id=$1")
            .bind(slot)
            .bind(uid)
            .bind(now)
            .bind(end)
            .bind(zalo_name)
            .bind(zalo_avatar)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'slot_connected',$3)")
            .bind(Uuid::new_v4())
            .bind(tenant)
            .bind(json!({"slot_id": slot, "zalo_uid": uid, "expires_at": end}))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(end)
    }

    async fn reconcile(&self) -> Result<()> {
        let rows = sqlx::query(
            "SELECT * FROM slots WHERE status IN ('active','paused','login_required') AND expires_at>now() AND binding_revision>0 AND (last_runtime_check_at IS NULL OR last_runtime_check_at<now()-interval '30 seconds') LIMIT 30",
        )
        .fetch_all(&self.pool)
        .await?;
        for s in rows {
            let slot: Uuid = s.get("id");
            let tenant: Uuid = s.get("tenant_id");
            let rev: i64 = s.get("binding_revision");
            let end: DateTime<Utc> = s.get("expires_at");
            let desired: String = s.get("status");
            let mut transitioned_login_required = false;
            if self
                .bridge
                .call(&ident(), tenant, slot, rev, end, "lease", json!({}))
                .await
                .is_ok()
            {
                let state = self
                    .bridge
                    .call(&ident(), tenant, slot, rev, end, "status", json!({}))
                    .await;
                if desired == "paused" {
                    if state.as_ref().is_ok_and(|v| v["result"]["ready"] == true) {
                        let _ = self
                            .bridge
                            .call(&ident(), tenant, slot, rev, end, "stop", json!({}))
                            .await;
                    }
                } else {
                    let uid: Option<String> = s.get("zalo_uid");
                    let ready = state.as_ref().is_ok_and(|v| {
                        v["result"]["authenticated"] == true
                            && v["result"]["listenerReady"] == true
                            && v["result"]["ready"] == true
                            && v["result"]["uid"].as_str() == uid.as_deref()
                    });
                    let zname = state
                        .as_ref()
                        .ok()
                        .and_then(|v| {
                            v["result"]["displayName"]
                                .as_str()
                                .or_else(|| v["result"]["name"].as_str())
                        })
                        .map(str::to_owned);
                    let zavatar = state
                        .as_ref()
                        .ok()
                        .and_then(|v| v["result"]["avatar"].as_str())
                        .map(str::to_owned);
                    let next_status = if ready { "active" } else { "login_required" };
                    if desired == "active" && next_status == "login_required" {
                        transitioned_login_required = true;
                    }
                    sqlx::query("UPDATE slots SET status=$3,zalo_name=coalesce($4,zalo_name),zalo_avatar=coalesce($5,zalo_avatar) WHERE id=$1 AND binding_revision=$2 AND status IN ('active','login_required')")
                        .bind(slot)
                        .bind(rev)
                        .bind(next_status)
                        .bind(zname)
                        .bind(zavatar)
                        .execute(&self.pool)
                        .await?;
                }
            } else if desired == "active" {
                let n = sqlx::query("UPDATE slots SET status='login_required' WHERE id=$1 AND binding_revision=$2 AND status='active'")
                    .bind(slot)
                    .bind(rev)
                    .execute(&self.pool)
                    .await?
                    .rows_affected();
                if n == 1 {
                    transitioned_login_required = true;
                }
            }
            if transitioned_login_required {
                sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'session_login_required',$3)")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(json!({"slot_id": slot}))
                    .execute(&self.pool)
                    .await?;
            }
            sqlx::query("UPDATE slots SET last_runtime_check_at=now() WHERE id=$1")
                .bind(slot)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    async fn schedule(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let campaigns = sqlx::query(
            "SELECT c.*,s.expires_at,s.status AS slot_status,s.binding_revision AS current_revision FROM campaigns c JOIN slots s ON s.id=c.slot_id AND s.tenant_id=c.tenant_id WHERE c.status='running' AND c.next_run_at<=now() ORDER BY c.next_run_at FOR UPDATE OF c SKIP LOCKED LIMIT 30",
        )
        .fetch_all(&mut *tx)
        .await?;
        for c in campaigns {
            let id: Uuid = c.get("id");
            let tenant: Uuid = c.get("tenant_id");
            let slot: Uuid = c.get("slot_id");
            let rev: i64 = c.get("binding_revision");
            let now = Utc::now();
            let due: DateTime<Utc> = c.get("next_run_at");
            let schedule: Value = c.get("schedule");
            let count: i32 = c.get("run_count");
            let slot_expires: Option<DateTime<Utc>> = c.get("expires_at");
            if c.get::<i64, _>("current_revision") != rev
                || slot_expires.is_none_or(|end| end <= now)
                || c.get::<String, _>("slot_status") != "active"
            {
                sqlx::query("UPDATE campaigns SET status='needs_review',next_run_at=NULL WHERE id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'campaign_stopped',$3)")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(json!({"campaign_id": id, "slot_id": slot, "reason": "BOT_NOT_ACTIVE"}))
                    .execute(&mut *tx)
                    .await?;
                continue;
            }
            let slot_end = slot_expires.unwrap();
            let parsed = if schedule.is_null() || schedule.as_object().is_some_and(|v| v.is_empty())
            {
                None
            } else {
                Some(serde_json::from_value::<Schedule>(schedule)?)
            };
            let next = match &parsed {
                Some(s) => s
                    .next_after(now, due, (count + 1) as u32)?
                    .filter(|at| *at < slot_end),
                None => None,
            };
            let active: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM campaign_runs WHERE campaign_id=$1 AND status IN ('pending','running'))",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if should_skip_missed(due, now) || active {
                sqlx::query("INSERT INTO notifications(id,tenant_id,kind,body) VALUES($1,$2,'schedule_skipped',$3)")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(json!({
                        "campaign_id": id,
                        "reason": if active { "PREVIOUS_RUN_ACTIVE" } else { "MISSED_DURING_DOWNTIME" },
                    }))
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("UPDATE campaigns SET next_run_at=$2,last_scheduled_at=$3 WHERE id=$1")
                    .bind(id)
                    .bind(next)
                    .bind(due)
                    .execute(&mut *tx)
                    .await?;
                continue;
            }
            let content: Value = c.get("content");
            let kind: String = c.get("kind");
            let mut recipients = value_strings(&c.get::<Value, _>("recipients"));
            if kind == "dm" {
                let roster = sqlx::query_scalar::<_, Value>(
                    "SELECT result FROM rosters WHERE tenant_id=$1 AND slot_id=$2 AND binding_revision=$3 ORDER BY created_at DESC LIMIT 1",
                )
                .bind(tenant)
                .bind(slot)
                .bind(rev)
                .fetch_optional(&mut *tx)
                .await?;
                if roster.as_ref().is_none_or(|r| r["completeness"] != "full")
                    && content["partial_accepted"] != true
                {
                    sqlx::query("UPDATE campaigns SET status='needs_review',next_run_at=NULL WHERE id=$1")
                        .bind(id)
                        .execute(&mut *tx)
                        .await?;
                    continue;
                }
                if content["rescan_each_run"] == true {
                    // Rescan is executed before freezing a run, never claiming old recipients fresh.
                    let groups = content["group_ids"].clone();
                    if !groups.as_array().is_some_and(|v| !v.is_empty()) {
                        sqlx::query("UPDATE campaigns SET status='needs_review',next_run_at=NULL WHERE id=$1")
                            .bind(id)
                            .execute(&mut *tx)
                            .await?;
                        continue;
                    }
                    let result = self
                        .bridge
                        .call(&ident(), tenant, slot, rev, slot_end, "roster", json!({"group_ids": groups}))
                        .await;
                    let Ok(result) = result else {
                        sqlx::query("UPDATE campaigns SET status='needs_review',next_run_at=NULL WHERE id=$1")
                            .bind(id)
                            .execute(&mut *tx)
                            .await?;
                        continue;
                    };
                    let roster = &result["result"];
                    if result["status"] != "succeeded"
                        || (roster["completeness"] != "full" && content["partial_accepted"] != true)
                    {
                        sqlx::query("UPDATE campaigns SET status='needs_review',next_run_at=NULL WHERE id=$1")
                            .bind(id)
                            .execute(&mut *tx)
                            .await?;
                        continue;
                    }
                    recipients = roster["members"]
                        .as_array()
                        .map(|m| {
                            m.iter()
                                .filter_map(|m| m["uid"].as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                    sqlx::query("INSERT INTO rosters(id,tenant_id,slot_id,binding_revision,result) VALUES($1,$2,$3,$4,$5)")
                        .bind(Uuid::new_v4())
                        .bind(tenant)
                        .bind(slot)
                        .bind(rev)
                        .bind(roster)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            let recipients =
                recipient_snapshot(recipients, value_strings(&c.get::<Value, _>("exclusions")));
            let run = Uuid::new_v4();
            sqlx::query("INSERT INTO campaign_runs(id,tenant_id,campaign_id,status,scheduled_at,started_at,recipient_count,content,kind) VALUES($1,$2,$3,'running',$4,now(),$5,$6,$7)")
                .bind(run)
                .bind(tenant)
                .bind(id)
                .bind(due)
                .bind(recipients.len() as i32)
                .bind(content)
                .bind(kind)
                .execute(&mut *tx)
                .await?;
            for recipient in recipients {
                sqlx::query("INSERT INTO deliveries(id,tenant_id,run_id,slot_id,binding_revision,recipient) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
                    .bind(Uuid::new_v4())
                    .bind(tenant)
                    .bind(run)
                    .bind(slot)
                    .bind(rev)
                    .bind(recipient)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE campaigns SET next_run_at=$2,last_scheduled_at=$3,run_count=run_count+1 WHERE id=$1")
                .bind(id)
                .bind(next)
                .bind(due)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    async fn delivery(&self) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT d.*,s.expires_at,s.status AS slot_status,s.binding_revision AS current_revision,c.status AS campaign_status,r.kind,r.content,c.exclusions FROM deliveries d JOIN slots s ON s.id=d.slot_id AND s.tenant_id=d.tenant_id JOIN campaign_runs r ON r.id=d.run_id AND r.tenant_id=d.tenant_id JOIN campaigns c ON c.id=r.campaign_id AND c.tenant_id=d.tenant_id WHERE d.status='pending' AND c.status<>'paused' AND (s.next_send_at IS NULL OR s.next_send_at<=now()) AND NOT EXISTS(SELECT 1 FROM deliveries other WHERE other.slot_id=d.slot_id AND other.status='sending') ORDER BY d.created_at FOR UPDATE OF d,s SKIP LOCKED LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let Some(d) = row else { return Ok(false) };
        let id: Uuid = d.get("id");
        let slot: Uuid = d.get("slot_id");
        let tenant: Uuid = d.get("tenant_id");
        let rev: i64 = d.get("binding_revision");
        let recipient: String = d.get("recipient");
        let expired = d
            .get::<Option<DateTime<Utc>>, _>("expires_at")
            .is_none_or(|end| end <= Utc::now());
        let allowed = !expired
            && d.get::<i64, _>("current_revision") == rev
            && d.get::<String, _>("slot_status") == "active"
            && d.get::<String, _>("campaign_status") == "running"
            && !value_strings(&d.get::<Value, _>("exclusions")).contains(&recipient);
        if !allowed {
            sqlx::query("UPDATE deliveries SET status='skipped',result='{\"code\":\"SEND_GATE_CLOSED\"}' WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(true);
        }
        let kind: String = d.get("kind");
        let content: Value = d.get("content");
        let interval = minimum_interval(
            if kind == "dm" {
                CampaignKind::Dm
            } else {
                CampaignKind::Group
            },
            content["interval_seconds"].as_u64().unwrap_or(0),
        );
        let attempt = Uuid::new_v4();
        sqlx::query("UPDATE deliveries SET status='sending',attempt_id=$2,lease_until=now()+interval '2 minutes' WHERE id=$1")
            .bind(id)
            .bind(attempt)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE slots SET next_send_at=now()+$2*interval '1 second' WHERE id=$1")
            .bind(slot)
            .bind(interval as f64)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let result = match self.send_payload(tenant, &recipient, &kind, &content).await {
            Ok(payload) => {
                self.bridge
                    .call(
                        &attempt.to_string(),
                        tenant,
                        slot,
                        rev,
                        d.get("expires_at"),
                        "send",
                        payload,
                    )
                    .await
            }
            Err(_) => Ok(json!({"status":"failed","result":{"code":"UPLOAD_NOT_FOUND"}})),
        };
        let status = terminal_send_status(&result);
        let value = match result {
            Ok(value) => value,
            Err(error) => public_error(&error),
        };
        sqlx::query("UPDATE deliveries SET status=$2,result=$3,sent_at=CASE WHEN $2='api_confirmed' THEN now() ELSE NULL END WHERE id=$1 AND status='sending'")
            .bind(id)
            .bind(if status == "rate_limited" {
                "pending"
            } else {
                status
            })
            .bind(&value)
            .execute(&self.pool)
            .await?;
        if status == "rate_limited" {
            let cooldown = value["result"]["retry_after"]
                .as_u64()
                .or_else(|| value["retry_after"].as_u64())
                .unwrap_or(60)
                .clamp(5, 86_400);
            sqlx::query("UPDATE slots SET next_send_at=greatest(coalesce(next_send_at,now()),now()+$2*interval '1 second') WHERE id=$1")
                .bind(slot)
                .bind(cooldown as f64)
                .execute(&self.pool)
                .await?;
        }
        Ok(true)
    }

    async fn finish_runs(&self) -> Result<()> {
        sqlx::query(
            "UPDATE campaign_runs r SET status='completed',finished_at=now(),report=(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT status,count(*) AS n FROM deliveries WHERE run_id=r.id GROUP BY status) counts) WHERE r.status IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM deliveries WHERE run_id=r.id AND status IN ('pending','sending'))",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "UPDATE campaigns c SET status='completed' WHERE c.status='running' AND c.next_run_at IS NULL AND NOT EXISTS(SELECT 1 FROM campaign_runs WHERE campaign_id=c.id AND status IN ('pending','running'))",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
