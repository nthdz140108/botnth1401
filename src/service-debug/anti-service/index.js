import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { fileURLToPath } from "node:url";
import { getProjectRoot } from "../../utils/env.js";
import { getActiveRuntimeContext } from "../../utils/io-json.js";
import {
  ANTI_CONFIG_FILENAME,
  migrateAntiConfigFiles,
  normalizeAntiState,
} from "./anti-config-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyConfigPath = path.join(__dirname, ANTI_CONFIG_FILENAME);

function resolveAntiConfigPath() {
  try {
    const ctx = getActiveRuntimeContext();
    if (ctx?.antiConfigPath) {
      return ctx.antiConfigPath;
    }
  } catch {}
  return legacyConfigPath;
}

const antiState = {
  data: normalizeAntiState(),
  hasChanges: false,
};

export async function loadAntiConfig() {
  try {
    const rootDir = getProjectRoot();
    await migrateAntiConfigFiles(rootDir).catch(() => {});
    const targetPath = resolveAntiConfigPath();

    if (!fsSync.existsSync(targetPath) && fsSync.existsSync(legacyConfigPath) && targetPath !== legacyConfigPath) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(legacyConfigPath, targetPath).catch(() => {});
    }

    if (fsSync.existsSync(targetPath)) {
      const data = await fs.readFile(targetPath, "utf8");
      antiState.data = normalizeAntiState(JSON.parse(data.replace(/^\uFEFF/, "")));
    } else {
      antiState.data = normalizeAntiState();
    }
    antiState.hasChanges = false;
    console.log(chalk.green("Đã tải xong config anti service"));
  } catch (error) {
    console.error("Lỗi khi đọc file config anti:", error?.message || error);
  }
}

let saveChain = Promise.resolve();

export async function saveAntiConfig() {
  const runSave = async () => {
    try {
      const targetPath = resolveAntiConfigPath();
      const snapshot = normalizeAntiState(antiState.data);
      antiState.hasChanges = false;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const tmpPath = `${targetPath}.tmp-${process.pid}`;
      await fs.writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await fs.rename(tmpPath, targetPath);
    } catch (error) {
      console.error("Lỗi khi ghi file config anti:", error?.message || error);
    }
  };
  saveChain = saveChain.then(runSave, runSave);
  return saveChain;
}

export function updateAntiConfig(newData) {
  antiState.data = normalizeAntiState({ ...antiState.data, ...newData });
  antiState.hasChanges = true;
  saveAntiConfig().catch((err) => console.error("Lỗi lưu anti config:", err.message));
}

export async function startAntiConfigCheck() {
  await loadAntiConfig();
}

export const getAntiState = () => antiState;
