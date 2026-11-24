import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  acquireBotLock,
  releaseBotLock,
  withBotLock,
  getBotLockInfo,
} from "../src/runtime/bot-lock.js";
import {
  reconcileState,
  readNodeBots,
  readSqliteBots,
} from "../scripts/reconcile-node-rust-state.js";
import { BotRegistry } from "../src/dashboard/bot-registry.js";
import { ConfigStore } from "../src/dashboard/config-store.js";
import { createBotActionService } from "../src/dashboard/bot-action-service.js";

// Helper to create an isolated temporary workspace
async function createTempWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-test-workspace-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.mkdir(path.join(root, ".runtime", "locks"), { recursive: true });
  return root;
}

// Helper to cleanup temporary workspace
async function cleanupWorkspace(root) {
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {}
}

test("bot-lock: acquires atomic lock file with pid, timestamp, token and releases safely", async () => {
  const root = await createTempWorkspace();
  try {
    const botKey = "bot-alpha";
    const lock = await acquireBotLock(botKey, { root, timeoutMs: 1000 });

    assert.equal(lock.botKey, botKey);
    assert.equal(lock.pid, process.pid);
    assert.ok(typeof lock.token === "string" && lock.token.length > 0);
    assert.ok(typeof lock.timestamp === "number");

    // Verify lock file exists on disk
    const lockFile = path.join(root, ".runtime", "locks", `${botKey}.lock`);
    assert.ok(fsSync.existsSync(lockFile));

    const content = JSON.parse(await fs.readFile(lockFile, "utf8"));
    assert.equal(content.token, lock.token);
    assert.equal(content.pid, process.pid);

    // Mismatched token release must fail and keep file
    const fakeRelease = await releaseBotLock(botKey, "wrong-token-1234", { root });
    assert.equal(fakeRelease, false);
    assert.ok(fsSync.existsSync(lockFile));

    // Valid release removes file
    const okRelease = await releaseBotLock(botKey, lock.token, { root });
    assert.equal(okRelease, true);
    assert.equal(fsSync.existsSync(lockFile), false);
  } finally {
    await cleanupWorkspace(root);
  }
});

test("bot-lock: prevents concurrent operations on same bot and succeeds after release", async () => {
  const root = await createTempWorkspace();
  try {
    const botKey = "bot-concurrent";
    const lock1 = await acquireBotLock(botKey, { root, timeoutMs: 2000 });

    let lock2Acquired = false;
    // Attempt second acquisition in background with a short timeout
    const p2 = acquireBotLock(botKey, { root, timeoutMs: 300, pollIntervalMs: 20 });
    await assert.rejects(p2, (err) => {
      assert.equal(err.code, "LOCK_TIMEOUT");
      return true;
    });

    // Release lock1
    await releaseBotLock(botKey, lock1.token, { root });

    // Now second acquisition succeeds
    const lock3 = await acquireBotLock(botKey, { root, timeoutMs: 1000 });
    assert.ok(lock3.token);
    assert.notEqual(lock3.token, lock1.token);
    await releaseBotLock(botKey, lock3.token, { root });
  } finally {
    await cleanupWorkspace(root);
  }
});

test("bot-lock: allows different bot keys to acquire locks concurrently", async () => {
  const root = await createTempWorkspace();
  try {
    const lockA = await acquireBotLock("bot-1", { root });
    const lockB = await acquireBotLock("bot-2", { root });

    assert.ok(lockA.token);
    assert.ok(lockB.token);
    assert.notEqual(lockA.token, lockB.token);

    await releaseBotLock("bot-1", lockA.token, { root });
    await releaseBotLock("bot-2", lockB.token, { root });
  } finally {
    await cleanupWorkspace(root);
  }
});

test("bot-lock: breaks stale locks older than staleMs", async () => {
  const root = await createTempWorkspace();
  try {
    const botKey = "bot-stale";
    const lockDir = path.join(root, ".runtime", "locks");
    const lockFile = path.join(lockDir, `${botKey}.lock`);

    // Write a stale lock file with timestamp from 60 seconds ago
    const staleData = {
      pid: 12345,
      timestamp: Date.now() - 60000,
      token: "stale-dead-process-token",
    };
    await fs.writeFile(lockFile, JSON.stringify(staleData, null, 2), "utf8");

    // acquireBotLock with staleMs = 30000 (default) or 1000ms
    const lock = await acquireBotLock(botKey, { root, staleMs: 30000, timeoutMs: 2000 });
    assert.ok(lock.token);
    assert.notEqual(lock.token, "stale-dead-process-token");

    const currentLock = await getBotLockInfo(botKey, { root });
    assert.equal(currentLock.token, lock.token);

    await releaseBotLock(botKey, lock.token, { root });
  } finally {
    await cleanupWorkspace(root);
  }
});

test("bot-lock: withBotLock runs under lock and guarantees release even on error", async () => {
  const root = await createTempWorkspace();
  try {
    const botKey = "bot-withlock";
    let ran = false;

    await assert.rejects(
      withBotLock(botKey, async (lock) => {
        ran = true;
        assert.ok(lock.token);
        assert.ok(fsSync.existsSync(lock.lockPath));
        throw new Error("action failed deliberately");
      }, { root }),
      /action failed deliberately/
    );

    assert.ok(ran);
    // Lock must be released despite error
    const lockFile = path.join(root, ".runtime", "locks", `${botKey}.lock`);
    assert.equal(fsSync.existsSync(lockFile), false);
  } finally {
    await cleanupWorkspace(root);
  }
});

test("bot-action-service: start, stop, restart, delete acquire per-bot mutex lock", async () => {
  const root = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
      child: { name: "child", displayName: "Child Bot", status: "running" },
    }));
    await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({
      name: "child",
      webPort: 3000,
    }));
    await fs.writeFile(path.join(root, "mybot", "state", "child.json"), JSON.stringify({
      status: "running",
      pid: "1234",
    }));

    const registry = new BotRegistry({ root, portProbe: async () => false, pm2: { status: async () => null } });
    const configStore = new ConfigStore({ backupDir: path.join(root, "logs", "backups") });

    let isRunning = false;
    let activeLockDuringStart = false;
    let activeLockDuringStop = false;

    const pm2Adapter = {
      status: async () => ({ running: isRunning, status: isRunning ? "online" : "stopped" }),
      start: async (id) => {
        const info = await getBotLockInfo(id, { root });
        if (info) activeLockDuringStart = true;
        isRunning = true;
        return { success: true, pid: 1001 };
      },
      stop: async (id) => {
        const info = await getBotLockInfo(id, { root });
        if (info) activeLockDuringStop = true;
        isRunning = false;
        return { success: true };
      },
      restart: async () => ({ success: true }),
      delete: async (id) => ({ success: true, verifiedAbsent: true, ownershipVerified: true }),
    };

    const service = createBotActionService({
      root,
      registry,
      configStore,
      pm2Adapter,
    });

    await service.start("child");
    assert.equal(activeLockDuringStart, true, "Lock was active during start");

    await service.stop("child");
    assert.equal(activeLockDuringStop, true, "Lock was active during stop");
  } finally {
    await cleanupWorkspace(root);
  }
});

test("reconcile-node-rust-state: handles missing SQLite DB gracefully without throwing", async () => {
  const root = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(root, "assets", "config.json"), JSON.stringify({
      name: "Main Admin",
      uid: "admin-uid-1",
      cookie: [{ name: "zpsid", value: "cookie-123" }],
    }));
    await fs.writeFile(path.join(root, "mybot", "state", "admin.json"), JSON.stringify({
      uid: "admin-uid-1",
      cookieDead: false,
    }));

    const nonExistentDb = path.join(root, "data", "non-existent.db");
    const { report, reportPath } = await reconcileState({
      root,
      dbPath: nonExistentDb,
      dryRun: false,
    });

    assert.equal(report.sqliteDbFound, false);
    assert.equal(report.summary.nodeBotCount, 1);
    assert.equal(report.summary.sqliteBotCount, 0);
    assert.equal(report.summary.nodeOnlyCount, 1);
    assert.ok(fsSync.existsSync(reportPath));
  } finally {
    await cleanupWorkspace(root);
  }
});

test("reconcile-node-rust-state: detects UID conflicts and preserves Node record", async () => {
  const root = await createTempWorkspace();
  try {
    // Node has bot-conflict with UID 'node-uid-999'
    await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
      "bot-conflict": {
        name: "bot-conflict",
        uid: "node-uid-999",
        status: "running",
      },
    }));
    await fs.writeFile(path.join(root, "mybot", "state", "bot-conflict.json"), JSON.stringify({
      uid: "node-uid-999",
      cookieDead: false,
      status: "running",
    }));

    // SQLite has bot-conflict with different UID 'sqlite-uid-888'
    const sqliteBots = [
      {
        bot_key: "bot-conflict",
        uid: "sqlite-uid-888",
        status: "stopped",
        cookie_json: '[{"name":"zpsid","value":"xyz"}]',
        is_main: 0,
        cookie_dead: 0,
      },
    ];

    const { report } = await reconcileState({
      root,
      sqliteBots,
      dryRun: false,
    });

    assert.equal(report.summary.conflictsCount, 1);
    assert.equal(report.conflicts[0].botKey, "bot-conflict");
    assert.equal(report.conflicts[0].nodeUid, "node-uid-999");
    assert.equal(report.conflicts[0].sqliteUid, "sqlite-uid-888");
    assert.equal(report.conflicts[0].resolution, "kept_node_record");

    // Verify Node's state file was NOT corrupted or overwritten
    const stateFile = path.join(root, "mybot", "state", "bot-conflict.json");
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(state.uid, "node-uid-999");
  } finally {
    await cleanupWorkspace(root);
  }
});

test("reconcile-node-rust-state: imports bot present ONLY in SQLite when credentials are valid", async () => {
  const root = await createTempWorkspace();
  try {
    // Initially empty Node state
    await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({}));

    const sqliteBots = [
      {
        bot_key: "bot-sqlite-only",
        uid: "uid-valid-12345",
        display_name: "Imported SQLite Bot",
        status: "running",
        cookie_json: '[{"name":"zpsid","value":"valid-token"}]',
        is_main: 0,
        cookie_dead: 0,
        cookie_dead_reason: null,
      },
    ];

    const { report } = await reconcileState({
      root,
      sqliteBots,
      dryRun: false,
    });

    assert.equal(report.summary.importedFromSqliteCount, 1);
    assert.equal(report.importedFromSqlite[0].botKey, "bot-sqlite-only");
    assert.equal(report.importedFromSqlite[0].uid, "uid-valid-12345");

    // Verify state file created
    const createdStateFile = path.join(root, "mybot", "state", "bot-sqlite-only.json");
    assert.ok(fsSync.existsSync(createdStateFile));
    const createdState = JSON.parse(await fs.readFile(createdStateFile, "utf8"));
    assert.equal(createdState.uid, "uid-valid-12345");
    assert.equal(createdState.displayName, "Imported SQLite Bot");

    // Verify registered in inventory
    const inventory = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    assert.ok(inventory["bot-sqlite-only"]);
    assert.equal(inventory["bot-sqlite-only"].uid, "uid-valid-12345");
  } finally {
    await cleanupWorkspace(root);
  }
});

test("reconcile-node-rust-state: skips bot present ONLY in SQLite with invalid credentials", async () => {
  const root = await createTempWorkspace();
  try {
    await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({}));

    const sqliteBots = [
      {
        bot_key: "bot-no-cookies",
        uid: "uid-no-cookies",
        display_name: "No Cookies Bot",
        status: "stopped",
        cookie_json: "", // empty cookies!
        is_main: 0,
      },
      {
        bot_key: "bot-no-uid",
        uid: "", // empty UID!
        display_name: "No UID Bot",
        status: "stopped",
        cookie_json: '[{"name":"zpsid","value":"foo"}]',
        is_main: 0,
      },
    ];

    const { report } = await reconcileState({
      root,
      sqliteBots,
      dryRun: false,
    });

    assert.equal(report.summary.importedFromSqliteCount, 0);
    assert.equal(report.summary.skippedFromSqliteCount, 2);

    // Verify NO state files created for invalid bots
    assert.equal(fsSync.existsSync(path.join(root, "mybot", "state", "bot-no-cookies.json")), false);
    assert.equal(fsSync.existsSync(path.join(root, "mybot", "state", "bot-no-uid.json")), false);
  } finally {
    await cleanupWorkspace(root);
  }
});

test("reconcile-node-rust-state: queries real SQLite DB via Python script end-to-end", async () => {
  const root = await createTempWorkspace();
  try {
    const dbPath = path.join(root, "data", "test-mybot.db");

    // Create real SQLite DB using Python script
    const pyScriptFile = path.join(root, "create_test_db.py");
    const pyCreateDb = `import sqlite3
conn = sqlite3.connect(r'''${dbPath}''')
conn.execute('''
CREATE TABLE bots (
    bot_key TEXT PRIMARY KEY,
    uid TEXT,
    display_name TEXT,
    status TEXT,
    cookie_json TEXT,
    is_main INTEGER,
    cookie_dead INTEGER,
    cookie_dead_reason TEXT
)
''')
conn.execute('''
INSERT INTO bots (bot_key, uid, display_name, status, cookie_json, is_main, cookie_dead)
VALUES ('bot-e2e', 'uid-e2e-real', 'E2E Real Bot', 'running', '[{"name":"zpsid","value":"real"}]', 0, 0)
''')
conn.commit()
conn.close()
`;
    await fs.writeFile(pyScriptFile, pyCreateDb, "utf8");
    execSync(`python "${pyScriptFile}"`);

    // Verify readSqliteBots reads it via python script
    const pyRead = readSqliteBots({ root, dbPath });
    assert.equal(pyRead.exists, true);
    assert.equal(pyRead.tableExists, true);
    assert.equal(pyRead.bots.length, 1);
    assert.equal(pyRead.bots[0].bot_key, "bot-e2e");
    assert.equal(pyRead.bots[0].uid, "uid-e2e-real");

    // Run reconciliation against real SQLite DB
    const { report } = await reconcileState({
      root,
      dbPath,
      dryRun: false,
    });

    assert.equal(report.sqliteDbFound, true);
    assert.equal(report.sqliteTableFound, true);
    assert.equal(report.summary.importedFromSqliteCount, 1);

    const importedState = JSON.parse(
      await fs.readFile(path.join(root, "mybot", "state", "bot-e2e.json"), "utf8")
    );
    assert.equal(importedState.uid, "uid-e2e-real");
  } finally {
    await cleanupWorkspace(root);
  }
});
