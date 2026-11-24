# Task 1: Add the Phase 5 red test

**Files:**
- Create: `tests/phase-5-dispatch.test.js`
- Reference: `src/commands/command-registry.js`, `src/commands/command-dispatcher.js`

**Interfaces:**
- Consumes: `createPhase5Registry`, `createCommandRegistryForPhases`, `dispatchCommand`.
- Produces: executable assertions for the exact canonical list, alias resolution, and safe mock dispatch.

Write the test before any production implementation. The test must define this exact canonical list:

```js
const EXPECTED_PHASE_5_COMMANDS = [
  "spamjoin", "xnxx", "ketban", "kb", "soundcloud", "zingmp3",
  "zingchart", "nhaccuatui", "voice", "truyencuoi", "tarrot",
  "poststatus", "createqr", "scanqr", "scanapi", "sendresourcesfile",
  "sendsrc", "sendresourcesvideo", "sendresourcesimage", "sendresourcesaudio",
];
```

Add tests that:

1. Assert `PHASE_5_COMMANDS` equals the exact list and that `createPhase5Registry(overrides)` returns definitions in that order with callable handlers.
2. Dispatch each canonical command through `dispatchCommand` using an override handler and a group/adminBot/mock config context; include enough sample args to satisfy future `minArgs` metadata. Assert `HANDLED`, canonical definition name, and the override's returned command.
3. Assert `sendsrc` resolves the compatibility alias `sharesrc` with case-insensitive input, using an override handler so no real sharing occurs.

Use `node:test` and `node:assert/strict`, matching the existing phase dispatch tests. Do not modify source files or call live APIs.

Run the focused test after writing it:

```powershell
node --test tests/phase-5-dispatch.test.js
```

Expected RED result: failure because `PHASE_5_COMMANDS` and `createPhase5Registry` do not yet exist. Record the exact command and relevant failure in the report.

The workspace is `C:\Users\Admin\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main`. There is no `.git` directory, so do not claim a commit. Write the detailed report to `.superpowers/sdd/2026-08-08-phase-5-command-router-plan/task-1-report.md` using the report format from the subagent skill, including TDD RED evidence and changed files.
