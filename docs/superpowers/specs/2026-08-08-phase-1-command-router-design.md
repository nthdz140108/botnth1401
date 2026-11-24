# Phase 1 Command Router Design

## Goal

Move the first 20 commands to a registry-driven dispatch path while preserving
the public signatures and behavior of `handleCommand` and
`handleCommandPrivate`. Commands outside Phase 1 continue through the existing
dispatcher until their own phase is migrated.

## Scope

Phase 1 contains these 20 canonical command names:

`mybot`, `help`, `game`, `command`, `simsimi`, `data`, `name`, `gemini`,
`gemini make`, `i4tiktok`, `spamsms`, `gpt`, `google`, `image`, `pinterest`,
`girl`, `boy`, `cosplay`, `anime`, and `vdgirl`.

The registry also carries the aliases already defined by
`assets/json-data/command.json`: `mebot`, `menu`, `cmd`, `sim`, `gem`, `chat`,
`gg`, `search`, `img`, `pin`, `cos`, and `vdgai`.

This phase does not migrate the dashboard scanner or command management API,
which remain compatible with the existing JSON configuration. It does not
enable new SMS/OTP behavior, require a live MySQL instance, or change the Zalo
transport.

## Architecture

### Parser

`src/commands/command-parser.js` remains the compatibility entry point and
continues to return `{ command, commandParts }`. It will normalize leading and
trailing whitespace and command case, while retaining the existing special
underscore command behavior. The router receives the normalized parts and
tries the longest registered command first, so `gemini make ...` resolves to
`gemini make` and never to `gemini`.

Aliases are normalized case-insensitively. Canonical names and aliases are
validated when the registry is built; a collision is an explicit configuration
error rather than a first-match result.

### Router

`src/commands/command-router.js` exposes:

- `CommandDefinition`, a validated metadata object containing `name`,
  `aliases`, `handler`, `scope`, `requiresDb`, `requiredConfig`, `risk`,
  `timeoutMs`, and argument requirements.
- `resolveCommand(commandParts, registry)`, which returns a canonical
  definition, normalized arguments, and the matched input, or a structured
  `UNKNOWN_COMMAND`/`AMBIGUOUS_COMMAND` result.
- `executeCommand(context, definition)`, which checks scope and dependency
  gates, invokes the handler, converts known failures to stable result codes,
  and prevents a handler exception from escaping the dispatcher.

The registry is an ordinary module export so tests can inject a small registry
without importing the Zalo runtime. Each handler is an adapter with one
consistent input: `CommandContext`. Adapters preserve the existing handler
argument order internally, including the group/private differences.

### Dispatcher integration

The existing wrapper signatures stay unchanged. After the current prefix and
message guards, each wrapper builds a context containing the API, message,
thread/group data, command parts, effective scope, permission flags, config,
and dependency providers. If the command is one of the Phase 1 registry keys,
the wrapper invokes the router and returns its result code. Otherwise it uses
the current switch path unchanged.

`prefix` remains a pre-dispatch command because it changes the parser input.
The existing countdown, group activation, admin checks, private enablement,
reaction behavior, and command JSON active flag remain in the wrapper boundary
until later phases move them into shared policy code.

## Phase 1 Handler Mapping

The registry maps these existing handlers unless a dedicated adapter is listed:

| Command | Handler or adapter | Scope | Dependency status |
| --- | --- | --- | --- |
| `mybot` | `mybotHandleCommand` | both | Zalo session |
| `help` | `helpCommand` | both | local/Zalo |
| `game` | `gameInfoCommand` | both | MySQL only for live game entries |
| `command` | `listCommands` | both | local |
| `simsimi` | `chatWithSimsimi` | group/private where currently supported | `SIMSIMI_API_KEY` |
| `data` | `handleDataCommand` | both | local/config |
| `name` | `handleRenameCommand` | both | Zalo session |
| `gemini` | `askGeminiCommand` | both | `GEMINI_API_KEYS` |
| `gemini make` | `handleGeminiMakeCommand` adapter | both | `GEMINI_API_KEYS` |
| `i4tiktok` | `handleI4tiktokCommand` | both | provider config if required |
| `spamsms` | `handleSpamSmsCommand` | both | guard/rate-limit/audit; no spam expansion |
| `gpt` | `askGPTCommand` | both | provider config if required |
| `google` | `handleGoogleCommand` | both | provider/network config if required |
| `image` | `searchImageGoogle` | both | provider/network config if required |
| `pinterest` | `searchImagePinterest` | both | provider/network config if required |
| `girl` | `sendImage` with `girl` mode | both | image provider/config |
| `boy` | `sendImage` with `boy` mode | both | image provider/config |
| `cosplay` | `sendImage` with `cosplay` mode | both | image provider/config |
| `anime` | `sendImage` with `anime` mode | both | image provider/config |
| `vdgirl` | `handleVideoCommand` with `girl` mode | both | media provider/config |

`handleGeminiMakeCommand` is a separate adapter from `askGeminiCommand`. It
must select the image-generation request path and must not silently route the
prompt to the text chat handler.

## Results and Errors

Router results use stable codes: `HANDLED`, `UNKNOWN_COMMAND`,
`AMBIGUOUS_COMMAND`, `SCOPE_DENIED`, `COMMAND_DISABLED`, `MISSING_ARGUMENT`,
`MISSING_DEPENDENCY`, `DB_BLOCKED`, `TIMEOUT`, and `HANDLER_ERROR`.

The compatibility wrappers translate these results into the existing Zalo
messages and return values. The router does not log raw credentials, API keys,
cookies, or full message content. A handler error is logged with canonical
command, scope, thread ID, and redacted error metadata, then converted to a
user-facing error without terminating the bot process.

Database-dependent definitions are present in the registry but return
`DB_BLOCKED` with a concrete setup message when the database provider is not
ready. Missing API configuration returns `MISSING_DEPENDENCY` with the exact
environment variable name, without exposing its value.

## Tests

Tests are added before implementation in these files:

- `tests/command-router.test.js`: longest-match, normalization, alias lookup,
  unknown/collision results, scope and dependency gates, timeout, and handler
  error conversion.
- `tests/command-contract.test.js`: all 20 canonical entries have a handler,
  aliases are unique, and each handler mapping is an actual exported function
  or explicit adapter.
- `tests/command-dependency.test.js`: missing API keys and unavailable MySQL
  produce `MISSING_DEPENDENCY` and `DB_BLOCKED` without calling the handler.
- `tests/api-config.test.js`: Phase 1 providers read environment/config
  values, and no credential literal is embedded in command source.

Each new behavior follows red-green-refactor: the focused test must fail for
the missing behavior before production code is added, then the focused test
and the full existing suite must pass.

## Acceptance Criteria

Phase 1 is complete when:

1. All 20 canonical commands resolve through the registry in both wrappers
   where their current scope permits.
2. `gemini make` resolves as a longest-match command and uses its dedicated
   image handler.
3. Aliases are case-insensitive and no canonical/alias collision exists.
4. Group/private permission and enablement checks remain behavior-compatible.
5. Missing configuration and database readiness return explicit status codes.
6. Handler failures are contained and do not crash the dispatcher or process.
7. `npm test`, syntax checks, and the Phase 1 contract/dependency tests pass.
8. A live smoke test is run only for commands whose dependencies are available;
   unavailable external services are reported as dependency-blocked rather than
   treated as successful execution.
