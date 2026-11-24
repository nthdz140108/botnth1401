process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { SendTaskSchedulerManager, getOrCreateSendtaskSchedulerManager } from "../src/service-debug/scheduler/sendtask-scheduler-manager.js";
import { buildDefaultSendtaskSchedules } from "../src/commands/studio/sendtask-defaults.js";
import { initializeScheduler, broadcastSendtaskRecord } from "../src/service-debug/scheduler/scheduler.js";

function buildFakeManager() {
  let scheduleCalls = 0;
  return new SendTaskSchedulerManager({
    scheduleJob: (cron, timezone) => {
      scheduleCalls += 1;
      return {
        cron,
        timezone,
        id: `job-${scheduleCalls}`,
        nextInvocation: () => new Date(Date.now() + 3600000),
      };
    },
    cancelJob: () => true,
    logger: { error: () => {} },
  });
}

function withCapturedConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.log = original;
      throw error;
    })
    .then((result) => {
      console.log = original;
      return { result, lines };
    });
}

test("get-or-create reuses the same manager across startup and reloads", () => {
  const previous = globalThis.__sendtaskSchedulerManager;
  globalThis.__sendtaskSchedulerManager = undefined;
  try {
    const first = getOrCreateSendtaskSchedulerManager();
    const second = getOrCreateSendtaskSchedulerManager();
    assert.ok(first instanceof SendTaskSchedulerManager);
    assert.equal(first, second, "reload must not create a second manager");
  } finally {
    globalThis.__sendtaskSchedulerManager = previous;
  }
});

test("startup registers exactly 24 jobs and repeated reloads never duplicate handles", async () => {
  const previous = globalThis.__sendtaskSchedulerManager;
  globalThis.__sendtaskSchedulerManager = undefined;
  try {
    const schedules = buildDefaultSendtaskSchedules();
    const first = await initializeScheduler({}, { schedules });
    assert.equal(first.result.scheduled, 24);
    assert.equal(first.manager.handles.size, 24);

    // Reload Command Studio: cùng manager, diff không tạo job mới
    const second = await initializeScheduler({}, { schedules });
    assert.equal(second.manager, first.manager, "initializeScheduler must reuse the existing manager");
    assert.equal(second.result.scheduled, 0);
    assert.equal(second.manager.handles.size, 24, "no duplicated job handles after reloads");

    const third = await initializeScheduler({}, { schedules });
    assert.equal(third.manager.handles.size, 24);

    await third.manager.sync([]);
    assert.equal(third.manager.handles.size, 0, "sync([]) cancels every running job");

    const restored = await initializeScheduler({}, { schedules });
    assert.equal(restored.manager.handles.size, 24, "re-enabling restores the full schedule set");
  } finally {
    if (globalThis.__sendtaskSchedulerManager && typeof globalThis.__sendtaskSchedulerManager.sync === "function") {
      await globalThis.__sendtaskSchedulerManager.sync([]).catch(() => {});
    }
    globalThis.__sendtaskSchedulerManager = previous;
  }
});

test("explicit manager injection still works for tests and adapters", async () => {
  const manager = buildFakeManager();
  const init = await initializeScheduler({}, { manager });
  assert.equal(init.manager, manager);
  assert.equal(manager.handles.size, 24);
});

test("scheduler status log reports job count, revision, timezone and next run", async () => {
  const manager = buildFakeManager();
  const { lines } = await withCapturedConsole(() =>
    initializeScheduler({}, { manager, schedules: buildDefaultSendtaskSchedules() }),
  );
  const statusLine = lines.find((line) => line.includes("[sendtask-scheduler]"));
  assert.ok(statusLine, "must emit a scheduler status line");
  assert.match(statusLine, /phase=(startup|reload)/);
  assert.match(statusLine, /jobs=24/);
  assert.match(statusLine, /revision=\d+/);
  assert.match(statusLine, /timezone=Asia\/Ho_Chi_Minh/);
  assert.match(statusLine, /next=/);
});

test("job callback triggers the broadcaster exactly once per record", async () => {
  const broadcasts = [];
  let trigger;
  const triggered = new Promise((resolve) => {
    trigger = resolve;
  });

  const manager = new SendTaskSchedulerManager({
    scheduleJob: (_cron, _tz, task) => {
      trigger();
      return { taskRef: task, nextInvocation: () => null };
    },
    cancelJob: () => true,
    logger: { error: () => {} },
  });

  const record = { id: "hour-cb", kind: "girl-video", category: "sex", ttlMinutes: 60 };
  manager.bindTaskFactory(async (row) => {
    broadcasts.push(row);
    await broadcastSendtaskRecord({}, row, {});
  });
  await manager.sync([record]);
  await triggered;

  const handle = manager.handles.get("hour-cb");
  await handle.taskRef();

  assert.equal(broadcasts.length, 1, "callback fired exactly once per scheduled run");
  assert.equal(broadcasts[0].id, "hour-cb");
});
