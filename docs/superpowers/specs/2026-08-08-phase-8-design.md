# Phase 8 Command Registry Design

## Goal

Complete Phase 8 of the command-router migration by registering exactly these 20 commands:

`antiall`, `antitext`, `antifile`, `antiphoto`, `antivoice`, `onlytext`, `ban`, `unban`, `tagall`, `spamgroup`, `scold`, `approve`, `learn`, `learnnow`, `unlearn`, `reply`, `autoreply`, `undo`, `todo`, `sendp`.

Every command must resolve to an exported legacy handler through the central registry, enforce its scope and permission before invocation, expose structured missing-argument and handler-error results, and preserve the existing handler behavior.

## Context

The repository already has the generic router in `src/commands/command-router.js`, the dispatcher in `src/commands/command-dispatcher.js`, and registry definitions for Phases 1-7. The aggregate registry currently contains 140 definitions and stops at `createPhase7Registry`.

The legacy dispatcher in `src/commands/command.js` is still retained for compatibility. Phase 8 adapters must call the same handler exports and arguments used by its existing switch cases. This phase does not rewrite the legacy dispatcher or unrelated command implementations.

## Architecture

Add `PHASE_8_COMMANDS`, phase metadata, `createPhase8Handlers(loadModule)`, `createPhase8Registry(overrides, options)`, and `phase8Registry` to `src/commands/command-registry.js`. The handlers use the existing `lazy(modulePath, exportName, invoke, loadModule)` adapter so contract tests can replace module loading and no live API is touched during registry tests.

Append the Phase 8 definitions in `createCommandRegistryForPhases`. The aggregate definition count becomes 160. Existing order for Phases 1-7 is unchanged.

The exact adapter mappings are:

| Command | Module | Export | Invocation |
| --- | --- | --- | --- |
| antiall | `../service-debug/anti-service/anti-all.js` | `handleAntiAll` | `api, message, groupSettings` |
| antitext | `../service-debug/anti-service/anti-text.js` | `handleAntiText` | `api, message, groupSettings` |
| antifile | `../service-debug/anti-service/anti-file.js` | `handleAntiFile` | `api, message, groupSettings` |
| antiphoto | `../service-debug/anti-service/anti-photo.js` | `handleAntiPhotoVideo` | `api, message, groupSettings` |
| antivoice | `../service-debug/anti-service/anti-voice.js` | `handleAntiVoice` | `api, message, groupSettings` |
| onlytext | `../service-debug/anti-service/anti-not-text.js` | `handleOnlyText` | `api, message, groupSettings` |
| ban | `../service-debug/game-service/index.js` | `handleBanCommand` | `api, message, groupSettings` |
| unban | `../service-debug/game-service/index.js` | `handleUnbanCommand` | `api, message, groupSettings` |
| tagall | `../service-debug/chat-zalo/chat-general/chat-all.js` | `chatAll` | `api, message, groupInfo, aliasCommand` |
| spamgroup | `./bot-manager/spamgroup.js` | `spamgroup` | `api, message` |
| scold | `../service-debug/chat-bot/scold-user/scold-user.js` | `scoldUser` | `api, message` |
| approve | `./bot-manager/welcome-bye.js` | `handleApprove` | `api, message, groupSettings` |
| learn | `../service-debug/chat-bot/bot-learning/dqt-bot.js` | `handleLearnCommand` | `api, message, groupSettings` |
| learnnow | `../service-debug/chat-bot/bot-learning/dqt-bot.js` | `handleLearnCommand` | `api, message, groupSettings` |
| unlearn | `../service-debug/chat-bot/bot-learning/dqt-bot.js` | `handleLearnCommand` | `api, message, groupSettings` |
| reply | `../service-debug/chat-bot/bot-learning/dqt-bot.js` | `handleReplyCommand` | `api, message, groupSettings` |
| autoreply | `../service-debug/api-crawl/assistant-ai/auto-reply.js` | `handleAutoReplyCommand` | `api, message, aliasCommand, groupSettings` |
| undo | `./bot-manager/utilities.js` | `handleUndoMessage` | `api, message` |
| todo | `./bot-manager/utilities.js` | `handleSendToDo` | `api, message` |
| sendp | `./bot-manager/utilities.js` | `handleSendMessagePrivate` | `api, message` |

## Metadata

All Phase 8 commands are active, type 3 except `learn`, `learnnow`, and `unlearn` which use type 2, and use countdown 1. The permission and scope contract is:

- `permission: adminBot`: all commands except `spamgroup`, `scold`, and `autoreply`.
- `scope: both`: `todo` only.
- `scope: group`: all other Phase 8 commands.
- `minArgs: 1`: `ban`, `unban`, `spamgroup`, `scold`, `unlearn`, `todo`, and `sendp`.
- `minArgs: 2`: `learnnow` because its underscore syntax requires question and answer segments.
- No generic minimum: toggle commands, `tagall`, `learn`, `reply`, `autoreply`, `undo`; these handlers support omitted arguments or use quoted/mention message data.

Aliases are case-insensitive and must not collide with canonical names or aliases from any phase. Register `vanban`, `all`, `spamgr`, `reo`, `var`, `chui`, `duyetmem`, and `un`. Do not register the legacy `sendp -> todo` alias because it collides with the `todo` canonical command and would make resolution ambiguous or incorrect.

## Handler Hardening

Only Phase 8 touched handlers may be hardened:

- Ensure `groupSettings[message.threadId]` exists before reading or writing toggle state in anti, approve, and learning handlers when the adapter is used with a fresh context.
- Replace any undefined prefix reference in syntax-error branches with the existing `getGlobalPrefix()` utility.
- Keep external API failures inside the existing handler behavior; the dispatcher catches rejected handler promises and returns `HANDLER_ERROR` without crashing the process.

No provider retry, spam expansion, database fallback, or legacy dispatcher rewrite is part of Phase 8.

## Testing and Acceptance

Add `tests/phase-8-dispatch.test.js` and `tests/phase-8-contract.test.js`.

The tests must prove:

1. Phase 8 exposes exactly 20 canonical definitions and the aggregate registry contains 160 definitions.
2. Every adapter loads the expected module/export and passes the expected argument list.
3. All aliases resolve case-insensitively; `sendp` does not create a `todo` collision.
4. Group-only commands return `SCOPE_DENIED` in private scope before their handler runs; `todo` remains available in both scopes.
5. `adminBot` commands return `PERMISSION_DENIED` for `all`; public commands do not.
6. Required-argument commands return `MISSING_ARGUMENT` without invoking their handler.
7. A rejected Phase 8 handler becomes `HANDLER_ERROR` with the original error message.
8. The phase tests use injected module loaders and mock handlers, so they do not call Zalo, MySQL, file persistence, timers, or external providers.

Verification must include the focused Phase 8 tests, the full `npm test` suite, JavaScript syntax checks for changed source files, and a mock smoke dispatch for all 20 commands with `dbReady: true`. Live Zalo credentials are not required for the contract phase.

## Non-Goals

- Rewriting `src/commands/command.js` in this phase.
- Changing Phase 1-7 metadata or handler mappings.
- Adding aliases beyond the existing command configuration.
- Enabling or expanding high-volume SMS/spam behavior.
- Introducing new dependencies or requiring a live MySQL instance.
