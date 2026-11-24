# Phase 6 Command Router Design

## Goal

Register all 20 Phase 6 commands through the existing command router, keep the
legacy group/private command wrappers compatible, and provide safe in-memory
Caro and calendar handlers without live external side effects in tests.

## Architecture

`src/commands/command-registry.js` will add the exact Phase 6 canonical list,
metadata, aliases, and lazy adapters. The aggregate registry will append Phase
6 after Phases 1 through 5. Existing `handleCommand` and
`handleCommandPrivate` signatures remain unchanged and continue to own the
fallback switch for commands that are not registered yet.

The adapters will invoke existing positional handlers with the common
`CommandContext`. New behavior is isolated in
`src/service-debug/game-service/mini-game/caro.js` and
`src/commands/lich-command.js`. The mini-game service will recognize active
Caro sessions so subsequent messages are routed by `threadId`.

## Canonical mappings

| Command | Handler | Scope | Permission | Args | Active | Aliases |
| --- | --- | --- | --- | --- | --- | --- |
| doanso | `handleGuessNumberCommand` | group | all | 1 | yes | ds |
| noitu | `handleWordChainCommand` | group | all | 0 | no | none |
| doantu | `handleWordGuessCommand` | group | all | 0 | no | none |
| caro | `handleCaroCommand` | group | all | 0 | yes | none |
| lich | `handleCalendarCommand` | both | all | 0 | yes | amlich |
| manager | `adminCommand` | group | all | 0 | yes | none |
| listmute | `handleMuteList` | group | all | 0 | yes | none |
| settinggroup | `handleSettingGroupCommand` | group | all | 0 | yes | stg, stgr |
| changelink | `handleChangeGroupLink` | group | all | 0 | yes | none |
| listadmin | `handleListAdmin` | group | adminBot | 0 | yes | none |
| add | `handleAdminHighLevelCommands` | group | all | 0 | yes | none |
| remove | `handleAdminHighLevelCommands` | group | all | 0 | yes | none |
| setcmd | `handleSetCommandActive` | both | all | 2 | yes | cmdset |
| bot | `handleActiveBotUser` | both | adminBot | 0 | yes | none |
| gameactive | `handleActiveGameUser` | group | adminBot | 0 | yes | none |
| autodownload | `handleAutoDownloadCommand` | group | all | 0 | yes | atd |
| mute | `handleMuteUser` | group | adminBot | 0 | yes | cam |
| unmute | `handleUnmuteUser` | group | adminBot | 0 | yes | sua |
| prefix | `handlePrefixCommand` | both | all | 0 | yes | none |
| sendtext | `handleAutoSendTextCommand` | group | adminBot | 0 | no | rai |

The `active` values and aliases mirror the current command configuration. The
router therefore returns `COMMAND_DISABLED` for `noitu`, `doantu`, and
`sendtext` unless an explicit registry override enables them, matching current
runtime configuration.

## Caro behavior

Each `threadId` owns at most one session in a module-level `Map`. A session is
created by `caro`, stores a bounded board, current player, and participants,
and supports `cancel` and coordinate moves. The handler validates coordinates,
rejects occupied cells, alternates turns, detects five-in-a-row in all four
directions, sends structured messages through `api.sendMessage`, and removes a
finished or cancelled session. No database or network provider is used.

The mini-game message loop will call the Caro move handler when the active game
type is `caro`, while preserving existing guess-number, word-chain, and
word-guess branches.

## Calendar behavior

`handleCalendarCommand` uses the installed `lunar-calendar` package for the
current local date. Without arguments it reports Gregorian and lunar date
details. With `month` plus an optional `YYYY-MM` value it returns a compact
month listing. Invalid dates or unsupported package ranges produce a user-safe
message and do not throw out of the dispatcher.

## Error and dependency policy

The common router remains responsible for scope, permission, active state,
minimum arguments, timeout, and handler error conversion. Phase 6 handlers are
lazy-loaded so registry creation does not initialize external API work. Tests
inject handlers for all command dispatch assertions; Caro and calendar tests
exercise local logic only.

## Verification

- `tests/phase-6-dispatch.test.js` covers the exact 20 definitions, aliases,
  aggregate count, and mock dispatch.
- `tests/phase-6-contract.test.js` covers scope, permission, disabled state,
  missing arguments, and handler errors.
- `tests/caro-game.test.js` covers isolated thread state, move validation,
  turn changes, win detection, and cancellation.
- `tests/calendar-command.test.js` covers current-date formatting and invalid
  month input without network access.
- The full `npm test`, syntax scan, and mock-only registry smoke test must pass.
