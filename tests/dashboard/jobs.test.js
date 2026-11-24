import test from "node:test";
import assert from "node:assert/strict";
import { createJobState, isTerminalJob, transitionJob } from "../../dashboard/src/app/jobs.js";

test("tracks valid job lifecycle transitions and progress", () => {
  let job = createJobState("job-1");
  job = transitionJob(job, "running", { progress: 20 });
  job = transitionJob(job, "succeeded");
  assert.equal(job.progress, 100);
  assert.equal(isTerminalJob(job), true);
});

test("rejects invalid lifecycle transitions", () => {
  assert.throws(() => transitionJob(createJobState("job-1"), "succeeded"), /Invalid job transition/);
});
