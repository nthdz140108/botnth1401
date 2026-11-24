import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRankStore } from "../src/service-debug/info-service/rank-store.js";

async function makeStore(options = {}, seed = null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rank-store-"));
  const context = { uid: options.uid || "test-bot", rankInfoPath: path.join(dir, "rank-info.json") };
  if (seed) {
    await fs.mkdir(path.dirname(context.rankInfoPath), { recursive: true });
    await fs.writeFile(context.rankInfoPath, JSON.stringify(seed), "utf8");
  }
  return { store: createRankStore(context, { flushIntervalMs: 20 }), context, dir };
}

test("two increments for same user yield score 2 in memory with a single pending flush", async () => {
  const { store } = await makeStore();
  store.increment("g1", "u1", "Alice", "Group One");
  store.increment("g1", "u1", "Alice", "Group One");
  const group = store.snapshot("g1");
  assert.equal(group.users.find((u) => u.UID === "u1").Rank, 2);
  assert.equal(store.isDirty, true);

  // Flush writes exactly once and clears dirty flag
  const result = store.flush();
  assert.equal(result.flushed, true);
  assert.equal(store.isDirty, false);
  const secondFlush = store.flush();
  assert.equal(secondFlush.flushed, false);
});

test("snapshot reads come from memory without re-reading the file", async () => {
  const { store } = await makeStore({}, { groups: { g9: { users: [{ UID: "x", UserName: "X", Rank: 7 }] } } });
  const snap = store.snapshot("g9");
  assert.equal(snap.users[0].Rank, 7);
  // Mutating snapshot must not affect store memory
  snap.users[0].Rank = 100;
  assert.equal(store.snapshot("g9").users[0].Rank, 7);
});

test("reset clears memory and rewrites the file immediately", async () => {
  const { store, dir } = await makeStore();
  store.increment("g1", "u1", "Alice");
  store.reset();
  const raw = JSON.parse(await fs.readFile(path.join(dir, "rank-info.json"), "utf8"));
  assert.deepEqual(raw, { groups: {} });
});

test("replace is write-through for administrative callers", async () => {
  const { store, dir } = await makeStore();
  store.replace({ groups: { gz: { users: [{ UID: "a", UserName: "A", Rank: 3 }] } } });
  const raw = JSON.parse(await fs.readFile(path.join(dir, "rank-info.json"), "utf8"));
  assert.equal(raw.groups.gz.users[0].Rank, 3);
});

test("admin context mirrors legacy rank file during flush; child does not", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rank-mirror-"));
  await fs.mkdir(path.join(tmpRoot, "assets", "json-data"), { recursive: true });
  const adminContext = {
    uid: "admin",
    rankInfoPath: path.join(tmpRoot, "mybot", "instances", "admin", "data", "rank-info.json"),
  };
  const store = createRankStore(adminContext, { projectRoot: tmpRoot });
  store.increment("g1", "u1", "Alice");
  store.flush();
  const legacyRaw = JSON.parse(await fs.readFile(path.join(tmpRoot, "assets", "json-data", "rank-info.json"), "utf8"));
  assert.equal(legacyRaw.groups.g1.users[0].UID, "u1");

  const childContext = {
    uid: "child-1",
    rankInfoPath: path.join(tmpRoot, "mybot", "instances", "child-1", "data", "rank-info.json"),
  };
  const childStore = createRankStore(childContext, { projectRoot: tmpRoot });
  childStore.increment("g1", "u2", "Bob");
  childStore.flush();
  await fs.access(childContext.rankInfoPath);
  const legacyAfter = JSON.parse(await fs.readFile(path.join(tmpRoot, "assets", "json-data", "rank-info.json"), "utf8"));
  assert.equal(legacyAfter.groups.g1.users.length, 1, "child flush must not touch legacy mirror");
});

test("close performs a final flush and stops the timer", async () => {
  const { store } = await makeStore();
  store.increment("gc", "uc", "Close");
  await store.close();
  assert.equal(store.isDirty, false);
});
