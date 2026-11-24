import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFfmpegArgs,
  convertToAAC,
  convertToM4A,
  extractAudioFromVideo,
} from "../src/service-debug/chat-zalo/chat-special/send-voice/process-audio.js";

test("ffmpeg helper builds an argument array instead of a shell string", () => {
  assert.deepEqual(buildFfmpegArgs("input.mp3", "output.m4a"), [
    "-y",
    "-i", "input.mp3",
    "-vn",
    "-c:a", "aac",
    "-q:a", "2",
    "output.m4a",
  ]);
});

test("convertToM4A resolves the binary and invokes execFile with arguments", async () => {
  const calls = [];
  const outputPath = await convertToM4A("sample.mp3", {
    resolveBinary: () => "ffmpeg-test",
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(outputPath, "sample.m4a");
  assert.deepEqual(calls, [{
    command: "ffmpeg-test",
    args: buildFfmpegArgs("sample.mp3", "sample.m4a"),
  }]);
});

test("convertToAAC resolves the binary and invokes execFile with arguments", async () => {
  const calls = [];
  const outputPath = await convertToAAC("sample.mp3", {
    resolveBinary: () => "ffmpeg-test",
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(outputPath, "sample.aac");
  assert.deepEqual(calls, [{
    command: "ffmpeg-test",
    args: buildFfmpegArgs("sample.mp3", "sample.aac"),
  }]);
});

test("extractAudioFromVideo uses the same execFile path for buffers", async () => {
  const calls = [];
  const api = {
    uploadAttachment: async (files, threadId, type) => {
      assert.equal(files.length, 1);
      assert.equal(threadId, "thread-1");
      assert.equal(type, 1);
      assert.match(files[0], /\.aac$/);
      return [{ fileUrl: "https://example.com/audio.aac" }];
    },
  };
  const message = { threadId: "thread-1", type: 1 };

  const voiceUrl = await extractAudioFromVideo(Buffer.from("fake-video"), api, message, {
    resolveBinary: () => "ffmpeg-test",
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(voiceUrl, "https://example.com/audio.aac");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ffmpeg-test");
  assert.deepEqual(calls[0].args, buildFfmpegArgs(calls[0].args[2], calls[0].args[8]));
});
