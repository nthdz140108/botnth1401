# YouTube and TikTok Search Reply Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile YouTube HTML search, add configured TikTok keyword search, and make both result-reply workflows durable for 120 seconds with retry-safe cleanup.

**Architecture:** Keep direct-link download paths unchanged. Add `runYoutubeSearch` to the existing yt-dlp core and a `searchTikTokByKeyword` adapter to the TikTok API module; command handlers normalize provider output into their existing result model. Each platform owns a quoted-message session map keyed by the result message ID, with `threadId`, `collection`, `idle/inFlight` state, and a 120-second expiry. Valid replies transition to `inFlight`; only a fully successful send deletes the quoted result and state, while any download/upload/send/duration failure returns the session to `idle` and refreshes expiry.

**Tech Stack:** Node.js ESM, `yt-dlp-exec`, existing `axios`, Zalo message helpers, Node test runner.

## Global Constraints

- Preserve direct-link downloads, auto-download, TikTok reactions, scheduler, SoundCloud, and ZingMP3 workflows.
- YouTube search must use `ytsearch{limit}:<query>` with `dumpSingleJson`, `flatPlaylist`, and `skipDownload`.
- Search tables contain at most 10 valid videos and distinguish provider errors from a successful empty result.
- TikTok search requires `TIKTOK_SEARCH_API_URL` and `TIKTOK_SEARCH_API_KEY`; do not disable TLS or fall back to broken legacy endpoints.
- Selection is accepted only as a reply to the platform's own result table; shared selection maps and other platform behavior remain unchanged.
- Session expiry is 120 seconds and cleanup removes only idle expired sessions.
- No new dependencies.

### Task 1: Establish failing provider-contract tests

**Files:**
- Create: `tests/youtube-tiktok-search.test.js`
- Modify: `tests/provider-config.test.js` only if the existing config contract needs an assertion for the two TikTok settings.

**Interfaces:**
- Tests will import `runYoutubeSearch`, `searchTikTokByKeyword`, and exported normalization/error helpers.

- [ ] **Step 1: Add YouTube search tests** covering yt-dlp arguments, limit clamping, valid video filtering, metadata normalization, and propagation/classification of executor timeout/runtime/auth errors.
- [ ] **Step 2: Add TikTok adapter tests** covering URL encoding, `limit=10`, API key query parameter, response normalization, missing fields, timeout, malformed response, and successful empty results as distinct outcomes.
- [ ] **Step 3: Add session lifecycle tests** for both handlers: valid reply success deletes state, invalid selection retains state, wrong group is ignored, concurrent valid replies produce one send and an in-flight response, failed send/download retains collection and refreshes 120 seconds, and idle expiry removes the session.
- [ ] **Step 4: Run `node --test tests/youtube-tiktok-search.test.js` and confirm the new tests fail for missing contracts/current behavior.

### Task 2: Implement the YouTube yt-dlp search core

**Files:**
- Modify: `src/service-debug/api-crawl/youtube/youtube-core.js`

**Interfaces:**
- Produces: `runYoutubeSearch(query, limit = 10, executor = youtubedl)` returning normalized video objects or throwing a typed provider/runtime error.

- [ ] **Step 1: Build yt-dlp search options** with `dumpSingleJson: true`, `flatPlaylist: true`, `skipDownload: true`, existing runtime/auth options, and a bounded result limit.
- [ ] **Step 2: Execute `ytsearch{limit}:<query>` through the existing timeout/error wrapper without converting exceptions to `[]`.
- [ ] **Step 3: Normalize only valid YouTube video entries: valid 11-character IDs, non-empty title/url, duration when required, and no channel/playlist/live-only entries; preserve thumbnail, channel, views, and publish metadata.
- [ ] **Step 4: Export helpers needed by focused tests and retain all existing metadata/download APIs unchanged.
- [ ] **Step 5: Run the provider tests and existing YouTube core/runtime tests.

### Task 3: Replace YouTube command search and harden reply sessions

**Files:**
- Modify: `src/service-debug/api-crawl/youtube/youtube-service.js`
- Modify: `src/service-debug/api-crawl/index.js` only if the existing shared registry export must be extended.

**Interfaces:**
- Consumes: `runYoutubeSearch` from Task 2.
- Produces: YouTube command search tables capped at 10 and a quoted-message session with `idle/inFlight` lifecycle.

- [ ] **Step 1: Remove search-only `axios`/`JSDOM` parser usage and call `runYoutubeSearch` for keyword queries; leave URL parsing and quality options intact.
- [ ] **Step 2: Emit “no results” only after a successful search returns an empty collection; map provider/runtime/auth/timeout failures to the existing warning path without falsely claiming no results.
- [ ] **Step 3: Store `quotedMsgId`, `threadId`, collection, timestamp, and status in the YouTube-local map; do not use the shared cross-platform selection map for reply acceptance.
- [ ] **Step 4: Validate that replies quote this exact YouTube table and originate in the same thread; invalid replies warn and retain state.
- [ ] **Step 5: Atomically transition valid selections to `inFlight`; later replies receive the processing notice and do not duplicate work.
- [ ] **Step 6: Keep the table/state and refresh timestamp on download, duration, upload, or send failure; delete the quoted table and state only after successful video/audio send.
- [ ] **Step 7: Make the scheduled cleanup remove only idle sessions older than 120 seconds.
- [ ] **Step 8: Run all YouTube command/reply/workflow tests.

### Task 4: Add the configured TikTok search adapter and registry contract

**Files:**
- Modify: `src/service-debug/api-crawl/tiktok/tiktok-api.js`
- Modify: `src/utils/provider-config.js` or the current TikTok registry module identified by existing provider tests.

**Interfaces:**
- Produces: `searchTikTokByKeyword(query, limit = 10)` using `TIKTOK_SEARCH_API_URL` and `TIKTOK_SEARCH_API_KEY`, returning normalized `sendTikTokVideo`-compatible records.

- [ ] **Step 1: Add dependency/config resolution that reports `MISSING_DEPENDENCY` when URL or key is absent.
- [ ] **Step 2: Request `GET <URL>?keyword=<encoded>&limit=10&apikey=<key>` with the existing axios client and TLS verification intact.
- [ ] **Step 3: Validate `{ data: [] }`, reject malformed payloads and records missing ID, video URL, or cover, and normalize author/music/stat fields to the current `sendTikTokVideo` contract.
- [ ] **Step 4: Preserve legacy direct-link, reaction, related, and scheduler adapters without fallback from keyword search to HoangDev/SubHatDe endpoints.
- [ ] **Step 5: Run TikTok adapter/config/dependency tests.

### Task 5: Route TikTok keyword commands through durable reply sessions

**Files:**
- Modify: `src/service-debug/api-crawl/tiktok/tiktok-service.js`

**Interfaces:**
- Consumes: `searchTikTokByKeyword` from Task 4.
- Produces: TikTok keyword result tables and retry-safe quoted-message sessions.

- [ ] **Step 1: Use the configured adapter for keyword queries, cap the displayed collection at 10, and retain current direct-link quality behavior.
- [ ] **Step 2: Distinguish missing dependency/provider failure/malformed response from a successful empty list in user-facing warnings.
- [ ] **Step 3: Store TikTok sessions with `quotedMsgId`, `threadId`, collection, timestamp, and `idle/inFlight`; remove dependence on shared selection state for accepting replies.
- [ ] **Step 4: Require a reply to the exact TikTok table and same thread; preserve sessions for invalid selections and cross-group ignores.
- [ ] **Step 5: Guard concurrent valid replies with `inFlight`; retain and reset sessions after any send pipeline failure, refreshing the 120-second expiry.
- [ ] **Step 6: Delete the table and full session only after `sendTikTokVideo` succeeds; cleanup only idle expired sessions.
- [ ] **Step 7: Run TikTok command/reply and regression tests for reactions/scheduler/direct links.

### Task 6: Full verification and completion audit

**Files:**
- No source changes expected; update tests only if a requirement is uncovered during verification.

- [ ] **Step 1: Run focused YouTube/TikTok/provider/reply/command dependency tests.
- [ ] **Step 2: Run `npm test` from the nested project root.
- [ ] **Step 3: Inspect failures against the objective, fix only in-scope regressions, and rerun the affected tests.
- [ ] **Step 4: Audit every objective requirement against source and test evidence before claiming completion.

