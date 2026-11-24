import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePrObjects, normalizeWebPrConfig } from "../src/service-debug/scheduler/pr-config.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schedulerSource = fs.readFileSync(
  path.join(projectRoot, "src", "service-debug", "scheduler", "pr-zalo.js"),
  "utf8",
);

const validPrObject = {
  ten: "promo",
  idZalo: "123",
  noiDung: "hello",
  hinhAnh: ["a.png"],
  video: [],
  link: { a: "https://x" },
  thoiGianGui: ["09:00"],
  customContent: {},
  isContentActive: false,
  isImageActive: true,
  isVideoActive: false,
  isCardActive: true,
};

test("normalizePrObjects repairs missing or invalid prObjects collections", () => {
  assert.deepEqual(normalizePrObjects(undefined), []);
  assert.deepEqual(normalizePrObjects(null), []);
  assert.deepEqual(normalizePrObjects("nope"), []);
  assert.deepEqual(normalizePrObjects({ ten: "obj" }), []);

  const normalized = normalizePrObjects([validPrObject, {}]);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], validPrObject);
  assert.equal(normalized[1].ten, "");
  assert.deepEqual(normalized[1].thoiGianGui, []);
  assert.deepEqual(normalized[1].customContent, {});
  assert.equal(normalized[1].isContentActive, true);
});

test("normalizeWebPrConfig keeps fresh child configs scheduler-safe without mutating input", () => {
  const freshChildConfig = {
    selectedGroups: { g1: true },
    selectedFriends: {},
    privateEnabled: true,
    groupEnabled: true,
  };
  const snapshot = JSON.parse(JSON.stringify(freshChildConfig));

  const normalized = normalizeWebPrConfig(freshChildConfig);

  assert.deepEqual(normalized.prObjects, []);
  assert.deepEqual(normalized.selectedGroups, { g1: true });
  assert.deepEqual(normalized.selectedFriends, {});
  assert.equal(normalized.privateEnabled, true);
  assert.deepEqual(freshChildConfig, snapshot);

  assert.deepEqual(normalizeWebPrConfig(null).prObjects, []);
  assert.deepEqual(normalizeWebPrConfig(undefined).selectedGroups, {});
});

test("scheduler normalizes web config before iterating pr jobs", () => {
  assert.match(schedulerSource, /normalizeWebPrConfig|normalizePrObjects/);
  assert.doesNotMatch(schedulerSource, /for \(const prObject of config\.prObjects\)/);
});
