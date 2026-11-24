# Provider Key Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Validate the supplied provider credentials and refresh the application's local provider configuration without overwriting user-managed credentials.

**Architecture:** Use read-only or authentication-only provider requests in a transient process, classify each credential, then update only the nested application's `.env.local`. Move every discovered provider literal to environment-backed access while keeping unverified values empty.

**Tech Stack:** Node.js 20+, native `fetch`, dotenv-compatible `.env.local`, Node test runner, existing provider modules.

## Global Constraints

- Preserve all existing `.env.local` values, including `GEMINI_API_KEYS`, `OPENWEATHER_API_KEY`, `TOMORROW_API_KEY`, and `TIKTOK_COOKIE`.
- Never print, commit, or add supplied secret values to source code, tests, logs, or the design/plan documents.
- Add only credentials whose variable names are in `PROVIDER_CONFIG_KEYS` and whose validation succeeds.
- Use read-only or authentication-only requests; do not create, modify, or delete provider data.
- `TENOR_CLIENT_KEY` and `J2DOWN_DECRYPT_PASSWORD` have no current source consumer; SoundCloud, Imgur, Instagram, Zalo dirty-content, and FM_X consumers were discovered during execution.
- The source root is `C:\Users\Admin\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main`.
- This workspace has no `.git` directory, so commits are not available.

## File Map

- Modify: `.env.local` to add validated missing provider values while preserving existing lines.
- Modify: `src/service-debug/chat-bot/simsimi/simsimi-api.js` so SimSimi reads `process.env.SIMSIMI_API_KEY` instead of embedding a credential.
- Modify: `src/service-debug/utilities/remove-background.js` so remove.bg reads `process.env.REMOVE_BG_API_KEY` instead of embedding a credential.
- Modify: `src/service-debug/api-crawl/music/soundcloud.js`, `src/service-debug/api-crawl/music/zingmp3.js`, `src/utils/util.js`, `src/api-zalo/apis/checkImage.js`, and `src/commands/spamsms/dec.py` to read credentials from environment.
- Modify: `src/service-debug/api-crawl/config.json` to remove embedded SoundCloud/ZingMP3 credentials while retaining non-secret version metadata.
- Modify: `src/dashboard/provider-config-service.js` and `.env.example` to document the discovered environment names.
- Modify: `tests/phase-4-credentials.test.js` with regression assertions that provider consumers have no embedded credentials and read the environment.
- Create: no validation script; provider checks run in a transient process so secrets never persist to disk.
- Do not modify: `.env.example` unless the supported key inventory changes; it already documents the provider allowlist.

### Task 1: Establish the validation matrix

**Files:**
- Read: `src/dashboard/provider-config-service.js`
- Read: provider modules found through the graph/search inventory
- Read: `.env.local`

**Interfaces:**
- Consumes: the supplied key names and current local configuration.
- Produces: an in-memory matrix of key name, provider endpoint, expected success status, and classification.

- [ ] **Step 1: Confirm supported names and current values without printing values**

  Verify names against `PROVIDER_CONFIG_KEYS`. Treat current `.env.local` names as protected and do not replace them with source-list values.

- [ ] **Step 2: Confirm endpoint/auth contracts from the existing source**

  Use the provider modules and their existing request shapes where available. Do not invent configuration names for unsupported legacy services.

### Task 2: Validate supplied credentials

**Files:**
- Create no files; run a transient Node process only.

**Interfaces:**
- Consumes: supplied credentials held in process memory.
- Produces: a redacted classification table containing only variable names and status/reason codes.

- [ ] **Step 1: Validate authentication-only/read-only providers**

  Use these checks, with a timeout and no response-body logging:

  - Gemini: `GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>`; success requires HTTP 2xx.
  - SimSimi: use the source's existing talk request with a harmless short prompt and `x-api-key`; success requires an authenticated provider response.
  - WeatherAPI: source forecast endpoint with a fixed public coordinate; success requires HTTP 2xx and a forecast payload.
  - HoangDev: source endpoint/auth shape with a harmless public URL; classify unavailable/ambiguous responses as `uncertain` rather than guessing.
  - Spotify: `POST https://accounts.spotify.com/api/token` using HTTP Basic client credentials and `grant_type=client_credentials`; success requires HTTP 200 and an access token field.
  - Tenor: `GET https://tenor.googleapis.com/v2/search?q=cat&key=<key>&client_key=my_bot_app&limit=1`; success requires HTTP 2xx and a JSON response.
  - remove.bg: `GET https://api.remove.bg/v1.0/account` with `X-Api-Key`; success requires HTTP 2xx.
  - SoundCloud: source search endpoint with the supplied client ID; HTTP 401 classified as `dead`.
  - ZingMP3: source signing shape against chart-home; HTTP 200 with `err=0` classified as `live`.
  - Zalo dirty-content: source filter endpoint with a local repository image; HTTP 2xx classified as `live`.

- [ ] **Step 2: Mark unsupported credentials without network calls**

  Do not send requests for FM_X because its known operation can trigger SMS delivery and has no safe authentication-only endpoint. Do not send a credential validation request for Instagram app ID because it is a public request header rather than an independently authenticatable secret. `TENOR_CLIENT_KEY` and `J2DOWN_DECRYPT_PASSWORD` remain unsupported.

- [ ] **Step 3: Record only redacted results**

  Report each name as `live`, `dead`, `uncertain`, `unsupported`, or `protected-existing`; never include key prefixes, lengths, response bodies, or authorization headers.

### Task 3: Remove provider literals from source

**Files:**
- Test: `tests/phase-4-credentials.test.js`
- Modify: `src/service-debug/chat-bot/simsimi/simsimi-api.js`
- Modify: `src/service-debug/utilities/remove-background.js`

**Interfaces:**
- Consumes: `process.env.SIMSIMI_API_KEY` and `process.env.REMOVE_BG_API_KEY`.
- Produces: SimSimi and remove.bg requests whose credentials are populated at request time from the environment.

- [ ] **Step 1: Write the failing regression assertion**

  Assert that the SimSimi module contains `process.env.SIMSIMI_API_KEY` and does not contain a string-valued module-level `SIMSIMI_API_KEY` declaration. Assert the remove.bg module contains `process.env.REMOVE_BG_API_KEY` and does not contain a string-valued `apiKey` declaration. The tests remain secret-free because they check source structure rather than credential values.

- [ ] **Step 2: Run the focused credential test**

  Run: `node --test tests/phase-4-credentials.test.js`

  Expected: FAIL before the source change because SimSimi and remove.bg currently embed credentials and do not read the environment.

- [ ] **Step 3: Implement the minimal environment lookup**

  Replace the module-level SimSimi hard-coded value with `process.env.SIMSIMI_API_KEY || ""`. Replace the local remove.bg hard-coded value with `process.env.REMOVE_BG_API_KEY || ""`. Replace legacy provider literals with environment reads, keep non-secret fallback metadata only, and preserve request/response handling.

- [ ] **Step 4: Run the focused credential test again**

  Run: `node --test tests/phase-4-credentials.test.js`

  Expected: PASS, with no secret value emitted by the test runner.

### Task 4: Merge validated values into local configuration

**Files:**
- Modify: `.env.local`

**Interfaces:**
- Consumes: the Task 2 redacted result matrix and protected existing values.
- Produces: a dotenv file containing protected values plus only validated, supported missing credentials.

- [ ] **Step 1: Preserve protected existing entries**

  Leave current `.env.local` values byte-for-byte unchanged wherever possible, including unrelated settings and the TikTok cookie.

- [ ] **Step 2: Add live supported missing entries**

  Add only names in `PROVIDER_CONFIG_KEYS` classified `live`. Serialize values using the existing provider config service convention; quote values containing whitespace or shell-significant characters.

- [ ] **Step 3: Remove dead entries if present**

  Remove a provider line only when the name is classified `dead` and the line is not one of the protected existing entries. Do not add uncertain or unsupported values.

- [ ] **Step 4: Verify the resulting file without exposing values**

  Parse `.env.local`, print only sorted variable names and configured/unconfigured state, and confirm no supplied secret literal appears in source files or logs.

### Task 5: Full verification

**Files:**
- No additional files.

- [ ] **Step 1: Run provider/config tests**

  Run: `node --test tests/phase-4-credentials.test.js tests/provider-config.test.js`

  Expected: PASS.

- [ ] **Step 2: Run the complete test suite**

  Run: `npm test`

  Expected: all existing tests pass, or any unrelated pre-existing failure is reported with its test name and output summary.

- [ ] **Step 3: Confirm final scope**

  Confirm only the spec, plan, SimSimi source/test changes, and `.env.local` changed. Do not claim a key is live unless the provider check produced an authenticated success response.
