import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SendTaskSchedulerManager } from "../src/service-debug/scheduler/sendtask-scheduler-manager.js";
import { buildDefaultSendtaskSchedules } from "../src/commands/studio/sendtask-defaults.js";
import { crossFieldValidateSendtask } from "../src/commands/studio/runtime-adapters.js";
import { initializeScheduler } from "../src/service-debug/scheduler/scheduler.js";

function buildFakeManager() {
  const jobs = new Map();
  let scheduleCalls = 0;
  const manager = new SendTaskSchedulerManager({
    scheduleJob: (cron, timezone) => {
      const handle = { cron, timezone, id: `job-${scheduleCalls += 1}` };
      return handle;
    },
    cancelJob: (handle) => {
      if (handle) jobs.delete(handle.id);
      return true;
    },
    logger: { error: () => {} },
  });
  manager.__jobs = jobs;
  return manager;
}

test("fake scheduler sync creates exactly 24 hourly jobs", async () => {
  const manager = new SendTaskSchedulerManager({
    scheduleJob: () => ({ fake: true }),
    cancelJob: () => true,
    logger: { error: () => {} },
  });
  const schedules = buildDefaultSendtaskSchedules();
  const result = await manager.sync(schedules);
  assert.equal(result.scheduled, 24);
  assert.equal(manager.handles.size, 24);
});

test("replacing one job reschedules only that job and never duplicates the other 23", async () => {
  const manager = buildFakeManager();
  const schedules = buildDefaultSendtaskSchedules();
  await manager.sync(schedules);
  const handlesBefore = new Set([...manager.desired.keys()]);
  assert.equal(handlesBefore.size, 24);

  const modified = schedules.map((row) => (
    row.id === "hour-10"
      ? { ...row, caption: "> SendTask 10:05 <\nĐổi caption thử", ttlMinutes: 90 }
      : row
  ));
  const diff = manager.diff(modified.filter((row) => row.enabled !== false));
  assert.equal(diff.toSchedule.length, 1);
  assert.equal(diff.toCancel.length, 0);

  await manager.sync(modified.filter((row) => row.enabled !== false));
  assert.equal(manager.handles.size, 24, "no duplicated job handles");
  assert.equal(manager.desired.get("hour-10").ttlMinutes, 90);
  assert.equal(manager.desired.get("hour-11").caption, schedules[11].caption);
});

test("disabling a schedule cancels its handle without touching others", async () => {
  const manager = buildFakeManager();
  const schedules = buildDefaultSendtaskSchedules();
  await manager.sync(schedules);
  const disabled = schedules.map((row) => (row.id === "hour-03" ? { ...row, enabled: false } : row));
  await manager.sync(disabled.filter((row) => row.enabled !== false));
  assert.equal(manager.handles.size, 23);
  assert.equal(manager.desired.has("hour-03"), false);
});

test("rollback restores the previous schedule set after a change", async () => {
  const manager = buildFakeManager();
  const schedules = buildDefaultSendtaskSchedules();
  await manager.sync(schedules);
  const originalCaption = manager.desired.get("hour-00").caption;
  const changed = schedules.map((row) => (row.id === "hour-00" ? { ...row, cron: "15 0 * * *" } : row));
  await manager.sync(changed.filter((row) => row.enabled !== false));
  assert.equal(manager.desired.get("hour-00").cron, "15 0 * * *");
  const rollbackResult = await manager.rollback();
  assert.equal(rollbackResult.rolledBack, true);
  assert.equal(manager.desired.get("hour-00").cron, "5 0 * * *");
  assert.equal(manager.desired.get("hour-00").caption, originalCaption);
  assert.equal(manager.handles.size, 24);
});

test("sync failure rolls back to previous snapshot instead of partial apply", async () => {
  let failOn = -1;
  let callIndex = -1;
  const manager = new SendTaskSchedulerManager({
    scheduleJob: (cron) => {
      callIndex += 1;
      if (failOn >= 0 && callIndex >= failOn) throw new Error(`boom at ${callIndex}`);
      return { cron };
    },
    cancelJob: () => true,
    logger: { error: () => {} },
  });
  const firstHalf = buildDefaultSendtaskSchedules().slice(0, 12);
  await manager.sync(firstHalf);
  const sizeBefore = manager.handles.size;
  failOn = 3;
  await assert.rejects(
    () => manager.sync(buildDefaultSendtaskSchedules().slice(0, 20)),
    /rolled back/,
  );
  assert.equal(manager.desired.size, sizeBefore, "desired state must stay at pre-failure snapshot");
  failOn = -1;
  await manager.sync(buildDefaultSendtaskSchedules());
  assert.equal(manager.handles.size, 24);
});

test("cross-field validation rejects duplicate crons and bad records", () => {
  const base = buildDefaultSendtaskSchedules();
  const good = crossFieldValidateSendtask({ "schedules.items": base });
  assert.equal(good.ok, true, JSON.stringify(good.errors));

  const duplicateCron = base.map((row) => ({ ...row }));
  duplicateCron[1] = { ...duplicateCron[1], cron: duplicateCron[0].cron };
  const dup = crossFieldValidateSendtask({ "schedules.items": duplicateCron });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((errorItem) => /Duplicate cron/.test(errorItem.message)));

  const wrongCount = base.slice(0, 23);
  const count = crossFieldValidateSendtask({ "schedules.items": wrongCount });
  assert.equal(count.ok, false);
  assert.ok(count.errors.some((errorItem) => /exactly 24/.test(errorItem.message)));

  const missingQuery = base.map((row) => (row.id === "hour-04" ? { ...row, queryTemplate: "" } : row));
  const queryCheck = crossFieldValidateSendtask({ "schedules.items": missingQuery });
  assert.equal(queryCheck.ok, false);
});

test("initializeScheduler wires defaults through the manager", async () => {
  const created = [];
  const manager = new SendTaskSchedulerManager({
    scheduleJob: (cron) => {
      const handle = { cron };
      created.push(handle);
      return handle;
    },
    cancelJob: () => true,
    logger: { error: () => {} },
  });
  const init = await initializeScheduler({}, {
    manager,
    retry: { maxRetries: 0 },
  });
  assert.equal(init.manager, manager);
  assert.equal(created.length, 24);
  assert.deepEqual(manager.status().jobs, buildDefaultSendtaskSchedules().map((row) => row.id));
});
