import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocmemStore, closeAllLocmemStores } from "../src/service-debug/locmem/locmem-store.js";
import { trackLocmemReaction } from "../src/service-debug/locmem/locmem-tracker.js";
import { getVietnamDateKey } from "../src/service-debug/locmem/time-util.js";

test("group HAHA is counted while private reactions are ignored", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locmem-reaction-"));
  const dbPath = path.join(dir, "activity");
  const store = new LocmemStore({ dbPath, botUid: "bot" });
  const bot = { locmemDbPath: dbPath, botKey: "bot" };
  t.after(() => { closeAllLocmemStores(); fs.rmSync(dir, { recursive: true, force: true }); });
  trackLocmemReaction({}, { isGroup: true, threadId: "group", data: { uidFrom: "member", content: { rType: 0 } } }, bot);
  trackLocmemReaction({}, { isGroup: false, threadId: "private", data: { uidFrom: "member", idTo: "private", content: { rType: 5 } } }, bot);
  assert.equal(store.getMemberActivity("group", "member", getVietnamDateKey())?.reactionCount, 1);
  assert.equal(store.getMemberActivity("private", "member", getVietnamDateKey()), null);
});
