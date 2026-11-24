# Bot Off Group Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep group events listening while suppressing all automatic interaction when `activeBot` is false.

**Architecture:** Preserve `messagesUser` as the event listener and command entry point. Add a small pure policy helper in `src/automations/chat-access-policy.js` and consume it at the start of `handleChatBot`, where both auto-reply sending and training-side effects can be stopped without affecting `bot on/off` command dispatch.

**Tech Stack:** Node.js ES modules, `node:test`, `node:assert/strict`.

## Global Constraints

- `bot off` must not stop event listening or logging.
- `bot off` must prevent group auto-replies and learning side effects.
- `bot on/off` must remain available to the administrator.
- Private-message behavior and the separate `replyEnabled` setting must remain unchanged.

---

### Task 1: Add the regression test

**Files:**
- Modify: `tests/message-chat-policy.test.js`
- Read: `src/automations/chat-access-policy.js`

**Interfaces:**
- Consumes: `handleChatBot(api, message, threadId, groupSettings, nameGroup, isHandleCommand)`.
- Produces: Failing tests proving that only an explicitly active group is eligible for interaction.

- [ ] **Step 1: Write the failing test**

Import `isGroupBotActive` from the policy module and assert both explicit states:

```js
test("group bot interaction requires an explicitly active group", () => {
  assert.equal(isGroupBotActive({ "group-1": { activeBot: false } }, "group-1"), false);
  assert.equal(isGroupBotActive({ "group-1": { activeBot: true } }, "group-1"), true);
});
```

- [ ] **Step 2: Run the test and verify it fails for the current bug**

Run: `node --test tests/message-chat-policy.test.js`

Expected: FAIL because `isGroupBotActive` does not yet exist.

### Task 2: Add the interaction guard

**Files:**
- Modify: `src/automations/chat-access-policy.js`
- Modify: `src/service-debug/chat-bot/bot-learning/dqt-bot.js:34-36`
- Test: `tests/message-chat-policy.test.js`

**Interfaces:**
- Consumes: Existing `groupSettings` and `threadId` arguments.
- Produces: `isGroupBotActive(groupSettings, threadId)` and a `handleChatBot` guard that returns without sending or learning unless the group is active.

- [ ] **Step 1: Write the minimal implementation**

Export this helper from `src/automations/chat-access-policy.js`:

```js
export function isGroupBotActive(groupSettings, threadId) {
  return groupSettings?.[threadId]?.activeBot === true;
}
```

Import it into `dqt-bot.js` and add this immediately after the existing `isHandleCommand` guard:

```js
  if (groupSettings?.[threadId]?.activeBot !== true) return;
```

- [ ] **Step 2: Run the focused test and verify it passes**

Run: `node --test tests/message-chat-policy.test.js`

Expected: PASS with zero `sendMessage` calls.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: PASS with no new failures.

- [ ] **Step 4: Review the diff and record the changed files**

Run: `git diff -- src/automations/chat-access-policy.js src/service-debug/chat-bot/bot-learning/dqt-bot.js tests/message-chat-policy.test.js`

Expected: Only the policy helper, guard, and focused regression test are present, with no changes to listener or command routing.

- [ ] **Step 5: Commit the focused change**

Run: `git add src/automations/chat-access-policy.js src/service-debug/chat-bot/bot-learning/dqt-bot.js tests/message-chat-policy.test.js && git commit -m "fix: respect bot off for group interactions"`

Expected: A commit containing only the production guard and regression test.
