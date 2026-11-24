import { fork, spawn } from "node:child_process";

const isWindows = process.platform === "win32";

function killTree(pid, child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!pid) {
      try { child?.kill?.("SIGKILL"); } catch {}
      return resolve();
    }

    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child?.kill?.("SIGKILL"); } catch {}
      resolve();
    };

    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    if (isWindows) {
      try {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("close", finish);
        killer.once("error", finish);
      } catch {
        finish();
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      finish();
    }
  });
}

export function createNativeProcessPool(options = {}) {
  const {
    entrypoint,
    maxProcesses = 2,
    initialProcesses = 0,
    onDemand = true,
    idleTimeoutMs = 300_000, // 5 minutes
    taskTimeoutMs = 30000,
    maxTasksPerProcess = 500,
    logger = console,
  } = options;

  if (!entrypoint) throw new Error("entrypoint is required for createNativeProcessPool");

  const processes = [];
  const taskQueue = [];
  let nextTaskId = 1;
  let closed = false;

  function clearIdleTimer(wrapper) {
    if (wrapper.idleTimer) {
      clearTimeout(wrapper.idleTimer);
      wrapper.idleTimer = null;
    }
  }

  function resetIdleTimer(wrapper) {
    clearIdleTimer(wrapper);
    if (idleTimeoutMs > 0 && !closed) {
      wrapper.idleTimer = setTimeout(() => {
        if (!wrapper.busy && !closed) {
          reapWorker(wrapper);
        }
      }, idleTimeoutMs);
      wrapper.idleTimer.unref?.();
    }
  }

  async function reapWorker(wrapper) {
    if (wrapper.handled || wrapper.state === "terminating" || wrapper.state === "terminated") return;
    wrapper.handled = true;
    wrapper.state = "terminating";
    clearIdleTimer(wrapper);
    if (wrapper.activeTimeout) clearTimeout(wrapper.activeTimeout);

    await killTree(wrapper.pid, wrapper.child);
    wrapper.state = "terminated";

    const idx = processes.indexOf(wrapper);
    if (idx !== -1) processes.splice(idx, 1);
  }

  function createProcessInstance() {
    if (closed) return null;

    let child;
    try {
      child = fork(entrypoint, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch (err) {
      logger.error?.(`[native-process-pool] Failed to fork ${entrypoint}: ${err.message}`);
      return null;
    }

    const STDERR_LIMIT = 4096;
    let stderrTail = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrTail += chunk;
        if (stderrTail.length > STDERR_LIMIT) {
          stderrTail = stderrTail.slice(-STDERR_LIMIT);
        }
      });
    }

    const wrapper = {
      id: `proc-${child.pid}-${Math.random().toString(36).slice(2, 6)}`,
      child,
      pid: child.pid,
      state: "active", // active | terminating | terminated | failed
      handled: false,
      busy: false,
      taskCount: 0,
      activeTaskId: null,
      activeTimeout: null,
      activeResolve: null,
      activeReject: null,
      idleTimer: null,
      getStderrTail: () => stderrTail,
    };

    child.on("message", (msg) => {
      const { taskId, success, result, error } = msg || {};
      if (wrapper.activeTaskId === taskId) {
        if (wrapper.activeTimeout) clearTimeout(wrapper.activeTimeout);
        const resolve = wrapper.activeResolve;
        const reject = wrapper.activeReject;

        wrapper.busy = false;
        wrapper.activeTaskId = null;
        wrapper.activeTimeout = null;
        wrapper.activeResolve = null;
        wrapper.activeReject = null;
        wrapper.taskCount++;

        if (success) {
          resolve?.(result);
        } else {
          reject?.(new Error(error || "Process task failed"));
        }

        // Check if process reached max task count for memory recycling
        if (wrapper.taskCount >= maxTasksPerProcess) {
          recycleProcess(wrapper);
        } else if (taskQueue.length > 0) {
          dispatchNext();
        } else {
          resetIdleTimer(wrapper);
        }
      }
    });

    child.on("error", (err) => {
      logger.error?.(`[native-process-pool] child ${wrapper.pid} error: ${err.message}`);
      handleProcessFailure(wrapper, err);
    });

    child.on("exit", (code, signal) => {
      if (!closed) {
        logger.warn?.(`[native-process-pool] child ${wrapper.pid} exited (code: ${code}, signal: ${signal})`);
        handleProcessFailure(wrapper, new Error(`Process exited with code ${code}`));
      } else {
        wrapper.state = "terminated";
      }
    });

    processes.push(wrapper);
    resetIdleTimer(wrapper);
    return wrapper;
  }

  async function handleProcessFailure(wrapper, err) {
    if (wrapper.handled || wrapper.state === "terminating" || wrapper.state === "terminated" || wrapper.state === "failed") {
      return;
    }
    wrapper.handled = true;
    wrapper.state = "failed";

    clearIdleTimer(wrapper);
    if (wrapper.activeTimeout) clearTimeout(wrapper.activeTimeout);

    const stderr = wrapper.getStderrTail();
    const finalErr = err || new Error("Process terminated unexpectedly");
    if (stderr && !finalErr.message.includes("Worker stderr:")) {
      finalErr.message += ` (Worker stderr: ${stderr.trim().slice(-500)})`;
    }

    if (wrapper.activeReject) {
      wrapper.activeReject(finalErr);
      wrapper.activeReject = null;
      wrapper.activeResolve = null;
    }

    wrapper.state = "terminating";
    await killTree(wrapper.pid, wrapper.child);
    wrapper.state = "terminated";

    const idx = processes.indexOf(wrapper);
    if (idx !== -1) processes.splice(idx, 1);

    // Only respawn if tasks are waiting in queue. Never respawn on idle crash!
    if (!closed && taskQueue.length > 0 && processes.length < maxProcesses) {
      createProcessInstance();
      dispatchNext();
    } else if (!closed && !onDemand && initialProcesses > 0 && processes.length < initialProcesses) {
      createProcessInstance();
    }
  }

  async function recycleProcess(wrapper) {
    if (wrapper.handled || wrapper.state === "terminating" || wrapper.state === "terminated") return;
    wrapper.handled = true;
    wrapper.state = "terminating";

    clearIdleTimer(wrapper);
    if (wrapper.activeTimeout) {
      clearTimeout(wrapper.activeTimeout);
      wrapper.activeTimeout = null;
    }
    if (wrapper.activeReject) {
      const rejectFn = wrapper.activeReject;
      wrapper.busy = false;
      wrapper.activeTaskId = null;
      wrapper.activeResolve = null;
      wrapper.activeReject = null;
      try {
        rejectFn(new Error("Worker process recycled"));
      } catch {}
    }

    await killTree(wrapper.pid, wrapper.child);
    wrapper.state = "terminated";

    const idx = processes.indexOf(wrapper);
    if (idx !== -1) processes.splice(idx, 1);

    if (!closed && taskQueue.length > 0 && processes.length < maxProcesses) {
      createProcessInstance();
      dispatchNext();
    } else if (!closed && !onDemand && initialProcesses > 0 && processes.length < initialProcesses) {
      createProcessInstance();
    }
  }

  // Pre-initialize pool processes only if initialProcesses > 0
  const countToInit = Math.min(initialProcesses, maxProcesses);
  for (let i = 0; i < countToInit; i++) {
    createProcessInstance();
  }

  function dispatchNext() {
    if (closed || taskQueue.length === 0) return;

    let idleProc = processes.find((p) => !p.busy && p.state === "active");
    if (!idleProc && processes.length < maxProcesses) {
      idleProc = createProcessInstance();
    }
    if (!idleProc) return;

    const task = taskQueue.shift();
    if (!task) return;

    clearIdleTimer(idleProc);
    idleProc.busy = true;
    idleProc.activeTaskId = task.taskId;
    idleProc.activeResolve = task.resolve;
    idleProc.activeReject = task.reject;

    idleProc.activeTimeout = setTimeout(() => {
      logger.warn?.(`[native-process-pool] task ${task.taskId} timed out after ${taskTimeoutMs}ms`);
      handleProcessFailure(idleProc, new Error(`Task timed out after ${taskTimeoutMs}ms`));
    }, taskTimeoutMs);
    idleProc.activeTimeout.unref?.();

    try {
      idleProc.child.send({
        taskId: task.taskId,
        type: task.type,
        data: task.data,
      });
    } catch (sendErr) {
      handleProcessFailure(idleProc, sendErr);
    }
  }

  function run(type, data) {
    if (closed) return Promise.reject(new Error("Process pool is closed"));
    return new Promise((resolve, reject) => {
      const taskId = nextTaskId++;
      taskQueue.push({ taskId, type, data, resolve, reject });
      dispatchNext();
    });
  }

  async function pruneIdle() {
    const idleList = processes.filter((p) => !p.busy && p.state === "active");
    await Promise.all(idleList.map((idle) => reapWorker(idle)));
  }

  async function close() {
    closed = true;
    while (taskQueue.length > 0) {
      const task = taskQueue.shift();
      task.reject(new Error("Process pool closed"));
    }
    const currentProcesses = [...processes];
    processes.length = 0;
    await Promise.all(
      currentProcesses.map(async (wrapper) => {
        wrapper.handled = true;
        wrapper.state = "terminating";
        clearIdleTimer(wrapper);
        if (wrapper.activeTimeout) {
          clearTimeout(wrapper.activeTimeout);
          wrapper.activeTimeout = null;
        }
        if (wrapper.activeReject) {
          const rejectFn = wrapper.activeReject;
          wrapper.busy = false;
          wrapper.activeTaskId = null;
          wrapper.activeResolve = null;
          wrapper.activeReject = null;
          try {
            rejectFn(new Error("Process pool closed"));
          } catch {}
        }
        await killTree(wrapper.pid, wrapper.child);
        wrapper.state = "terminated";
      })
    );
  }

  function stats() {
    return {
      processes: processes.length,
      workers: processes.length,
      busy: processes.filter((p) => p.busy).length,
      queued: taskQueue.length,
      closed,
      pids: processes.map((p) => p.pid),
      states: processes.map((p) => ({ pid: p.pid, state: p.state, busy: p.busy })),
    };
  }

  async function recycle(target) {
    if (target === undefined || target === null || target === "") {
      return { success: false, reason: "worker_not_found" };
    }
    const p = processes.find(
      (item) => item.pid === target || item.id === target || String(item.pid) === String(target)
    );
    if (!p) {
      return { success: false, reason: "worker_not_found" };
    }
    await recycleProcess(p);
    return { success: true, pid: p.pid };
  }

  async function recycleAll() {
    const list = [...processes];
    await Promise.all(list.map((wrapper) => recycleProcess(wrapper)));
  }

  return {
    run,
    runTask: run, // Compatibility alias
    pruneIdle,
    recycle,
    recycleAll,
    close,
    stats,
  };
}
