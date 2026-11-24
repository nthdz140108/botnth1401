# Caro PvP Participant Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict Caro input to its two players, end games on surrender, and retain correct invitation acceptance for all challengers.

**Architecture:** Keep identity checks in `caro.js`. A participant guard precedes control parsing; surrender uses the existing final-board cleanup; invite acceptance remains tied to exact invite and opponent IDs.

**Tech Stack:** Node.js ESM, `node:test`, shared mini-game state.

## Global Constraints

- Any member may challenge exactly one other member.
- Only the challenged member's heart on the bot invitation starts a game.
- Only the two recorded players may make moves, cancel, or surrender.
- `dauhang`, `dau hang`, and accented equivalents forfeit immediately.

---

### Task 1: Restrict active-game input

**Files:**
- Modify: `tests/caro-game.test.js`
- Modify: `src/service-debug/game-service/mini-game/caro.js`

**Interfaces:** `handleCaroMessage(api, message)` returns `false` without a reply for non-player senders.

- [ ] **Step 1: Write the failing test**

```js
test("Caro ignores numeric moves from people outside the game", async () => {
  const beforeCount = api.messages.length;
  assert.equal(await handleCaroMessage(api, createMessage("thread-a", "121", "mallory", "Mallory")), false);
  assert.equal(api.messages.length, beforeCount);
  assert.equal(getCaroGames().get("thread-a").game.moves, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run `node --test --test-concurrency=1 tests/caro-game.test.js`. Expected: FAIL because the current handler replies that it is not Mallory's turn.

- [ ] **Step 3: Write minimal implementation**

```js
const uid = String(message?.data?.uidFrom ?? "");
const isPlayer = Object.values(game.players).some((player) => player.uid === uid);
if (!isPlayer) return false;
```

Place the guard before control-word and number parsing, and reuse `uid` for turn validation.

- [ ] **Step 4: Run test to verify it passes**

Run `node --test --test-concurrency=1 tests/caro-game.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

Run `git add -- tests/caro-game.test.js src/service-debug/game-service/mini-game/caro.js` then `git commit -m "fix: restrict caro moves to players"`.

### Task 2: End games on surrender

**Files:**
- Modify: `tests/caro-game.test.js`
- Modify: `src/service-debug/game-service/mini-game/caro.js`

**Interfaces:** A participant surrender calls `finishGame`, awards the opponent, and clears active state.

- [ ] **Step 1: Write the failing test**

```js
test("Caro awards the opponent when a player surrenders", async () => {
  assert.equal(await handleCaroMessage(api, createMessage("thread-a", "dauhang", "alice", "Alice")), true);
  assert.equal(getCaroGames().has("thread-a"), false);
  assert.match(api.messages.at(-1).payload.msg, /Bob \(O\).*thắng ván Caro/i);
});
```

Also cover Bob sending `đầu hàng` after his turn begins.

- [ ] **Step 2: Run test to verify it fails**

Run `node --test --test-concurrency=1 tests/caro-game.test.js`. Expected: FAIL because surrender text is ignored.

- [ ] **Step 3: Write minimal implementation**

```js
function isSurrenderToken(token) {
  return String(token ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "").toLowerCase() === "dauhang";
}
```

After participant validation, determine the other symbol and call `finishGame` with an opponent-wins message.

- [ ] **Step 4: Run test to verify it passes**

Run `node --test --test-concurrency=1 tests/caro-game.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

Run `git add -- tests/caro-game.test.js src/service-debug/game-service/mini-game/caro.js` then `git commit -m "feat: end caro games on surrender"`.

### Task 3: Cover challenger-neutral reaction acceptance

**Files:**
- Modify: `tests/caro-game.test.js`
- Modify only if required: runtime reaction dispatcher that should call `handleCaroReaction`.

**Interfaces:** An invite sent by `bot-id` starts when the tagged user hearts its exact message; hearts from all other IDs remain ignored.

- [ ] **Step 1: Write the regression test**

```js
test("Caro starts when the tagged opponent hearts an invite from the bot account", async () => {
  await handleCaroCommand(api, createMessage("thread-a", "!caro @bob", "bot-id", "MyBot", [createMention("bob", 6, 4)]));
  const inviteMsgId = api.messages.at(-1).response.msgId;
  assert.equal(await handleCaroReaction(api, createReaction("thread-a", inviteMsgId, "bot-id")), false);
  assert.equal(await handleCaroReaction(api, createReaction("thread-a", inviteMsgId, "bob")), true);
  assert.equal(getCaroGames().get("thread-a").game.players.X.uid, "bot-id");
});
```

- [ ] **Step 2: Run test to establish behavior**

Run `node --test --test-concurrency=1 tests/caro-game.test.js`. Expected: PASS if reactions reach `handleCaroReaction`; otherwise trace and patch only the missing dispatcher call.

- [ ] **Step 3: Run focused test suite**

Run `node --test --test-concurrency=1 tests/caro-game.test.js`. Expected: PASS, with no automatic bot reaction added.

- [ ] **Step 4: Commit implementation if a dispatcher change was needed**

Run `git add -- tests/caro-game.test.js src` then `git commit -m "fix: route caro invite reactions consistently"`.

### Task 4: Regression verification

**Files:**
- Test: `tests/caro-game.test.js`
- Test: `tests/game-runtime-rounds.test.js`

- [ ] **Step 1: Run focused game tests**

Run `node --test --test-concurrency=1 tests/caro-game.test.js tests/game-runtime-rounds.test.js`. Expected: PASS.

- [ ] **Step 2: Run the complete suite**

Run `npm test`. Expected: PASS with no Caro test failures.

- [ ] **Step 3: Inspect final change scope**

Run `git diff --check` and `git status --short`. Expected: no whitespace errors and no changes outside Caro files, tests, and committed documentation.
