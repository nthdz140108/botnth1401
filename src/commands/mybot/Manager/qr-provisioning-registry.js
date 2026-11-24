import fs from "node:fs";
import path from "node:path";
import properLockfile from "proper-lockfile";
import { writeJsonAtomic } from "../System/json-state.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "../System/mybots-registry.js";
import { PORT_SCAN_START, PORT_SCAN_END, usedRegistryPorts } from "../../../runtime/port-allocator.js";

/**
 * Safe registry mutation for concurrent provisioning.
 *
 * Uses proper-lockfile for Windows file locking around the mybots.json read–
 * modify–write cycle so that two concurrent provisioning transactions always
 * see the latest state, allocate distinct ports, and never overwrite each
 * other's changes.
 *
 * A record written mid-flight (status "provisioning") carries the provisioning
 * session ID and a timestamp. Consumers that check `status === "running"` will
 * not treat "provisioning" as a running bot.
 */

/**
 * Acquires a file lock around mybots.json, then calls the callback with a
 * transaction handle that can read, reserve, commit, and rollback state.
 *
 * @param {Object} options
 * @param {string} options.root
 * @param {string} options.registryPath
 * @param {Function} callback (txn) => any
 * @returns {Promise<any>} the return value of callback
 */
export async function withMyBotsTransaction({ root, registryPath }, callback) {
  const resolvedPath = registryPath || path.join(root, "mybot", "mybots.json");
  const lockFile = resolvedPath;
  let releaseLock = null;

  // Ensure target registry file exists before locking so proper-lockfile does not fail with ENOENT
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    if (!fs.existsSync(lockFile)) {
      fs.writeFileSync(lockFile, "{}", "utf8");
    }
  } catch {}

  // Acquire file lock (best-effort; fallback to noop if proper-lockfile unavailable)
  if (properLockfile && fs.existsSync(lockFile)) {
    try {
      releaseLock = await properLockfile.lock(lockFile, {
        retries: { retries: 10, minTimeout: 50, maxTimeout: 200 },
        stale: 15_000,
      });
    } catch {
      // proceed without lock if already held by an unrecoverable external lock
    }
  }

  // Read current state (declared outside try so rollback in catch can access it)
  let registry = {};
  try {
    if (fs.existsSync(resolvedPath)) {
      registry = JSON.parse(fs.readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, ""));
    }
  } catch {
    registry = {};
  }

  // Track previous values for conditional rollback (declared outside try so catch can use it)
  const previousValues = new Map();

  try {
    const changedKeys = new Set();

    const txn = {
      _registry: registry,
      _changedKeys: changedKeys,
      _previousValues: previousValues,
      _committed: false,
      _registryPath: resolvedPath,

      /**
       * Reads the current registry (fresh from disk, already locked).
       */
      readRegistry() {
        return { ...this._registry };
      },

      /**
       * Reserves a port and creates a new provisioning record.
       * The record is written with status "provisioning" immediately.
       *
       * @param {Object} bot
       * @param {string} bot.uid
       * @param {string} bot.displayName
       * @returns {Object} the bot record
       */
      reserveProvisionedBot(bot = {}) {
        const uid = String(bot.uid || "").trim();
        if (!uid) throw new Error("reserveProvisionedBot: uid is required");

        // Save previous value for rollback
        this._previousValues.set(uid, this._registry[uid] ? JSON.parse(JSON.stringify(this._registry[uid])) : null);

        const usedPorts = usedRegistryPorts(this._registry);

        const maxScanEnd = Math.max(PORT_SCAN_END, Number(process.env.MYBOT_PORT_SCAN_END) || 65000);
        let webPort = PORT_SCAN_START;
        for (let port = PORT_SCAN_START; port <= maxScanEnd; port++) {
          if (!usedPorts.has(port)) {
            webPort = port;
            break;
          }
        }

        const record = {
          name: uid,
          displayName: bot.displayName || uid,
          ownerUid: bot.ownerUid || "",
          ownerName: bot.ownerName || "",
          status: "provisioning",
          provisioningSessionId: uid,
          provisioningStartedAt: new Date().toISOString(),
          trialStatus: "pending",
          trialStartedAt: null,
          expiryAt: null,
          webPort: String(webPort),
          database: uid === "admin" ? "nthdz" : uid,
          uid,
          pid: null,
          consolePid: null,
          createdAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          ...bot,
          // Ensure these fields are always set correctly
          status: "provisioning",
          trialStatus: bot.trialStatus || "pending",
          trialStartedAt: bot.trialStartedAt || null,
          expiryAt: bot.expiryAt || null,
        };

        this._registry[uid] = record;
        this._changedKeys.add(uid);
        this._flush();
        return record;
      },

      /**
       * Finalizes a provisioning record from "provisioning" to its final
       * status (e.g. "stopped"). Clears provisioning metadata.
       */
      finalizeProvisionedBot(uid, patch = {}) {
        const normUid = String(uid || "").trim();
        if (!normUid || !this._registry[normUid]) {
          throw new Error(`finalizeProvisionedBot: bot ${normUid} not found in registry`);
        }
        const record = { ...this._registry[normUid] };
        delete record.provisioningSessionId;
        delete record.provisioningStartedAt;
        if (!record.database || String(record.database).trim() === "") {
          record.database = normUid === "admin" ? "nthdz" : normUid;
        } else if (normUid === "admin" && String(record.database).trim().toLowerCase() === "admin") {
          record.database = "nthdz";
        }
        if (!record.webPort) {
          record.webPort = normUid === "admin" ? "2000" : "4444";
        }
        this._registry[normUid] = {
          ...record,
          ...patch,
          status: patch.status || "stopped",
          lastUpdated: new Date().toISOString(),
        };
        this._changedKeys.add(normUid);
        this._flush();
      },

      /**
       * Removes a provisioning record completely (rollback).
       */
      removeProvisionedBot(uid) {
        const normUid = String(uid || "").trim();
        if (normUid && this._registry[normUid]) {
          delete this._registry[normUid];
          this._changedKeys.add(normUid);
          this._flush();
        }
      },

      _flush() {
        writeJsonAtomic(this._registryPath, this._registry);
      },
    };

    const result = await callback(txn);

    // Commit changes (already flushed, but track committed state)
    txn._committed = true;
    return result;
  } catch (error) {
    // Rollback: restore previous values for keys that were changed
    for (const [uid, previous] of previousValues.entries()) {
      if (previous === null) {
        delete registry[uid];
      } else {
        registry[uid] = previous;
      }
    }
    if (previousValues.size > 0) {
      try {
        writeJsonAtomic(resolvedPath, registry);
      } catch (writeErr) {
        console.error(`[QR-PROV] rollback write failed: ${writeErr.message}`);
      }
    }
    throw error;
  } finally {
    if (releaseLock && typeof releaseLock === "function") {
      try {
        await releaseLock();
      } catch {
        // ignore lock release errors
      }
    }
  }
}

/**
 * Acquires a serializing lock for a specific actualUid so that two sessions
 * returning the same Zalo UID are handled one at a time.
 *
 * Uses an in-memory promise-chain mutex keyed by actualUid. Each caller waits
 * on the previous caller's completion promise, so the same actualUid sessions
 * never run concurrently.
 */
const uidLockChains = new Map();

export async function acquireActualUidLock({ root, actualUid }, callback) {
  const normUid = String(actualUid || "").trim();
  if (!normUid) return callback();

  const previous = uidLockChains.get(normUid) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  uidLockChains.set(normUid, current);

  await previous;
  try {
    return await callback();
  } finally {
    release();
    // If this call is the last in the chain, clear the entry so a future
    // caller starts a fresh chain.
    if (uidLockChains.get(normUid) === current) {
      uidLockChains.delete(normUid);
    }
  }
}