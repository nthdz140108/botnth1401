import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getFfmpegExecutableSync, getFfprobeExecutableSync } from "../src/utils/runtime-dependencies.js";
import { resolveYtDlpCommand } from "../src/service-debug/api-crawl/youtube/youtube-runtime.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredPaths = [
  "package.json",
  "src/index.js",
  "src/bootstrap.js",
  "src/commands/command-registry.js",
  "src/commands/command-permission-policy.js",
  "assets/json-data/command.json",
  "mybot/defaultCommand.json",
  "dashboard/server.js",
];

const errors = [];
const warnings = [];

// 1. Node.js version check (>= 20)
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  errors.push(`Node.js >= 20 required (detected v${process.versions.node})`);
}

// 2. Windows Server 2012 / 2012 R2 check (NT 6.2 / 6.3)
if (process.platform === "win32") {
  const rel = os.release().split(".").map((n) => Number.parseInt(n, 10));
  if (rel[0] === 6 && (rel[1] === 2 || rel[1] === 3)) {
    if (process.env.NODE_SKIP_PLATFORM_CHECK !== "1") {
      warnings.push("Windows Server 2012/2012 R2 detected without NODE_SKIP_PLATFORM_CHECK=1 (run via run.bat / install.bat)");
    }
  }
}

// 3. Required project structure check
for (const rel of requiredPaths) {
  if (!fs.existsSync(path.join(projectRoot, rel))) {
    errors.push(`Missing required path: ${rel}`);
  }
}

// 4. Ensure sandboxed .runtime directories are writable
try {
  const tempDir = path.join(projectRoot, ".runtime", "temp");
  const leasesDir = path.join(tempDir, ".leases");
  fs.mkdirSync(leasesDir, { recursive: true });
  const probeFile = path.join(tempDir, `.doctor-probe-${process.pid}`);
  fs.writeFileSync(probeFile, "ok", "utf8");
  fs.rmSync(probeFile, { force: true });
} catch (error) {
  errors.push(`Cannot write to .runtime/temp: ${error.message}`);
}

// 5. Check Dashboard build & Media binaries (advisory warnings if running in bare CI)
if (!fs.existsSync(path.join(projectRoot, "dashboard", "dist", "index.html"))) {
  warnings.push("dashboard/dist/index.html not built yet (run: npm run dashboard:build)");
}
if (!getFfmpegExecutableSync() || !getFfprobeExecutableSync()) {
  warnings.push("ffmpeg/ffprobe binary not found in .runtime/bin or PATH");
}
const ytDlp = resolveYtDlpCommand();
if (!ytDlp?.available) {
  warnings.push("yt-dlp binary not found in .runtime/bin or PATH");
}

for (const warn of warnings) {
  console.warn(`[doctor:warn] ${warn}`);
}

if (errors.length > 0) {
  console.error(`Missing/Invalid: ${errors.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`doctor ok (node=${process.versions.node}, platform=${process.platform}-${process.arch}, warnings=${warnings.length})`);
}
