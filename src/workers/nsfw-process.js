import fs from "node:fs/promises";

let model = null;
let canvasLib = null;
let tfLib = null;

const TARGET_SIZE = 224;

process.on("disconnect", () => {
  process.exit(0);
});

async function getOrLoadModel() {
  if (!model) {
    const [nsfwjsModule, canvasModule, tfModule] = await Promise.all([
      import("nsfwjs"),
      import("canvas"),
      import("@tensorflow/tfjs").catch(() => null),
    ]);
    canvasLib = canvasModule.default || canvasModule;
    tfLib = tfModule?.default || tfModule || null;
    const loadFn = nsfwjsModule.load || nsfwjsModule.default?.load;
    model = await loadFn();
  }
  return { model, canvasLib, tfLib };
}

process.on("message", async (msg) => {
  const { taskId, type, data } = msg || {};
  if (!taskId) return;

  try {
    if (type === "classify") {
      const { model: m, canvasLib: cvsLib, tfLib: tf } = await getOrLoadModel();
      let buffer;
      if (data?.filePath) {
        buffer = await fs.readFile(data.filePath);
      } else if (Buffer.isBuffer(data?.buffer)) {
        buffer = data.buffer;
      } else if (data?.buffer) {
        buffer = Buffer.from(data.buffer?.data || data.buffer);
      } else {
        throw new Error("Missing image filePath or buffer");
      }

      const { Canvas, loadImage } = cvsLib;
      const image = await loadImage(buffer);
      const cvs = new Canvas(TARGET_SIZE, TARGET_SIZE);
      const ctx = cvs.getContext("2d");
      ctx.drawImage(image, 0, 0, TARGET_SIZE, TARGET_SIZE);

      const engine = typeof tf?.engine === "function" ? tf.engine() : null;
      engine?.startScope?.();
      let predictions;
      try {
        predictions = await m.classify(cvs);
      } finally {
        engine?.endScope?.();
      }

      const nsfwScore = predictions.reduce((score, pred) => {
        if (["Porn", "Sexy", "Hentai"].includes(pred.className)) {
          return score + pred.probability;
        }
        return score;
      }, 0);

      process.send?.({
        taskId,
        success: true,
        result: {
          predictions,
          nsfwScore: Number((nsfwScore * 100).toFixed(0)),
        },
      });
      return;
    }

    if (type === "ping") {
      process.send?.({ taskId, success: true, result: "pong" });
      return;
    }

    process.send?.({ taskId, success: false, error: `Unknown task type: ${type}` });
  } catch (error) {
    process.send?.({
      taskId,
      success: false,
      error: error?.message || String(error),
    });
  }
});
