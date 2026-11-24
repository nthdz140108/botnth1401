# QR Login Prefix Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a new bot is created via `!mybot qrlogin`, the bot prompts the user to set a prefix for the new bot by replying to the prompt message, then saves that prefix to the new bot's command config.

**Architecture:** Add an in-memory state map `qrLoginAwaitingPrefix` keyed by `botUid` that stores the requester's UID, threadId, and the prompt message's `globalMsgId`. After qrlogin success, the prompt is sent and state is recorded. In `messagesUser`, every incoming private message is checked against this state: if the user replies to the recorded `globalMsgId`, the reply text is validated and written to `command-{botUid}.json`.

**Tech Stack:** Node.js ESM, fs/promises, existing `updatePrefix` logic in `prefix.js`, `message.data.quote.globalMsgId` for reply detection.

## Global Constraints

- Project uses ESM (`"type": "module"`).
- No new npm dependencies.
- Prefix must not contain whitespace, must not be empty.
- Timeout for awaiting prefix reply: 5 minutes (300000 ms).
- Only the requester (the user who ran `!mybot qrlogin`) may reply to set the prefix; other users' replies are ignored.
- Only affects the **newly created bot**; the default bot and existing bots are untouched.

---
### Task 1: Create the awaiting-prefix state helper

**Files:**
- Create: `src/utils/qr-login-prefix-state.js`
- Modify: none
- Test: none (no test framework configured; verify by reading the file)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `setAwaitingPrefix(botUid, requesterUid, threadId, messageGlobalId)`
  - `getAwaitingPrefix(botUid)` → `{ requesterUid, threadId, messageGlobalId, timestamp } | undefined`
  - `clearAwaitingPrefix(botUid)`
  - `isExpired(entry)` → `boolean`
  - `cleanupExpired()`

- [ ] **Step 1: Write the file**

Create `src/utils/qr-login-prefix-state.js`:

```js
const qrLoginAwaitingPrefix = new Map();
const PREFIX_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export function setAwaitingPrefix(botUid, requesterUid, threadId, messageGlobalId) {
  qrLoginAwaitingPrefix.set(botUid, {
    requesterUid,
    threadId,
    messageGlobalId: String(messageGlobalId),
    timestamp: Date.now(),
  });
}

export function getAwaitingPrefix(botUid) {
  return qrLoginAwaitingPrefix.get(botUid);
}

export function clearAwaitingPrefix(botUid) {
  qrLoginAwaitingPrefix.delete(botUid);
}

export function isExpired(entry) {
  if (!entry) return true;
  return Date.now() - entry.timestamp > PREFIX_TIMEOUT;
}

export function cleanupExpired() {
  for (const [botUid, entry] of qrLoginAwaitingPrefix.entries()) {
    if (isExpired(entry)) {
      qrLoginAwaitingPrefix.delete(botUid);
    }
  }
}
```

- [ ] **Step 2: Verify the file exists and syntax is correct**

Run: `node --check src/utils/qr-login-prefix-state.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add src/utils/qr-login-prefix-state.js
git commit -m "feat: add qr-login awaiting-prefix state helper"
```

---
### Task 2: Send prefix prompt and record state after qrlogin success

**Files:**
- Modify: `src/commands/mybot/Manager/qr-login-command.js`
- Test: none (verify by reading the modified file)

**Interfaces:**
- Consumes: `setAwaitingPrefix(botUid, requesterUid, threadId, messageGlobalId)` from Task 1
- Produces: state entry in `qrLoginAwaitingPrefix` after successful bot creation

- [ ] **Step 1: Import the new helper**

At the top of `src/commands/mybot/Manager/qr-login-command.js`, add:

```js
import {
  setAwaitingPrefix,
  clearAwaitingPrefix,
  isExpired,
  cleanupExpired
} from "../../../utils/qr-login-prefix-state.js";
```

- [ ] **Step 2: Add a helper function to prompt for prefix**

Add these functions inside `qr-login-command.js` (before the existing `createAllRequiredFilesWithCredentials` or after `sanitizeInput` — placement is flexible, keep them near the top-level helpers):

```js
async function promptForPrefix(api, message, botUid, requesterUid, threadId) {
  const promptMsg = `✅ Bot mới đã được tạo thành công!\n\nReply tin nhắn này để đặt prefix cho bot mới (ví dụ: reply với dấu ? hoặc !).\n\nBạn có 5 phút để đặt prefix, sau đó bot sẽ dùng prefix mặc định là !`;
  try {
    const sent = await api.sendMessage(
      {
        msg: promptMsg,
        quote: message,
        ttl: 300000,
      },
      threadId,
      message.type
    );
    const globalMsgId = sent?.data?.globalMsgId || sent?.globalMsgId;
    if (globalMsgId) {
      setAwaitingPrefix(botUid, requesterUid, threadId, globalMsgId);
    }
  } catch (err) {
    console.error(`[ERROR] Failed to send prefix prompt: ${err.message}`);
  }
}

function applyPrefixToBot(botUid, newPrefix) {
  const sanitized = String(newPrefix).trim().replace(/\s+/g, "");
  if (!sanitized || sanitized.length === 0) {
    throw new Error("Prefix không được rỗng");
  }
  const botInfoPath = path.join(botsDir, `${botUid}.json`);
  if (!fs.existsSync(botInfoPath)) {
    throw new Error(`Không tìm thấy config bot ${botUid}`);
  }
  const botConfig = JSON.parse(fs.readFileSync(botInfoPath, "utf8"));
  const commandFilePath = path.join(projectRoot, botConfig.commandFilePath);
  if (!fs.existsSync(commandFilePath)) {
    throw new Error(`Không tìm thấy file command của bot ${botUid}`);
  }
  const commandConfig = JSON.parse(fs.readFileSync(commandFilePath, "utf8"));
  commandConfig.prefix = sanitized;
  fs.writeFileSync(commandFilePath, JSON.stringify(commandConfig, null, 2), "utf-8");
  return sanitized;
}
```

- [ ] **Step 3: Call `promptForPrefix` after both successful bot creation paths**

In `handleQrLogin`, find the two success-send paths:

1. **Reuse existing bot path** (around line 257):
```js
await sendMessageComplete(
  api, message,
  `Bot của ${scannedName} đã được khởi động lại thành công!\n\nTên BOT: ${userInfo.data.info.name}\nTrạng thái: Hoạt động`,
  true, false
);
```
Replace this block with:
```js
await sendMessageComplete(
  api, message,
  `Bot của ${scannedName} đã được khởi động lại thành công!\n\nTên BOT: ${userInfo.data.info.name}\nTrạng thái: Hoạt động`,
  true, false
);
await promptForPrefix(api, message, actualUid, uidFrom, threadId);
```

2. **New bot creation path** (around line 301):
```js
await sendMessageComplete(
  api,
  message,
  `Bot của ${scannedName} đã được khởi tạo thành công!\n\nNgười tạo: ${dName}\nTên BOT: ${userInfo.data.info.name}\nTrạng thái: Hoạt động\nThời gian dùng thử: 1 giờ`,
  true,
  false
);
```
Replace this block with:
```js
await sendMessageComplete(
  api,
  message,
  `Bot của ${scannedName} đã được khởi tạo thành công!\n\nNgười tạo: ${dName}\nTên BOT: ${userInfo.data.info.name}\nTrạng thái: Hoạt động\nThời gian dùng thử: 1 giờ`,
  true,
  false
);
await promptForPrefix(api, message, actualUid, uidFrom, threadId);
```

- [ ] **Step 4: Verify syntax**

Run: `node --check src/commands/mybot/Manager/qr-login-command.js`
Expected: no output (success)

- [ ] **Step 5: Commit**

```bash
git add src/commands/mybot/Manager/qr-login-command.js
git commit -m "feat: prompt for prefix after qrlogin success"
```

---
### Task 3: Handle prefix reply in `messagesUser`

**Files:**
- Modify: `src/automations/event-send-msg.js`
- Modify: `src/commands/mybot/Manager/qr-login-command.js` (export `applyPrefixToBot`)
- Test: none (verify by reading the modified file)

**Interfaces:**
- Consumes: `getAwaitingPrefix(botUid)`, `clearAwaitingPrefix(botUid)`, `isExpired(entry)`, `cleanupExpired()` from Task 1
- Consumes: `applyPrefixToBot(botUid, newPrefix)` from Task 2
- Produces: prefix written to `command-{botUid}.json` when user replies correctly

- [ ] **Step 1: Export `applyPrefixToBot` from `qr-login-command.js`**

In `src/commands/mybot/Manager/qr-login-command.js`, change:
```js
async function applyPrefixToBot(botUid, newPrefix) {
```
to:
```js
export async function applyPrefixToBot(botUid, newPrefix) {
```

- [ ] **Step 2: Import helpers in `event-send-msg.js`**

Add at the top of `src/automations/event-send-msg.js`:
```js
import {
  getAwaitingPrefix,
  clearAwaitingPrefix,
  isExpired,
  cleanupExpired,
} from "../utils/qr-login-prefix-state.js";
import { applyPrefixToBot } from "../commands/mybot/Manager/qr-login-command.js";
```

- [ ] **Step 3: Add a handler function for prefix reply**

Add this function inside `event-send-msg.js` (place it near the top, before `messagesUser` or after `canReplyToUser`):

```js
async function handleQrLoginPrefixReply(api, message) {
  const senderId = message?.data?.uidFrom || '';
  const quote = message?.data?.quote || {};
  const globalMsgId = quote.globalMsgId;
  if (!globalMsgId) return false;

  cleanupExpired();

  let matchedEntry = null;
  let matchedBotUid = null;
  for (const [botUid, entry] of qrLoginAwaitingPrefix.entries()) {
    if (entry.messageGlobalId === String(globalMsgId) && !isExpired(entry)) {
      matchedEntry = entry;
      matchedBotUid = botUid;
      break;
    }
  }
  if (!matchedEntry) return false;
  if (matchedEntry.requesterUid !== senderId) return false;

  const content = (message?.data?.content || '').trim();
  if (!content) return false;

  try {
    const newPrefix = await applyPrefixToBot(matchedBotUid, content);
    clearAwaitingPrefix(matchedBotUid);
    await api.sendMessage(
      {
        msg: `✅ Prefix của bot mới đã được đặt thành: ${newPrefix}`,
        quote: message,
        ttl: 60000,
      },
      message.threadId,
      message.type
    );
  } catch (err) {
    console.error(`[ERROR] Failed to apply prefix: ${err.message}`);
    await api.sendMessage(
      {
        msg: `❌ Đã xảy ra lỗi khi đặt prefix: ${err.message}`,
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
    clearAwaitingPrefix(matchedBotUid);
  }
  return true;
}
```

- [ ] **Step 4: Call `handleQrLoginPrefixReply` at the start of private message handling**

In `messagesUser`, inside the `DirectMessage` case, call it **before** `handleOnReplyFromUser` so it takes priority:

```js
case MessageType.DirectMessage: {
  if (contentText && contentText.toLowerCase().startsWith("uid"))
    api.sendMessage({msg: senderId, ttl: 60000, quote: message}, threadId, message.type);

  if (getConnectedClientsCount() > 0) {
    const userInfo = await api.getGroupMembers([senderId + "_0"]);
    pushMessageToWebLog(io, "Tin Nhắn Riêng Tư", senderName, content, userInfo?.profiles?.[senderId]?.avatar || '');
  }
  if (contentText) {
    const logMessage = `Có Mesage Riêng tư mới:
          - Sender Name: [ ${senderName} ] | ID: ${threadId}
          - Content: ${contentText}\n`;
    logMessageToFile(logMessage);
  }
  if (isPlainText) {
    let continueProcessingChat = true;
    continueProcessingChat = !isUserBlocked(senderId);
    continueProcessingChat = continueProcessingChat && (await canReplyToUser(senderId));
    // <-- Add this line:
    const handledPrefixReply = await handleQrLoginPrefixReply(api, message);
    continueProcessingChat = continueProcessingChat && !handledPrefixReply;
    continueProcessingChat = continueProcessingChat && !(await handleOnReplyFromUser(api, message));
    if (continueProcessingChat) {
      const commandResult = await handleCommandPrivate(api, message);
      continueProcessingChat = continueProcessingChat && commandResult === 1 && isSelf;
      continueProcessingChat =
        continueProcessingChat && !(!isSelf && (await checkAndSendBusinessCard(api, senderId, senderName)));
    }
  }
  break;
}
```

- [ ] **Step 5: Verify syntax**

Run: `node --check src/automations/event-send-msg.js`
Expected: no output (success)

- [ ] **Step 6: Commit**

```bash
git add src/automations/event-send-msg.js src/commands/mybot/Manager/qr-login-command.js
git commit -m "feat: handle prefix reply after qrlogin in messagesUser"
```

---
### Task 4: Verify end-to-end flow

**Files:**
- No code changes
- Test: manual reasoning review

**Interfaces:**
- Consumes: all tasks above

**Steps:**
- [ ] **Step 1: Trace the full flow**

Read the modified files and confirm:
1. `handleQrLogin` calls `promptForPrefix` after both success paths.
2. `promptForPrefix` sends a quoted message and records `globalMsgId` via `setAwaitingPrefix`.
3. `messagesUser` calls `handleQrLoginPrefixReply` for every private message before any other reply handler.
4. `handleQrLoginPrefixReply` matches `globalMsgId`, validates `requesterUid`, calls `applyPrefixToBot`, writes to `command-{botUid}.json`, and clears state.
5. Expired entries are cleaned up on each incoming message via `cleanupExpired()`.

- [ ] **Step 2: Commit the plan review (no code change)**

If everything looks correct, note that verification passed. No additional commit needed beyond Task 3.
