# QR Login Cookie Lifecycle Design

## Goal

Change QR login so bot identity is discovered only after Zalo SDK login succeeds with the QR cookie, then reconcile the real UID into the bot registry without stopping an already running duplicate bot.

## Architecture

QR login will produce only raw cookies and IMEI. A short-lived bootstrap process runs `src/index.js` with a temporary config and writes an identity handshake file under `mybot/state/qr-bootstrap/<sessionId>.json`. The QR command waits for that file, then uses the discovered UID to decide whether to hot reload an existing bot, restart a stopped bot, update admin credentials, or create a new bot.

Running bots receive credential updates through JSON reload requests in `mybot/state/reload/<uid>.json`. `src/index.js` polls this file, validates the new credential through `Zalo.login()`, swaps the API/listener in the same process, and marks the reload request `ready` or `failed`.

## Components

- `src/commands/mybot/System/json-state.js`: atomic JSON read/write helpers and timestamp helpers for state files.
- `src/commands/mybot/System/identity-handshake.js`: schema helpers for bootstrap handshake files.
- `src/commands/mybot/System/reload-request.js`: schema helpers for credential reload requests.
- `src/commands/mybot/System/mybots-registry.js`: atomic registry writes.
- `src/commands/mybot/System/pm2-manager.js`: launcher options, credential-only writes, reload requests, and handshake polling.
- `src/commands/mybot/Manager/qr-login-command.js`: QR flow and UID reconciliation after handshake.
- `src/index.js`: bootstrap-only mode, listener rebinding, and hot reload loop.
- `bot.js`: startup cleanup for child bots with dead cookies.

## Data Flow

1. `handleQrLogin` creates QR session and waits for scan/confirm.
2. On confirm, it saves temporary credentials/config for `bootstrapId`.
3. It starts `src/index.js` with `BOT_NAME=qr-bootstrap-<id>`, `CONFIG_PATH=<bootstrap-config>`, `QR_BOOTSTRAP_SESSION=<id>`, and `QR_BOOTSTRAP_ONLY=true`.
4. Bootstrap login writes handshake with real `uid`, `displayName`, `avatar`, `pid`, and status.
5. QR command reconciles the UID:
   - Admin duplicate writes `assets/config.json`, requests admin reload, and rejects UID mismatch.
   - Running child duplicate atomically writes credentials and requests hot reload, rolling back on failure.
   - Stopped child duplicate writes credentials and starts existing config.
   - New UID creates files, starts bot, then adds registry record after health check.

## Error Handling

Bootstrap timeout, auth failure, and empty UID leave no registry entry and clean temporary config/state where safe. Running duplicate reload failures restore previous credential/registry snapshots and leave the old bot running. Admin recovery continues to require the existing admin UID.

## Testing

Use `node --test`. Add focused tests for atomic JSON writes, handshake polling, reload request transitions, registry atomic writes, QR reconciliation decisions, and startup cleanup decisions. Tests should avoid real Zalo network calls by exercising pure helpers and injected process/health dependencies.
