# Bot Prefix Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each QR-created bot load and persist its own prefix instead of sharing the admin bot's runtime prefix.

**Architecture:** The runtime context will derive its identity from the bot config's `uid` or `name`, so each bot receives an isolated `mybot/instances/<uid>` workspace. Runtime command seeding and prefix updates will target that isolated command file while retaining the existing legacy command file for compatibility.

**Tech Stack:** Node.js ES modules, `node:test`, filesystem-backed JSON configuration.

## Global Constraints

- Preserve existing bot-specific command metadata and legacy command-file compatibility.
- Keep the change scoped to prefix/runtime identity behavior.
- Follow RED/GREEN TDD and run the focused tests before the full suite.

---

### Task 1: Lock Runtime Identity And Seed Behavior

**Files:**
- Modify: `tests/bot-runtime-context.test.js`
- Modify: `src/utils/bot-runtime-context.js`

**Interfaces:**
- Consumes: bot config objects with `name`/`uid`, runtime context objects, and command JSON seed files.
- Produces: `createBotRuntimeContext({ name: "child" })` with `uid === "child"`; `seedRuntimeFiles` preferring `mybot/json-data/command-<uid>.json`.

- [ ] **Step 1: Write the failing tests**

```js
test("uses the bot config name when uid is omitted", () => {
  assert.equal(createBotRuntimeContext({ name: "child-1" }).uid, "child-1");
});

test("seeds a bot runtime command file from that bot's command config", async () => {
  const context = makeRuntimeContext(root, "child-1");
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "json-data"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "admin" }));
  await fs.writeFile(path.join(root, "mybot", "json-data", "command-child-1.json"), JSON.stringify({ prefix: "child" }));

  seedRuntimeFiles(context);

  assert.equal(JSON.parse(await fs.readFile(context.commandConfigPath, "utf8")).prefix, "child");
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/bot-runtime-context.test.js`

Expected: FAIL because config `name` currently falls back to `admin`, and seeding does not look at the bot-specific command file.

- [ ] **Step 3: Implement the minimal runtime-context change**

Derive `uid` with `uidOrConfig.uid || uidOrConfig.name || getBotName() || "admin"`, and add `mybot/json-data/command-${uid}.json` before the global command seed candidates.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/bot-runtime-context.test.js`

Expected: PASS.

### Task 2: Write Prefix To The Runtime File Used By The Bot

**Files:**
- Modify: `tests/qr-login-prefix-state.test.js`
- Modify: `src/commands/mybot/Manager/qr-login-command.js`
- Modify: `src/commands/bot-manager/prefix.js`

**Interfaces:**
- Consumes: `botUid`, `newPrefix`, bot config path, and runtime context command path.
- Produces: QR prefix updates and normal prefix commands that write the runtime command file and legacy command file, then reload the bot using the runtime value.

- [ ] **Step 1: Write the failing regression test**

Add an assertion that a bot runtime command file remains independent from the admin command file after setting a child prefix, using a temporary runtime context and the same path resolution used by the production helper.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/qr-login-prefix-state.test.js`

Expected: FAIL because the current implementation writes only `botConfig.commandFilePath`.

- [ ] **Step 3: Implement the minimal prefix-path fix**

Resolve `createBotRuntimeContext(botUid).commandConfigPath`, update that file, and mirror the value to `botConfig.commandFilePath` when it is a distinct existing path. Make the normal `prefix` command use the same runtime context path.

- [ ] **Step 4: Run the focused tests and the full suite**

Run: `node --test tests/qr-login-prefix-state.test.js`

Then run: `npm test`

Expected: both commands exit with code 0 and no failed tests.

### Task 3: Verify The Complete Change

**Files:**
- Inspect: `src/utils/bot-runtime-context.js`
- Inspect: `src/commands/mybot/Manager/qr-login-command.js`
- Inspect: `src/commands/bot-manager/prefix.js`
- Inspect: `tests/bot-runtime-context.test.js`
- Inspect: `tests/qr-login-prefix-state.test.js`

- [ ] **Step 1: Review the diff for unrelated changes**

Run: `git diff --check` and `git diff --stat`.

- [ ] **Step 2: Re-run the focused regression tests**

Run: `node --test tests/bot-runtime-context.test.js tests/qr-login-prefix-state.test.js`

- [ ] **Step 3: Confirm runtime isolation manually from test data**

Verify the child context path is `mybot/instances/<child uid>/data/command.json` and that its prefix is not read from `mybot/instances/admin/data/command.json`.
