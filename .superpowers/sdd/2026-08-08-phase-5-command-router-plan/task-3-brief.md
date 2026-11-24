# Task 3: Add Phase 5 contract tests

**Files:**
- Create: `tests/phase-5-contract.test.js`
- Do not modify production files.

The Phase 5 registry is implemented in `src/commands/command-registry.js`; the focused dispatch test is green. Add contract coverage using `node:test`, `node:assert/strict`, `dispatchCommand`, `createPhase5Registry`, and where needed `createCommandDefinition`/`createCommandRegistry` from `command-router.js`.

Add these behaviors:

1. Group-only commands `xnxx`, `ketban`, and `kb` return `SCOPE_DENIED` for private dispatch and never invoke their override handler.
2. Commands requiring input (`spamjoin`, `scanapi`, `sendresourcesfile`, `sendsrc`, `sendresourcesvideo`, `sendresourcesimage`, `sendresourcesaudio`) return `MISSING_ARGUMENT` when dispatched without args and do not invoke their override handler.
3. A Phase 5 handler that throws becomes `HANDLER_ERROR`, preserving the thrown message.
4. Case-insensitive aliases from the Phase 5 metadata resolve to their canonical command. At minimum test `SCL -> soundcloud`, `ZMP3 -> zingmp3`, `TOPZINGMP3 -> zingchart`, `NCT -> nhaccuatui`, `PS -> poststatus`, `QR -> createqr`, `SQR -> scanqr`, `SAPI -> scanapi`, `SHARE -> sendresourcesfile`, `SHARESRC -> sendsrc`, `SENDVIDEO -> sendresourcesvideo`, `SENDANH -> sendresourcesimage`, and `SENDVOICE -> sendresourcesaudio`. Use overrides and mock context so no lazy handler runs.
5. Phase 5 definitions have unique canonical names and unique lookup keys; aggregate registry contains 100 definitions after phases 1 through 5.
6. Exercise permission denial on the common router with a small custom definition, since all Phase 5 command metadata intentionally uses `permission: "all"` from `assets/json-data/command.json`:

```js
const restricted = createCommandRegistry([
  createCommandDefinition({ name: "phase5-permission-fixture", permission: "adminBot", handler: async () => "no" }),
]);
const result = await dispatchCommand({ commandParts: ["phase5-permission-fixture"], scope: "group", permissionLevel: "all" }, restricted);
assert.equal(result.code, "PERMISSION_DENIED");
```

Use test-only overrides. Do not invoke live Zalo, network, media, file-sharing, spam, or XNXX behavior. The existing implementation may make these tests pass immediately; this task is contract coverage, not a production change. Run:

```powershell
node --test tests/phase-5-contract.test.js
```

Then write the detailed report to `.superpowers/sdd/2026-08-08-phase-5-command-router-plan/task-3-report.md`, including command output, files changed, and any coverage concerns. No git commit is possible because the workspace has no `.git` directory.
