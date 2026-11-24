# Bot Restart Design

## Goal

Make restart deterministic for the main launcher and for dashboard-managed child bots. A restart must not create overlapping runtimes, must wait for the old runtime to stop, and must report failures instead of claiming success after a fire-and-forget spawn.

## Scope

This change covers:

- the main launcher in `bot.js`, including manual restart, signal-triggered restart, and crash recovery;
- child bot actions in `src/dashboard/bot-action-service.js`, including direct spawned processes and actual PM2 processes;
- regression tests for both runtime owners.

It does not change QR login, cookie cleanup, command routing, or the dashboard visual design except for the status/error data already returned by the action service.

## Current Problems

1. `bot.js` starts a replacement after a fixed one-second delay while Windows `taskkill` is still asynchronous.
2. Multiple paths can call `startBot()` directly: `restartBot()`, the `exit` handler for the restart action, and signal handlers. These paths can overlap.
3. Exit events from an older child process can be observed after a newer process has been assigned to `botProcess`.
4. `startBot()` schedules child-bot startup after five seconds without retaining or invalidating that timer across restarts.
5. Dashboard restart calls the PM2 command even when the child is a directly spawned process.
6. Dashboard stop detection treats registry status `running` as proof that PM2 owns the process, which can invoke the wrong stop adapter.

## Design

### Main launcher coordinator

Create a small dependency-injected coordinator in `src/utils/restart-coordinator.js`. It owns one in-flight restart promise and exposes:

```js
createRestartCoordinator({ stop, start, delayMs, onStateChange })
restart(reason = "manual", context = {})
getState()
```

The coordinator has `idle`, `stopping`, `starting`, and `running` states. Concurrent `restart()` calls return the same in-flight promise. `stop(context)` must resolve only after the old process is confirmed stopped; `start(context)` is called only after that resolution and the delay. `delayMs` may be a number or a function receiving `{ reason, context }`, so crash backoff is not added twice. A rejection leaves the coordinator idle and is propagated to the caller.

`bot.js` adapts its existing process operations to this coordinator. `stopBot()` becomes an awaitable operation that waits for the Windows `taskkill` close event and has a bounded timeout. The current process object is passed to stop and event handlers so an old process cannot stop or restart a newer one. Only the coordinator starts a replacement.

Crash backoff remains bounded by the existing failure limit. Explicit restart resets the failure counter only after a successful replacement. A failed explicit restart is logged and does not silently start another replacement. Pending five-second child-bot startup work is cleared or tagged with the coordinator generation so it cannot run for an obsolete launcher cycle.

### Main launcher event routing

The `error`, `exit`, `SIGINT`, and `SIGTERM` handlers become request sources rather than independent restart implementations. An explicit `stop` remains terminal. An explicit `restart` requests one coordinator restart. An unexpected exit requests crash recovery through the same coordinator, preserving backoff and cookie-dead/CTRL+C terminal cases. The event handler ignores an event whose process is no longer the active process.

### Child bot action service

Add a per-bot in-flight action map in `src/dashboard/bot-action-service.js`. `restart(botId)` shares one Promise with concurrent requests for the same bot and removes the lock in `finally`, including failures. Different bot IDs remain independent.

Runtime ownership is determined from live adapter results:

- PM2 restart is used only when `pm2.status(botId)` reports an online/running PM2 process;
- a directly spawned process is stopped through `process.kill(botId)` and then started through the existing launcher adapter;
- configured or registry status alone is never treated as proof of PM2 ownership.

The stop path remains best-effort across both owners but returns `STOP_FAILED` with adapter details when a required operation fails. Restart returns `ACTION_FAILED` when stop/start or the PM2 restart command returns `false` or throws. A successful request keeps the existing `{ botId, action: "restart", status: "restarting" }` contract.

### Observability

Keep existing launcher and dashboard log channels. Add phase-specific messages for `stopping`, `starting`, and failed restart, including bot ID or PID where available. Do not log credentials or cookie contents.

## Error Handling

- A stop timeout must attempt the existing hard-kill mechanism before failing.
- A start failure must clear the in-flight lock and leave no stale PID/state ownership in the coordinator.
- A duplicate request must not issue a second stop, start, PM2 restart, or timer.
- An old process exit must not reset the new process state or trigger another restart.
- Child bot adapter errors must be returned with stable action error codes already used by the service.

## Testing

Add focused tests before production changes:

- coordinator tests for stop-before-start ordering, shared Promise on concurrent requests, stale-generation events, stop timeout, start failure, and state cleanup;
- launcher integration-level tests around the extracted coordinator adapter for manual restart and crash retry routing;
- dashboard action tests for direct spawned restart, PM2 restart, duplicate same-bot requests, independent different-bot requests, and adapter failure propagation.

Run the focused tests first, then the complete `npm test` suite. The change is complete only when the focused tests and the full suite pass.

## Non-goals

- replacing the current process model with PM2 everywhere;
- changing restart delay policy beyond making it single-flight and bounded;
- adding automatic restart of disabled or cookie-dead child bots;
- changing API response shapes outside documented error handling.
