# PM2 Port Readiness and Child Restore Intent Design

> **SUPERSEDED POLICY NOTE (2026-09-01).** The `desiredStatus` registry field
> designed below was NOT implemented. The approved replacement policy is
> "mọi bot hợp lệ còn hạn": at `run.bat` startup reconcile, EVERY valid,
> non-expired child bot is auto-started regardless of its previous registry
> `status` (including `stopped`). Stop only takes effect until the next
> `run.bat`. Excluded (fail-closed): disabled/rejected/deleted, expired or
> malformed expiry, `cookieDead`, `identityPending`,
> `trialStatus=pending|activating`, missing cookie+imei credentials, invalid
> `webPort`, and `admin`. See
> `src/commands/mybot/System/mybot-auto-restore.js`
> (`evaluateRestoreCandidate`, `explainAutoRestoreCandidates`) and
> `src/runtime/reconcile-and-monitor.js` (`restoreChildBotsForTest`).

## Problem statement

The VPS shows two independent failures after the PM2 migration:

- `admin` remains PM2 `online` with zero restarts, but port 2000 is not listening and the monitor reports `port-closed`.
- A paid/permanent child remains PM2 `stopped` after an update even though `expiryAt: "-1"` is valid and both admin and child state report `cookieDead: false`.

## Evidence and root causes

### Current admin process is stuck before current-run readiness

The VPS evidence shows PM2 `admin` online for about 12 minutes with zero restarts and no listener on port 2000. `mybot/state/admin.json` is not proof that this PM2 PID is ready: its `lastReadyAt` predates the PM2 `created at` timestamp by many hours. Therefore the current process has not completed the login-ready path that starts the runtime bridge.

The direct PM2 log command in the screenshot failed because that PM2 build rejected the supplied `--lines` option, and the later `Get-Content` used the repository `logs/` directory instead of the paths printed by `pm2 describe`: `%USERPROFILE%\.pm2\logs\admin-out.log` and `admin-error.log`. The exact external trigger (pending `zalo.login`, QR recovery, or transport failure) needs those current files, but the code defect is already established: admin login and the spawned QR recovery child are awaited without a controlling startup deadline, so a Node process can remain PM2-online indefinitely before it binds port 2000.

### Runtime bridge is also destroyed by a transient Zalo listener failure

`src/index.js:startListenerWithRetry()` calls `closeWebServer()` whenever `api.listener.start()` throws. The retry loop can later succeed and return without calling `startWebServer()` again. This leaves a healthy Node process under PM2 with no runtime bridge, exactly matching `online`, zero restarts, and no listener on port 2000.

The bridge and Zalo listener have different responsibilities. A transient Zalo reconnect must change readiness state, but must not destroy the local control/health endpoint. The bridge closes only during controlled process shutdown or an unrecoverable bootstrap failure.

### Persistent registry `status` mixes desired and observed state

The updater intentionally calls `pm2 stop` for the fleet. The runtime exit handler then writes child registry `status: "stopped"`. The updater backs up persistent data after the stop, so that value survives the update. `getAutoRestoreCandidates()` restores only records whose status is `running`, so `run.bat` cannot restore a child that was running before maintenance.

`expiryAt: "-1"` is not broken. It means the bot is eligible indefinitely; it does not encode whether the operator wants the bot to run. The registry needs a durable desired state distinct from PM2/runtime observations.

## Required behavior

1. The runtime bridge stays bound while the Zalo listener retries.
2. Admin login and QR recovery have explicit deadlines and cannot leave PM2 online forever before readiness.
3. Admin state records the current startup phase and PID so stale `lastReadyAt` cannot be mistaken for current readiness.
4. `/internal/runtime/identity` and `/internal/runtime/health` report whether the Zalo listener is connected.
5. Dashboard and terminal report `running/ready` only when PM2 is online, the correct bridge answers, and the listener is connected.
6. A PM2 crash, restart, updater stop, or OS shutdown does not overwrite durable desired state.
7. Successful `mybot start` sets desired state to `running`; successful manual `mybot stop`, disable, expiry, and delete set it to `stopped`.
8. `run.bat` restores only desired-running, enabled, unexpired, cookie-valid child bots.
9. Legacy records without `desiredStatus` fall back to the existing status so deployment is migration-safe.
10. QR provisioning remains stopped/pending and never gains desired-running state.
11. `update.bat` remains update-only; it does not auto-start the fleet. A later explicit `run.bat` restores previously desired-running children.

## Non-goals

- Do not make permanent expiry imply automatic activation.
- Do not make the terminal monitor mutate registry or PM2 state.
- Do not weaken cookie-dead, disabled, expired, identity, or owner-active-slot checks.
- Do not use `pm2 kill`, force-delete PM2 definitions, or touch foreign PM2 apps.

## Acceptance evidence

- Focused unit/integration tests prove retry-without-port-close and desired-state preservation.
- An isolated PM2 smoke proves `online + listener disconnected` remains port-open but not ready, then becomes ready after listener recovery.
- VPS evidence proves `admin` listens on 127.0.0.1:2000, identity reports the correct main bot and listener state, and a previously running permanent child is restored after `update.bat` followed by explicit `run.bat`.
- Zalo message send/receive proof is reported separately from PM2 and HTTP health.
