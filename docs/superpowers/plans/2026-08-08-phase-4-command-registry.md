# Phase 4 Command Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and safely dispatch all 20 Phase 4 commands while preserving legacy handler behavior and proving dependency, permission, argument, and failure contracts.

**Architecture:** Extend the existing phase registry pattern in `src/commands/command-registry.js`. Each command gets metadata plus a lazy or direct adapter that translates the common `CommandContext` into the legacy handler signature. The existing router remains the single gate for scope, permission, arguments, DB/config dependencies, timeout, and handler errors. Provider secrets are read from environment configuration at module load and never from source literals.

**Tech Stack:** Node.js ESM, `node:test`, existing command router/dispatcher, existing service-debug handlers, dotenv-backed environment configuration.

## Global Constraints

- Phase 4 contains exactly: `mybag`, `baucua`, `taixiu`, `chanle`, `keobuabao`, `vietlott655`, `tiktok`, `spotify`, `youtube`, `capcut`, `download`, `dich`, `qrbank`, `getlink`, `getvoice`, `checkip`, `checkdomain`, `cpus`, `thoitiet`, `prservice`.
- Preserve the existing `handleCommand` and `handleCommandPrivate` compatibility wrappers and legacy command behavior.
- Database-dependent commands return `DB_BLOCKED` when `dbReady` is false; missing provider configuration returns `MISSING_DEPENDENCY` with named keys.
- Tests must not call external providers, send Zalo messages, or require a live MySQL server.
- Use the existing command definition fields: `handler`, `aliases`, `scope`, `permission`, `requiresDb`, `requiredConfig`, `minArgs`, `timeoutMs`, `risk`, and legacy `type`/`countdown` metadata.

---

### Task 1: Establish the failing Phase 4 contract tests

**Files:**
- Create: `tests/phase-4-dispatch.test.js`
- Create: `tests/phase-4-contract.test.js`
- Create: `tests/phase-4-dependency.test.js`

**Interfaces:**
- Consumes: `PHASE_4_COMMANDS`, `createPhase4Registry`, `createCommandRegistryForPhases`, `dispatchCommand`, and `executeCommand`.
- Produces: executable expectations for all 20 canonical names, handler adapters, DB/config gates, scope/argument validation, and handler failure conversion.

- [x] **Step 1: Write the failing dispatch assertions**

  Assert that `PHASE_4_COMMANDS` contains the exact 20 names and that each name resolves from `createPhase4Registry` using an override handler. Assert that `createCommandRegistryForPhases` exposes all 80 commands from phases 1 through 4 without aliases colliding.

- [x] **Step 2: Write the failing contract assertions**

  For representative phase 4 definitions, assert group-only commands reject private scope, missing `minArgs` returns `MISSING_ARGUMENT`, insufficient permission returns `PERMISSION_DENIED`, and a throwing override returns `HANDLER_ERROR` through `dispatchCommand`.

- [x] **Step 3: Write the failing dependency assertions**

  Assert game commands return `DB_BLOCKED` with `dbReady: false`, Spotify/TikTok/download commands expose their required provider configuration, weather exposes `OPENWEATHER_API_KEY` or `WEATHERAPI_KEY`, and configured contexts reach the override handler without network access.

- [x] **Step 4: Run only the new tests to verify the expected RED state**

  Run: `node --test tests/phase-4-dispatch.test.js tests/phase-4-contract.test.js tests/phase-4-dependency.test.js`

  Expected: FAIL because phase 4 exports and registry entries do not exist yet.

---

### Task 2: Add the Phase 4 registry definitions and handler adapters

**Files:**
- Modify: `src/commands/command-registry.js`
- Test: `tests/phase-4-dispatch.test.js`
- Test: `tests/phase-4-contract.test.js`

**Interfaces:**
- Consumes: existing `lazy` adapter, `createCommandDefinition`, `createCommandRegistry`, and `CommandContext` fields (`api`, `message`, `groupSettings`, `aliasCommand`).
- Produces: exported `PHASE_4_COMMANDS`, `createPhase4Registry`, `phase4Registry`, and a four-phase `commandRegistry`.

- [x] **Step 1: Implement the exact command list and metadata**

  Add all 20 names in the order from the phase specification. Use group scope and `requiresDb: true` for the six database-backed commands (`mybag`, `baucua`, `taixiu`, `chanle`, `keobuabao`, `vietlott655`). Require at least one argument for provider commands whose handlers need a target, while preserving handlers that parse the full message. Require Spotify client and downloader credentials, `HOANGDEV_API_KEY` for TikTok/download, and either weather key through a provider-aware adapter/config gate.

- [x] **Step 2: Implement the exact legacy mappings**

  Map `mybag` to `handleMyBagCommand`, `baucua` to `handleBauCua`, `taixiu` to `handleTaiXiuCommand`, `chanle` to `handleChanLe`, `keobuabao` to `handleKBBCommand`, `vietlott655` to `handleVietlott655Command`, `tiktok` to `handleTikTokCommand`, `spotify` to `handleSpotifyCommand`, `youtube` to `handleYoutubeCommand`, `capcut` to `handleCapcutCommand`, `download` to the `api-hoangdev/aio-downlink.js` handler, `dich` to `translateCommand`, `qrbank` to `handleBankInfoCommand`, `getlink` to `handleGetLinkInQuote`, `getvoice` to `handleGetVoiceCommand`, `checkip` to `handleCheckipCommand`, `checkdomain` to `handleCheckdomainCommand`, `cpus` to `handleBenchmarkCommand`, `thoitiet` to `weatherCommand`, and `prservice` to `handlePRCommand`.

- [x] **Step 3: Merge Phase 4 into the aggregate registry**

  Add `createPhase4Registry(overrides)` and include its definitions in `createCommandRegistryForPhases`. Keep alias resolution longest-match and retain the existing phase 1-3 exports.

- [x] **Step 4: Run the focused tests to verify GREEN**

  Run: `node --test tests/phase-4-dispatch.test.js tests/phase-4-contract.test.js tests/phase-4-dependency.test.js`

  Expected: PASS with every canonical command resolving and all gate/error assertions green.

---

### Task 3: Remove phase 4 provider credentials from source and make dependency checks truthful

**Files:**
- Modify: `src/service-debug/api-crawl/content/weather.js`
- Create: `src/service-debug/api-crawl/content/weather-provider.js`
- Modify: `src/service-debug/api-crawl/tiktok/tiktok-service.js`
- Modify: `src/service-debug/api-crawl/spotify/spotify-downlink.js`
- Modify: `.env.example`
- Test: `tests/phase-4-credentials.test.js`
- Test: `tests/phase-4-weather.test.js`
- Test: `tests/phase-4-dependency.test.js`

**Interfaces:**
- Consumes: `process.env.OPENWEATHER_API_KEY`, `process.env.WEATHERAPI_KEY`, `process.env.TOMORROW_API_KEY`, and `process.env.HOANGDEV_API_KEY`.
- Produces: provider modules that use environment values and return the router-level missing dependency status before invocation when configuration is absent.

- [x] **Step 1: Add failing source/config assertions**

  Assert the example file documents all phase 4 provider keys and scan the active weather/TikTok source for known hardcoded credential literals or static session cookies.

- [x] **Step 2: Run the focused security test to verify RED**

  Run: `node --test tests/api-config.test.js tests/phase-4-dependency.test.js`

  Expected: FAIL on the existing weather literals and TikTok cookie/config behavior.

- [x] **Step 3: Replace literals with environment reads**

  Remove static weather keys and static TikTok cookie data. Build request headers from optional environment configuration and let provider absence be reported as `MISSING_DEPENDENCY` by the command definition rather than making an unauthenticated request.

- [x] **Step 4: Run security and Phase 4 tests to verify GREEN**

  Run: `node --test tests/api-config.test.js tests/phase-4-dependency.test.js tests/phase-4-dispatch.test.js`

  Expected: PASS with no credential literals and no external request made by tests.

---

### Task 4: Run regression and acceptance verification

**Files:**
- Modify: only files required by failing regression tests.
- Test: `tests/phase-1-dispatch.test.js`, `tests/phase-2-dispatch.test.js`, `tests/phase-3-dispatch.test.js`, all existing tests.

**Interfaces:**
- Consumes: the completed four-phase registry and existing compatibility dispatchers.
- Produces: evidence that phase 1-3 behavior remains intact and Phase 4 has a complete canonical mapping.

- [x] **Step 1: Run all command registry and dispatch tests**

  Run: `node --test tests/command-router.test.js tests/command-parser.test.js tests/command-contract.test.js tests/command-dependency.test.js tests/phase-1-dispatch.test.js tests/phase-2-dispatch.test.js tests/phase-3-dispatch.test.js tests/phase-4-dispatch.test.js tests/phase-4-contract.test.js tests/phase-4-dependency.test.js`

  Expected: PASS.

- [x] **Step 2: Run the complete project test suite**

  Run: `npm test`

  Expected: every existing test passes, with no unhandled rejection or module-load error.

- [x] **Step 3: Run syntax/import verification**

  Run: `node --check src/commands/command-registry.js; node --check src/service-debug/api-crawl/content/weather.js; node --check src/service-debug/api-crawl/tiktok/tiktok-service.js`

  Expected: no syntax errors.

- [x] **Step 4: Audit the 20-command acceptance matrix**

  Run a small Node assertion over `phase4Registry.definitions` checking canonical names, function handlers, unique aliases, and expected dependency metadata. Record the exact test counts and any environment-only limitations in the final report.
