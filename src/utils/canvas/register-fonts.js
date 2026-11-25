import fs from "node:fs";
import path from "node:path";
import { registerFont } from "canvas";
import { getProjectRoot } from "../env.js";

let fontsRegistered = false;

const FONT_DEFINITIONS = [
  { file: "BeVietnamPro-Bold.ttf", family: "BeVietnamPro", weight: "bold" },
  { file: "BeVietnamPro-Bold.ttf", family: "BeVietnamPro-Bold", weight: "bold" },
  { file: "BeVietnamPro-Bold.ttf", family: "Be Vietnam Pro", weight: "bold" },
  { file: "UTMAvoBold.ttf", family: "UTMAvoBold", weight: "bold" },
  { file: "NotoSans-Regular.ttf", family: "NotoSans", weight: "normal" },
  { file: "NotoEmoji-Bold.ttf", family: "NotoEmoji", weight: "bold" },
  { file: "arial.ttf", family: "Arial", weight: "normal" },
];

export function ensureCanvasFontsRegistered() {
  if (fontsRegistered) return true;
  const fontsDir = path.join(getProjectRoot(), "assets", "fonts");
  for (const def of FONT_DEFINITIONS) {
    const fontPath = path.join(fontsDir, def.file);
    if (!fs.existsSync(fontPath)) continue;
    try {
      registerFont(fontPath, { family: def.family, weight: def.weight });
    } catch {
      // Ignore duplicate or platform font registration warnings
    }
  }
  fontsRegistered = true;
  return true;
}

export function resolveCanvasFontPath(preferredPaths = []) {
  const root = getProjectRoot();
  for (const candidate of preferredPaths) {
    if (!candidate) continue;
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  const fallback = path.join(root, "assets", "fonts", "BeVietnamPro-Bold.ttf");
  return fs.existsSync(fallback) ? fallback : null;
}
