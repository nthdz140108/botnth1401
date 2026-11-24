# Phase 5 Nong Trai And Fishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nongtrai`/`mybag` and `fishing` deterministic across reloads, with correct timers, inventory, shop/sell transactions, cooldowns, loot, exp, persistence, and cleanup.

**Architecture:** Keep the existing command surface, but move the game rules onto normalized state helpers so farm and fishing both read, mutate, and persist through the same safety rules. Farm and fishing each get explicit migration/validation paths for old saves, and timer-driven behavior becomes derived state rather than an extra source of truth. Tests will cover retry/idempotency, insufficient resources, expiry, reload/migration, cleanup, and one renderer smoke path that proves the HHH assets still render.

**Tech Stack:** Node.js ESM, `node:test`, existing Zalo bot service modules, `node-schedule` for current timers, canvas-based render helpers in `src/service-debug/game-service/*`.

## Global Constraints

- Preserve the current `nongtrai`, `mybag`, and `fishing` command names and aliases.
- Do not introduce a new persistence backend; keep file/state storage compatible with the existing game data files.
- Preserve existing HHH asset paths and render helpers unless a test proves they need a narrow fix.
- Every mutation that changes coins, inventory, exp, or farm plots must remain idempotent under retry or reload.
- Timer cleanup must happen on timeout, completion, cancellation, and reload.

---

### Task 1: Map and normalize the farm state boundary

**Files:**
- Modify: `src/service-debug/game-service/nong-trai/nong-trai.js`
- Modify: `src/service-debug/game-service/nong-trai/farm.js`
- Modify: `src/service-debug/game-service/nong-trai/shop-nongtrai.js`
- Modify: `src/service-debug/game-service/game-state-store.js`
- Test: `tests/phase-5-nongtrai-state.test.js`

**Interfaces:**
- Consumes: existing `readGameState`, `persistGameState`, `getPlayerInfo`, farm helpers, and the current `gameState` shape.
- Produces: normalized farm load/save helpers that always return `bag`, `plots`, and farm stats in a stable shape.

- [ ] **Step 1: Write the failing state-migration test**

```js
test("farm state migration fills missing bag, plots, and numeric fields without changing valid data", async () => {
  const migrated = normalizeFarmRecord({
    plots: [{ crop: null }],
    bag: null,
    coins: "12",
  });

  assert.equal(Array.isArray(migrated.plots), true);
  assert.equal(typeof migrated.bag, "object");
  assert.equal(migrated.coins, 12);
});
```

- [ ] **Step 2: Run the targeted test and confirm the current state fails**

Run: `node --test tests/phase-5-nongtrai-state.test.js`

- [ ] **Step 3: Implement the migration and normalization helpers**

```js
export function normalizeFarmRecord(record) {
  // Fill missing bag/plots/stats, coerce counts, and preserve valid values.
}
```

- [ ] **Step 4: Route all farm reads and writes through the normalized helper**

```js
const farm = normalizeFarmRecord(gameData.nongtrai[userName]);
gameData.nongtrai[userName] = farm;
```

- [ ] **Step 5: Run the migration test and the farm smoke test**

Run: `node --test tests/phase-5-nongtrai-state.test.js tests/phase-5-nongtrai-flow.test.js`

- [ ] **Step 6: Commit the farm state boundary changes**

```bash
git add src/service-debug/game-service/nong-trai/*.js tests/phase-5-nongtrai-state.test.js tests/phase-5-nongtrai-flow.test.js
git commit -m "fix: normalize nongtrai state and persistence"
```

### Task 2: Fix farm transactions, timers, and bag inventory

**Files:**
- Modify: `src/service-debug/game-service/nong-trai/farm.js`
- Modify: `src/service-debug/game-service/nong-trai/shop-nongtrai.js`
- Modify: `src/service-debug/game-service/nong-trai/cv-nongtrai.js`
- Modify: `src/service-debug/game-service/nong-trai/cv-shop.js`
- Test: `tests/phase-5-nongtrai-transactions.test.js`

**Interfaces:**
- Consumes: `normalizeFarmRecord`, `parseSlotRanges`, `drawFarm`, `drawShopCanvas`, and the current shop item tables.
- Produces: transaction-safe `gieohat`, `tuoinuoc`, `thuhoach`, `shop`, `buy`, `sell`, `xoahat`, `phacay`, and `mybag` behavior.

- [ ] **Step 1: Write the failing transaction tests**

```js
test("buying seeds fails when coins are insufficient and does not mutate inventory", async () => {
  const result = await handleBuyProduct({ coins: 0, bag: {} }, "L1", 1);
  assert.equal(result.success, false);
});

test("harvest is idempotent under retry and does not duplicate rewards", async () => {
  const first = await handleHarvestCommand(...);
  const second = await handleHarvestCommand(...);
  assert.deepEqual(second.delta, { coins: 0, bag: {} });
});
```

- [ ] **Step 2: Run the transaction tests and confirm the current behavior is unsafe**

Run: `node --test tests/phase-5-nongtrai-transactions.test.js`

- [ ] **Step 3: Implement transaction guards and one-way state commits**

```js
function commitFarmTransaction(farm, draft, logger) {
  // Validate first, then mutate bag/coins/plots once.
}
```

- [ ] **Step 4: Make timer-driven farm updates derive from stored timestamps**

```js
function updatePlotTimers(farm, now = Date.now()) {
  // Derive dryness, growth, and harvest readiness from timestamps only.
}
```

- [ ] **Step 5: Verify the renderer still uses HHH assets**

Run: `node --test tests/phase-5-nongtrai-render.test.js`

- [ ] **Step 6: Commit the farm gameplay fix**

```bash
git add src/service-debug/game-service/nong-trai/*.js tests/phase-5-nongtrai-transactions.test.js tests/phase-5-nongtrai-render.test.js
git commit -m "fix: harden nongtrai gameplay transactions"
```

### Task 3: Normalize fishing persistence and cooldown state

**Files:**
- Modify: `src/service-debug/game-service/fishing/fishing.js`
- Modify: `src/service-debug/game-service/fishing/dataManager.js`
- Modify: `src/service-debug/game-service/fishing/data/schedule.json`
- Modify: `src/service-debug/game-service/fishing/data/monster_state.json`
- Modify: `src/service-debug/game-service/fishing/data/team_data.json`
- Test: `tests/phase-5-fishing-state.test.js`

**Interfaces:**
- Consumes: `loadPlayerData`, `savePlayerData`, fishing config, and existing quest/inventory structures.
- Produces: normalized player, cooldown, monster, team, and schedule state that survives reload.

- [ ] **Step 1: Write the failing fishing-state migration test**

```js
test("fishing state migration fills missing inventory, stats, and cooldown defaults", () => {
  const migrated = normalizeFishingPlayer({
    inventory: { fish: null },
    stats: {},
  });

  assert.equal(Array.isArray(migrated.inventory.rods), true);
  assert.equal(typeof migrated.inventory.fish, "object");
  assert.equal(typeof migrated.cooldowns, "object");
});
```

- [ ] **Step 2: Run the migration test and confirm the current state is incomplete**

Run: `node --test tests/phase-5-fishing-state.test.js`

- [ ] **Step 3: Add explicit normalization for player, monster, schedule, and team records**

```js
export function normalizeFishingPlayer(player) {
  // Preserve existing catches/rewards while filling missing defaults.
}
```

- [ ] **Step 4: Make cooldown, loot, exp, and sell flow commit only after validation**

```js
function applyFishingReward(player, reward, now = Date.now()) {
  // Update inventory, exp, and coins in one validated commit.
}
```

- [ ] **Step 5: Commit the fishing persistence fix**

```bash
git add src/service-debug/game-service/fishing/*.js src/service-debug/game-service/fishing/data/*.json tests/phase-5-fishing-state.test.js
git commit -m "fix: normalize fishing persistence and cooldowns"
```

### Task 4: Add regression coverage for reload, retry, and timer cleanup

**Files:**
- Add: `tests/phase-5-farm-reload.test.js`
- Add: `tests/phase-5-fishing-reload.test.js`
- Add: `tests/phase-5-game-cleanup.test.js`
- Add: `tests/phase-5-render-smoke.test.js`

**Interfaces:**
- Consumes: normalized farm and fishing helpers plus the existing render helpers.
- Produces: regression coverage for reload, transaction retries, insufficient items/coins, and cleanup of expired timers/jobs.

- [ ] **Step 1: Write the reload and retry tests**

```js
test("reloading farm and fishing preserves committed state and does not rerun rewards", async () => {
  // seed -> persist -> reload -> replay action -> assert no double grant
});
```

- [ ] **Step 2: Write the cleanup test**

```js
test("timer cleanup clears scheduled jobs on completion and cancellation", async () => {
  // mock schedule/clear and assert no orphan timer remains
});
```

- [ ] **Step 3: Write the renderer smoke test**

```js
test("farm renderer can draw with HHH assets available on disk", async () => {
  // invoke draw helper and assert output file or buffer exists
});
```

- [ ] **Step 4: Run the full Phase 5 test bundle**

Run: `node --test tests/phase-5-*.test.js`

- [ ] **Step 5: Commit the regression coverage**

```bash
git add tests/phase-5-*.test.js
git commit -m "test: cover nongtrai and fishing regressions"
```

### Task 5: Verify package-level health and prepare the merge commit

**Files:**
- Modify: `docs/plans/nqduan-merge-plan.md` only if the phase checklist needs to be updated after validation
- Modify: any files still needed from Tasks 1-4

**Interfaces:**
- Consumes: all farm/fishing code and all Phase 5 regression tests.
- Produces: final green verification, phase checklist updates, and a merge-ready commit on `master`.

- [ ] **Step 1: Run focused game tests plus the repo test suite**

Run: `node --test tests/phase-5-*.test.js && npm test`

- [ ] **Step 2: Confirm the renderer smoke path and asset paths are clean**

Run: `node --test tests/phase-5-render-smoke.test.js`

- [ ] **Step 3: Update the Phase 5 checklist entry with the verified result**

```md
- [x] Sua gieo, tuoi, thu hoach, shop, ban hang, timer va inventory cho `nongtrai`/`mybag`.
- [x] Sua cooldown, loot table, exp, inventory, ban ca va persistence cho `fishing`.
- [x] Kiem tra migration/reload cua farm, fishing, inventory va thong ke.
- [x] Viet test cho cooldown, het thoi gian, thieu vat pham, giao dich bien, retry va cleanup timer; them render smoke test.
- [x] Commit cac thay doi va push len GitHub nhanh `master`.
```

- [ ] **Step 4: Create the final merge commit and push to `master`**

```bash
git add .
git commit -m "fix: finalize phase 5 nongtrai and fishing"
git push origin master
```

