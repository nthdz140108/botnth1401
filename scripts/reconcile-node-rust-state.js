#!/usr/bin/env node
/**
 * State Audit & Reconciliation Script
 *
 * Reconciles bot state between Node (mybot/state/*.json, assets/config.json, mybot/mybots.json)
 * and Rust SQLite (data/mybot.db).
 *
 * Rules:
 * - Compares UIDs, credentials, status between Node and SQLite.
 * - If a bot is present ONLY in SQLite: validate credentials (UID not empty, cookies present).
 *   If valid: create mybot/state/${botKey}.json and register in inventory.
 *   If invalid: mark as skipped.
 * - If a bot exists in both with conflicting UIDs: record conflict and keep Node's record.
 * - Saves report to .runtime/state-reconciliation-report.json and prints a clear summary table.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Extracts bots from SQLite database.
 * If sqliteBots is supplied directly (e.g. In tests), uses it.
 * Otherwise uses Python helper scripts/read_sqlite_bots.py or inline python.
 *
 * @param {object} options
 * @returns {{ exists: boolean, tableExists: boolean, bots: Array<object>, dbPath: string, error?: string }}
 */
export function readSqliteBots({ root = process.cwd(), dbPath = null, sqliteBots = null } = {}) {
  if (sqliteBots !== null) {
    return {
      exists: true,
      tableExists: true,
      bots: Array.isArray(sqliteBots) ? sqliteBots : [],
      dbPath: dbPath || "mock://in-memory",
    };
  }

  const resolvedDbPath = path.resolve(
    dbPath || process.env.MYBOT_DB_PATH || path.join(root, "data", "mybot.db")
  );

  if (!fsSync.existsSync(resolvedDbPath)) {
    return {
      exists: false,
      tableExists: false,
      bots: [],
      dbPath: resolvedDbPath,
    };
  }

  const helperScript = path.resolve(root, "scripts", "read_sqlite_bots.py");
  const pyCmd = process.platform === "win32" ? "python" : "python3";

  let res = null;
  if (fsSync.existsSync(helperScript)) {
    res = spawnSync(pyCmd, [helperScript, "--db", resolvedDbPath], {
      encoding: "utf8",
      timeout: 10000,
    });
  }

  if (!res || res.error || res.status !== 0) {
    // Inline Python fallback
    const inlineScript = `
import sqlite3, json, sys, os
db = sys.argv[1]
if not os.path.exists(db):
    print(json.dumps({'exists': False, 'bots': []}))
    sys.exit(0)
try:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bots'")
    if not cur.fetchone():
        print(json.dumps({'exists': True, 'tableExists': False, 'bots': []}))
    else:
        cur.execute("SELECT * FROM bots")
        rows = [dict(r) for r in cur.fetchall()]
        print(json.dumps({'exists': True, 'tableExists': True, 'bots': rows}))
except Exception as e:
    print(json.dumps({'exists': True, 'error': str(e), 'bots': []}))
`;
    res = spawnSync(pyCmd, ["-c", inlineScript, resolvedDbPath], {
      encoding: "utf8",
      timeout: 10000,
    });
  }

  try {
    const parsed = JSON.parse(res?.stdout || "{}");
    return {
      exists: parsed.exists ?? true,
      tableExists: parsed.tableExists ?? true,
      bots: Array.isArray(parsed.bots) ? parsed.bots : [],
      dbPath: resolvedDbPath,
    };
  } catch (err) {
    return {
      exists: true,
      tableExists: false,
      bots: [],
      dbPath: resolvedDbPath,
      error: `Failed to parse Python output: ${err.message}`,
    };
  }
}

/**
 * Reads all Node bots from mybot/state/*.json, assets/config.json, and mybot/mybots.json.
 *
 * @param {object} options
 * @returns {Promise<{ nodeBots: Map<string, object>, inventory: object, inventoryPath: string, stateDir: string }>}
 */
export async function readNodeBots({ root = process.cwd() } = {}) {
  const nodeBots = new Map();
  const stateDir = path.resolve(root, "mybot", "state");
  const inventoryPath = path.resolve(root, "mybot", "mybots.json");
  const configPath = path.resolve(root, "assets", "config.json");

  let inventory = {};
  try {
    const raw = await fs.readFile(inventoryPath, "utf8");
    inventory = JSON.parse(raw);
  } catch {}

  // 1. Admin Bot
  let adminConfig = null;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    adminConfig = JSON.parse(raw);
  } catch {}

  let adminState = null;
  try {
    const raw = await fs.readFile(path.join(stateDir, "admin.json"), "utf8");
    adminState = JSON.parse(raw);
  } catch {}

  const adminInventory = inventory.admin || {};
  const adminUid = adminState?.uid || adminConfig?.botId || adminConfig?.uid || adminInventory?.uid || "admin";
  const adminCookieDead = Boolean(adminState?.cookieDead || adminInventory?.cookieDead);
  const adminStatus = adminCookieDead ? "cookie_dead" : (adminInventory?.status || adminState?.status || "stopped");
  const adminHasCookies = Boolean(
    adminConfig?.cookie &&
    (Array.isArray(adminConfig.cookie?.cookies) ? adminConfig.cookie.cookies.length > 0 : true)
  );

  nodeBots.set("admin", {
    botKey: "admin",
    uid: adminUid,
    displayName: adminConfig?.name || adminInventory?.displayName || "Main Bot",
    status: adminStatus,
    cookieDead: adminCookieDead,
    cookieDeadReason: adminState?.cookieDeadReason || null,
    hasCredentials: adminHasCookies,
    isMain: true,
    source: "assets/config.json + mybot/state/admin.json",
  });

  // 2. Child bots in mybot/state/*.json
  try {
    const files = await fs.readdir(stateDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (file === "admin.json") continue;
      if (file === "dead-cookie-notifications.json") continue;

      const botKey = path.basename(file, ".json");
      try {
        const raw = await fs.readFile(path.join(stateDir, file), "utf8");
        const state = JSON.parse(raw);
        const inv = inventory[botKey] || {};
        const uid = state.uid || inv.uid || botKey;
        const cookieDead = Boolean(state.cookieDead || inv.cookieDead);
        const status = cookieDead ? "cookie_dead" : (inv.status || state.status || "stopped");

        // Credential check
        let hasCreds = Boolean(state.cookie || state.cookies);
        if (!hasCreds) {
          const credFile = path.resolve(root, "mybot", "credentials", `${botKey}.json`);
          try {
            const credRaw = await fs.readFile(credFile, "utf8");
            hasCreds = Boolean(credRaw && credRaw.length > 10);
          } catch {}
        }

        nodeBots.set(botKey, {
          botKey,
          uid,
          displayName: inv.displayName || inv.name || botKey,
          status,
          cookieDead,
          cookieDeadReason: state.cookieDeadReason || null,
          hasCredentials: hasCreds,
          isMain: false,
          source: `mybot/state/${file}`,
        });
      } catch {}
    }
  } catch {}

  // 3. Child bots in inventory that may not have state files yet
  for (const [botKey, inv] of Object.entries(inventory)) {
    if (!nodeBots.has(botKey)) {
      nodeBots.set(botKey, {
        botKey,
        uid: inv.uid || botKey,
        displayName: inv.displayName || inv.name || botKey,
        status: inv.status || "stopped",
        cookieDead: Boolean(inv.cookieDead),
        cookieDeadReason: null,
        hasCredentials: false,
        isMain: Boolean(inv.isMain),
        source: "mybot/mybots.json",
      });
    }
  }

  return { nodeBots, inventory, inventoryPath, stateDir };
}

/**
 * Performs full state audit and reconciliation.
 *
 * @param {object} options
 * @param {string} [options.root] - project root
 * @param {string} [options.dbPath] - path to SQLite DB
 * @param {Array<object>} [options.sqliteBots] - mock SQLite bots for testing
 * @param {boolean} [options.dryRun=false] - do not write changes
 * @returns {Promise<{ report: object, reportPath: string }>}
 */
export async function reconcileState(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const dryRun = Boolean(options.dryRun);
  const { nodeBots, inventory, inventoryPath, stateDir } = await readNodeBots({ root });
  const sqliteResult = readSqliteBots({ root, dbPath: options.dbPath, sqliteBots: options.sqliteBots });

  const sqliteBots = sqliteResult.bots || [];
  const sqliteBotsMap = new Map();
  for (const b of sqliteBots) {
    if (b.bot_key) {
      sqliteBotsMap.set(b.bot_key, b);
    }
  }

  const allBotKeys = new Set([...nodeBots.keys(), ...sqliteBotsMap.keys()]);

  const conflicts = [];
  const importedFromSqlite = [];
  const skippedFromSqlite = [];
  const nodeOnly = [];
  const auditedBots = [];

  let inventoryModified = false;

  for (const botKey of allBotKeys) {
    const nodeBot = nodeBots.get(botKey);
    const sqliteBot = sqliteBotsMap.get(botKey);

    // Case 1: Present in both Node and SQLite
    if (nodeBot && sqliteBot) {
      const nodeUid = String(nodeBot.uid || "").trim();
      const sqliteUid = String(sqliteBot.uid || "").trim();

      const uidConflict = nodeUid !== sqliteUid;
      if (uidConflict) {
        conflicts.push({
          botKey,
          type: "UID_MISMATCH",
          nodeUid,
          sqliteUid,
          resolution: "kept_node_record",
          message: `UID conflict for "${botKey}": Node has "${nodeUid}" while SQLite has "${sqliteUid}". Node record kept.`,
        });
      }

      auditedBots.push({
        botKey,
        inNode: true,
        inSqlite: true,
        nodeUid,
        sqliteUid,
        uidMatch: !uidConflict,
        nodeStatus: nodeBot.status,
        sqliteStatus: sqliteBot.status,
        nodeHasCredentials: nodeBot.hasCredentials,
        sqliteHasCredentials: Boolean(sqliteBot.cookie_json),
        conflict: uidConflict ? "UID_MISMATCH" : null,
        action: "audited",
      });
    }
    // Case 2: Present ONLY in SQLite
    else if (!nodeBot && sqliteBot) {
      const hasUid = Boolean(sqliteBot.uid && String(sqliteBot.uid).trim() !== "");
      const cookieStr = typeof sqliteBot.cookie_json === "string" ? sqliteBot.cookie_json.trim() : "";
      const hasCookie = Boolean(cookieStr && cookieStr !== "[]" && cookieStr !== "{}" && cookieStr !== "null");

      if (hasUid && hasCookie) {
        // Valid credentials -> Import bot into Node state and inventory
        const newBotState = {
          uid: sqliteBot.uid,
          cookieDead: Boolean(sqliteBot.cookie_dead),
          cookieDeadReason: sqliteBot.cookie_dead_reason || null,
          displayName: sqliteBot.display_name || botKey,
          status: sqliteBot.status || "stopped",
          reconciledFromSqliteAt: new Date().toISOString(),
        };

        if (!dryRun) {
          await fs.mkdir(stateDir, { recursive: true });
          const statePath = path.join(stateDir, `${botKey}.json`);
          await fs.writeFile(statePath, JSON.stringify(newBotState, null, 2), "utf8");

          inventory[botKey] = {
            name: botKey,
            displayName: sqliteBot.display_name || botKey,
            uid: sqliteBot.uid,
            status: sqliteBot.status || "stopped",
            isMain: Boolean(sqliteBot.is_main),
            cookieDead: Boolean(sqliteBot.cookie_dead),
            reconciledFromSqliteAt: new Date().toISOString(),
          };
          inventoryModified = true;
        }

        importedFromSqlite.push({
          botKey,
          uid: sqliteBot.uid,
          status: sqliteBot.status || "stopped",
          displayName: sqliteBot.display_name || botKey,
          action: "created_state_and_registered",
        });

        auditedBots.push({
          botKey,
          inNode: false,
          inSqlite: true,
          nodeUid: null,
          sqliteUid: sqliteBot.uid,
          uidMatch: false,
          nodeStatus: null,
          sqliteStatus: sqliteBot.status,
          nodeHasCredentials: false,
          sqliteHasCredentials: true,
          conflict: null,
          action: "imported_from_sqlite",
        });
      } else {
        // Invalid credentials -> Skip
        const reason = !hasUid ? "Missing UID" : "Missing cookies";
        skippedFromSqlite.push({
          botKey,
          uid: sqliteBot.uid || null,
          reason: "INVALID_CREDENTIALS",
          detail: reason,
        });

        auditedBots.push({
          botKey,
          inNode: false,
          inSqlite: true,
          nodeUid: null,
          sqliteUid: sqliteBot.uid || null,
          uidMatch: false,
          nodeStatus: null,
          sqliteStatus: sqliteBot.status,
          nodeHasCredentials: false,
          sqliteHasCredentials: hasCookie,
          conflict: null,
          action: "skipped_invalid_credentials",
        });
      }
    }
    // Case 3: Present ONLY in Node
    else if (nodeBot && !sqliteBot) {
      nodeOnly.push({
        botKey,
        uid: nodeBot.uid,
        status: nodeBot.status,
        source: nodeBot.source,
      });

      auditedBots.push({
        botKey,
        inNode: true,
        inSqlite: false,
        nodeUid: nodeBot.uid,
        sqliteUid: null,
        uidMatch: false,
        nodeStatus: nodeBot.status,
        sqliteStatus: null,
        nodeHasCredentials: nodeBot.hasCredentials,
        sqliteHasCredentials: false,
        conflict: null,
        action: "node_only",
      });
    }
  }

  if (inventoryModified && !dryRun) {
    try {
      await fs.writeFile(inventoryPath, JSON.stringify(inventory, null, 2), "utf8");
    } catch {}
  }

  const report = {
    timestamp: new Date().toISOString(),
    dryRun,
    sqliteDbPath: sqliteResult.dbPath || null,
    sqliteDbFound: sqliteResult.exists,
    sqliteTableFound: sqliteResult.tableExists ?? false,
    summary: {
      nodeBotCount: nodeBots.size,
      sqliteBotCount: sqliteBots.length,
      inBothCount: auditedBots.filter((b) => b.inNode && b.inSqlite).length,
      conflictsCount: conflicts.length,
      importedFromSqliteCount: importedFromSqlite.length,
      skippedFromSqliteCount: skippedFromSqlite.length,
      nodeOnlyCount: nodeOnly.length,
    },
    conflicts,
    importedFromSqlite,
    skippedFromSqlite,
    nodeOnly,
    auditedBots,
  };

  // Save report to .runtime/state-reconciliation-report.json
  const runtimeDir = path.resolve(root, ".runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  const reportPath = path.join(runtimeDir, "state-reconciliation-report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  return { report, reportPath };
}

/**
 * CLI Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let dbPath = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) {
      root = args[++i];
    } else if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  console.log("=================================================");
  console.log("   Node-Rust Bot State Reconciliation & Audit   ");
  console.log("=================================================");
  console.log(`Project root: ${path.resolve(root)}`);
  console.log(`Dry run:      ${dryRun}`);

  const { report, reportPath } = await reconcileState({ root, dbPath, dryRun });

  console.log(`SQLite DB:    ${report.sqliteDbPath || "None"}`);
  console.log(`SQLite Found: ${report.sqliteDbFound ? "YES" : "NO (no SQLite DB found yet)"}`);
  if (report.sqliteDbFound) {
    console.log(`Table 'bots': ${report.sqliteTableFound ? "YES" : "NO"}`);
  }
  console.log("");

  // Summary Table
  console.log("--- Reconciliation Summary ---");
  console.table({
    "Total Node bots": { Count: report.summary.nodeBotCount },
    "Total SQLite bots": { Count: report.summary.sqliteBotCount },
    "Matched in Both": { Count: report.summary.inBothCount },
    "UID Conflicts (kept Node)": { Count: report.summary.conflictsCount },
    "Imported from SQLite": { Count: report.summary.importedFromSqliteCount },
    "Skipped SQLite (invalid creds)": { Count: report.summary.skippedFromSqliteCount },
    "Node-only Bots": { Count: report.summary.nodeOnlyCount },
  });

  if (report.auditedBots.length > 0) {
    console.log("\n--- Bot Audit Details ---");
    const displayBots = report.auditedBots.map((b) => ({
      "Bot Key": b.botKey,
      "Node UID": b.nodeUid || "-",
      "SQLite UID": b.sqliteUid || "-",
      "Node Status": b.nodeStatus || "-",
      "SQLite Status": b.sqliteStatus || "-",
      "Action / Status": b.conflict ? `CONFLICT: ${b.conflict}` : b.action,
    }));
    console.table(displayBots);
  }

  if (report.conflicts.length > 0) {
    console.log("\n--- Conflicts Resolved ---");
    for (const c of report.conflicts) {
      console.warn(`[!] ${c.message}`);
    }
  }

  console.log(`\nReconciliation report written to: ${reportPath}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error("Reconciliation error:", err);
    process.exit(1);
  });
}
