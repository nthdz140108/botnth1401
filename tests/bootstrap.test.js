import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("provider environment uses process, local, then fallback precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-bootstrap-"));
  await fs.writeFile(path.join(root, ".env.local"), "LOCAL_ONLY=local\nSHARED=local\n");
  await fs.writeFile(path.join(root, ".env"), "FALLBACK_ONLY=fallback\nSHARED=env\n");
  const previous = Object.fromEntries(["LOCAL_ONLY", "FALLBACK_ONLY", "SHARED"].map((key) => [key, process.env[key]]));
  delete process.env.LOCAL_ONLY;
  delete process.env.FALLBACK_ONLY;
  process.env.SHARED = "process";

  try {
    const { loadProviderEnvironment } = await import("../src/bootstrap.js");
    loadProviderEnvironment({ root });
    assert.equal(process.env.LOCAL_ONLY, "local");
    assert.equal(process.env.FALLBACK_ONLY, "fallback");
    assert.equal(process.env.SHARED, "process");
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("bootstrap source dynamically imports the bot after loading env", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "src", "bootstrap.js"), "utf8");
  assert.match(source, /loadProviderEnvironment/);
  assert.match(source, /await import\(["']\.\/index\.js["']\)/);
});

test("isRuntimeEntrypoint: direct node execution matches moduleFile", async () => {
  const { isRuntimeEntrypoint } = await import("../src/bootstrap.js");
  const moduleFile = "C:\\proj\\src\\bootstrap.js";
  assert.equal(isRuntimeEntrypoint({ moduleFile, argv1: "C:\\proj\\src\\bootstrap.js", pmExecPath: null }), true);
});

test("isRuntimeEntrypoint: PM2 ESM import matches via pm_exec_path", async () => {
  const { isRuntimeEntrypoint } = await import("../src/bootstrap.js");
  const moduleFile = "C:\\proj\\src\\bootstrap.js";
  // PM2 7 ProcessContainerFork.js imports bootstrap via
  // import(pathToFileURL(pm_exec_path)) — so argv[1] is PM2's own container,
  // and the actual script path is in process.env.pm_exec_path.
  assert.equal(isRuntimeEntrypoint({ moduleFile, argv1: "node_modules\\pm2\\lib\\ProcessContainerFork.js", pmExecPath: "C:\\proj\\src\\bootstrap.js" }), true);
});

test("isRuntimeEntrypoint: normal import from another module never starts the bot", async () => {
  const { isRuntimeEntrypoint } = await import("../src/bootstrap.js");
  const moduleFile = "C:\\proj\\src\\bootstrap.js";
  // index.js/bot.js import bootstrap helpers but argv[1] points at a wrapper.
  assert.equal(isRuntimeEntrypoint({ moduleFile, argv1: "C:\\proj\\index.js", pmExecPath: null }), false);
  assert.equal(isRuntimeEntrypoint({ moduleFile, argv1: "C:\\proj\\bot.js", pmExecPath: null }), false);
  assert.equal(isRuntimeEntrypoint({ moduleFile, argv1: null, pmExecPath: null }), false);
  // Case: neither argv1 nor pm_exec_path resolve to this module.
  assert.equal(isRuntimeEntrypoint({ moduleFile, argv1: "C:\\proj\\other.js", pmExecPath: "C:\\proj\\other.js" }), false);
  // Regression: child CLI script (e.g. qr-login-admin.js) spawned from a PM2-managed
  // bot process inherits pm_exec_path="...\src\bootstrap.js". Importing bootstrap
  // helpers in that child MUST NOT re-enter index.js!
  assert.equal(
    isRuntimeEntrypoint({
      moduleFile,
      argv1: "C:\\proj\\qr-login-admin.js",
      pmExecPath: "C:\\proj\\src\\bootstrap.js",
    }),
    false
  );
});
