# QC validation — 2026-11-27

## Verified changes

- Focused QC, roster, catalog, Studio, permission, limiter and broker suite: 131 tests passed, 0 failed.
- Deployment catalog preview, orchestrator, receipts, lane isolation and registry suite: 17 tests passed, 0 failed.
- ESLint on changed production files and git diff --check: passed.
- Review covered transport retries/redirects, queued policy inheritance, error envelopes, media preflight, session races, timeout and checkpoint failures. Reported defects were fixed with regression tests.

## Existing failures reproduced at original HEAD

Original commit: 3f7a46967dd92daad9fd6591a7faed232b3837aa. Exported tracked source/tests with git archive into an isolated temporary directory and linked the installed node_modules. Ran the 16 test files containing unrelated failures, sequentially: 132 tests, 109 passed, 23 failed. This establishes that the failures below exist before QC changes.

- tests\anti-service\anti-zalo-regression-fixes.test.js:788:1 — 10a. anti-bot ignores standard Zalo human disappearing message TTL presets while catching short bot TTLs
- tests\auto-download-youtube.test.js:15:1 — YouTube autodownload owns its single confirmation reaction
- tests\auto-download-youtube.test.js:71:1 — TikTok autodownload reacts before requesting video data
- tests\command-dependency.test.js:6:1 — gemini returns MISSING_DEPENDENCY without invoking its handler
- tests\command-dependency.test.js:48:1 — spamjoin retains a critical-risk registry guard without provider retries
- tests\commands\commands-services-regression-fixes.test.js:213:1 — active-bot: restricts privatebot/nameserver/rs to adminLevelHigh and matches exact rs token
- tests\dashboard\runtime-status-resolver.test.js:148:1 — resolver result shape: supervisor + readiness layers present
- tests\free-form-selection-youtube-tiktok.test.js:437:1 — youtube consume enforces the 30 minute limit using duration in seconds for non-admins
- tests\free-form-selection-youtube-tiktok.test.js:543:1 — youtube consume classifies download/upload/send/unavailable/auth/runtime/timeout errors
- tests\free-form-selection-youtube-tiktok.test.js:752:1 — youtube search caption explains direct number sending without quote
- tests\latency-tracker.test.js:5:1 — latency tracker records all required phases and computes percentiles
- tests\phase-4-new-zalo-apis.test.js:217:1 — new HHH Zalo APIs surface ZaloApiError when the backend reports an error
- tests\phase-5-contract.test.js:50:1 — Phase 5 lazy handlers load the expected exports with the expected arguments
- tests\phase-5-contract.test.js:146:1 — input-required Phase 5 commands reject missing arguments without invoking overrides
- tests\phase-6-contract.test.js:28:1 — Phase 6 lazy adapters preserve existing handler exports and arguments
- tests\phase-7-contract.test.js:37:1 — Phase 7 lazy handlers load the expected exports and arguments
- tests\phase-8-contract.test.js:10:1 — Phase 8 lazy handlers load the expected exports and arguments
- tests\phase-9-contract.test.js:36:1 — Phase 9 lazy adapters preserve handler exports and argument order
- tests\reply-workflow-access.test.js:39:1 — group reply dispatch uses pre-command message eligibility
- tests\restart-supervisor-transaction.test.js:89:1 — restartSelf on child bot requests restart and exits with RESTART_EXIT_CODE=10
- tests\terminal-log.test.js:73:1 — uses ansi colors only when enabled and never when NO_COLOR or redirected
- tests\terminal-log.test.js:103:1 — allows managed listener pipes to color when the supervising terminal opted in
- tests\terminal-log.test.js:120:1 — colors event branches and labels by field tone for easier scanning

## Initial live acceptance and deployment

The user reported no test bot/group/recipient account. Live Zalo acceptance has not been performed. VPS apply is held until that acceptance; only BAT status/dry-run has been executed. BAT status confirms current VPS code at the original commit above with transaction confirmed.

## Final complete project run

`npm test`: 2,371 tests; 2,324 passed, 24 failed, 23 skipped, 0 cancelled. Duration: 858 seconds. The project suite is **not green**.

23 failures match the original-HEAD failures listed above. One additional timing-sensitive test failed: `tests/fast-vs-heavy-isolation.test.js` — `heavy tasks do not block or increase latency of fast-text and control tasks`. It requires fast/control p95 below 20 ms. Running that unchanged test alone against the final code passed (1/1). Its full-suite failure remains recorded rather than being hidden by the successful isolated rerun.

All QC tests passed in the complete run, including HTTP 503/disconnect/redirect no-retry, queued policy propagation, actual SDK media preflight, origin pipeline, stop/restart, checkpoint errors, sentinel message IDs and a 65-recipient campaign beyond 60 seconds.

## Initial BAT preview

`DAY_LEN_VPS.bat --target HEAD --dry-run` succeeded against code commit `013fd26e187b5a57b21def0a13b55ec74715882a`: base `3f7a46967dd92daad9fd6591a7faed232b3837aa`, 18 runtime files, 241410 bytes. Actions: restart Node only; no Rust/Dashboard build and no dependency installation. Shared runtime catalog changes are supplied through additive release defaults. No apply was run.

## Follow-up: silent selections from the bot's own account

The user provided a live Zalo screenshot showing the updated free-chat prompt but no response to `28 32`. Read-only VPS inspection confirmed release `92a4b6f`, an active selection checkpoint with 58 groups, and `actor_is_bot=true`. The blanket `isSelf`/own-UID rejection in QC discarded manually typed messages from the logged-in account.

The fix accepts the authorized initiator's manual self-account input and excludes program-generated echoes using outbound client/server IDs. QC notification receipts and eight native SDK send methods now record provenance; native IDs are claimed before HTTP so an early echo cannot become campaign content. Regression tests cover real GroupMessage normalization, the actual group pipeline, manual text/media in both chat scopes, and a native sticker echo arriving before its HTTP receipt.

Validation: 111 targeted QC/native SDK/outbound tests passed; 17 core session/native-echo tests also passed after sharing the receipt helper. ESLint and diff whitespace checks passed. The prior complete-suite results above remain recorded; no new complete-suite run is claimed for this narrow fix.

`DAY_LEN_VPS.bat --target HEAD --apply` deployed `3327e71c03e087556f5de2041dd910584d04fd65` from `92a4b6f` and reported `confirmed`. BAT status and the current release symlink independently matched the target; PM2 bridge/admin processes were online. A temporary isolated replay on the deployed VPS source passed selection `[28,32]` into the content stage and ignored a QC echo. It used fake APIs and sent zero advertisements. The existing conversation must be reopened with `!qc` after restart. Real recipient/media campaign acceptance remains unperformed.
