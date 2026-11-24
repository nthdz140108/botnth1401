# Reply Workflow Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make replies to non-admin multi-step commands available to any group member while preserving owner-only administrative workflows.

**Architecture:** Keep message filtering and chatbot eligibility separate from reply dispatch. Store an explicit `replyAccess: "public"` marker in public selection maps and centralize the sender check in a small helper; unmarked state remains owner-only by default.

**Tech Stack:** Node.js ES modules, `node:test`, existing Zalo message handlers.

## Global Constraints

- Public workflows are those whose command permission is `all`.
- `scangroups` and `listgroups` follow-up actions remain requester-bound because they can perform administrative actions.
- Invalid selections, expired maps, and unmatched quotes keep their current behavior.
- Do not add dependencies or change unrelated command permissions.

---

### Task 1: Add Reply Access Policy Tests

**Files:**
- Create: `src/service-debug/reply-access.js`
- Test: `tests/reply-workflow-access.test.js`

**Interfaces:**
- Produces `canContinueReply(replyData, senderId, threadId)` returning a boolean. `replyData.replyAccess === "public"` permits any sender in the stored thread; otherwise `userRequest` or `senderId` must match.

- [ ] **Step 1: Write the failing test**

```js
test("public reply state accepts a different sender", () => {
  assert.equal(canContinueReply({ replyAccess: "public", userRequest: "user-a" }, "admin"), true);
});

test("owner-only reply state rejects a different sender", () => {
  assert.equal(canContinueReply({ userRequest: "user-a" }, "admin"), false);
});

test("owner-only state accepts senderId-backed workflows for the owner", () => {
  assert.equal(canContinueReply({ senderId: "user-a" }, "user-a"), true);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/reply-workflow-access.test.js`

Expected: FAIL because `src/service-debug/reply-access.js` and the exported helper do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

```js
export function canContinueReply(replyData, senderId) {
  if (replyData?.replyAccess === "public") return true;
  return replyData?.userRequest === senderId || replyData?.senderId === senderId;
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/reply-workflow-access.test.js`

Expected: PASS.

### Task 2: Fix Group Reply Dispatch

**Files:**
- Modify: `src/automations/event-send-msg.js:324-356`
- Test: `tests/reply-workflow-access.test.js`

**Interfaces:**
- The group event handler retains `canProcessReply` from the anti-filter stage and uses it to invoke `handleOnReplyFromUser`, without using the later chatbot-only `handleChat` value as the gate.

- [ ] **Step 1: Extend the failing contract test**

```js
const eventSource = readFileSync(new URL("../src/automations/event-send-msg.js", import.meta.url), "utf8");
assert.match(eventSource, /const canProcessReply = handleChat;/);
assert.match(eventSource, /if \(canProcessReply \|\| isAdminBot\)/);
assert.doesNotMatch(eventSource, /if \(handleChat \|\| isAdminBot\) \{\s*handleChat = await handleOnReplyFromUser/);
```

- [ ] **Step 2: Run the focused test to verify the new contract fails**

Run: `node --test tests/reply-workflow-access.test.js`

Expected: FAIL because the current code gates replies with the post-command `handleChat` value.

- [ ] **Step 3: Implement the minimal dispatch change**

Capture `const canProcessReply = handleChat` immediately before `handleCommand`. After command handling, keep the existing `handleOnChatUser` gate, but invoke `handleOnReplyFromUser` when `canProcessReply || isAdminBot`. Pass that same eligibility to the action-group handler and only set `handleChat` to `true` when the reply handler reports that it handled the message.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/reply-workflow-access.test.js`

Expected: PASS.

### Task 3: Mark Public Selection Workflows

**Files:**
- Modify: `src/service-debug/api-crawl/music/soundcloud.js`
- Modify: `src/service-debug/api-crawl/music/zingmp3.js`
- Modify: `src/service-debug/api-crawl/music/nhaccuatui.js`
- Modify: `src/service-debug/api-crawl/youtube/youtube-service.js`
- Modify: `src/service-debug/api-crawl/tiktok/tiktok-service.js`
- Modify: `src/service-debug/api-crawl/api-hoangdev/aio-downlink.js`
- Modify: `src/service-debug/api-crawl/download/aio-downlink.js`
- Modify: `src/service-debug/api-crawl/spotify/spotify-downlink.js`
- Modify: `src/service-debug/api-crawl/capcut/capcut-service.js`
- Modify: `src/commands/lenh-debug/hoang/xnxx.js`
- Modify: `src/commands/bot-manager/scan-group.js`
- Modify: `src/commands/bot-manager/remote-action-group.js`
- Test: `tests/reply-workflow-access.test.js`

**Interfaces:**
- Public media/search maps include `replyAccess: "public"` and use `canContinueReply` in their reply handlers.
- Administrative maps remain unmarked and keep their existing requester checks.

- [ ] **Step 1: Extend tests for public versus administrative state**

```js
  assert.equal(canContinueReply({ replyAccess: "public", senderId: "user-a", threadId: "group-1" }, "user-b", "group-1"), true);
  assert.equal(canContinueReply({ replyAccess: "public", senderId: "user-a", threadId: "group-1" }, "user-b", "group-2"), false);
assert.equal(canContinueReply({ userRequest: "user-a" }, "user-b"), false);
```

- [ ] **Step 2: Run the focused test to verify the map contract is not yet present**

Run: `node --test tests/reply-workflow-access.test.js`

Expected: FAIL for the source contracts that require the public marker and centralized check.

- [ ] **Step 3: Add the public marker and replace public owner checks**

Add `replyAccess: "public"` and the originating `threadId` beside requester fields when each public workflow stores its selection map. Import `canContinueReply` in those modules and replace direct owner rejection with the helper. Keep the direct checks in `scan-group.js` and `remote-action-group.js`; do not mark their state public.

- [ ] **Step 4: Run focused tests and existing command tests**

Run: `node --test tests/reply-workflow-access.test.js tests/command-policy.test.js tests/command-router.test.js`

Expected: PASS with no change to admin command permissions.

### Task 4: Full Verification

**Files:**
- No additional files.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: PASS for all existing and new tests.

- [ ] **Step 2: Verify all intended public handlers are covered**

Run: `rg -n "replyAccess: \"public\"|canContinueReply|userRequest !== senderId|senderId !== senderId" src/service-debug/api-crawl src/commands`

Expected: public selection handlers use the helper; `scan-group.js` and `remote-action-group.js` retain owner-only checks.
