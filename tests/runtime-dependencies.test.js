import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { projectRoot } from "../src/platform/index.js";
import { getRuntimeDependencyState } from "../src/utils/runtime-dependencies.js";
import { getFfprobeExecutableSync, getPythonExecutableSync } from "../src/utils/runtime-dependencies.js";

test("runtime dependency state reports the Zalo session and probes configured binaries", () => {
  const state = getRuntimeDependencyState({
    api: {},
    probe: (command) => command === "ffmpeg",
  });

  assert.equal(state.zaloSession, true);
  assert.equal(state.python, false);
  assert.equal(state.ffmpeg, true);
});

test("python executable resolution prefers configured environment candidates before py", () => {
  const calls = [];
  const python = getPythonExecutableSync({
    probe: (candidates) => {
      calls.push(candidates);
      return candidates.includes("python3") ? "python3" : null;
    },
  });

  assert.equal(python, "python3");
  assert.deepEqual(calls[0], [process.env.PYTHON_BIN, process.env.PYTHON3_BIN, "python3", "python", "py"].filter(Boolean));
});

test("ffprobe executable resolution uses the dedicated runtime candidate list", () => {
  const calls = [];
  const ffprobe = getFfprobeExecutableSync({
    probe: (candidates, options) => {
      calls.push({ candidates, options });
      return candidates.includes("ffprobe") ? "ffprobe" : null;
    },
  });

  const sandboxedFfprobe = path.join(projectRoot, ".runtime", "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  assert.equal(ffprobe, "ffprobe");
  assert.deepEqual(calls[0].candidates, [process.env.FFPROBE_BIN, sandboxedFfprobe, "ffprobe"].filter(Boolean));
  assert.deepEqual(calls[0].options, { probeArgs: ["-version"] });
});
