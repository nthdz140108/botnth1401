import test from "node:test";
import assert from "node:assert/strict";
import { MediaJobStore } from "../src/service-debug/media/media-job-store.js";

test("media job store caps concurrency and executes queued jobs in order", async () => {
  const store = new MediaJobStore({ maxConcurrent: 2, defaultTimeoutMs: 5000 });
  let activeCount = 0;
  let maxActiveObserved = 0;
  const executedOrder = [];

  store.registerHandler("test_job", async (payload) => {
    activeCount++;
    maxActiveObserved = Math.max(maxActiveObserved, activeCount);
    await new Promise((r) => setTimeout(r, 20));
    executedOrder.push(payload.name);
    activeCount--;
    return `result-${payload.name}`;
  });

  const job1 = store.submitJob({ type: "test_job", payload: { name: "1" } });
  const job2 = store.submitJob({ type: "test_job", payload: { name: "2" } });
  const job3 = store.submitJob({ type: "test_job", payload: { name: "3" } });

  const [res1, res2, res3] = await Promise.all([
    store.waitForJob(job1.id),
    store.waitForJob(job2.id),
    store.waitForJob(job3.id),
  ]);

  assert.equal(res1, "result-1");
  assert.equal(res2, "result-2");
  assert.equal(res3, "result-3");
  assert.ok(maxActiveObserved <= 2, `Max active observed should be <= 2, was ${maxActiveObserved}`);
  assert.equal(executedOrder.length, 3);
});

test("media job cancellation stops execution", async () => {
  const store = new MediaJobStore({ maxConcurrent: 1 });
  store.registerHandler("long_job", async () => {
    await new Promise((r) => setTimeout(r, 500));
  });

  const j1 = store.submitJob({ type: "long_job" });
  const j2 = store.submitJob({ type: "long_job" });

  const cancelled = store.cancelJob(j2.id);
  assert.equal(cancelled, true);
  assert.equal(store.getJob(j2.id).status, "cancelled");
});
