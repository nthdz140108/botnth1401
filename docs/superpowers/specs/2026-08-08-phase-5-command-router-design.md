# Phase 5 Command Router Design

## Goal

Complete registry-based dispatch for the 20 Phase 5 commands while preserving the existing `handleCommand` and `handleCommandPrivate` wrappers and preventing live external side effects in tests.

## Scope

Phase 5 contains exactly these canonical commands:

`spamjoin`, `xnxx`, `ketban`, `kb`, `soundcloud`, `zingmp3`, `zingchart`, `nhaccuatui`, `voice`, `truyencuoi`, `tarrot`, `poststatus`, `createqr`, `scanqr`, `scanapi`, `sendresourcesfile`, `sendsrc`, `sendresourcesvideo`, `sendresourcesimage`, `sendresourcesaudio`.

The implementation will use the existing `command-router.js`, `command-dispatcher.js`, and `command-registry.js` contracts. It will not redesign the dispatcher or execute live Zalo/API calls during tests.

## Architecture

`command-registry.js` will define Phase 5 names, metadata, and lazy adapters. Each adapter receives the common dispatcher context and invokes the existing handler with the handler's established positional arguments. `createCommandRegistryForPhases` will append a Phase 5 registry after phases 1 through 4.

The wrappers will continue to resolve and dispatch registered commands before their legacy switch statements. Commands outside the registry remain on the fallback path, so this phase does not require a broad dispatcher rewrite.

## Mapping

| Command | Handler | Scope | Required args | Configuration |
| --- | --- | --- | --- | --- |
| `spamjoin` | `handleJoinLeaveGroup` | both | 2 | none |
| `xnxx` | `handleXnxxCommand` | group | 0 | none |
| `ketban` | `ketbanCommand.execute` | group | 0 | none |
| `kb` | `ketbanTagCommand.execute` | group | 0 | none |
| `soundcloud` | `handleMusicCommand` | both | 0 | none |
| `zingmp3` | `handleZingMp3Command` | both | 0 | none |
| `zingchart` | `handleTopChartZingMp3` | both | 0 | none |
| `nhaccuatui` | `handleNhacCuaTuiCommand` | both | 0 | none |
| `voice` | `handleVoiceCommand` | both | 0 | none |
| `truyencuoi` | `handleStoryCommand` | both | 0 | none |
| `tarrot` | `handleTarrotCommand` | both | 0 | none |
| `poststatus` | `handleCommandStatusPost` | both | 0 | none |
| `createqr` | `handleCreateQRCommand` | both | 0 | none |
| `scanqr` | `handleScanQRCommand` | both | 0 | none |
| `scanapi` | `scanApi` | both | 1 | none |
| `sendresourcesfile` | `handleSendFile` | both | 1 | none |
| `sendsrc` | `shareSrc` | both | 1 | none |
| `sendresourcesvideo` | `handleSendVideo` | both | 1 | none |
| `sendresourcesimage` | `handleSendImage` | both | 1 | none |
| `sendresourcesaudio` | `handleSendAudio` | both | 1 | none |

The existing command configuration remains the runtime source of active/disabled state, while registry metadata carries canonical aliases, scope, permission, countdown, and argument contracts. `sendsrc` also accepts the legacy `sharesrc` spelling; aliases from `assets/json-data/command.json` are preserved case-insensitively.

## Safety and errors

The common router checks scope, permission, disabled state, required arguments, dependencies, timeout, and handler exceptions before returning structured result codes. Phase 5 handlers that perform network, media, Zalo, or file side effects are invoked only through injected test handlers in contract tests. `spamjoin` and `xnxx` are never live-smoked.

## Testing

`tests/phase-5-dispatch.test.js` will assert the exact 20-command list, canonical/alias resolution, all handler mappings through overrides, and aggregate count of 100 commands after phase 5. Contract tests will assert group-only denial for `xnxx`, `ketban`, and `kb`, argument validation for resource/scan commands, permission denial, and conversion of handler errors to `HANDLER_ERROR`. The full `npm test` suite, syntax validation, and mock-only smoke dispatch are required before completion.

## Acceptance

- All 20 Phase 5 commands are present exactly once in the aggregate registry.
- Every definition has a callable handler and no alias collision.
- `sendsrc` resolves to `shareSrc`; `ketban` and `kb` use their object methods.
- Scope, permission, missing-argument, and handler-error results are structured.
- No test invokes live Zalo, spam, adult-video, or external media operations.
- Existing phases 1 through 4 continue to pass their regression tests.
