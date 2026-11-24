# Outbound Receipt IDs and Runtime Undo Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the real outbound `clientId` as `cliMsgId` in every `sendMessage()` receipt so QR and search-result expiry can call Zalo undo with the exact server `msgId` plus client message ID, and stop retrying malformed payloads.

**Architecture:** Fix the data loss at the send boundary: every internal send request carries sanitized request metadata, and the returned Zalo `{ msgId }` receipt is enriched with the request's `clientId` before reaching countdown/selection code. Tighten normalization and undo validation so missing IDs are never fabricated, make one layer own retry policy, and verify the direct/group encrypted payload plus a real Zalo self-echo correlation before declaring success.

**Tech Stack:** Node.js ES modules, `node:test`, local HTTP protocol fixtures, AES request decoding, Zalo Web endpoints, PowerShell.

**Spec:** Runtime failure evidence supplied on 2026-08-22 plus `docs/superpowers/plans/2026-08-22-qr-search-selection-undo-on-expiry.md`; current upstream reference contracts are `https://github.com/RFS-ADRENO/zca-js/blob/main/src/apis/sendMessage.ts` and `https://github.com/RFS-ADRENO/zca-js/blob/main/src/apis/undo.ts`.

## Global Constraints

- Work only in `C:\Users\Admin\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main`.
- Start from current `master` at or after `398a0aa`; verify the exact HEAD again before implementation.
- Preserve `.bot.pid`, `logs/bot-stdout.log`, `.cache/`, `.env.local`, and unrelated untracked plan files.
- Do not change the completed CLOCK reaction-frame behavior.
- Do not use `deleteMessage(..., false)` as an undo fallback.
- Do not fabricate `cliMsgId` from `msgId`; missing IDs must produce a precise diagnostic and no Zalo undo request.
- Keep outbound receipt compatibility: existing `response.message.msgId` and `response.attachment[n].msgId` remain unchanged; only additive metadata is allowed.
- Never log message content, QR contents, cookies, IMEI, secret keys, PATs, or encrypted request bodies.
- Cap every test invocation at 300 seconds.
- A mocked success is not runtime proof. Final acceptance requires direct and group Zalo smoke tests and a fresh runtime fingerprint.

## Evidence and Root Cause

Observed runtime failure:

```text
[RecallBotMessage] Attempting undo: type=0, msgId="8180842287691", cliMsgId="8180842287691"
[RecallBotMessage] Failed to undo message after 3 attempts: Loi khong xac dinh
```

Source trace:

1. `src/api-zalo/apis/sendMessage.js` creates an attachment request `params.clientId` at lines 284-294.
2. The internal `send()` function returns only `result.data`, typically `{ msgId }`, and discards request metadata.
3. `normalizeMessageReference()` falls back from a missing `cliMsgId` to `msgId` at lines 222-247.
4. `undoMessageFactory()` sends that fabricated value as `cliMsgIdUndo`.
5. Both the repository's Nqduan reference and current upstream zca-js require distinct payload fields `msgId` and `cliMsgId`; upstream uses `Date.now()` for the undo request's own `clientId`.
6. Current tests manually supply `cliMsgId` and make the fake server always return success, so 39/39 focused tests pass while the real endpoint rejects the malformed receipt.

Single hypothesis to test:

```text
The clientId used to send the bot-owned prompt is the cliMsgId required by undo.
If sendMessage preserves that outbound clientId in its returned receipt, the undo payload becomes valid.
```

The live self-echo probe in Task 5 must confirm `requestClientId === listenerMessage.cliMsgId` for the same `msgId`. If it does not, stop and use listener/cache correlation instead of pushing this hypothesis as a fix.

---

### Task 1: Reproduce the Lost Client ID at the Send Boundary

**Files:**
- Create: `tests/send-message-receipt.test.js`
- Modify: `tests/interaction-countdown.test.js:108-210`

**Interfaces:**
- Consumes: `sendMessageFactory(api)` and `normalizeMessageReference(response, context)`.
- Produces: failing tests proving that Zalo's response-only `{ msgId }` loses the outbound `clientId` and becomes a fabricated `cliMsgId`.

- [ ] **Step 1: Build a local encrypted send endpoint fixture.**

Create an HTTP server like the existing undo protocol test. It must decrypt the incoming `params`, store `clientId`, and return an encrypted Zalo response containing only:

```js
{
  error_code: 0,
  data: { msgId: "8180842287691" },
}
```

Initialize only the required `appContext` fields and use a fake `uploadAttachment()` that returns one image record.

- [ ] **Step 2: Add an attachment receipt test.**

```js
const result = await sendMessage(
  { msg: "selection caption", attachments: ["selection-result.png"] },
  "direct-thread-1",
  0
);

assert.equal(result.attachment[0].msgId, "8180842287691");
assert.equal(
  result.attachment[0].cliMsgId,
  String(interceptedSendParams.clientId)
);
assert.notEqual(result.attachment[0].cliMsgId, result.attachment[0].msgId);
```

- [ ] **Step 3: Add a text receipt test.**

Send a text-only message through the same fixture and assert `result.message.cliMsgId` equals the request `clientId` while `result.message.msgId` remains the server response ID.

- [ ] **Step 4: Add a no-fabrication normalizer test.**

```js
const ref = normalizeMessageReference(
  { attachment: [{ msgId: "server-only-1" }] },
  { threadId: "direct-1", type: 0 }
);
assert.equal(ref.data.msgId, "server-only-1");
assert.equal(ref.data.cliMsgId, "");
```

- [ ] **Step 5: Run RED.**

```powershell
node --test --test-concurrency=1 tests/send-message-receipt.test.js tests/interaction-countdown.test.js
```

Expected: receipt assertions fail because `send()` discards `clientId`; the no-fabrication assertion fails because normalization currently aliases `cliMsgId` to `msgId`.

- [ ] **Step 6: Commit red tests only.**

```powershell
git add tests/send-message-receipt.test.js tests/interaction-countdown.test.js
git commit -m "test(zalo): reproduce lost outbound client id"
```

---

### Task 2: Return an Enriched Outbound Send Receipt

**Files:**
- Modify: `src/api-zalo/apis/sendMessage.js:53-99,200-266,267-449`
- Test: `tests/send-message-receipt.test.js`

**Interfaces:**
- Consumes: Zalo send response `{ msgId }` and internal request metadata `{ clientId, threadId, type, operation }`.
- Produces: each returned message/attachment receipt as `{ ...serverData, cliMsgId, clientId }` without changing `msgId`.

- [ ] **Step 1: Carry `clientId` beside the encrypted request.**

For text requests, add metadata to `handleMessage()`'s return value:

```js
return {
  url: finalServiceUrl.toString(),
  body: new URLSearchParams({ params: encryptedParams }),
  operation: quote ? "message-with-quote" : "message",
  threadId,
  type,
  clientId: String(params.clientId),
};
```

For image/video/file attachment request descriptors, add:

```js
clientId: String(data.params.clientId),
```

For GIF descriptors, carry `String(params.clientId)` explicitly before returning the descriptor.

- [ ] **Step 2: Enrich only successful responses.**

Replace the success return in `send()` with:

```js
const responseData = result.data && typeof result.data === "object"
  ? { ...result.data }
  : {};
if (each.clientId !== undefined && each.clientId !== null) {
  const outboundClientId = String(each.clientId);
  responseData.clientId ??= outboundClientId;
  responseData.cliMsgId ??= outboundClientId;
}
return responseData;
```

Do not replace a real `cliMsgId` returned by Zalo.

- [ ] **Step 3: Align only the touched send client IDs with upstream.**

Change `handleMessage()`'s new-message request `clientId` from `Date.now() * 600` to `Date.now()`. Do not sweep unrelated API files in this task.

- [ ] **Step 4: Run GREEN for receipt tests.**

```powershell
node --test --test-concurrency=1 tests/send-message-receipt.test.js
```

Expected: text and attachment receipts retain server `msgId` plus request `cliMsgId`; direct/group request routing remains unchanged.

- [ ] **Step 5: Run send-message regression tests.**

```powershell
node --test --test-concurrency=1 tests/send-message-receipt.test.js tests/fixes.test.js tests/undo-message-download-lifecycle.test.js
```

- [ ] **Step 6: Commit the receipt fix.**

```powershell
git add src/api-zalo/apis/sendMessage.js tests/send-message-receipt.test.js
git commit -m "fix(zalo): preserve outbound client id in send receipts"
```

---

### Task 3: Reject Fabricated Undo IDs and Remove Duplicate Retry Layers

**Files:**
- Modify: `src/utils/interaction-countdown.js:222-296,416-466`
- Modify: `src/api-zalo/apis/undoMessage.js:20-71`
- Modify: `tests/interaction-countdown.test.js`
- Modify: `tests/undo-message-download-lifecycle.test.js:12-150`

**Interfaces:**
- Consumes: enriched send receipt from Task 2.
- Produces: `recallBotMessage()` sends undo only when both a server ID and a real client ID exist; `undoMessageFactory()` performs one protocol request using `clientId: Date.now()` and exposes `code/status/retryable` through `ZaloApiError`.

- [ ] **Step 1: Stop normalizer fallback from `cliMsgId` to `msgId`.**

Remove `msgId` from `cliMsgIdCandidates` and return an empty string when no real client ID exists:

```js
const cliMsgId = resolvedCliMsgId !== undefined
  ? String(resolvedCliMsgId)
  : "";
```

- [ ] **Step 2: Add strict recall validation tests.**

Add cases asserting `recallBotMessage()` returns `false` and never calls `api.undoMessage()` when:

- `cliMsgId` is empty.
- `cliMsgId` was not supplied by the response/request metadata.
- direct/group routing data is incomplete.

The diagnostic must contain `reason="missing_cli_msg_id"` without message content.

- [ ] **Step 3: Make `undoMessageFactory()` require both IDs.**

Use:

```js
const msgId = message.data?.globalMsgId ?? message.data?.msgId ?? message.globalMsgId ?? message.msgId ?? message.data?.quote?.globalMsgId ?? message.data?.quote?.msgId;
const cliMsgId = message.data?.cliMsgId ?? message.cliMsgId ?? message.data?.quote?.cliMsgId;
if (!msgId) throw new ZaloApiError("Missing msgId for undo message", "UNDO_MSG_ID_MISSING");
if (!cliMsgId) throw new ZaloApiError("Missing cliMsgId for undo message", "UNDO_CLI_MSG_ID_MISSING");
```

Do not fall back either ID to the other.

- [ ] **Step 4: Align the undo request's own `clientId`.**

Change:

```js
clientId: Date.now() * 600,
```

to:

```js
clientId: Date.now(),
```

Add protocol assertions that the decoded `clientId` lies between timestamps captured immediately before and after the call.

- [ ] **Step 5: Establish one retry owner.**

Remove the inner three-attempt loop from `undoMessageFactory()` so it performs one request and throws the exact `ZaloApiError`. Keep retry policy in `recallBotMessage()` only.

Convert a decoded Zalo application error without losing its classification:

```js
if (result.error) {
  throw new ZaloApiError(
    result.error.message,
    result.error.code,
    result.error.status,
    { retryable: result.error.retryable }
  );
}
```

Add:

```js
function isRetryableRecallError(error) {
  if (error?.retryable === true) return true;
  const status = Number(error?.status);
  return status === 408 || status === 429 || status >= 500;
}
```

Retry only retryable errors. Protocol/application failures with a concrete Zalo code stop after the first call.

- [ ] **Step 6: Improve sanitized failure evidence.**

Log `code`, `status`, `retryable`, `threadId`, `type`, `msgId`, and `cliMsgId`; do not log encrypted params or content.

- [ ] **Step 7: Run focused RED/GREEN verification.**

```powershell
node --test --test-concurrency=1 tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js tests/send-message-receipt.test.js
```

Expected: all pass, missing-ID cases issue zero HTTP requests, and protocol errors are not multiplied into nine identical requests.

- [ ] **Step 8: Commit undo validation and retry ownership.**

```powershell
git add src/utils/interaction-countdown.js src/api-zalo/apis/undoMessage.js tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js
git commit -m "fix(undo): require real client ids and classify retries"
```

---

### Task 4: Keep Prompt Identity Bot-Owned Through Selection and QR Lifecycles

**Files:**
- Modify: `src/utils/interaction-countdown.js:828-956`
- Modify: `src/utils/qr-login-countdown.js:39-297`
- Modify: `src/commands/mybot/Manager/qr-login-command.js:324-355,705-744`
- Modify: `tests/group-prompts-countdown.test.js`
- Modify: `tests/qr-login-retry-lock.test.js`

**Interfaces:**
- Consumes: enriched receipt and strict recall contract.
- Produces: selection/QR lifecycle always recalls the stored bot-owned prompt reference; a user's unquoted reply can never become the undo target.

- [ ] **Step 1: Add a selection claim identity test.**

Register a bot prompt with `{ msgId: "bot-msg", cliMsgId: "bot-cli" }`, claim using an unquoted user reply `{ msgId: "user-msg", cliMsgId: "user-cli" }`, and assert undo targets `bot-msg/bot-cli`, not the user reply.

- [ ] **Step 2: Remove unvalidated reply override.**

In `openMediaSelection.finish()`, always call `cleanupPromptMessage()` with the stored `messageRef`. A reply quote may supplement IDs only when its `globalMsgId/msgId` equals the stored prompt server ID; otherwise ignore it.

- [ ] **Step 3: Verify QR receives the enriched raw send response.**

Keep `message: qrSent` and `messageContext: message` in `startQrLoginCountdown()`. Remove any manual fallback that sets QR/prefix `cliMsgId` equal to `globalMsgId`; use the enriched send receipt's `cliMsgId`.

- [ ] **Step 4: Add QR response-only regression coverage.**

Feed QR countdown an attachment receipt produced by the Task 2 helper where server response originally contained only `msgId`; assert the undo call receives the preserved outbound `cliMsgId`.

- [ ] **Step 5: Run lifecycle tests.**

```powershell
node --test --test-concurrency=1 tests/group-prompts-countdown.test.js tests/interaction-countdown.test.js tests/qr-login-retry-lock.test.js tests/qr-login-countdown.test.js
```

- [ ] **Step 6: Commit lifecycle identity changes.**

```powershell
git add src/utils/interaction-countdown.js src/utils/qr-login-countdown.js src/commands/mybot/Manager/qr-login-command.js tests/group-prompts-countdown.test.js tests/qr-login-retry-lock.test.js tests/qr-login-countdown.test.js
git commit -m "fix(lifecycle): retain bot prompt ids through recall"
```

---

### Task 5: Prove Outbound Client ID Correlation on Real Zalo

**Files:**
- Modify only if required by the probe: `src/api-zalo/apis/sendMessage.js`, `src/utils/message-cache.js`, `src/utils/interaction-countdown.js`
- Runtime evidence: fresh `logs/bot-stdout.log`

**Interfaces:**
- Consumes: Task 2 enriched receipts and self-listener message cache.
- Produces: evidence that request `clientId` is the `cliMsgId` required for undo, or a documented fallback design if the IDs differ.

- [ ] **Step 1: Add one sanitized correlation log gated by an environment flag.**

When `ZALO_DEBUG_SEND_RECEIPT=1`, log only:

```js
console.log(
  `[SEND RECEIPT] operation=${each.operation || "request"} threadId="${each.threadId || ""}" type=${each.type} msgId="${responseData.msgId || ""}" requestClientId="${each.clientId || ""}"`
);
console.log(
  `[SELF ECHO] threadId="${data.threadId || ""}" type=${data.type} msgId="${data.data?.msgId || ""}" cliMsgId="${data.data?.cliMsgId || ""}"`
);
```

Do not enable this flag by default.

- [ ] **Step 2: Restart the exact runtime cleanly.**

Confirm root, entrypoint, PID, HEAD, and a fresh `[RUNTIME FINGERPRINT]`. Do not start a second bot process over the first.

- [ ] **Step 3: Send one disposable image-caption prompt in direct chat and one in a group.**

For each, match by `msgId` and verify:

```text
SEND RECEIPT requestClientId == SELF ECHO cliMsgId
```

- [ ] **Step 4: Apply the decision gate.**

- If equal in direct and group: continue to Task 6.
- If unequal: stop. Do not push the receipt-enrichment hypothesis. Implement a bounded resolver that waits for `getMessageCacheByMsgId(msgId)` and uses its real `cliMsgId`, then add a timeout/failure test before continuing.
- If self echo is unavailable: verify `selfListen` runtime configuration; do not invent an ID.

- [ ] **Step 5: Disable the debug flag after evidence capture.**

Keep gated diagnostic code if useful, but ensure production default is off.

---

### Task 6: End-to-End Expiry Verification and Push Gate

**Files:**
- Test files from Tasks 1-4.
- Runtime log only; do not commit runtime artifacts.

**Interfaces:**
- Consumes: confirmed correlation and all prior commits.
- Produces: automated, encrypted-payload, and real-device evidence for the exact commit to push.

- [ ] **Step 1: Run the complete focused suite under 300 seconds.**

```powershell
node --test --test-force-exit --test-concurrency=1 tests/send-message-receipt.test.js tests/interaction-countdown.test.js tests/undo-message-download-lifecycle.test.js tests/group-prompts-countdown.test.js tests/qr-login-retry-lock.test.js tests/qr-login-countdown.test.js tests/search-selection-contract.test.js tests/youtube-service-workflow.test.js tests/tiktok-pipeline.test.js
```

- [ ] **Step 2: Check source invariants.**

```powershell
rg -n "cliMsgId.*\|\|.*msgId|cliMsgId.*\?\?.*msgId|Date\.now\(\) \* 600|deleteMessage\(.*false" src/api-zalo/apis/sendMessage.js src/api-zalo/apis/undoMessage.js src/utils/interaction-countdown.js src/utils/qr-login-countdown.js
git diff --check
git status --short
```

Expected: no fallback aliases `cliMsgId` to `msgId`; no undo request uses `Date.now() * 600`; unrelated dirty runtime files remain outside commits.

- [ ] **Step 3: Real direct-chat expiry smoke test.**

Run a keyword search, do not reply for 60 seconds, and verify:

1. Countdown reactions clear.
2. The result panel disappears for both participants.
3. Log shows one successful undo with different `msgId` and `cliMsgId`.
4. A late reply does nothing.

- [ ] **Step 4: Real group expiry smoke test.**

Repeat in a group and verify the group undo endpoint route, `grid`, `visibility=0`, and `imei` behavior through sanitized protocol test evidence plus visible recall.

- [ ] **Step 5: Real QR expiry smoke test.**

Do not scan for 90 seconds. Verify QR message recall, one expiry warning, and no late credential write.

- [ ] **Step 6: Verify the exact tree before push.**

Run the focused suite again on final HEAD, record pass count/duration, verify `git diff --check`, review every commit, and confirm no secret/runtime file is staged.

- [ ] **Step 7: Push non-force to `origin/master`.**

Fetch first, require `origin/master` to be an ancestor of HEAD, then:

```powershell
git push origin HEAD:master
```

Never force-push. Verify `git ls-remote origin refs/heads/master` equals local HEAD without printing the credential-bearing remote URL.

## Acceptance Checklist

- [ ] Real send receipt retains server `msgId` plus outbound request `cliMsgId`.
- [ ] Normalization never invents `cliMsgId` from `msgId`.
- [ ] Undo payload uses exact `msgId`, `cliMsgIdUndo`, correct thread route, and `clientId: Date.now()`.
- [ ] One layer owns at most three retry attempts; non-retryable protocol errors stop immediately with code/status evidence.
- [ ] Selection claim and expiry always target the stored bot-owned prompt.
- [ ] Direct search panel disappears after 60 seconds without a reply.
- [ ] Group search panel disappears after 60 seconds without a reply.
- [ ] QR disappears after 90 seconds without successful login.
- [ ] CLOCK countdown behavior remains unchanged.
- [ ] Focused tests pass within five minutes.
- [ ] Runtime fingerprint and real PC/mobile behavior are verified for the pushed commit.
