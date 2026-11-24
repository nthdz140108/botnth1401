import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SKIP_ENV_VALIDATION = "1";
process.env.TRAINING_WRITE_DEBOUNCE_MS = "50";

const {
  loadTrainingData,
  saveTrainingData,
  flushTrainingData,
  flattenGroupTraining,
  listLearnedResponses,
  removeLearnedResponseByIndex,
} = await import("../src/service-debug/chat-bot/bot-learning/dqt-bot.js");

async function setup() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "learn-list-"));
  const trainingPath = path.join(tmp, "data-training.json");
  await fs.writeFile(trainingPath, "{}", "utf8");
  const envMod = await import("../src/utils/env.js");
  const prev = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = path.join(tmp, "bot.json");
  await fs.writeFile(process.env.CONFIG_PATH, JSON.stringify({ dataTrainingPath: trainingPath }), "utf8");
  envMod.resetCache();
  return { trainingPath, cleanup: async () => { process.env.CONFIG_PATH = prev; envMod.resetCache(); await flushTrainingData(); } };
}

test("listLearnedResponses only lists the calling group with stable numbering", async () => {
  const { cleanup } = await setup();
  try {
    const data = {
      groupA: {
        nameGroup: "A",
        listTrain: {
          "q1": [{ response: "a1", isTemporary: true }, { response: "a2", isTemporary: false }],
          "q2": [{ response: "b1", isTemporary: true }],
        },
      },
      groupB: {
        nameGroup: "B",
        listTrain: {
          "foreign": [{ response: "x", isTemporary: true }],
        },
      },
    };
    saveTrainingData(data);
    const result = listLearnedResponses("groupA", 1, 20);
    assert.equal(result.total, 3);
    assert.equal(result.items.length, 3);
    assert.equal(result.items[0].index, 1);
    assert.equal(result.items[1].index, 2);
    assert.equal(result.items[2].index, 3);
    assert.equal(result.items[0].question, "q1");
    assert.equal(result.items[1].question, "q1");
    assert.equal(result.items[2].question, "q2");
    assert.equal(result.items[0].response, "a1");
    assert.equal(result.items[1].isTemporary, false);
    assert.equal(result.items[2].isTemporary, true);
  } finally {
    await cleanup();
  }
});

test("listLearnedResponses paginates safely and clips the page", async () => {
  const { cleanup } = await setup();
  try {
    const listTrain = {};
    for (let i = 1; i <= 45; i++) {
      listTrain[`q${i}`] = [{ response: `r${i}`, isTemporary: true }];
    }
    saveTrainingData({ groupA: { nameGroup: "A", listTrain } });

    const page1 = listLearnedResponses("groupA", 1, 20);
    assert.equal(page1.total, 45);
    assert.equal(page1.totalPages, 3);
    assert.equal(page1.items.length, 20);
    assert.equal(page1.items[0].index, 1);

    const page2 = listLearnedResponses("groupA", 2, 20);
    assert.equal(page2.items.length, 20);
    assert.equal(page2.items[0].index, 21);

    const page3 = listLearnedResponses("groupA", 3, 20);
    assert.equal(page3.items.length, 5);
    assert.equal(page3.items[0].index, 41);

    // Out-of-range page clips to the last page
    const over = listLearnedResponses("groupA", 9, 20);
    assert.equal(over.page, 3);
  } finally {
    await cleanup();
  }
});

test("removeLearnedResponseByIndex removes one answer among multiple", async () => {
  const { cleanup } = await setup();
  try {
    const data = {
      groupA: {
        nameGroup: "A",
        listTrain: {
          "q1": [
            { response: "keep1", isTemporary: true },
            { response: "drop", isTemporary: false },
            { response: "keep2", isTemporary: true },
          ],
        },
      },
    };
    saveTrainingData(data);
    const result = removeLearnedResponseByIndex("groupA", 2);
    assert.equal(result.removed, true);
    assert.equal(result.question, "q1");
    assert.equal(result.response, "drop");
    assert.equal(result.questionRemoved, false);
    const reloaded = loadTrainingData();
    assert.equal(reloaded.groupA.listTrain.q1.length, 2);
    assert.ok(reloaded.groupA.listTrain.q1.some((r) => r.response === "keep1"));
    assert.ok(reloaded.groupA.listTrain.q1.some((r) => r.response === "keep2"));
    assert.ok(!reloaded.groupA.listTrain.q1.some((r) => r.response === "drop"));
  } finally {
    await cleanup();
  }
});

test("removeLearnedResponseByIndex removes the question when it is the last answer", async () => {
  const { cleanup } = await setup();
  try {
    const data = {
      groupA: {
        nameGroup: "A",
        listTrain: {
          "q1": [{ response: "only", isTemporary: true }],
          "q2": [{ response: "other", isTemporary: false }],
        },
      },
    };
    saveTrainingData(data);
    const result = removeLearnedResponseByIndex("groupA", 1);
    assert.equal(result.removed, true);
    assert.equal(result.question, "q1");
    assert.equal(result.questionRemoved, true);
    const reloaded = loadTrainingData();
    assert.equal(reloaded.groupA.listTrain.q1, undefined);
    assert.equal(reloaded.groupA.listTrain.q2.length, 1);
  } finally {
    await cleanup();
  }
});

test("removeLearnedResponseByIndex with out-of-range index does not mutate data", async () => {
  const { cleanup } = await setup();
  try {
    const data = {
      groupA: {
        nameGroup: "A",
        listTrain: {
          "q1": [{ response: "a1", isTemporary: true }],
        },
      },
    };
    saveTrainingData(data);
    const snapshot = JSON.stringify(loadTrainingData());
    const result = removeLearnedResponseByIndex("groupA", 99);
    assert.equal(result.removed, false);
    assert.equal(result.reason, "not_found");
    assert.equal(JSON.stringify(loadTrainingData()), snapshot);
  } finally {
    await cleanup();
  }
});

test("legacy string/object/array entries still list and remove correctly", async () => {
  const { cleanup } = await setup();
  try {
    const data = {
      groupA: {
        nameGroup: "A",
        listTrain: {
          "legacyString": "bare-string-answer",
          "legacyObject": { response: "obj-answer", isTemporary: false },
          "legacyArray": ["arr-answer-1", "arr-answer-2"],
        },
      },
    };
    saveTrainingData(data);
    const flat = flattenGroupTraining("groupA");
    assert.equal(flat.length, 4);
    assert.equal(flat[0].response, "bare-string-answer");
    assert.equal(flat[0].isTemporary, true);
    assert.equal(flat[1].response, "obj-answer");
    assert.equal(flat[1].isTemporary, false);

    // Remove the bare string answer (index 1)
    const res = removeLearnedResponseByIndex("groupA", 1);
    assert.equal(res.removed, true);
    assert.equal(res.questionRemoved, true);
    const reloaded = loadTrainingData();
    assert.equal(reloaded.groupA.listTrain.legacyString, undefined);

    // Remove one array element (index 3 = arr-answer-2)
    const res2 = removeLearnedResponseByIndex("groupA", 3);
    assert.equal(res2.removed, true);
    assert.equal(res2.questionRemoved, false);
    const reloaded2 = loadTrainingData();
    assert.deepEqual(reloaded2.groupA.listTrain.legacyArray, ["arr-answer-1"]);
  } finally {
    await cleanup();
  }
});

test("removeLearnedResponseByIndex rejects zero and negative indexes", async () => {
  const { cleanup } = await setup();
  try {
    const data = { groupA: { nameGroup: "A", listTrain: { "q1": [{ response: "a", isTemporary: true }] } } };
    saveTrainingData(data);
    const snapshot = JSON.stringify(loadTrainingData());
    assert.equal(removeLearnedResponseByIndex("groupA", 0).reason, "invalid");
    assert.equal(removeLearnedResponseByIndex("groupA", -3).reason, "invalid");
    assert.equal(JSON.stringify(loadTrainingData()), snapshot);
  } finally {
    await cleanup();
  }
});
