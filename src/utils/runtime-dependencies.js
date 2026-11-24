import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { resolveExecutableSync, projectRoot } from "../platform/index.js";

const sandboxedFfmpeg = path.join(projectRoot, ".runtime", "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const sandboxedFfprobe = path.join(projectRoot, ".runtime", "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

const executableCandidates = Object.freeze({
  python: Object.freeze([process.env.PYTHON_BIN, process.env.PYTHON3_BIN, "python3", "python", "py"].filter(Boolean)),
  ffmpeg: Object.freeze([process.env.FFMPEG_BIN, sandboxedFfmpeg, "ffmpeg"].filter(Boolean)),
  ffprobe: Object.freeze([process.env.FFPROBE_BIN, sandboxedFfprobe, "ffprobe"].filter(Boolean)),
});
let cachedBinaryState;
let cachedAt = 0;

export function configureFluentFfmpeg() {
  const ffmpegBin = getFfmpegExecutableSync();
  const ffprobeBin = getFfprobeExecutableSync();
  if (ffmpegBin) {
    try { ffmpeg.setFfmpegPath(ffmpegBin); } catch {}
  }
  if (ffprobeBin) {
    try { ffmpeg.setFfprobePath(ffprobeBin); } catch {}
  }
  return { ffmpegBin, ffprobeBin };
}

export function getRuntimeDependencyState({ api, probe = resolveExecutableSync } = {}) {
  const now = Date.now();
  if (cachedBinaryState && now - cachedAt < 30_000) {
    return { ...cachedBinaryState, zaloSession: Boolean(api) };
  }
  const probeExecutable = (candidates, options) => {
    for (const candidate of candidates) {
      const result = probe(candidate, options);
      if (result) return result;
    }
    return null;
  };
  const python = probeExecutable(executableCandidates.python);
  const ffmpegExe = probeExecutable(executableCandidates.ffmpeg, { probeArgs: ["-version"] });
  const ffprobeExe = probeExecutable(executableCandidates.ffprobe, { probeArgs: ["-version"] });
  cachedBinaryState = { python: Boolean(python), ffmpeg: Boolean(ffmpegExe), ffprobe: Boolean(ffprobeExe) };
  cachedAt = now;
  if (ffmpegExe || ffprobeExe) {
    try { configureFluentFfmpeg(); } catch {}
  }
  return {
    zaloSession: Boolean(api),
    ...cachedBinaryState,
  };
}

export function getPythonExecutableSync({ probe = resolveExecutableSync } = {}) {
  return probe(executableCandidates.python);
}

export function getFfmpegExecutableSync({ probe = resolveExecutableSync } = {}) {
  const bin = probe(executableCandidates.ffmpeg, { probeArgs: ["-version"] });
  if (bin) {
    try { ffmpeg.setFfmpegPath(bin); } catch {}
  }
  return bin;
}

export function getFfprobeExecutableSync({ probe = resolveExecutableSync } = {}) {
  const bin = probe(executableCandidates.ffprobe, { probeArgs: ["-version"] });
  if (bin) {
    try { ffmpeg.setFfprobePath(bin); } catch {}
  }
  return bin;
}

