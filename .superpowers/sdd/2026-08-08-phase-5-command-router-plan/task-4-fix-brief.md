# Final Review Fix: Injectable Phase 5 lazy handlers

The final review found a real bug and a test gap:

1. `src/commands/command-registry.js` currently maps `xnxx` as `handler(api, message)`, but `handleXnxxCommand` requires `(api, message, aliasCommand)`. This breaks registry dispatch for `xnxx` searches.
2. Existing Phase 5 tests override every handler, so they cannot verify lazy module paths, export names, positional arguments, or `ketban`/`kb` object execution.

Implement a small testable module-loader seam in `src/commands/command-registry.js`:

- Define a default loader equivalent to `modulePath => import(modulePath)`.
- Extend the existing `lazy` helper with an optional loader parameter while preserving current Phase 1-4 call sites.
- Export `createPhase5Handlers(loadModule = defaultLoader)`, containing the same 20 adapters. Pass the loader into each `lazy` call.
- Keep a default Phase 5 handler set for normal runtime.
- Extend `createPhase5Registry(overrides = {}, options = {})` so `options.loadModule` builds Phase 5 handlers with the injected loader; normal callers behave exactly as before.
- Fix `xnxx` adapter to call `handler(api, message, aliasCommand)`.
- Keep `ketban` and `kb` adapters calling the loaded object's `execute(api, message, groupInfo)`.
- Update the implementation plan snippet at `docs/superpowers/plans/2026-08-08-phase-5-command-router-plan.md` so its `xnxx` adapter includes `aliasCommand`.

After the seam exists, extend `tests/phase-5-contract.test.js` with a mock-loader contract test. The loader must record module paths and return a Proxy whose requested function export returns `{ exportName, args }`; for `ketbanCommand` and `ketbanTagCommand`, return an object with `execute` returning the same shape. Dispatch all 20 canonical commands through `createPhase5Registry({}, { loadModule })` with group/adminBot/mock context and sample args. Assert each result is `HANDLED`, the recorded module path and export name match the exact Phase 5 mapping, and especially `xnxx` receives `[api, message, "xnxx"]`. This must not import any real handler module or call external systems.

Also expand the alias test to cover every Phase 5 alias, including `music`, `ms3`, `zing`, `zmp3c`, `ms2`, `status`, `stt`, `qrcode`, `sendaudio`, and `sdv`.

Run:

```powershell
node --test tests/phase-5-contract.test.js tests/phase-5-dispatch.test.js
node --check src/commands/command-registry.js
```

Then run `npm test`. Write the detailed fix report to `.superpowers/sdd/2026-08-08-phase-5-command-router-plan/task-4-fix-report.md`. No git commit is possible because the workspace has no `.git` directory.
