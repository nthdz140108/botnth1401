# QR and Search Selection Undo on Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the QR-login countdown or any keyword-search selection countdown expires without a valid response, recall the exact bot-owned QR/result message with `undoMessage`; preserve the completed PC reaction countdown behavior.

**Architecture:** Keep `src/utils/interaction-countdown.js` as the shared message-reference, reaction, and recall layer. Make every selection prompt own exactly one `openMediaSelection()` lifecycle with the state machine `open -> claimed | expired`, then make QR login use the same successful-recall contract while retaining its QR-specific abort and cleanup flow. Provider handlers only supply the sent response, incoming message context, platform state, and expiry callback; they must not create a second timer or use `deleteMessage(..., false)` as a recall substitute.

**Tech Stack:** Node.js ES modules, `node:test`, Zalo `addReaction`/`undoMessage` APIs, `lru-cache`, PowerShell on Windows.

**Spec:** `docs/superpowers/specs/2026-08-10-qr-login-expiry-design.md` and `docs/superpowers/plans/2026-08-16-youtube-tiktok-search-reply-workflow.md`, amended by the user-approved behavior and constraints recorded below on 2026-08-22.

## Global Constraints

- Work only in the nested repository `C:\Users\Admin\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main`.
- Preserve unrelated working-tree data, including `.bot.pid`, `logs/bot-stdout.log`, `.cache/`, `.env.local`, and `docs/superpowers/plans/2026-08-22-react-countdown-state-sync.md`.
- Do not change the visible PC countdown-frame behavior introduced by commit `5aeb65c`.
- Search selection timeout is exactly 60 seconds; QR-login timeout is exactly 90 seconds.
- A valid selection received before the deadline claims the session immediately; its download/upload may finish after the 60-second deadline.
- Invalid replies do not claim a selection and do not reset its original deadline.
- Only `api.undoMessage(...)` counts as recalling a bot-owned prompt; `api.deleteMessage(..., false)` is not an acceptable fallback.
- Recall failures are best-effort and observable: retry, return `false`, and log sanitized IDs without leaking message content, cookies, QR codes, API keys, or credentials.
- Keep group/direct routing correct by retaining `threadId`, `type`, `msgId`, `globalMsgId`, and `cliMsgId` from the real send response plus the original incoming-message context.
- Every test command must have a hard maximum duration of five minutes. Report timeout or partial-suite results plainly.
- Unit and mocked integration tests do not prove production behavior. Completion requires a clean bot restart, a fresh runtime fingerprint, and real Zalo smoke tests on PC and mobile.

## Behavioral Specification

```text
send QR or result prompt
  -> normalize and validate the bot-owned message reference
  -> start exactly one reaction countdown
  -> open
       -> valid reply before deadline
            -> claimed (atomic, exactly once)
            -> stop timer and clear reactions
            -> undo exact prompt once
            -> continue requested media work
       -> no valid reply at deadline
            -> expired (atomic, exactly once)
            -> stop timer and clear reactions
            -> remove provider and generic selection state
            -> undo exact prompt once
            -> ignore late replies
```

QR termination order is:

```text
stop/abort QR polling
  -> clear countdown reactions
  -> recall QR message
  -> send the single expiry warning when expired
  -> remove the local QR image
  -> release activeQrLoginSession
```

## File Structure

- `src/utils/interaction-countdown.js`: normalize sent-message responses, validate recall targets, retry recall, and own the `open -> claimed | expired` selection lifecycle.
- `src/service-debug/api-crawl/index.js`: own generic selection-map registration/claim/removal and delegate prompt lifetime to `openMediaSelection()` exactly once.
- `src/utils/qr-login-countdown.js`: own QR-specific terminal state and successful-recall idempotency.
- `src/commands/mybot/Manager/qr-login-command.js`: wire the sent QR response and original message context into the QR lifecycle and keep terminal cleanup ordering.
- `src/commands/mybot/Credentials/qr-login.js`: keep the local 90-second deadline authoritative while polling Zalo scan/confirm endpoints.
- Provider handlers listed in Tasks 4 and 5: pass the exact sent prompt response and message context; remove duplicate timers and incomplete registrations.
- `tests/interaction-countdown.test.js`, `tests/group-prompts-countdown.test.js`, `tests/qr-login-countdown.test.js`, `tests/undo-message-download-lifecycle.test.js`: behavioral and protocol-shaped regression coverage.
- `tests/search-selection-contract.test.js`: table-driven coverage that every in-scope provider registers a recallable bot-owned prompt.

---

### Task 1: Lock the Recall Contract with Failing Tests

**Files:**
- Modify: `tests/interaction-countdown.test.js:108-220,237-330,767-909`
- Modify: `tests/undo-message-download-lifecycle.test.js:12-144`

**Interfaces:**
- Consumes: existing `normalizeMessageReference(messageOrResponse, fallbackContextOrThreadId, fallbackType, fallbackUid)`, `recallBotMessage(options)`, and `openMediaSelection(options)`.
- Produces: regression expectations for distinct message IDs, exact group/direct routing, expiry recall, claim recall, and retry behavior.

- [ ] **Step 1: Add real send-response normalization cases.**

Add assertions that preserve distinct IDs instead of aliasing all IDs to `msgId`:

```js
test("normalizes attachment response without losing globalMsgId or cliMsgId", () => {
  const sent = {
    message: null,
    attachment: [{
      msgId: "local-attachment-11",
      globalMsgId: "global-attachment-22",
      cliMsgId: "client-attachment-33",
    }],
    link: null,
  };
  const context = {
    threadId: "group-selection-44",
    type: 1,
    data: { uidFrom: "requester-55" },
  };

  const ref = normalizeMessageReference(sent, context);
  assert.equal(ref.threadId, "group-selection-44");
  assert.equal(ref.type, 1);
  assert.equal(ref.data.msgId, "local-attachment-11");
  assert.equal(ref.data.globalMsgId, "global-attachment-22");
  assert.equal(ref.data.cliMsgId, "client-attachment-33");
});
```

- [ ] **Step 2: Add an expiry test that explicitly verifies prompt recall.**

Extend the existing `openMediaSelection onExpire` test with:

```js
assert.equal(api.undoCalls.length, 1);
assert.equal(api.undoCalls[0].message.threadId, "t-selection");
assert.equal(api.undoCalls[0].message.type, 1);
assert.equal(api.undoCalls[0].message.data.msgId, "prompt-2");
assert.equal(api.deleteCalls.length, 0);
```

- [ ] **Step 3: Add an expiry-versus-claim race test.**

Use the fake scheduler to start a one-second selection, start the final tick and `session.claim()` without awaiting either first, then assert exactly one terminal result and one `undoMessage` call:

```js
const expiryRun = scheduler.step();
const claimRun = session.claim(null, replyMessage);
const [, claimResult] = await Promise.all([expiryRun, claimRun]);

assert.equal(api.undoCalls.length, 1);
assert.equal(
  session.isExpired() || session.isClaimed(),
  true
);
assert.equal(session.isExpired() && session.isClaimed(), false);
assert.ok(claimResult.ok || claimResult.reason === "expired");
```

- [ ] **Step 4: Extend the protocol-shaped undo test.**

In `tests/undo-message-download-lifecycle.test.js`, pass a normalized reference with distinct `globalMsgId`, `msgId`, and `cliMsgId`, decode the request body, and assert:

```js
assert.equal(interceptedRequests[index].body.grid, "group-distinct-ids");
assert.equal(interceptedRequests[index].body.msgId, "global-distinct-200");
assert.equal(interceptedRequests[index].body.cliMsgIdUndo, "cli-distinct-300");
```

Add the corresponding direct-message case and assert `toid` is present while `grid` is absent.

- [ ] **Step 5: Run the focused tests and confirm the new distinct-ID case fails before implementation.**

Run:

```powershell
node --test --test-concurrency=1 tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js
```

Expected: the distinct `globalMsgId` assertion fails against the current normalizer; existing reaction-frame tests remain green.

- [ ] **Step 6: Commit the red tests.**

```powershell
git add tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js
git commit -m "test(countdown): cover exact prompt recall references"
```

---

### Task 2: Preserve Exact Message IDs and Harden Shared Recall

**Files:**
- Modify: `src/utils/interaction-countdown.js:17-277,397-440,443-923`
- Test: `tests/interaction-countdown.test.js`
- Test: `tests/undo-message-download-lifecycle.test.js`

**Interfaces:**
- Consumes: Task 1 tests and existing Zalo `api.undoMessage(messageRef)`.
- Produces: `normalizeMessageReference(...) -> { type, threadId, data: { msgId, globalMsgId, cliMsgId, uidFrom } }`; `recallBotMessage(...) -> Promise<boolean>`; `openMediaSelection(...)` with exactly-once terminal cleanup.

- [ ] **Step 1: Preserve a distinct `globalMsgId`.**

Add a `globalMsgIdCandidates` list next to the existing `msgIdCandidates`, then return the independently resolved value:

```js
const globalMsgIdCandidates = [
  messageOrResponse?.data?.globalMsgId,
  messageOrResponse?.globalMsgId,
  innerMsg?.data?.globalMsgId,
  innerMsg?.globalMsgId,
  attachment0?.data?.globalMsgId,
  attachment0?.globalMsgId,
  linkMsg?.data?.globalMsgId,
  linkMsg?.globalMsgId,
  messageOrResponse?.data?.quote?.globalMsgId,
  msgId,
];
const resolvedGlobalMsgId = globalMsgIdCandidates.find(
  (id) => id !== undefined && id !== null && String(id).trim() !== ""
);
const globalMsgId = resolvedGlobalMsgId !== undefined
  ? String(resolvedGlobalMsgId)
  : msgId;
```

Return `globalMsgId` instead of `globalMsgId: msgId`.

- [ ] **Step 2: Validate the complete recall route before making a request.**

Change the recall guard to reject missing thread routing as well as missing IDs:

```js
const hasType = messageRef?.type === 0 || messageRef?.type === 1;
const hasThread = Boolean(String(messageRef?.threadId || "").trim());
const hasMessageId = Boolean(
  messageRef?.data?.globalMsgId ||
  messageRef?.data?.msgId ||
  messageRef?.data?.cliMsgId
);
if (!hasThread || !hasType || !hasMessageId) {
  console.warn(`[RecallBotMessage] Skipped invalid target: threadId="${messageRef?.threadId || ""}", type=${messageRef?.type}, msgId="${messageRef?.data?.msgId || ""}", globalMsgId="${messageRef?.data?.globalMsgId || ""}", cliMsgId="${messageRef?.data?.cliMsgId || ""}"`);
  return false;
}
```

- [ ] **Step 3: Keep `recallBotMessage()` boolean and retry semantics stable.**

Retain the current three total attempts (`maxRetries = 2`) and only return `true` after `api.undoMessage(messageRef)` resolves. Do not catch the returned `false` as success in callers.

- [ ] **Step 4: Make selection terminal cleanup exactly once.**

Inside `openMediaSelection()`, add a shared terminal promise:

```js
let terminalPromise = null;

const finish = (nextStatus, replyMessage = null) => {
  if (status !== "open") {
    return Promise.resolve({ ok: false, reason: status });
  }
  status = nextStatus;
  terminalPromise ??= (async () => {
    if (normalizedKey) await completeInteractionCountdown(normalizedKey);
    else await cancelCountdown();
    await cleanupPromptMessage(replyMessage?.data?.quote || replyMessage);
    return { ok: true, reason: nextStatus };
  })();
  return terminalPromise;
};
```

Use `finish("claimed", replyMessage)` from `claim()` and `finish("expired")` from explicit cancellation. Keep natural countdown expiry from recalling twice: it already owns `deleteOnExpire: true`, so its callback changes state and removes provider state while the countdown performs the single recall.

- [ ] **Step 5: Run the focused tests.**

```powershell
node --test --test-concurrency=1 tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js
```

Expected: all tests pass, including distinct IDs, expiry recall, claim recall, and race coverage.

- [ ] **Step 6: Commit the shared contract.**

```powershell
git add src/utils/interaction-countdown.js tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js
git commit -m "fix(countdown): preserve exact ids for prompt recall"
```

---

### Task 3: Give the Generic Selection Map One Lifecycle

**Files:**
- Modify: `src/service-debug/api-crawl/index.js:20-82,83-159`
- Modify: `tests/group-prompts-countdown.test.js:19-66`

**Interfaces:**
- Consumes: `openMediaSelection(options)` and `recallBotMessage(options)` from Task 2.
- Produces: `setSelectionsMapData(idUser, data) -> Promise<SelectionRecord>`; `claimSelectionsMapData(idUser, replyMessage) -> Promise<boolean>`; `deleteSelectionsMapData(idUser) -> boolean` for pure state removal.

- [ ] **Step 1: Replace the weak selection-map test with an expiry-recall test.**

Update the fake API to implement `undoMessage`, pass an attachment-only sent response plus context, inject the fake scheduler through the registration data, run the scheduler to expiry, and assert:

```js
assert.equal(getSelectionsMapData().has("u1"), false);
assert.equal(api.undos.length, 1);
assert.equal(api.undos[0].threadId, "group-selection-1");
assert.equal(api.undos[0].type, 1);
assert.equal(api.deleted.length, 0);
```

- [ ] **Step 2: Add a test that rejects incomplete registrations.**

```js
await assert.rejects(
  setSelectionsMapData("u-missing", {
    platform: "youtube",
    collection: [{ id: "video-1" }],
  }),
  /requires api, sentMessage, and messageContext/
);
```

- [ ] **Step 3: Add a test for claiming a generic selection.**

Register the prompt, call `claimSelectionsMapData("u1", replyMessage)`, and assert the prompt is recalled once, the map entry is gone, and later scheduler ticks do not invoke expiry.

- [ ] **Step 4: Run the generic-selection tests and observe failure.**

```powershell
node --test --test-concurrency=1 tests/group-prompts-countdown.test.js
```

Expected: fail because the current API is synchronous, silently accepts missing prompt metadata, and does not expose claim lifecycle.

- [ ] **Step 5: Import and delegate to `openMediaSelection()`.**

Replace the direct `startInteractionCountdown()` ownership in `setSelectionsMapData()` with this exact contract:

```js
export async function setSelectionsMapData(idUser, data) {
  const {
    api,
    sentMessage,
    messageContext,
    platform,
    seconds = 60,
    schedule,
    cancelSchedule,
    now,
  } = data || {};
  if (!api || !sentMessage || !messageContext) {
    throw new Error(`[Selection:${platform || "unknown"}] requires api, sentMessage, and messageContext`);
  }

  const previous = selectionsMapData.get(idUser);
  if (previous?.selectionSession?.cancel) {
    await previous.selectionSession.cancel();
  }
  selectionsMapData.delete(idUser);

  const selectionSession = openMediaSelection({
    key: `selection_${idUser}`,
    api,
    prompt: sentMessage,
    messageContext,
    seconds,
    schedule,
    cancelSchedule,
    now,
    onExpire: async () => {
      if (selectionsMapData.get(idUser)?.selectionSession === selectionSession) {
        selectionsMapData.delete(idUser);
      }
      await data.onExpire?.();
    },
  });

  const record = { ...data, selectionSession };
  selectionsMapData.set(idUser, record);
  return record;
}
```

- [ ] **Step 6: Add the atomic claim function.**

```js
export async function claimSelectionsMapData(idUser, replyMessage) {
  const record = selectionsMapData.get(idUser);
  if (!record?.selectionSession?.claim) return false;
  const result = await record.selectionSession.claim(null, replyMessage);
  if (!result.ok) return false;
  if (selectionsMapData.get(idUser) === record) {
    selectionsMapData.delete(idUser);
  }
  return true;
}
```

Keep `deleteSelectionsMapData(idUser)` as pure synchronous state removal. Do not use it to claim or recall a live prompt.

- [ ] **Step 7: Update `checkReplySelectionsMapData()` to claim instead of locally deleting.**

Replace the `deleteSelectionsMapData(senderId)` plus `api.deleteMessage(msgDel, false)` block with:

```js
const claimed = await claimSelectionsMapData(senderId, message);
if (!claimed) return false;
```

Perform the platform dispatch only after `claimed === true`.

- [ ] **Step 8: Run the generic selection and shared countdown tests.**

```powershell
node --test --test-concurrency=1 tests/group-prompts-countdown.test.js tests/interaction-countdown.test.js
```

Expected: all pass; no test records a `deleteMessage(..., false)` call for bot-owned prompt cleanup.

- [ ] **Step 9: Commit the generic lifecycle.**

```powershell
git add src/service-debug/api-crawl/index.js tests/group-prompts-countdown.test.js tests/interaction-countdown.test.js
git commit -m "fix(selection): unify expiry and claim prompt recall"
```

---

### Task 4: Migrate Primary Media Search Providers

**Files:**
- Modify: `src/service-debug/api-crawl/tiktok/tiktok-service.js:516-560,578-640`
- Modify: `src/service-debug/api-crawl/youtube/youtube-service.js:364-410,427-491`
- Modify: `src/service-debug/api-crawl/capcut/capcut-service.js:138-183,195-256`
- Modify: `src/service-debug/api-crawl/api-hoangdev/aio-downlink.js:675-731`
- Modify: `src/service-debug/api-crawl/spotify/spotify-downlink.js:360-412,605-649`
- Modify: `src/service-debug/api-crawl/music/zingmp3.js:400-450,494-540`
- Modify: `src/service-debug/api-crawl/music/soundcloud.js:190-252`
- Modify: `src/service-debug/api-crawl/music/nhaccuatui.js:274-330`
- Create: `tests/search-selection-contract.test.js`

**Interfaces:**
- Consumes: Task 2 direct `openMediaSelection()` and Task 3 async `setSelectionsMapData(...)`/`claimSelectionsMapData(...)`.
- Produces: one recallable 60-second prompt lifecycle per TikTok, YouTube, CapCut, Download/AIO, Spotify, ZingMP3/ZingChart, SoundCloud, and NhacCuaTui search/selection flow.

- [ ] **Step 1: Create a table-driven provider contract test.**

Create `tests/search-selection-contract.test.js` with an explicit provider matrix:

```js
const providers = [
  ["tiktok", "src/service-debug/api-crawl/tiktok/tiktok-service.js"],
  ["youtube", "src/service-debug/api-crawl/youtube/youtube-service.js"],
  ["capcut", "src/service-debug/api-crawl/capcut/capcut-service.js"],
  ["download", "src/service-debug/api-crawl/api-hoangdev/aio-downlink.js"],
  ["spotify", "src/service-debug/api-crawl/spotify/spotify-downlink.js"],
  ["zingmp3", "src/service-debug/api-crawl/music/zingmp3.js"],
  ["soundcloud", "src/service-debug/api-crawl/music/soundcloud.js"],
  ["nhaccuatui", "src/service-debug/api-crawl/music/nhaccuatui.js"],
];
```

For each source, assert the handler stores the actual `sendMessageCompleteRequest()` result, supplies the incoming `message` as `messageContext`, and uses either direct `openMediaSelection()` or awaited `setSelectionsMapData()` exactly once. Add explicit negative assertions for CapCut and AIO so they cannot combine both lifecycle creators for the same prompt.

- [ ] **Step 2: Run the provider contract test and confirm the known failures.**

```powershell
node --test --test-concurrency=1 tests/search-selection-contract.test.js
```

Expected: CapCut/AIO fail the duplicate-lifecycle assertion; any provider missing `await` or `messageContext` fails its contract row.

- [ ] **Step 3: Keep TikTok and YouTube on their provider-specific sessions.**

Retain their existing `openMediaSelection()` calls because replies are keyed by quoted message ID in provider-specific maps. Ensure both pass:

```js
prompt: listMessage,
messageContext: message,
seconds: 60,
```

Keep `selectionSession.claim(null, message)` awaited before deleting the provider map and dispatching media. Remove calls to the unrelated generic selection map from their expiry callbacks when no generic record exists.

- [ ] **Step 4: Remove CapCut's duplicate lifecycle.**

Delete the direct `openMediaSelection()` block. Register once with:

```js
const selectionRecord = await setSelectionsMapData(senderId, {
  quotedMsgId: quotedMsgIdStr,
  collection: searchResults,
  platform: PLATFORM,
  api,
  sentMessage: searchResultMessage,
  messageContext: message,
  threadId: message.threadId,
  type: message.type,
  seconds: 60,
  onExpire: () => templateSelectionsMap.delete(quotedMsgIdStr),
});
```

Store `selectionRecord.selectionSession` in `templateSelectionsMap` and use its awaited `claim()` in `handleCapcutReply()`.

- [ ] **Step 5: Remove Download/AIO's duplicate lifecycle.**

Apply the same single-registration pattern as CapCut, preserving the AIO metadata fields `uniqueId`, `mediaType`, `title`, `duration`, and `author`. Store the returned `selectionSession` in `downloadSelectionsMap`.

- [ ] **Step 6: Await generic registration for music providers.**

For Spotify, ZingMP3/ZingChart, SoundCloud, and NhacCuaTui, change each registration to:

```js
await setSelectionsMapData(senderId, {
  ...existingProviderData,
  api,
  sentMessage: listMessageOrMusicListMessage,
  messageContext: message,
  threadId: message.threadId,
  type: message.type,
  seconds: 60,
  onExpire: existingProviderMapCleanup,
});
```

Do not use the inactive duplicate module `src/service-debug/api-crawl/music/spotify.js`; the registered command imports `src/service-debug/api-crawl/spotify/spotify-downlink.js`.

- [ ] **Step 7: Run provider, selection, and focused workflow tests.**

```powershell
node --test --test-concurrency=1 tests/search-selection-contract.test.js tests/group-prompts-countdown.test.js tests/interaction-countdown.test.js tests/youtube-service-workflow.test.js tests/tiktok-pipeline.test.js
```

Expected: all tests finish within five minutes and pass; report any pre-existing provider-network test failure separately.

- [ ] **Step 8: Commit primary provider migration.**

```powershell
git add src/service-debug/api-crawl tests/search-selection-contract.test.js tests/group-prompts-countdown.test.js tests/interaction-countdown.test.js
git commit -m "fix(search): recall expired result prompts across providers"
```

---

### Task 5: Migrate Remaining Keyword and Shared Selection Callers

**Files:**
- Modify: `src/commands/lenh-debug/hoang/xnxx.js:275-312`
- Modify: `src/service-debug/servises/clipphot.vn.js:191-207`
- Modify: `src/service-debug/servises/LOL.General.js:96-146,224-251`
- Modify: `src/service-debug/servises/LQM-General.js:108-156,246-260`
- Modify: `src/service-debug/servises/truyensex.js:53-68`
- Modify: `tests/search-selection-contract.test.js`

**Interfaces:**
- Consumes: Task 3 async selection registration.
- Produces: no remaining active `setSelectionsMapData()` callsite that silently omits `api`, the exact sent response, or the original message context.

- [ ] **Step 1: Extend the provider matrix with legacy/shared callers.**

Add `xnxx`, `clipphot`, `LOL`, `LQM`, and `truyensex` rows. Assert every callsite awaits registration and includes `api`, `sentMessage`, and `messageContext`.

- [ ] **Step 2: Run the contract test and record the expected failures.**

```powershell
node --test --test-concurrency=1 tests/search-selection-contract.test.js
```

Expected: fail because `xnxx` references the undefined `listMessage` variable and the other listed callers omit lifecycle metadata.

- [ ] **Step 3: Fix the XNXX sent-response variable.**

Replace:

```js
sentMessage: listMessage,
```

with:

```js
sentMessage: sent,
messageContext: message,
```

Await the registration.

- [ ] **Step 4: Pass complete prompt metadata from Clipphot, LOL, LQM, and Truyensex.**

For each response returned by `sendMessageCompleteRequest()`, await registration with:

```js
api,
sentMessage: response,
messageContext: message,
threadId: message.threadId,
type: message.type,
seconds: 60,
```

Keep the existing provider collection and reply-routing data unchanged.

- [ ] **Step 5: Handle LQM multi-image results deterministically.**

When `createSearchResultImage()` returns an array, recall the previous prompt by awaiting replacement before registering the next prompt. The final visible prompt becomes the only active selection. Do not leave multiple visible panels attached to one sender-keyed state record.

- [ ] **Step 6: Run the contract and reply-routing tests.**

```powershell
node --test --test-concurrency=1 tests/search-selection-contract.test.js tests/reply-workflow-access.test.js tests/group-prompts-countdown.test.js
```

Expected: all pass and no active selection registration lacks the exact bot-owned prompt response.

- [ ] **Step 7: Commit the remaining migration.**

```powershell
git add src/commands/lenh-debug/hoang/xnxx.js src/service-debug/servises tests/search-selection-contract.test.js
git commit -m "fix(selection): register recallable prompts for legacy searches"
```

---

### Task 6: Make QR Recall Retryable and Keep the Local Deadline Authoritative

**Files:**
- Modify: `src/utils/qr-login-countdown.js:39-194,267-296`
- Modify: `src/commands/mybot/Manager/qr-login-command.js:324-422,696-702`
- Modify: `src/commands/mybot/Credentials/qr-login.js:346-460,464-570`
- Modify: `tests/qr-login-countdown.test.js:121-340,376-523`

**Interfaces:**
- Consumes: Task 2 `recallBotMessage(...) -> Promise<boolean>` and existing `QR_LOGIN_TIMEOUT_MS = 90000`.
- Produces: `startQrLoginCountdown(options)` whose `expire()`, `success()`, `cancel()`, and `stop()` share a retryable, idempotent QR recall operation.

- [ ] **Step 1: Add a failing retry-after-failure QR test.**

Use an API whose `undoMessage()` fails all three internal attempts during `expire()` and then succeeds when `stop()` runs. Assert the QR is not marked recalled after the failed expiry attempt and that `stop()` retries successfully.

- [ ] **Step 2: Add a no-duplicate-after-success test.**

Expire a QR with successful undo, call `stop()` and `recallQrMessage()` again, and assert the API saw exactly one successful recall sequence.

- [ ] **Step 3: Keep the two current QR polling failures visible.**

Run:

```powershell
node --test --test-concurrency=1 tests/qr-login-countdown.test.js
```

Expected before implementation: the new retry test fails, and the existing `waitingConfirm continues past 10 attempts` plus `classifyQrScanResponse` cases remain red because production currently treats server-side `QR code expired` as immediately terminal.

- [ ] **Step 4: Replace the premature boolean with a successful-recall promise lock.**

Implement inside `startQrLoginCountdown()`:

```js
let isQrRecalled = false;
let recallPromise = null;

const recallQrMessage = async () => {
  if (isQrRecalled) return true;
  if (!api || !messageRef) return false;
  if (recallPromise) return recallPromise;

  recallPromise = (async () => {
    const recalled = await recallBotMessage({ api, message: messageRef });
    if (recalled) isQrRecalled = true;
    return recalled;
  })();

  try {
    return await recallPromise;
  } finally {
    recallPromise = null;
  }
};
```

Do not set `isQrRecalled` before the awaited result.

- [ ] **Step 5: Make QR terminal ordering explicit.**

Keep `handleExpire()` ordered as:

```js
stopTimer();
abortController.abort(QR_LOGIN_EXPIRY_REASON);
await stopReaction();
await recallQrMessage();
await onExpire?.();
await onCleanup?.();
```

Keep `success()` and `cancel()` on the same stop-reaction-then-recall ordering. In `qr-login-command.js`, retain `finally { await qrLifecycle.stop(); ... }` so a failed first recall receives the final retry opportunity.

- [ ] **Step 6: Restore the local 90-second deadline as the terminal authority.**

In `classifyQrScanResponse()`, treat `error_code -1003`/server text `QR code expired` as `waiting` while a local deadline is active. In `waitingConfirm()`, continue polling those transient server responses until `Date.now() >= expiresAt`; keep explicit user decline `-13` terminal and keep the local expiry callback authoritative.

Do not change `{ error_code: 8, data: null }`: it remains `waiting`.

- [ ] **Step 7: Run all focused QR tests.**

```powershell
node --test --test-concurrency=1 tests/qr-login-countdown.test.js tests/qr-login-expiry.test.js tests/qr-login-prefix-state.test.js
```

Expected: all pass, including the two baseline failures observed on 2026-08-22 and the new recall retry/idempotency tests.

- [ ] **Step 8: Commit QR lifecycle fixes.**

```powershell
git add src/utils/qr-login-countdown.js src/commands/mybot/Manager/qr-login-command.js src/commands/mybot/Credentials/qr-login.js tests/qr-login-countdown.test.js tests/qr-login-expiry.test.js tests/qr-login-prefix-state.test.js
git commit -m "fix(qr-login): retry prompt recall at local expiry"
```

---

### Task 7: Focused Regression, Runtime Smoke Test, and Deployment Proof

**Files:**
- Modify only if a test exposes a defect: files already listed in Tasks 2-6.
- Runtime evidence: `logs/bot-stdout.log` on the machine running the tested process.

**Interfaces:**
- Consumes: all prior task commits.
- Produces: test evidence, fresh runtime identity evidence, and real Zalo behavior evidence; no new public code interface.

- [ ] **Step 1: Run the complete focused lifecycle suite under the five-minute cap.**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/interaction-countdown.test.js tests/group-prompts-countdown.test.js tests/search-selection-contract.test.js tests/qr-login-countdown.test.js tests/qr-login-expiry.test.js tests/qr-login-prefix-state.test.js tests/undo-message-download-lifecycle.test.js tests/youtube-service-workflow.test.js tests/tiktok-pipeline.test.js
```

Expected: zero failures. If the command reaches 300 seconds, terminate it and report the timeout rather than claiming pass.

- [ ] **Step 2: Review the final diff for lifecycle duplication and local deletion.**

Run:

```powershell
rg -n "openMediaSelection|setSelectionsMapData|deleteMessage\(.*false|undoMessage|sentMessage|messageContext" src tests
git diff --check
git status --short
```

Expected: each prompt has one lifecycle creator; prompt cleanup uses `undoMessage`; no whitespace errors; unrelated dirty files remain untouched.

- [ ] **Step 3: Restart the actual bot cleanly and capture its identity.**

Before testing, verify:

```powershell
git rev-parse --show-toplevel
git rev-parse HEAD
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Select-Object ProcessId,CommandLine
```

Stop only the old bot process identified by its exact command line, start the intended entrypoint, and confirm a fresh `[RUNTIME FINGERPRINT]` line contains the nested root, correct entrypoint, new PID, and tested HEAD.

- [ ] **Step 4: Smoke-test QR expiry on real Zalo.**

Start QR login, do not scan it, wait the full 90 seconds, and verify in this order:

1. Countdown reactions reach zero and disappear.
2. The QR image message is recalled from the conversation.
3. The single expiry warning appears.
4. A late scan/confirm cannot write credentials.
5. The log contains `RecallBotMessage` success for the exact QR reference.

Repeat once in a group and once in direct chat; inspect both PC and mobile clients.

- [ ] **Step 5: Smoke-test every keyword-search platform without replying.**

For TikTok, YouTube, CapCut, Spotify, ZingMP3, SoundCloud, NhacCuaTui, XNXX, Clipphot, LOL, and LQM:

1. Send a keyword query that returns a result panel.
2. Record the panel's visible timestamp and platform.
3. Do not reply for 60 seconds.
4. Verify reactions clear and the exact panel is recalled.
5. Send a late reply and verify no media action begins.

Also test generic Download/AIO with a URL that yields multiple selectable variants.

- [ ] **Step 6: Smoke-test claim semantics.**

On YouTube and one generic-map provider:

1. Send a keyword query.
2. Submit an invalid selection and confirm the original countdown continues.
3. Submit a valid selection before the deadline and confirm the panel is recalled once.
4. Allow download/upload to continue beyond 60 seconds and confirm it is not cancelled by the expired wall-clock time.

- [ ] **Step 7: Record completion evidence.**

The completion report must include:

- Tested commit SHA.
- Runtime root, entrypoint, and PID from the fresh fingerprint.
- Focused-suite pass/fail count and duration.
- QR group/direct results.
- Per-platform no-reply expiry results.
- PC/mobile observation.
- Any recall error code or unverified surface.

- [ ] **Step 8: Commit any evidence-only test correction, then stop.**

If smoke testing required a source correction, return to the failing task, add a regression test, implement only that correction, rerun the focused suite, and commit it separately. Do not bundle deployment scripts, logs, `.env.local`, `.bot.pid`, `.cache/`, or generated assets.

## Acceptance Checklist

- [ ] QR is recalled with `undoMessage` when 90 seconds expire without completed login.
- [ ] Every in-scope keyword-search result prompt is recalled with `undoMessage` after 60 seconds without a valid reply.
- [ ] Each prompt owns exactly one countdown/lifecycle.
- [ ] Valid reply before deadline claims once, recalls once, and may finish work after the deadline.
- [ ] Invalid and late replies do not claim or restart a session.
- [ ] Group and direct undo requests use the correct route and exact IDs.
- [ ] Existing PC reaction countdown output remains unchanged.
- [ ] No caller treats `deleteMessage(..., false)` as successful recall.
- [ ] Focused tests pass inside the five-minute cap.
- [ ] Real Zalo PC/mobile smoke tests pass on the fingerprinted runtime process.

