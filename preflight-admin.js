import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname);
const instanceRoot = path.join(projectRoot, "mybot", "instances", "admin");
const requiredDirs = ["data", "logs", "temp", "resources", "generated", "state"].map((dir) =>
  path.join(instanceRoot, dir)
);
const source = (p) => path.join(projectRoot, p);
const target = (p) => path.join(instanceRoot, "data", p);

const fallbackManager = { groupRequiredReset: "-1", onBotPrivate: false };
const fallbackWebConfig = { selectedGroups: {}, selectedFriends: {}, privateEnabled: true, groupEnabled: true };

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function readJsonOr(filePath, fallback) {
  try {
    return await readJson(filePath);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function seedIfMissing(targetPath, sourcePath, fallback) {
  if (await exists(targetPath)) return;
  const data = sourcePath ? await readJsonOr(sourcePath, fallback) : fallback;
  await writeJsonAtomic(targetPath, data);
}

async function seedCommandConfig(targetPath) {
  if (await exists(targetPath)) {
    await readJson(targetPath).catch((err) => fail(13, `Preflight failed: command.json is invalid: ${err.message}`));
    return;
  }

  const assetCommand = source("assets/json-data/command.json");
  const defaultCommand = source("mybot/defaultCommand.json");
  if (await exists(assetCommand)) {
    await seedIfMissing(targetPath, assetCommand, { prefix: "!", commands: [] });
    return;
  }
  if (await exists(defaultCommand)) {
    await seedIfMissing(targetPath, defaultCommand, { prefix: "!", commands: [] });
    return;
  }
  await writeJsonAtomic(targetPath, { prefix: "!", commands: [] });
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

async function main() {
  for (const dir of requiredDirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  const config = await readJson(source("assets/config.json")).catch(() => null);
  if (!config || !config.cookie || !Array.isArray(config.cookie.cookies) || config.cookie.cookies.length === 0) {
    fail(11, "Preflight failed: assets/config.json does not contain valid admin credentials");
  }

  const state = await readJsonOr(source("mybot/state/admin.json"), {});
  if (state.cookieDead === true) {
    fail(12, "Preflight failed: admin cookie is marked dead");
  }

  await seedIfMissing(target("admin-list.json"), source("assets/data/list_admin.json"), []);
  await seedIfMissing(target("group-settings.json"), source("assets/data/group_settings.json"), {});

  await seedCommandConfig(target("command.json"));

  await seedIfMissing(target("manager.json"), source("assets/json-data/manager-bot.json"), fallbackManager);
  await seedIfMissing(target("prophylactic.json"), source("assets/json-data/prophylactic.json"), {
    prophylacticUploadAttachment: { enable: false, lastBlocked: "", numRequestZalo: 0 },
  });
  await seedIfMissing(target("training.json"), source("assets/json-data/data-training.json"), {});
  await seedIfMissing(target("rank-info.json"), source("assets/json-data/rank-info.json"), {});
  await seedIfMissing(target("web-config.json"), source("assets/web-config/web-config.json"), fallbackWebConfig);

  process.exit(0);
}

main().catch((err) => fail(1, `Preflight failed: ${err.message}`));
