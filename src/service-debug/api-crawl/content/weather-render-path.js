import fs from "node:fs";
import path from "node:path";
import { tempDir } from "../../../utils/io-json.js";

export function resolveCanvasTempPath(fileName, baseDir = tempDir) {
  const dir = baseDir || path.resolve(process.cwd(), "assets", "temp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}
