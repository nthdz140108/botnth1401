import test from "node:test";
import assert from "node:assert/strict";

import {
  showCooldownClock,
  clearAllInteractionCountdowns,
  buildCountdownReaction,
  applyReactionBatch,
  replaceCountdownReactionFrame,
  MAX_REACTION_BATCH_SIZE,
} from "../src/utils/interaction-countdown.js";
import {
  sendReactionWaitingCountdown,
} from "../src/commands/manager-command/check-countdown.js";
import { addReactionFactory } from "../src/api-zalo/apis/addReaction.js";
import { decodeAES, encodeAES } from "../src/api-zalo/utils.js";
import { MessageType } from "../src/api-zalo/models/Message.js";
import { appContext } from "../src/api-zalo/context.js";

function createApi() {
  const reactions = [];
  const reactionRequests = [];
  return {
    reactions,
    reactionRequests,
    async addReaction(iconOrOps, messages) {
      const ops = Array.isArray(iconOrOps)
        ? iconOrOps
        : [{ icon: iconOrOps, messages }];
      if (ops.length === 0) throw new Error("No reactions to apply");
      const recorded = ops.map((op) => {
        const list = Array.isArray(op.messages) ? op.messages : [op.messages];
        return { icon: op.icon, messages: list, count: list.length };
      });
      reactions.push(...recorded);
      reactionRequests.push(recorded);
      return { success: true };
    },
  };
}

test.beforeEach(() => {
  clearAllInteractionCountdowns();
});

test.afterEach(() => {
  clearAllInteractionCountdowns();
});

function createFakeScheduler(initialTime = 1000000) {
  const timers = new Map();
  let timerSeq = 0;
  let currentTime = initialTime;

  const now = () => currentTime;

  const schedule = (callback, delay) => {
    const id = ++timerSeq;
    timers.set(id, { callback, delay: delay ?? 1000, id });
    return id;
  };
  schedule.now = now;

  const cancelSchedule = (id) => {
    timers.delete(id);
  };

  const step = async () => {
    if (timers.size === 0) return false;
    const [id, entry] = timers.entries().next().value;
    timers.delete(id);
    currentTime += (entry.delay || 1000);
    await entry.callback();
    return true;
  };

  const stepAll = async () => {
    let count = 0;
    while (timers.size > 0 && count < 1000) {
      await step();
      count += 1;
    }
  };

  return { schedule, cancelSchedule, step, stepAll, now, timers };
}

test("showCooldownClock ticks each second: 3 -> 2 -> 1 -> cleared", async () => {
  const scheduler = createFakeScheduler();
  const api = createApi();
  const msg = { threadId: "t1", type: 1, data: { msgId: "m1", cliMsgId: "c1" } };

  const cancel = showCooldownClock({
    api,
    message: msg,
    remainingMs: 3000,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });
  assert.equal(typeof cancel, "function");

  await new Promise((r) => setImmediate(r));

  // t=0: frame 3 (single request)
  assert.equal(api.reactionRequests.length, 1);
  assert.deepEqual(
    api.reactions.map((r) => [r.icon, r.count]),
    [["CLOCK", 3]]
  );

  // t=1: frame 2
  await scheduler.step();
  assert.deepEqual(
    api.reactions.map((r) => [r.icon, r.count]),
    [["CLOCK", 3], ["UNDO", 3], ["CLOCK", 2]]
  );

  // t=2: frame 1
  await scheduler.step();
  assert.deepEqual(
    api.reactions.map((r) => [r.icon, r.count]),
    [["CLOCK", 3], ["UNDO", 3], ["CLOCK", 2], ["UNDO", 2], ["CLOCK", 1]]
  );

  // t=3: deadline reached, UNDO x 1, no new timer
  await scheduler.step();
  assert.deepEqual(
    api.reactions.map((r) => [r.icon, r.count]),
    [["CLOCK", 3], ["UNDO", 3], ["CLOCK", 2], ["UNDO", 2], ["CLOCK", 1], ["UNDO", 1]]
  );
  assert.equal(scheduler.timers.size, 0);
});

test("sendReactionWaitingCountdown routes through cooldown helper with count matching seconds and CLOCK icon", async () => {
  let scheduledCb = null;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (cb) => {
    scheduledCb = cb;
    return { unref() {} };
  };

  try {
    const api = createApi();
    const msg = { threadId: "t1", type: 1, data: { msgId: "m1", cliMsgId: "c1" } };

    await sendReactionWaitingCountdown(api, msg, 10, "testcmd");

    await new Promise((r) => setImmediate(r));
    assert.equal(api.reactions.length, 1);
    assert.equal(api.reactions[0].icon, "CLOCK");
    assert.equal(api.reactions[0].count, 10);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

import http from "node:http";

test("addReactionFactory protocol decodes AES payload: CLOCK gives rIcon='🕑', rType=55, source=6", async () => {
  const secretKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");
  appContext.secretKey = secretKey;
  appContext.imei = "mock-imei";
  appContext.cookie = "zpw_sek=mock";
  appContext.userAgent = "mock-ua";

  const interceptedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body).get("params");
      const decrypted = JSON.parse(decodeAES(secretKey, params));
      interceptedRequests.push({ url: req.url, body: decrypted });
      const responsePayload = {
        error_code: 0,
        data: encodeAES(secretKey, JSON.stringify({ error_code: 0, data: { status: 0 } })),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const serviceContext = {
      zpwServiceMap: {
        reaction: [baseUrl],
      },
    };

    const addReaction = addReactionFactory(serviceContext);
    const msg = {
      type: MessageType.GroupMessage,
      threadId: "group-100",
      data: { msgId: "12345", cliMsgId: "67890" },
    };

    // 1. Calling with "CLOCK" string
    await addReaction("CLOCK", [msg]);
    assert.equal(interceptedRequests.length, 1);
    const payload = interceptedRequests[0].body;

    assert.equal(payload.grid, "group-100");
    assert.equal(payload.react_list.length, 1);
    const innerMsg = JSON.parse(payload.react_list[0].message);
    assert.equal(innerMsg.rIcon, "🕑");
    assert.equal(innerMsg.rType, 55);
    assert.equal(innerMsg.source, 6);
    assert.deepEqual(innerMsg.rMsg, [{ gMsgID: 12345, cMsgID: 67890, msgType: 1 }]);

    // 2. Calling with UNDO string
    await addReaction("UNDO", [msg]);
    assert.equal(interceptedRequests.length, 2);
    const payload2 = interceptedRequests[1].body;
    const innerMsg2 = JSON.parse(payload2.react_list[0].message);
    assert.equal(innerMsg2.rIcon, "");
    assert.equal(innerMsg2.rType, -1);
    assert.equal(innerMsg2.source, 6);

    // 3. Multi-operation form: all ops packed into ONE request's react_list
    await addReaction([
      { icon: "CLOCK", messages: [msg, msg, msg] },
      { icon: "UNDO", messages: [msg] },
      { icon: "CLOCK", messages: [msg, msg] },
    ]);
    assert.equal(interceptedRequests.length, 3, "multi-operation call must still be ONE HTTP request");
    const multiPayload = interceptedRequests[2].body;
    assert.equal(multiPayload.react_list.length, 3);
    const parsedOps = multiPayload.react_list.map((entry) => JSON.parse(entry.message));
    assert.deepEqual(parsedOps.map(({ rType }) => rType), [55, -1, 55]);
    assert.deepEqual(parsedOps.map(({ rIcon }) => rIcon), ["🕑", "", "🕑"]);
    assert.deepEqual(parsedOps.map(({ rMsg }) => rMsg.length), [3, 1, 2]);
    assert.ok(parsedOps.every(({ source }) => source === 6));
    const clientIds = multiPayload.react_list.map((entry) => entry.clientId);
    assert.equal(new Set(clientIds).size, 3, "react_list entries must carry distinct clientIds");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("90 -> 89 frame transition emits exactly ONE HTTP request with four react_list entries", async () => {
  const secretKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");
  appContext.secretKey = secretKey;
  appContext.imei = "mock-imei";
  appContext.cookie = "zpw_sek=mock";
  appContext.userAgent = "mock-ua";

  const interceptedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body).get("params");
      const decrypted = JSON.parse(decodeAES(secretKey, params));
      interceptedRequests.push({ url: req.url, body: decrypted });
      const responsePayload = {
        error_code: 0,
        data: encodeAES(secretKey, JSON.stringify({ error_code: 0, data: { status: 0 } })),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const serviceContext = {
      zpwServiceMap: {
        reaction: [baseUrl],
      },
    };

    const api = { addReaction: addReactionFactory(serviceContext) };
    const messageRef = {
      type: MessageType.GroupMessage,
      threadId: "group-100",
      data: { msgId: "12345", cliMsgId: "67890" },
    };

    // Initial frame 90 -> CLOCK 50 + CLOCK 40 in one request
    const rendered90 = await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 0, nextCount: 90 });
    assert.equal(rendered90, 90);
    assert.equal(interceptedRequests.length, 1);
    const firstPayload = interceptedRequests[0].body;
    assert.equal(firstPayload.grid, "group-100");
    assert.equal(firstPayload.toid, undefined);
    assert.equal(firstPayload.react_list.length, 2);
    const firstOps = firstPayload.react_list.map((entry) => JSON.parse(entry.message));
    assert.deepEqual(firstOps.map(({ rType }) => rType), [55, 55]);
    assert.deepEqual(firstOps.map(({ rIcon }) => rIcon), ["🕑", "🕑"]);
    assert.deepEqual(firstOps.map(({ rMsg }) => rMsg.length), [50, 40]);

    // Transition 90 -> 89 -> still exactly ONE additional HTTP request
    const rendered89 = await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 90, nextCount: 89 });
    assert.equal(rendered89, 89);
    assert.equal(interceptedRequests.length, 2, "one frame transition must produce exactly one HTTP request");

    const payload = interceptedRequests[1].body;
    assert.equal(payload.grid, "group-100");
    assert.equal(payload.react_list.length, 4);
    const parsed = payload.react_list.map((entry) => JSON.parse(entry.message));

    assert.deepEqual(parsed.map(({ rType }) => rType), [-1, -1, 55, 55]);
    assert.deepEqual(parsed.map(({ rIcon }) => rIcon), ["", "", "🕑", "🕑"]);
    assert.deepEqual(parsed.map(({ rMsg }) => rMsg.length), [50, 40, 50, 39]);
    assert.ok(parsed.every(({ source }) => source === 6));
    assert.ok(
      parsed.every(({ rMsg }) =>
        rMsg.every((m) => m.gMsgID === 12345 && m.cMsgID === 67890 && m.msgType === 1)
      )
    );

    const clientIds = payload.react_list.map((entry) => entry.clientId);
    assert.equal(new Set(clientIds).size, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("applyReactionBatch packs large counts (55, 56, 57, 90) into ONE request with ops <= 50", async () => {
  const api = createApi();
  const msgRef = {
    type: 1,
    threadId: "group-large",
    data: { msgId: "111", cliMsgId: "222" },
  };

  const expectations = [
    [55, [50, 5]],
    [56, [50, 6]],
    [57, [50, 7]],
    [90, [50, 40]],
  ];

  for (const [count, expectedOps] of expectations) {
    api.reactions.length = 0;
    api.reactionRequests.length = 0;
    const applied = await applyReactionBatch({ api, icon: "CLOCK", messageRef: msgRef, count });
    assert.equal(applied, count);
    assert.equal(api.reactionRequests.length, 1, `count ${count} must be a single request`);
    assert.equal(api.reactions.length, expectedOps.length);
    assert.deepEqual(
      api.reactionRequests[0].map((op) => op.count),
      expectedOps
    );
    for (const op of api.reactionRequests[0]) {
      assert.ok(op.count <= MAX_REACTION_BATCH_SIZE);
      assert.equal(op.icon, "CLOCK");
    }
  }
});
