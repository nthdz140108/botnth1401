# Phase 3 Command Registry Design

## Goal

Move the 20 Phase 3 commands into the existing registry and dispatcher while preserving the current handler behavior and legacy fallback for later phases.

## Scope

Phase 3 contains `lamnet`, `sticker`, `stkmeme`, `gifmeme`, `giftxt`, `editvideo`, `gifvd`, `giftext`, `stickercustom`, `phatnguoi`, `gif`, `login`, `dangky`, `logout`, `mycard`, `daily`, `nap`, `rut`, `bank`, and `nongtrai`.

The registry will preserve aliases from `assets/json-data/command.json`: `stk`, `stkc`, `phng`, `dk`, and `ntr`. Existing handlers remain the source of behavior; registry handlers are small adapters that translate `CommandContext` into each handler's current positional signature.

## Architecture

`command-registry.js` will add `PHASE_3_COMMANDS`, metadata, adapters, `createPhase3Registry`, and include that registry in `createCommandRegistryForPhases`. `command-dispatcher.js` already resolves longest matches and runs scope, permission, argument, dependency, timeout, and error guards, so no dispatcher redesign is required.

Database-backed game commands (`login`, `dangky`, `logout`, `mycard`, `daily`, `nap`, `rut`, `bank`) will declare `requiresDb`. `lamnet` will require `HOANGDEV_API_KEY`; `stkmeme` and `gifmeme` will require `TENOR_API_KEY`. `nongtrai` is local state and will not be DB-gated.

## Data Flow and Errors

The existing message wrappers pass `api`, `message`, `scope`, `permissionLevel`, `config`, and `dbReady` into `dispatchCommand`. A resolved Phase 3 command receives `args` and canonical/alias command metadata, and the existing `sendPhase1Result` path renders non-success router codes. Unknown commands still return `null`, allowing Phase 4+ legacy switches to run.

## Testing

Add Phase 3 contract tests for the exact canonical set, aliases, adapter invocation, missing arguments, DB/config gates, handler errors, and unknown-command fallback. Run the focused tests, then the full `npm test` regression suite and syntax validation.
