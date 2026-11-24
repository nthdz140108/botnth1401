# Dashboard Observability Phase 1

## Scope

Implement server-side observability for the existing Express and Socket.IO dashboard.
This phase adds no frontend workspace redesign and does not change bot core, database,
authentication, roles, or audit trails.

## Architecture

`dashboard/server.js` remains the composition root. It creates an observability service
from `dashboard/observability/` and supplies adapters for the existing bot registry,
group settings, command configuration, and Socket.IO instance.

The observability service consists of:

- `store.js`: owns persisted JSON state, runtime snapshots, one-minute aggregation,
  seven-day retention, recent activity (maximum 1,000 entries), atomic writes, and
  corrupt-file recovery.
- `collector.js`: samples `systeminformation` every 15 seconds and uses injected
  adapters to create safe dashboard metrics.
- `service.js`: coordinates collection, persistence, overview projection, and Socket.IO
  events.

The persisted file lives under `dashboard/observability/`. A write uses a sibling
temporary file followed by rename. If parsing fails during startup, the original file
is renamed with a `.corrupt-<timestamp>` suffix and a new empty store is used.

## Data Contract

`GET /api/dashboard/overview?range=24h|7d` defaults to `24h`. A value other than
`24h` or `7d` returns HTTP 400:

```json
{ "success": false, "code": "INVALID_RANGE" }
```

Successful responses contain `success`, `generatedAt`, `range`, `summary`, `health`,
`series`, `fleet`, `recentActivity`, and `warnings`.

Each series point includes `timestamp`, `cpuAvg`, `cpuMax`, `memoryAvg`, `diskAvg`,
`onlineBots`, `messages`, and `alerts`. The 24-hour projection uses five-minute
buckets; the seven-day projection uses fifteen-minute buckets. Bucket fields are
always present, including for periods without samples.

Summary derives its counts from current configured data: online/total bots, messages
in the last 24 hours, groups with `activeBot === true`, commands with `active !==
false`, alerts in the last 24 hours, and uptime.

Health contains text-bearing CPU, memory, disk, and connection values. A failed health
source appends a sanitized warning and leaves the remaining health data available.

Metrics and activity never include cookies, IMEIs, user agents, credentials, or
user-identifying audit data.

## Realtime

The collector emits `dashboard:metrics` immediately after each 15-second sample.
Existing operational transitions feed the activity service, which retains the event
and emits `dashboard:activity`. Existing `botStatus` emission remains unchanged.

## Error Handling

Sampling, file writing, and external health failures never terminate the dashboard.
They become warnings where applicable. Invalid API input returns stable HTTP errors.
An empty or newly recovered store returns a valid overview payload with zero-filled
series data.

## Testing

Tests are written before implementation and cover:

- 15-second collector scheduling and immediate sample emission.
- One-minute aggregation, seven-day pruning, restart persistence, atomic persistence,
  and corrupt-file recovery.
- The overview HTTP contract for `24h`, `7d`, invalid ranges, empty data, and partial
  health failure.
- Activity retention and redaction.

Existing dashboard API and Socket.IO tests continue to run. No production endpoint is
removed or renamed in this phase.
