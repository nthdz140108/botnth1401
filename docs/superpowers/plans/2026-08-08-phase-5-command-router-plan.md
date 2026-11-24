# Phase 5 Command Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and test all 20 Phase 5 commands through the existing command router without live external side effects.

**Architecture:** Extend `src/commands/command-registry.js` with Phase 5 metadata and lazy adapters, then append those definitions to the aggregate registry. Keep legacy group/private wrappers and fallback switch behavior unchanged for commands outside the registry.

**Tech Stack:** Node.js ESM, `node:test`, existing command router/dispatcher, lazy dynamic imports.

## Global Constraints

- Preserve Node.js ESM and the current `handleCommand`/`handleCommandPrivate` signatures.
- Phase 5 must contain exactly the 20 canonical names from the approved spec.
- `sendsrc` maps to `shareSrc` and retains `sharesrc` as a compatibility alias.
- Tests must inject handlers and must not call live Zalo, spam, adult-video, or external media operations.
- Existing phases 1 through 4 and their tests must remain green.

---

### Task 1: Add the Phase 5 red test

**Files:**
- Create: `tests/phase-5-dispatch.test.js`
- Reference: `src/commands/command-registry.js`, `src/commands/command-dispatcher.js`

**Interfaces:**
- Consumes: `createPhase5Registry`, `createCommandRegistryForPhases`, `dispatchCommand`.
- Produces: executable assertions for the exact canonical list, alias resolution, and safe mock dispatch.

- [ ] **Step 1: Write the failing test**

```js
const EXPECTED_PHASE_5_COMMANDS = [
  "spamjoin", "xnxx", "ketban", "kb", "soundcloud", "zingmp3",
  "zingchart", "nhaccuatui", "voice", "truyencuoi", "tarrot",
  "poststatus", "createqr", "scanqr", "scanapi", "sendresourcesfile",
  "sendsrc", "sendresourcesvideo", "sendresourcesimage", "sendresourcesaudio",
];

test("phase 5 exposes exactly 20 canonical commands", () => {
  assert.deepEqual(PHASE_5_COMMANDS, EXPECTED_PHASE_5_COMMANDS);
  const registry = createPhase5Registry(overridesFor(EXPECTED_PHASE_5_COMMANDS));
  assert.deepEqual(registry.definitions.map(({ name }) => name), EXPECTED_PHASE_5_COMMANDS);
  assert.equal(registry.definitions.every(({ handler }) => typeof handler === "function"), true);
});

test("phase 5 commands resolve and dispatch through injected handlers", async () => {
  const registry = createPhase5Registry(overridesFor(EXPECTED_PHASE_5_COMMANDS));
  for (const command of EXPECTED_PHASE_5_COMMANDS) {
    const result = await dispatchCommand({
      commandParts: [...command.split(" "), "sample", "extra"],
      scope: "group",
      permissionLevel: "adminBot",
      config: {},
      dbReady: true,
    }, registry);
    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.equal(result.value.command, command);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/phase-5-dispatch.test.js`

Expected: FAIL because `PHASE_5_COMMANDS` and `createPhase5Registry` are not exported yet.

- [ ] **Step 3: Commit**

Commit is unavailable because this extracted workspace has no `.git` directory; retain the test as the RED checkpoint.

### Task 2: Implement Phase 5 registry mappings

**Files:**
- Modify: `src/commands/command-registry.js`

**Interfaces:**
- Consumes: existing `lazy`, `createCommandDefinition`, and handler module exports.
- Produces: `PHASE_5_COMMANDS`, `createPhase5Registry`, `phase5Registry`, and aggregate definitions.

- [ ] **Step 1: Add the canonical list and metadata**

Add the exact 20 names and metadata from the approved spec. Use aliases from `assets/json-data/command.json`, set `minArgs: 2` for `spamjoin`, `minArgs: 1` for `scanapi` and all four `sendresources*` commands plus `sendsrc`, and set `scope: "group"` for `xnxx`, `ketban`, and `kb`.

- [ ] **Step 2: Add lazy adapters**

Use these adapter shapes:

```js
spamjoin: lazy("./lenh-debug/spam/remote-join-leave.js", "handleJoinLeaveGroup", (handler, { api, message }) => handler(api, message)),
xnxx: lazy("./lenh-debug/hoang/xnxx.js", "handleXnxxCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
ketban: lazy("../automations/ndq-test.js", "ketbanCommand", (command, { api, message, groupInfo }) => command.execute(api, message, groupInfo)),
kb: lazy("../automations/ndq-test.js", "ketbanTagCommand", (command, { api, message, groupInfo }) => command.execute(api, message, groupInfo)),
soundcloud: lazy("../service-debug/api-crawl/music/soundcloud.js", "handleMusicCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
zingmp3: lazy("../service-debug/api-crawl/music/zingmp3.js", "handleZingMp3Command", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
zingchart: lazy("../service-debug/api-crawl/music/zingmp3.js", "handleTopChartZingMp3", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
nhaccuatui: lazy("../service-debug/api-crawl/music/nhaccuatui.js", "handleNhacCuaTuiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
voice: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleVoiceCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
truyencuoi: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleStoryCommand", (handler, { api, message }) => handler(api, message)),
tarrot: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleTarrotCommand", (handler, { api, message }) => handler(api, message)),
poststatus: lazy("../utils/canvas/status-post.js", "handleCommandStatusPost", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
createqr: lazy("../service-debug/utilities/qr-creater.js", "handleCreateQRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
scanqr: lazy("../service-debug/utilities/qr-scan.js", "handleScanQRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
scanapi: lazy("../service-debug/utilities/scan-api.js", "scanApi", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesfile: lazy("./lenh-debug/send-all/send-resources-file.js", "handleSendFile", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendsrc: lazy("../service-debug/utilities/share.js", "shareSrc", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesvideo: lazy("./lenh-debug/send-all/send-resources-video.js", "handleSendVideo", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesimage: lazy("./lenh-debug/send-all/send-resources-image.js", "handleSendImage", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesaudio: lazy("./lenh-debug/send-all/send-resources-audio.js", "handleSendAudio", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
```

- [ ] **Step 3: Append Phase 5 to the aggregate registry**

Create `phase5Registry` and append `...createPhase5Registry(overrides).definitions` in `createCommandRegistryForPhases`.

- [ ] **Step 4: Run focused test to verify it passes**

Run: `node --test tests/phase-5-dispatch.test.js`

Expected: PASS for the exact list and injected dispatch.

### Task 3: Add Phase 5 contract and dependency tests

**Files:**
- Modify: `tests/phase-5-dispatch.test.js`
- Create: `tests/phase-5-contract.test.js`

**Interfaces:**
- Consumes: `createPhase5Registry`, `dispatchCommand`, `resolveCommand`.
- Produces: regression coverage for scope, missing args, permission, handler errors, aliases, and aggregate count.

- [ ] **Step 1: Add failing contract assertions**

Cover these exact behaviors:

```js
test("group-only phase 5 commands reject private dispatch", async () => {
  for (const command of ["xnxx", "ketban", "kb"]) {
    const result = await dispatchCommand({ commandParts: [command], scope: "private", permissionLevel: "all" }, createPhase5Registry({ [command]: async () => "no" }));
    assert.equal(result.code, "SCOPE_DENIED", command);
  }
});

test("phase 5 validates required arguments before calling a handler", async () => {
  let invoked = false;
  const result = await dispatchCommand({ commandParts: ["sendsrc"], scope: "group", permissionLevel: "all" }, createPhase5Registry({ sendsrc: async () => { invoked = true; } }));
  assert.equal(result.code, "MISSING_ARGUMENT");
  assert.equal(invoked, false);
});

test("legacy sharesrc resolves to the sendsrc handler", async () => {
  const result = await dispatchCommand({ commandParts: ["SHARESRC", "sample"], scope: "group", permissionLevel: "all" }, createPhase5Registry({ sendsrc: async ({ aliasCommand }) => aliasCommand }));
  assert.equal(result.code, "HANDLED");
  assert.equal(result.definition.name, "sendsrc");
});

test("phase 5 handler failures become structured errors", async () => {
  const result = await dispatchCommand({ commandParts: ["voice"], scope: "group", permissionLevel: "all" }, createPhase5Registry({ voice: async () => { throw new Error("mock provider failed"); } }));
  assert.equal(result.code, "HANDLER_ERROR");
  assert.match(result.error.message, /mock provider failed/);
});
```

- [ ] **Step 2: Run contract tests to verify the new assertions fail or expose gaps**

Run: `node --test tests/phase-5-contract.test.js`

Expected: initial failures identify missing phase metadata or incorrect scope/argument behavior.

- [ ] **Step 3: Implement only the metadata changes needed by the failures**

Do not alter handler implementations or call external services.

- [ ] **Step 4: Run focused dispatch and contract tests**

Run: `node --test tests/phase-5-dispatch.test.js tests/phase-5-contract.test.js`

Expected: PASS with zero failures.

### Task 4: Verify aggregate regression and repository health

**Files:**
- Modify: `tests/phase-5-dispatch.test.js` only if an uncovered phase contract is found.

**Interfaces:**
- Consumes: completed Phase 5 registry and tests.
- Produces: evidence that all previous phases and the new phase coexist without collisions.

- [ ] **Step 1: Run the full Node test suite**

Run: `npm test`

Expected: exit code 0 and no failing tests.

- [ ] **Step 2: Run syntax validation for source files**

Run: `node --check src/commands/command-registry.js; node --check src/commands/command-router.js; node --check src/commands/command-dispatcher.js`

Expected: exit code 0 for each file.

- [ ] **Step 3: Run mock-only smoke dispatch**

Run: `node --input-type=module -e "import { dispatchCommand } from './src/commands/command-dispatcher.js'; import { createPhase5Registry } from './src/commands/command-registry.js'; const r=await dispatchCommand({commandParts:['sendsrc','sample'],scope:'group',permissionLevel:'all'},createPhase5Registry({sendsrc:async()=> 'mock'})); if(r.code!=='HANDLED'||r.value!=='mock') process.exit(1); console.log(r.code,r.definition.name);"`

Expected: output `HANDLED sendsrc` and exit code 0.

- [ ] **Step 4: Audit the acceptance checklist**

Confirm 20 Phase 5 definitions, 100 aggregate definitions, no duplicate lookup keys, correct handler mappings, structured errors, and no live side effects.
