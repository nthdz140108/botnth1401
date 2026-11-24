import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  updateMessageCache,
  getMessageCacheByMsgId,
  getMessageLRUCache,
  writeMessageJson,
} from "../src/utils/message-cache.js";

test("undo lookup finds message in LRU cache by msgId and cliMsgId", () => {
  const msg = {
    threadId: "g100",
    type: 1,
    data: {
      msgId: "mid-12345",
      cliMsgId: "clid-67890",
      ts: Date.now(),
      msgType: "chat.text",
      content: "Hello world for undo",
      dName: "Alice",
      uidFrom: "u123",
    },
  };

  updateMessageCache(msg);

  const foundByMsgId = getMessageCacheByMsgId("mid-12345");
  assert.ok(foundByMsgId);
  assert.equal(foundByMsgId.content, "Hello world for undo");

  const foundByCliMsgId = getMessageCacheByMsgId("clid-67890");
  assert.ok(foundByCliMsgId);
  assert.equal(foundByCliMsgId.content, "Hello world for undo");
});

test("undo lookup falls back to persistent store when evicted from memory LRU", () => {
  const lru = getMessageLRUCache();
  const evictedMsgId = "mid-evicted-999";
  const evictedCliMsgId = "clid-evicted-999";

  // Ensure not in RAM LRU
  lru.delete(evictedCliMsgId);

  // Write directly to persistent store simulating prior session / eviction
  const diskData = {
    [evictedCliMsgId]: {
      msgId: evictedMsgId,
      cliMsgId: evictedCliMsgId,
      content: "Evicted from RAM but preserved on disk",
      timestamp: Date.now(),
    },
  };
  writeMessageJson(diskData);

  // Lookup should find it from disk fallback and re-populate RAM LRU
  const restored = getMessageCacheByMsgId(evictedMsgId);
  assert.ok(restored, "Should find message from disk fallback");
  assert.equal(restored.content, "Evicted from RAM but preserved on disk");
  assert.ok(lru.has(evictedCliMsgId), "Should repopulate RAM LRU");
});
