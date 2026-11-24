import test from "node:test";
import assert from "node:assert/strict";
import {
  requireValidVideoUrl,
  resolveThumbnailParam,
} from "../src/api-zalo/apis/sendVideo.js";
import { ZaloApiError } from "../src/api-zalo/Errors/ZaloApiError.js";

test("requireValidVideoUrl trims a usable URL and rejects empty/non-string input", () => {
  assert.equal(requireValidVideoUrl("  https://cdn.example/v.mp4  "), "https://cdn.example/v.mp4");
  for (const bad of ["", "   ", null, undefined, 42]) {
    assert.throws(() => requireValidVideoUrl(bad), ZaloApiError);
  }
});

test("resolveThumbnailParam never lets an empty or stringified-null thumb reach Zalo when uploaded", () => {
  // Luồng local (videoAlreadyUploaded): mọi giá trị vô hiệu đều phải chặn gửi
  for (const bad of ["", "   ", "null", "NULL", "undefined"]) {
    assert.throws(
      () => resolveThumbnailParam(bad, { videoAlreadyUploaded: true }),
      (error) => error instanceof ZaloApiError && /thumbnail/i.test(error.message),
      `thumbUrl ${JSON.stringify(bad)} must never be sent`,
    );
  }
});

test("resolveThumbnailParam rejects invalid explicit thumbnails regardless of upload state", () => {
  assert.throws(() => resolveThumbnailParam("null", { thumbnailRequested: true }), ZaloApiError);
  assert.throws(() => resolveThumbnailParam("", { thumbnailRequested: true }), ZaloApiError);
});

test("resolveThumbnailParam keeps the legacy empty-thumb behavior for the online URL flow", () => {
  // Luồng URL online (vdsex): fallback thumbnail không ra URL vẫn giữ hành vi cũ
  assert.equal(resolveThumbnailParam(null), "");
  assert.equal(resolveThumbnailParam(undefined, { videoAlreadyUploaded: false }), "");
});

test("resolveThumbnailParam normalizes valid URLs by trimming whitespace", () => {
  assert.equal(
    resolveThumbnailParam(" https://cdn.example/t.jpg "),
    "https://cdn.example/t.jpg",
  );
});
