import fs from "node:fs";
import path from "node:path";
import { getProjectRoot } from "../env.js";
import { tempDir as instanceTempDir } from "../io-json.js";

export function resolveCanvasTempBase() {
  return instanceTempDir || path.join(getProjectRoot(), "assets", "temp");
}

export function createCanvasTempPath(fileName, baseDir = resolveCanvasTempBase()) {
  const safeName = path.basename(String(fileName || `canvas_${Date.now()}.png`));
  const targetDir = baseDir || path.join(getProjectRoot(), "assets", "temp");
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch {}
  return path.join(targetDir, safeName);
}
