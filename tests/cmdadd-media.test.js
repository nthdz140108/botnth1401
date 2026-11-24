import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyMime,
  mediaKindOf,
  validateDownloadedMedia,
} from "../src/commands/custom-commands/media.js";
import {
  createCustomCommand,
  findCustomCommand,
  customCommandsMediaDir,
  customCommandsRoot,
  customMediaPath,
  removeCustomCommand,
} from "../src/commands/custom-commands/store.js";
import {
  MEDIA_KIND_TEXT,
  MEDIA_KIND_IMAGE,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  mediaExtFor,
  mediaKindToMime,
} from "../src/commands/custom-commands/media-constants.js";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cmdadd-media-"));
}

test("media classification maps mime to kind", () => {
  assert.equal(classifyMime("image/jpeg"), MEDIA_KIND_IMAGE);
  assert.equal(classifyMime("video/mp4"), MEDIA_KIND_VIDEO);
  assert.equal(classifyMime("audio/mpeg"), MEDIA_KIND_AUDIO);
  assert.equal(classifyMime("application/pdf"), null);
});

test("mediaKindOf returns text when no media attached", () => {
  assert.equal(mediaKindOf({ media: null }), MEDIA_KIND_TEXT);
  assert.equal(mediaKindOf({}), MEDIA_KIND_TEXT);
  assert.equal(mediaKindOf({ media: { kind: MEDIA_KIND_IMAGE } }), MEDIA_KIND_IMAGE);
  assert.equal(mediaKindOf({ media: { type: "video/mp4" } }), MEDIA_KIND_VIDEO);
});

test("validateDownloadedMedia rejects invalid kind and oversize files", () => {
  assert.throws(() => validateDownloadedMedia(Buffer.from("x"), "application/pdf", null), { code: "INVALID_MEDIA_KIND" });
  assert.throws(() => validateDownloadedMedia(Buffer.alloc(0), "image/jpeg", null), { code: "EMPTY_MEDIA" });
  const big = Buffer.alloc(20 * 1024 * 1024);
  assert.throws(() => validateDownloadedMedia(big, "image/jpeg", { mime: "image/jpeg" }), { code: "MEDIA_TOO_LARGE" });
});

test("validateDownloadedMedia accepts a valid image", () => {
  const result = validateDownloadedMedia(Buffer.from("data"), "image/jpeg", { mime: "image/jpeg" });
  assert.equal(result.kind, MEDIA_KIND_IMAGE);
  assert.equal(result.size, 4);
});

test("media constants align ext and mime", () => {
  assert.equal(mediaExtFor(MEDIA_KIND_IMAGE), "jpg");
  assert.equal(mediaExtFor(MEDIA_KIND_AUDIO), "mp3");
  assert.equal(mediaExtFor(MEDIA_KIND_VIDEO), "mp4");
  assert.equal(mediaKindToMime(MEDIA_KIND_AUDIO), "audio/mpeg");
});

test("create with media moves the file into the store under <id>.<ext>", async () => {
  const root = makeRoot();
  fs.mkdirSync(customCommandsRoot(root), { recursive: true });
  const srcPath = path.join(root, "avatar.jpg");
  fs.writeFileSync(srcPath, "fake-image-bytes");

  const command = await createCustomCommand({
    name: "hinh",
    text: "ảnh đẹp",
    media: { tempPath: srcPath, kind: MEDIA_KIND_IMAGE },
    createdBy: "u1",
    root,
  });

  assert.ok(command.media.path, "media path must be set");
  const expectedPath = customMediaPath(root, command.id, "jpg");
  assert.equal(command.media.path, expectedPath);
  assert.equal(fs.existsSync(command.media.path), true);
  assert.equal(fs.existsSync(srcPath), false, "temp file should be moved, not copied");
});

test("remove deletes the media file and cleans the record", async () => {
  const root = makeRoot();
  fs.mkdirSync(customCommandsRoot(root), { recursive: true });
  const srcPath = path.join(root, "audio.mp3");
  fs.writeFileSync(srcPath, "fake-audio-bytes");

  const command = await createCustomCommand({
    name: "nhac",
    text: "nhạc hay",
    media: { tempPath: srcPath, kind: MEDIA_KIND_AUDIO },
    createdBy: "u1",
    root,
  });

  const removed = await removeCustomCommand(command.id, root);
  assert.equal(removed.id, command.id);
  assert.equal(fs.existsSync(command.media.path), false, "media should be deleted on removal");
  assert.equal(findCustomCommand("nhac", root), null);
});

test("persistence survives a fresh read from disk", async () => {
  const root = makeRoot();
  await createCustomCommand({ name: "greet", text: "Xin chào", createdBy: "u1", root });
  const found = findCustomCommand("greet", root);
  assert.equal(found.text, "Xin chào");
  assert.ok(customCommandsMediaDir(root));
});
