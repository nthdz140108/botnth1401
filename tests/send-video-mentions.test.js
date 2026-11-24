import test from "node:test";
import assert from "node:assert/strict";

import { validateVideoMentions } from "../src/api-zalo/apis/sendVideo.js";
import { MessageType } from "../src/api-zalo/models/Message.js";

test("validateVideoMentions validates positions against the caption string", () => {
  const result = validateVideoMentions(MessageType.GroupMessage, "@Lan shared a video", [
    { uid: "123", pos: 0, len: 4 },
  ]);

  assert.deepEqual(result.mentionsFinal, [{ uid: "123", pos: 0, len: 4, type: 0 }]);
  assert.equal(result.msgFinal, "@Lan shared a video");
});
