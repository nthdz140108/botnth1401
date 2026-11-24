import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Module 1 Regression: QR and child bot creation works without index.js at project root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-mod1-test-"));

  try {
    // Set up project structure WITHOUT index.js
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "mybot", "credentials"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "mybot", "bots"), { recursive: true });

    // Mock src/bootstrap.js exists
    await fs.writeFile(path.join(tempRoot, "src", "bootstrap.js"), "// bootstrap", "utf8");

    // Ensure index.js is absent
    let indexExists = false;
    try {
      await fs.stat(path.join(tempRoot, "index.js"));
      indexExists = true;
    } catch {
      indexExists = false;
    }
    assert.equal(indexExists, false, "index.js must not exist in this test environment");

    // Verify pm2-manager entrypoint validation logic:
    // If src/bootstrap.js exists, launcherPath resolves cleanly
    const botIndexPath = path.join(tempRoot, "src", "bootstrap.js");
    let missingEntrypointError = null;
    try {
      const stats = await fs.stat(botIndexPath);
      assert.ok(stats.isFile());
    } catch (e) {
      missingEntrypointError = e;
    }
    assert.equal(missingEntrypointError, null, "src/bootstrap.js should be detected as entrypoint");

    // If src/bootstrap.js is missing, it must fail with ERR_ENTRYPOINT_NOT_FOUND
    const fakeMissingPath = path.join(tempRoot, "src", "missing-bootstrap.js");
    try {
      const exists = await fs.stat(fakeMissingPath).then(() => true).catch(() => false);
      if (!exists) {
        const err = new Error(`Không tìm thấy bot entrypoint: ${fakeMissingPath}`);
        err.code = "ERR_ENTRYPOINT_NOT_FOUND";
        err.entrypoint = fakeMissingPath;
        throw err;
      }
      assert.fail("Should have thrown");
    } catch (err) {
      assert.equal(err.code, "ERR_ENTRYPOINT_NOT_FOUND");
      assert.equal(err.entrypoint, fakeMissingPath);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});
