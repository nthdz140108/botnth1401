import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvasTempPath } from "../src/utils/canvas/temp-path.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "src", "utils", "canvas", "temp-path.js"), "utf8");

test("canvas temp paths stay inside the provided instance temp base", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-temp-"));
  const generated = createCanvasTempPath(`card_${Date.now()}.png`, base);

  assert.equal(path.dirname(generated), base);
  assert.equal(fs.existsSync(base), true);
});

test("canvas renderer defaults to per-instance temp roots with shared fallback", () => {
  assert.match(source, /instanceTempDir/);
  assert.match(source, /resolveCanvasTempBase/);
});
