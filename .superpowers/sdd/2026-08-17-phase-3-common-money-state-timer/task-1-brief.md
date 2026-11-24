# Task 1 Brief

Files:
- Modify: src/service-debug/game-service/game-state-store.js
- Modify: src/service-debug/game-service/game-manager.js
- Test: tests/game-state-store.test.js
- Test: tests/game-manager.test.js

Requirements:
- Add normalizeGameStateV2() that preserves existing legacy data and fills default jackpot, history, inventory, and stats shapes.
- Add createGameRuntimeState() and clearGameRuntimeState() only if needed to support the shared runtime boundary.
- Keep current game rules unchanged.
- Write tests that prove normalizeGameStateV2() fills missing fields and preserves legacy jackpot/history values.
- Use Node ESM and existing project conventions.

Current context:
- Existing helpers already include normalizeGameState(), readGameState(), and persistGameState() in src/service-debug/game-service/game-state-store.js.
- game-manager.js currently initializes and persists game data for taixiu, chanle, baucua, and vietlott655.
- There is no existing game-runtime.js yet.

Expected output:
- Implement the task directly in the workspace.
- Write a report to .superpowers/sdd/2026-08-17-phase-3-common-money-state-timer/task-1-report.md including status, commits, files changed, tests run, and any concerns.
