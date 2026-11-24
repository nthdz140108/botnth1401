# Dashboard Chat Scope & Access Design

## Goal

Add command scope controls and per-bot chat access controls while keeping the existing command metadata, dashboard APIs, legacy command switch, and bot runtime behavior compatible.

## Current Context

- The bot runtime receives messages through `src/automations/event-send-msg.js` and dispatches commands through both `src/commands/command.js` and the newer `src/commands/command-router.js`.
- Global command configuration is stored in `assets/json-data/command.json`.
- Per-bot command overrides are stored in `mybot/command-overrides/<botId>.json`.
- Dashboard command APIs and persistence are implemented in `src/dashboard/api-routes.js`, `command-service.js`, and `config-store.js`.
- The dashboard frontend is React under `dashboard/src`.
- Existing `privateEnabled` and `groupEnabled` values are read by runtime code, but their gate currently does not apply the required administrator bypass and is not exposed through a per-bot dashboard API.

## Decisions

### Shared command policy

Create a pure resolver module at `src/commands/command-policy.js`. It owns:

- `VALID_SCOPES = { group, private, both }`.
- `DEFAULT_SCOPE = "both"`.
- validation and normalization of a scope value.
- `resolveCommandPolicy({ command, override })`, which returns the command metadata with `scope`, `effectiveScope`, and `override` information.
- `scopeAllows(scope, chatScope)` for group/private checks.

Resolution order is exactly `override.scope` when valid, then `command.scope` when valid, then `both`. A missing field is not persisted as a synthetic global field unless an existing caller needs the normalized view; the original command fields remain intact when writing.

`CommandService` and `CommandScanner` use this module for validation and returned views. `listForBot()` returns each global command plus `override` and `effectiveScope`. Reset removes only the command override entry, so global scope becomes effective again.

### Runtime integration

Extend `executeCommand()` to accept `scopeOverride` in its context and resolve the effective scope before checking the handler. The handler is never called on `SCOPE_DENIED`.

The command loader/registry path will load the global command configuration and the current bot's override file once per runtime context, then pass the matching override scope into the new dispatch path. The legacy `handleCommand()` and `handleCommandPrivate()` paths will perform the same policy check immediately after command metadata is resolved and before any legacy switch branch executes. Existing `SCOPE_DENIED` result formatting remains unchanged.

### Chat access persistence and API

Create `src/dashboard/chat-policy-service.js` with `read(botId)` and `update(botId, patch)` methods. The service will:

1. Resolve the bot with `BotRegistry`; return `BOT_NOT_FOUND` for unknown IDs.
2. Resolve that bot's `WEB_CONFIG_PATH` or the existing default web-config location.
3. Read the existing JSON object, default missing `groupEnabled` and `privateEnabled` to `true`, and preserve every other key.
4. Validate only supplied fields and reject non-boolean values with `CHAT_POLICY_VALIDATION_FAILED`.
5. Persist through `ConfigStore.writeJson()` so backups and `restartRequired` are returned.

Register `GET /api/bots/:id/chat-policy` and `PUT /api/bots/:id/chat-policy` in `api-routes.js`. Both routes use the existing request ID/error envelope. Updates append an audit record containing bot ID and changed paths.

### Message gate

Keep command scope separate from chat access. In the message pipeline:

- private messages are accepted when `privateEnabled !== false`, or the sender is a global admin;
- group messages are accepted when `groupEnabled !== false`, or the sender is a global admin, bot admin, or group admin;
- disabled scopes return before normal interaction/automation work for ordinary members;
- command policy checks still run for bypassed administrators.

The group gate must be evaluated only after group admins are known. This prevents the existing early gate from incorrectly blocking group administrators.

### Dashboard UI

Create `dashboard/src/components/chat-policy-panel.jsx`. It loads and saves one bot's policy, has independent group/private toggles, exposes loading/error/saved/restart states, and accepts a compact mode for embedding.

Add `ChatAccessWorkspace` with a bot selector and the shared panel. Add the same panel to the bot workspace. Add the `chat-access` route and navigation item. Extend `CommandWorkspace` with a scope select, effective-scope display, reset behavior, and scope-aware apply-all payloads while retaining all existing command fields and raw JSON editing.

## Data Flow

```text
command.json + bot override
        -> command-policy resolver
        -> dashboard normalized view / runtime registry
        -> router or legacy command gate
        -> handler only when scope allows

dashboard chat-policy panel
        -> PUT /api/bots/:id/chat-policy
        -> ChatPolicyService
        -> BotRegistry + ConfigStore
        -> backup + audit + restartRequired
        -> bot reads policy after restart
```

## Error Handling

- Invalid scopes and malformed command overrides use the existing `400 COMMAND_VALIDATION_FAILED` contract.
- Invalid chat policy booleans use `400 CHAT_POLICY_VALIDATION_FAILED`.
- Unknown bots use `404 BOT_NOT_FOUND`.
- Missing web-config files are treated as `{ groupEnabled: true, privateEnabled: true }` for reads; updates create the file while preserving the defaulted values and supplied patch.
- File writes remain atomic through `ConfigStore`.

## Testing Strategy

- Add unit tests for resolver fallback, global scope, bot override, reset, and scope matching.
- Extend command-router tests for group/private/both, `scopeOverride`, and no handler invocation on denial.
- Extend command service/scanner tests for scope validation and normalized fields.
- Add API integration tests for chat-policy read/write, validation, bot lookup, merge preservation, backup, audit, and command scope global/per-bot.
- Add runtime regression tests for ordinary-member blocking, administrator bypass, and legacy/new command scope behavior.
- Add dashboard component/route contract tests, then run `npm test` and `npm run dashboard:build`.

## Compatibility

- Commands without `scope` continue to run in both scopes.
- Alias, permission, cooldown, active state, and all unrelated command fields are preserved.
- Existing API envelopes and `SCOPE_DENIED` response text remain compatible.
- Chat access defaults to enabled when old config files do not contain either flag.
