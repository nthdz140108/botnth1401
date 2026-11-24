import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";

let systemInformationPromise = null;

export const moduleFile = fileURLToPath(import.meta.url);
export const moduleDir = path.dirname(moduleFile);

export function resolveProjectRoot(input = process.env.PROJECT_ROOT || process.env.ProjectRoot || path.resolve(moduleDir, "..", "..")) {
  return path.resolve(String(input));
}

export function resolveDataDir(input = process.env.MYBOT_DATA_DIR || path.join(resolveProjectRoot(), "mybot")) {
  return path.resolve(String(input));
}

export const projectRoot = resolveProjectRoot();
export const dataDir = resolveDataDir();

export function resolveDataPath(...segments) {
  return path.join(dataDir, ...segments);
}

export function normalizeExecutableCandidates(...candidates) {
  return [...new Set(candidates.flat().filter((value) => typeof value === "string" && value.trim()))];
}

export function resolveExecutableSync(candidates, { probeArgs = ["--version"] } = {}) {
  for (const candidate of normalizeExecutableCandidates(candidates)) {
    try {
      execFileSync(candidate, probeArgs, { stdio: "ignore", cwd: projectRoot, env: process.env, windowsHide: true });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: options.stdio || "pipe",
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(Object.assign(new Error(stderr || `Command failed: ${command}`), { code, stdout, stderr }));
    });
  });
}

export async function resolveExecutable(candidates, { probeArgs = ["--version"] } = {}) {
  for (const candidate of normalizeExecutableCandidates(candidates)) {
    try {
      await runCommand(candidate, probeArgs, { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function openPathInDefaultApp(targetPath, { platform = process.platform, spawnImpl = spawn, windowsHide = true } = {}) {
  const resolvedPath = path.resolve(String(targetPath));
  const argsByPlatform = {
    win32: ["cmd", ["/c", "start", "", resolvedPath]],
    darwin: ["open", [resolvedPath]],
    default: ["xdg-open", [resolvedPath]],
  };
  const [command, args] = argsByPlatform[platform] || argsByPlatform.default;
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide,
    });
    child?.unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

export async function getSystemSnapshot() {
  if (!systemInformationPromise) {
    systemInformationPromise = import("systeminformation").catch(() => null);
  }
  const mod = await systemInformationPromise;
  if (!mod?.default) return null;
  const [osInfo, mem, fsSize] = await Promise.allSettled([mod.default.osInfo(), mod.default.mem(), mod.default.fsSize()]);
  return {
    os: osInfo.status === "fulfilled" ? osInfo.value : null,
    memory: mem.status === "fulfilled" ? mem.value : null,
    disks: fsSize.status === "fulfilled" ? fsSize.value : null,
  };
}
