# Phase 2 Command Router Design

## Goal

Complete the 20 Phase 2 command registrations so each command resolves through
the centralized registry, enforces scope/permission/argument/dependency guards,
invokes the existing handler, and returns a stable result code when execution
cannot proceed.

## Scope

Phase 2 covers: `vdsexy`, `vdsex`, `vdcos`, `vdanime`, `vdboy`, `ff`,
`mail10p`, `les`, `quocgia`, `ghepdoi`, `gay`, `dam`, `info`, `object`,
`card`, `group`, `detail`, `speedtest`, `topchat`, and `rank`.

External providers are contract-tested. Missing configuration or a provider
failure must remain observable as `MISSING_DEPENDENCY` or `HANDLER_ERROR`; the
router must not fabricate a successful result or crash the dispatcher.

## Architecture

`command-registry.js` remains the single Phase 1/Phase 2 metadata and handler
adapter boundary. Phase 2 handlers are lazy imports so loading the registry does
not eagerly initialize network, image, or speed-test dependencies. The generic
dispatcher resolves the longest canonical name or alias, passes canonical
`aliasCommand` and parsed arguments to `executeCommand`, then returns the
definition and resolution details for compatibility and diagnostics.

The existing group/private wrappers keep their public signatures and legacy
fallback branches. They first attempt the registry for Phase 1 and Phase 2;
unknown commands continue into the legacy switch. Registered commands stop
after a router result, which prevents duplicate case handling.

## Handler Mapping

| Command | Adapter | Scope | Minimum args | Dependency |
| --- | --- | --- | --- | --- |
| `vdsexy` | `handleVideoCommand(api, message, "sexy")` | both | 0 | none |
| `vdsex` | `handleVideoCommand(api, message, "sex")` | both | 0 | none |
| `vdcos` | `handleVideoCommand(api, message, "cosplay")` | both | 0 | none |
| `vdanime` | `handleVideoCommand(api, message, "anime")` | both | 0 | none |
| `vdboy` | `handleVideoCommand(api, message, "boy")` | both | 0 | none |
| `ff` | `handleFfCommand(api, message)` | both | 1 | none |
| `mail10p` | `handleMail10pCommand(api, message)` | both | 0 | none |
| `les` | `handleLesCommand(api, message)` | both | 0 | none |
| `quocgia` | `handleQuocgiaCommand(api, message)` | both | 1 | none |
| `ghepdoi` | `handleGhepdoiCommand(api, message)` | group | 0 | none |
| `gay` | `handleGayCommand(api, message)` | both | 0 | none |
| `dam` | `handleDamCommand(api, message)` | both | 0 | none |
| `info` | `userInfoCommand(api, message, aliasCommand)` | both | 0 | none |
| `object` | `getObject(api, message, aliasCommand)` | both | 0 | none |
| `card` | `userBussinessCardCommand(api, message, aliasCommand)` | both | 0 | none |
| `group` | `groupInfoCommand(api, message)` | group | 0 | none |
| `detail` | `getBotDetails(api, message)` | both | 0 | none |
| `speedtest` | `handleSpeedTestCommand(api, message)` | both | 0 | `speedtest-net`/canvas runtime |
| `topchat` | `handleRankCommand(api, message)` | group | 0 | rank file |
| `rank` | `handleTopPlayers(api, message, groupSettings)` | group/private | 0 | MySQL |

`rank` is marked `requiresDb` so an unavailable database returns `DB_BLOCKED`
before `handleTopPlayers` is called. `speedtest` is lazy-loaded; if its native
or network dependency cannot load, the router converts that failure to
`HANDLER_ERROR` rather than crashing the dispatcher.

## Error and Compatibility Rules

- Canonical names and aliases are normalized to lowercase and whitespace-folded.
- Duplicate canonical/alias keys fail registry construction with
  `COMMAND_REGISTRY_COLLISION`.
- Scope, permission, minimum arguments, database readiness, required config,
  timeout, and handler exceptions are checked in that order.
- `UNKNOWN_COMMAND` returns `null` from the phase dispatcher so legacy command
  handling remains available.
- Router results are sent through the existing user-facing error helper and do
  not throw through either wrapper.

## Testing

Add Phase 2 contract coverage for all 20 canonical names and every declared
alias. Use override handlers for registry/adapter tests so no external API is
called. Assert the real router behavior for longest match, normalization,
scope, permission, missing args, `DB_BLOCKED`, missing dependency, timeout, and
handler error. Run the Phase 2 tests, then the complete `npm test` suite and a
syntax scan before claiming completion.

## Out of Scope

Provider redesign, new API credentials, database schema changes, and a full
rewrite of the 1,300-line legacy dispatcher are not required for Phase 2.
