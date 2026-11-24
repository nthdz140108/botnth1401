# Dashboard Shared Backend Phase 1

## Goal

Build the first implementation phase for the deep Vietnamese bot management
dashboard. This phase creates the shared backend foundation used by both the
standalone dashboard server and the admin bot web server. It intentionally
focuses on API contracts, bot discovery, runtime status, file writes, backups,
audit entries, credentials, and command override behavior. The deeper bot detail
UI is phase 2 and will consume these APIs.

## Scope

Phase 1 includes:

- Shared dashboard API registration under `src/dashboard/`.
- Mounting the same API routes from `dashboard/server.js` and
  `src/web-service/web-server.js`.
- Unified response envelope:
  `{ success, data, error?, requestId, restartRequired?, changedPaths?, backup? }`.
- Bot discovery from `mybot/mybots.json`, `mybot/bots/*.json`,
  `mybot/state/*.json`, process PID checks, PM2 status when available, and port
  health.
- Bot list, detail, runtime, start, stop, restart, delete, and bulk action API
  contracts.
- Config and credential read/update/reveal/rollback APIs with automatic backup,
  atomic writes, audit log entries, and `restartRequired: true` on writes.
- Command scan, global command CRUD, per-bot command overrides, reset override,
  copy from admin, and apply-all API contracts.
- Backend validation for duplicate aliases, invalid permissions, negative
  countdown, empty aliases, and invalid JSON/object payloads.
- Unit and API contract tests for both server entry points.

Out of scope for phase 1:

- Full React/plain JS command editor UI.
- Final visual polish for the deep bot workspace.
- Browser mobile/desktop smoke for the new editor screens.
- Changes to bot core behavior unrelated to dashboard management.

## Architecture

`src/dashboard/api-routes.js` exposes `registerDashboardApi(app, options)`. It
owns request IDs, response formatting, route registration, and route-level error
handling. The route module delegates work to focused services:

- `BotRegistry`: discovery and runtime status normalization.
- `ConfigStore`: safe JSON reads, backups, atomic writes, rollback.
- `CredentialService`: masked credential reads, explicit reveal, update of
  cookie, IMEI, userAgent, prefix, active, rawCookies, and raw JSON.
- `CommandService`: scan global commands, validate updates, write global command
  file, read/write per-bot overrides, copy/apply/reset operations.
- `AuditStore`: append-only JSONL audit entries for dashboard writes/actions.

`dashboard/server.js` becomes a small standalone host that mounts the shared
API, serves the dashboard assets, and keeps existing test exports. The admin
web server also mounts the same shared API. Existing admin-only routes can stay
in `src/web-service/web-server.js`, but duplicate dashboard routes should be
replaced by the shared implementation.

## Data Flow

Bot discovery builds a canonical bot model:

1. Start with `admin`.
2. Add IDs from `mybot/mybots.json`.
3. Add IDs from every `mybot/bots/*.json`.
4. Add IDs from every `mybot/state/*.json`.
5. Merge inventory, config, and state fields.
6. Probe PID, port health, and PM2 status.
7. Normalize status to `running`, `stopped`, `starting`, `stopping`,
   `restarting`, `error`, `credential_dead`, `expired`, or `unknown`.

Write APIs validate payloads first, create a backup, write through a temporary
file in the target directory, rename atomically, append audit metadata, and
return the changed paths plus backup information.

Credentials are masked by default. `POST /api/bots/:id/credential/reveal`
returns full credential content only through an explicit endpoint because the
dashboard is for internal admin use.

Command APIs keep global command data in the existing command file. Per-bot
customization is stored as an override file per bot so resetting a bot command
does not mutate the global admin/default command.

## API Contract

Phase 1 implements these backend routes:

- `GET /api/bots`
- `GET /api/bots/:id`
- `GET /api/bots/:id/runtime`
- `POST /api/bots/:id/actions/start`
- `POST /api/bots/:id/actions/stop`
- `POST /api/bots/:id/actions/restart`
- `POST /api/bots/:id/actions/delete`
- `POST /api/bots/actions/bulk`
- `GET /api/bots/:id/config`
- `GET /api/bots/:id/config/:pathKey`
- `PUT /api/bots/:id/config/:pathKey`
- `GET /api/bots/:id/credential`
- `POST /api/bots/:id/credential/reveal`
- `PUT /api/bots/:id/credential`
- `POST /api/bots/:id/config/rollback`
- `GET /api/commands/scan`
- `GET /api/commands`
- `PUT /api/commands/:commandName`
- `POST /api/commands`
- `DELETE /api/commands/:commandName`
- `GET /api/bots/:id/commands`
- `PUT /api/bots/:id/commands/:commandName`
- `DELETE /api/bots/:id/commands/:commandName/override`
- `POST /api/bots/:id/commands/copy-from-admin`
- `POST /api/commands/apply-all`

Legacy endpoints may continue to exist, but these routes are the canonical
dashboard contract from phase 1 onward.

## Error Handling

Every API response includes `success` and `requestId`. Validation errors return
HTTP 400 with a machine-readable `error.code` and Vietnamese-readable
`error.message`. Missing bots, files, or commands return 404. File parse errors
return 422. Runtime action failures return 500 with the action, bot ID, and
request ID in the audit entry.

Sensitive values are redacted except in the credential reveal endpoint.
Rollback only accepts backup files inside the configured dashboard backup
directory.

## Testing

Phase 1 tests cover:

- Bot discovery from registry, bot config files, state files, PID, PM2, and port
  health.
- Unified response envelope and request ID behavior.
- Config write, backup, atomic replacement, changed paths, rollback, and audit.
- Credential masked read, reveal, and update.
- Command scan, global update/add/delete, per-bot override, reset override,
  copy-from-admin, apply-all, and validation failures.
- API contract parity for `dashboard/server.js` and `src/web-service/web-server.js`.

Baseline dashboard tests remain part of verification:

`node --test tests/dashboard/app-api.test.js tests/dashboard/web-server.test.js tests/dashboard/navigation.test.js tests/dashboard/router.test.js`

## Phase Order

1. Phase 1: Shared backend foundation and contract tests.
2. Phase 2: Bot detail workspace UI in Vietnamese using the phase 1 APIs.
3. Phase 3: Deep command editor UI with compare, override, apply-all, and reset.
4. Phase 4: Logs, backup/rollback UX, browser smoke, and mobile polish.

## Repository Note

This workspace does not contain a `.git` directory, so the spec cannot be
committed here. The file is still written to the expected specs directory.
