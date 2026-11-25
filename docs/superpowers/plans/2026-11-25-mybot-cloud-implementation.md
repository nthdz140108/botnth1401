# MYBOT Cloud implementation ledger

Authority: `2026-11-25-mybot-cloud-spec.md` (user supplied; user requested direct completion).

## Boundaries and interfaces

- Independent workspace `rust/portal` with crates `domain`, `server`, `web`, `worker`. Existing Rust dashboard stays separate.
- Packages: `mybot-portal-domain`, `mybot-portal-server`, `mybot-portal-web`, `mybot-portal-worker`.
- Server exports `pub async fn router(pool: sqlx::PgPool) -> anyhow::Result<axum::Router>` and library modules `db`, `auth`, `api`. Binary `mybot-portal` serves `127.0.0.1:4180` (`/health` and `/healthz` verify DB connectivity); CLI `migrate` / `bootstrap-operator USERNAME`.
- Web exports `pub fn shell(options: leptos::config::LeptosOptions) -> impl leptos::IntoView`, component `App`, wasm `hydrate`. Axum fallback renders shell with hydration scripts. API responses use JSON `{data: ...}`; errors `{error:{code,message}}`.
- Domain independent of server/DB. Core identifiers UUID; times UTC; VND `i64`; exact remaining duration formatted in Vietnamese (`"12 ngày 5 giờ"`).
- Engine bridge `/bridge/portal/...`, JSON operations scoped by `slot_id`, `tenant_id`, `binding_revision`, `expires_at`. HMAC uses `${timestamp_ms}.${body}` and existing internal headers. Runtime policy fails closed.
- API prefix `/api/customer/v1`, operator `/api/operator/v1`. Cookie session `mybot_portal`; `/me` returns csrf token. Header `x-csrf-token` for mutations; `Idempotency-Key` for money changes.
- PostgreSQL migrations live in `rust/portal/crates/server/migrations` (`0001_portal.sql`, `0002_worker.sql`, `0003_portal_completion.sql`). Additive forward-only migrations; runtime DB role has no RLS bypass; `ledger` and `audit` are append-only immutable.
- Durable campaigns/deliveries with row leases (`FOR UPDATE SKIP LOCKED`), unknown send results never retried, stranger/permission rejections recorded as `skipped`, and schedules bounded by slot expiry in `Asia/Ho_Chi_Minh`.

## Tasks & Completion Status

1. **Domain rental, quote, schedule, remaining-time and delivery rules** — Completed (`8/8` unit tests passing).
2. **PostgreSQL migrations, Axum auth/operator/wallet/topup-confirm/rental/config/campaign-clone/operations/health API** — Completed (`invariants` + real PostgreSQL 17 RLS/concurrency/100-session P95 < 200 ms integration suite passing).
3. **Vietnamese Leptos SSR + WASM hydrated responsive UI (9 customer pages, 7-tab bot detail, `/operator`, 375 px mobile navigation)** — Completed (`14/14` unit + SSR tests passing; `cargo leptos build --cargo-locked` producing `mybot-portal.wasm` + JS + CSS).
4. **Node portal bridge, enriched group/admin metadata, `restart`, shared `getuser` roster service, and engine guards** — Completed (`22/22` Node tests passing).
5. **Rust durable worker, signed loopback bridge client, auto group/command sync on activation, 24h expiry & session notifications** — Completed (`policy` + real PostgreSQL concurrency/crash-recovery tests passing).
6. **Incremental VPS build/migrate/restart/health integration, `DAY_LEN_VPS.bat` + `CAI_DAT_PORTAL.bat` and deployment docs** — Completed.
7. **Live VPS acceptance** — Capacity defaults to `0` on initial deployment so the operator can verify live Zalo QR/DM/group behavior on test accounts before opening sales (`5 -> 10 -> <= 30` slots).
