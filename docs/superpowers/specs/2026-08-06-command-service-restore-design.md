# Command/Service Restore Design

## Goal

Restore command and service behavior from `main2` in the current `main` checkout while preserving the current Zalo API adapter, QR login, multi-bot runtime, dashboard, launcher, credentials, and operational JSON.

## Boundaries

`src/api-zalo/**`, QR/multi-bot/dashboard/runtime-context code, new tested integrations, credentials, registry files, and operational JSON are protected. Only behavior-bearing command/service functions are restored from the original where the current adapter interface remains compatible.

## Behavior

- `groupEnabled` and `privateEnabled` are outer gates; highest-level admin bypass remains intact.
- Group and private dispatchers normalize aliases to `message.commandName` before execution.
- Valid, permitted, non-cooldown commands of type `1` or `5` call `sendReactionConfirmReceive(api, message, numHandleCommand)` once.
- The helper always calls `api.addReaction("/-thanks", message)`, returns a boolean, and logs reaction failures without failing the command.
- Invalid, inactive, denied, cooldown, unsupported-type, or disabled-scope commands do not react.

## Error and assets

Existing command error boundaries remain short, chat-local, and reference-based. Hard-coded absolute asset paths are replaced with project/runtime context resolution, and temp directories are created before writes.

## Verification

Offline tests use mock APIs only. `npm run test:offline`, `node --check` for JavaScript, asset existence/decode checks, startup/import smoke, and operational-data hash comparison are required.
