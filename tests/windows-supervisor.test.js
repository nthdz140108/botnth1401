import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WindowsSupervisor } from "../scripts/windows-supervisor.js";

test("atomic lock acquisition prevents two simultaneous supervisor instances", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-lock-"));

  const sup1 = new WindowsSupervisor({
    botName: "test-bot",
    projectRoot: tmp,
  });

  const locked1 = sup1.acquireLock();
  assert.equal(locked1, true);

  // Second instance on the same bot name should be rejected because PID is alive
  const sup2 = new WindowsSupervisor({
    botName: "test-bot",
    projectRoot: tmp,
  });

  assert.throws(
    () => sup2.acquireLock(),
    /already running/
  );

  // Release lock
  sup1.releaseLock();

  // Now second supervisor can acquire lock
  const locked2 = sup2.acquireLock();
  assert.equal(locked2, true);

  sup2.releaseLock();
});
