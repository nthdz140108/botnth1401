import os from "node:os";
import { Worker } from "node:worker_threads";
import { sendMessageCompleteRequest, sendMessageFromSQL } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";

const TIME_TO_LIVE_MESSAGE = 600000;
const TEST_DURATION = 10000;

let isTestingBenchmark = false;
let currentTester = {
  id: null,
  threadId: null,
  name: null,
};
const benchmarkPromise = new Map();
let idRq = "BENCHMARK";

function resolveDefaultWorkerCount() {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  return Math.min(cpuCount, 4);
}

export class CpuBenchmark {
  constructor(options = {}) {
    this.durationMs = options.durationMs ?? 3000;
    this.workers = options.workers ?? resolveDefaultWorkerCount();
  }

  async runSingleThreadBenchmark(durationMs = this.durationMs) {
    return this.createWorker(durationMs);
  }

  createWorker(durationMs) {
    return new Promise((resolve, reject) => {
      const workerFile = new URL("./bench-worker.js", import.meta.url);
      const w = new Worker(workerFile, { workerData: { durationMs } });
      let settled = false;
      w.once("message", (msg) => {
        if (!settled) {
          settled = true;
          resolve(Number(msg?.ops) || 0);
        }
      });
      w.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      w.once("exit", (code) => {
        if (!settled) {
          settled = true;
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
          else resolve(0);
        }
      });
    });
  }

  async runMultiThreadBenchmark(durationMs = this.durationMs, numWorkers = this.workers) {
    const workerPromises = [];
    for (let i = 0; i < numWorkers; i++) {
      workerPromises.push(this.createWorker(durationMs));
    }
    const results = await Promise.all(workerPromises);
    const totalOps = results.reduce((s, v) => s + v, 0);
    return { totalOps, perWorker: results };
  }

  async run() {
    await this.runSingleThreadBenchmark(500);
    const singleOps = await this.runSingleThreadBenchmark(this.durationMs);
    const multi = await this.runMultiThreadBenchmark(this.durationMs, this.workers);

    const multiOps = multi.totalOps;
    const effectiveCores = Math.max(1, multiOps / Math.max(1, singleOps));

    return {
      single: { ops: singleOps, durationMs: this.durationMs },
      multi: { ops: multiOps, durationMs: this.durationMs, workers: this.workers },
      effectiveCores,
    };
  }
}

export async function runBench(options = {}) {
  const bench = new CpuBenchmark(options);
  return bench.run();
}

export async function handleBenchmarkCommand(api, message) {
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName || "Quản trị viên";
  const threadId = message.threadId;

  if (isTestingBenchmark) {
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: `Hiện tại bot đang thực hiện đánh giá hiệu năng CPU theo yêu cầu của ${currentTester.name || "Quản trị viên"}. Vui lòng đợi kết quả.`,
      },
      30000
    );
    return;
  }

  if (benchmarkPromise.has(idRq)) {
    try {
      const cachedOutput = await benchmarkPromise.get(idRq);
      await sendMessageFromSQL(
        api,
        message,
        { message: `Đây là kết quả đánh giá hiệu năng CPU của bot!\n\n${cachedOutput}` },
        false,
        TIME_TO_LIVE_MESSAGE
      );
    } catch (cachedErr) {
      benchmarkPromise.delete(idRq);
      console.error("Lỗi khi đọc kết quả benchmark đã lưu:", cachedErr);
      await sendMessageFromSQL(
        api,
        message,
        { message: `Đã xảy ra lỗi khi đánh giá hiệu năng CPU. Vui lòng thử lại sau.`, success: false },
        true,
        30000
      );
    }
    return;
  }

  // Acquire lock and register promise synchronously BEFORE any await
  isTestingBenchmark = true;
  currentTester = {
    id: senderId,
    name: senderName,
    threadId,
  };
  const runningPromise = createBenchmarkResult();
  runningPromise.catch(() => {});
  benchmarkPromise.set(idRq, runningPromise);

  try {
    await sendMessageCompleteRequest(
      api,
      message,
      { caption: `Vui lòng đợi bot đánh giá hiệu năng CPU...` },
      TEST_DURATION
    );

    const output = await runningPromise;
    await sendMessageFromSQL(
      api,
      message,
      { message: `Đây là kết quả đánh giá hiệu năng CPU của bot!\n\n${output}` },
      false,
      TIME_TO_LIVE_MESSAGE
    );
  } catch (error) {
    benchmarkPromise.delete(idRq);
    console.error("Lỗi khi đánh giá hiệu năng CPU:", error);
    const objectTemp = { message: `Đã xảy ra lỗi khi đánh giá hiệu năng CPU. Vui lòng thử lại sau.`, success: false };
    await sendMessageFromSQL(api, message, objectTemp, true, 30000);
  } finally {
    isTestingBenchmark = false;
    currentTester = { id: null, name: null, threadId: null };
    const timer = setTimeout(() => {
      benchmarkPromise.delete(idRq);
    }, 5000);
    timer.unref?.();
  }
}

async function createBenchmarkResult() {
  const result = await runBench();
  const caption = "== ĐÁNH GIÁ HIỆU NĂNG CPU ==";
  const output = `
${caption}
🧑‍💻  Đơn luồng:
   - Số phép toán: ${result.single.ops.toLocaleString("vi-VN")}
   - Thời gian chạy: ${result.single.durationMs} ms

🧑‍💻  Đa luồng:
   - Số phép toán: ${result.multi.ops.toLocaleString("vi-VN")}
   - Thời gian chạy: ${result.multi.durationMs} ms
   - Số luồng (workers): ${result.multi.workers}

💡  Số lõi CPU hiệu quả ước tính: ${result.effectiveCores.toFixed(2)}
`;
  return output;
}
