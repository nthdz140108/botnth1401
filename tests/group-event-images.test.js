import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import {
  createWelcomeImage,
  createGoodbyeImage,
  createKickImage,
  createBlockImage,
} from "../src/utils/canvas/event-image.js";
import { deleteFile } from "../src/utils/util.js";

test("group event images render successfully without ReferenceError (cs is not defined)", async () => {
  const dummyUser = {
    name: "Test User",
    avatar: "https://i.postimg.cc/tTwFPLV1/avt.jpg",
    genderId: 0,
  };

  const welcomePath = await createWelcomeImage(dummyUser, "Test Group", 1, "Admin", false);
  assert.ok(welcomePath && fs.existsSync(welcomePath), "Welcome image should exist");
  await deleteFile(welcomePath);

  const goodbyePath = await createGoodbyeImage(dummyUser, "Test Group", 1, false);
  assert.ok(goodbyePath && fs.existsSync(goodbyePath), "Goodbye image should exist");
  await deleteFile(goodbyePath);

  const kickPath = await createKickImage(dummyUser, "Test Group", 1, 0, "Admin", false);
  assert.ok(kickPath && fs.existsSync(kickPath), "Kick image should exist");
  await deleteFile(kickPath);

  const blockPath = await createBlockImage(dummyUser, "Test Group", 1, 0, "Admin", false);
  assert.ok(blockPath && fs.existsSync(blockPath), "Block image should exist");
  await deleteFile(blockPath);
});

test("group event images handle null/undefined userInfo safely", async () => {
  const welcomePath = await createWelcomeImage(null, "Test Group", 1, "Admin", false);
  assert.ok(welcomePath && fs.existsSync(welcomePath), "Welcome image should handle null user");
  await deleteFile(welcomePath);

  const goodbyePath = await createGoodbyeImage(undefined, "Test Group", 1, false);
  assert.ok(goodbyePath && fs.existsSync(goodbyePath), "Goodbye image should handle undefined user");
  await deleteFile(goodbyePath);
});
