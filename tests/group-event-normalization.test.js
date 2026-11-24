import test from "node:test";
import assert from "node:assert/strict";
import { GroupEventType } from "../src/api-zalo/models/index.js";
import {
  getGroupEventActorId,
  getGroupEventMembers,
} from "../src/automations/group-event-utils.js";

test("group member events tolerate missing and empty updateMembers", () => {
  assert.deepEqual(
    getGroupEventMembers({ type: GroupEventType.JOIN, data: {} }),
    []
  );
  assert.deepEqual(
    getGroupEventMembers({ type: GroupEventType.REMOVE_MEMBER, data: { updateMembers: [] } }),
    []
  );
});

test("group member events discard malformed member entries", () => {
  const members = getGroupEventMembers({
    type: GroupEventType.BLOCK_MEMBER,
    data: {
      updateMembers: [null, {}, { id: "user-1" }, { id: 0 }],
    },
  });

  assert.deepEqual(members, [{ id: "user-1" }, { id: 0 }]);
});

test("group event actor prefers sourceId and falls back to actorId", () => {
  assert.equal(
    getGroupEventActorId({ data: { sourceId: "source-1", actorId: "actor-1" } }),
    "source-1"
  );
  assert.equal(
    getGroupEventActorId({ data: { actorId: "actor-1" } }),
    "actor-1"
  );
});
