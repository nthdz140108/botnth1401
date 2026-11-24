import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SKIP_ENV_VALIDATION = "1";
process.env.TRAINING_WRITE_DEBOUNCE_MS = "50";

const { loadTrainingData, saveTrainingData, learnFromChat, findResponse, flushTrainingData } = await import(
  "../src/service-debug/chat-bot/bot-learning/dqt-bot.js"
);

test("training lookup does not re-parse the file when mtime is unchanged", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "training-"));
  const trainingPath = path.join(tmp, "data-training.json");
  await fs.writeFile(trainingPath, JSON.stringify({ t1: { listTrain: { hello: [{ response: "hi", isTemporary: false }] } } }), "utf8");

  const botInfo = { dataTrainingPath: trainingPath };
  const envMod = await import("../src/utils/env.js");
  const originalCfgPath = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(tmp, "bot.json");
  await fs.writeFile(process.env.CONFIG_PATH, JSON.stringify(botInfo), "utf8");
  envMod.resetCache();

  try {
    const first = loadTrainingData();
    assert.equal(first.t1.listTrain.hello[0].response, "hi");

    // findResponse uses the in-memory cache
    const responses = findResponse("well hello there", "t1");
    assert.deepEqual(responses, ["hi"]);

    // learnFromChat updates memory synchronously
    learnFromChat("hello", "t1", "temp reply", "Group");
    const after = loadTrainingData();
    assert.ok(after.t1.listTrain.hello.some((r) => (typeof r === "string" ? r === "temp reply" : r.response === "temp reply")));

    // Persist happens via the write queue, not inline
    await new Promise((resolve) => setTimeout(resolve, 120));
    const raw = JSON.parse(await fs.readFile(trainingPath, "utf8"));
    assert.ok(raw.t1.listTrain.hello.some((r) => r.response === "temp reply"));
  } finally {
    process.env.CONFIG_PATH = originalCfgPath;
    envMod.resetCache();
  }
});

test("saveTrainingData batches multiple writes into one disk write", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "training-batch-"));
  const trainingPath = path.join(tmp, "data-training.json");
  await fs.writeFile(trainingPath, "{}", "utf8");
  const envMod = await import("../src/utils/env.js");
  const prev = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(tmp, "bot.json");
  await fs.writeFile(process.env.CONFIG_PATH, JSON.stringify({ dataTrainingPath: trainingPath }), "utf8");
  envMod.resetCache();
  try {
    let statCount = 0;
    saveTrainingData({ a: 1 });
    saveTrainingData({ a: 2 });
    saveTrainingData({ a: 3 });
    assert.equal(loadTrainingData().a, 3);
    await flushTrainingData();
    const raw = JSON.parse(await fs.readFile(trainingPath, "utf8"));
    assert.equal(raw.a, 3);
  } finally {
    process.env.CONFIG_PATH = prev;
    envMod.resetCache();
  }
});

test("external dashboard writes are picked up within cache refresh", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "training-ext-"));
  const trainingPath = path.join(tmp, "data-training.json");
  await fs.writeFile(trainingPath, "{}", "utf8");
  const envMod = await import("../src/utils/env.js");
  const prev = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(tmp, "bot.json");
  await fs.writeFile(process.env.CONFIG_PATH, JSON.stringify({ dataTrainingPath: trainingPath }), "utf8");
  envMod.resetCache();
  try {
    assert.deepEqual(Object.keys(loadTrainingData()), []);
    // Simulate dashboard writing config externally
    await fs.writeFile(trainingPath, JSON.stringify({ t2: { listTrain: {} } }), "utf8");
    // Force mtime change on Windows FAT/NTFS granularity
    const now = new Date(Date.now() + 2000);
    await fs.utimes(trainingPath, now, now);
    const reloaded = loadTrainingData();
    assert.ok(reloaded.t2, "external write should be visible");
  } finally {
    process.env.CONFIG_PATH = prev;
    envMod.resetCache();
  }
});
