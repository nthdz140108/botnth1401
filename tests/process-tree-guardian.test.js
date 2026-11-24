import { test } from "node:test";
import assert from "node:assert/strict";
import { getProcessTreeRss, setMockProcessesListForTest } from "../src/runtime/process-tree.js";
import { MemoryGuardian } from "../src/runtime/memory-guardian-core.js";

test("process-tree: calculates tree RSS from root and descendants", async () => {
  const fakeProcesses = [
    { pid: 100, parentPid: 1, memRss: 50000 },   // 50 MB in KB
    { pid: 101, parentPid: 100, memRss: 20000 }, // 20 MB descendant
    { pid: 102, parentPid: 101, memRss: 10000 }, // 10 MB descendant
    { pid: 200, parentPid: 1, memRss: 80000 },   // Unrelated process
  ];

  setMockProcessesListForTest(fakeProcesses);

  const treeRss = await getProcessTreeRss(100);
  // (50000 + 20000 + 10000) * 1024 bytes = 81920000 bytes (~80 MB)
  assert.equal(treeRss, 80000 * 1024);

  setMockProcessesListForTest(null);
});

test("memory-guardian-core: ranks bots by treeRss for cleanup and restart", async () => {
  const fakeAdapter = {
    listProcesses: async () => [
      { name: "bot-low", pid: 100, pm_id: 1, status: "online", kind: "child", monit: { memory: 100 * 1024 * 1024 } },
      { name: "bot-high-tree", pid: 200, pm_id: 2, status: "online", kind: "child", monit: { memory: 80 * 1024 * 1024 } },
    ],
  };

  const fakeTreeRssFn = async (pid) => {
    if (pid === 100) return 100 * 1024 * 1024; // 100 MB total tree
    if (pid === 200) return 300 * 1024 * 1024; // 300 MB total tree (e.g. heavy workers)
    return 0;
  };

  const guardian = new MemoryGuardian({
    adapter: fakeAdapter,
    processTreeRssFn: fakeTreeRssFn,
    enableDiskCleanup: false,
  });

  const procList = await guardian._getProcessList();
  assert.equal(procList.length, 2);
  const botHigh = procList.find((p) => p.name === "bot-high-tree");
  const botLow = procList.find((p) => p.name === "bot-low");
  assert.equal(botHigh.treeRss, 300 * 1024 * 1024);
  assert.equal(botLow.treeRss, 100 * 1024 * 1024);

  // Highest treeRss should be selected first
  const selectedForCleanup = guardian._selectBotForCleanup(procList);
  assert.equal(selectedForCleanup.name, "bot-high-tree");

  const selectedForRestart = guardian._selectBotForRestart(procList);
  assert.equal(selectedForRestart.name, "bot-high-tree");
});
