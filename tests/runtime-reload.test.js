import test from "node:test";
import assert from "node:assert/strict";

import { performRuntimeReload } from "../src/commands/mybot/System/runtime-reload.js";

test("reloads command config and refreshes the cached prefix", async () => {
  let reloadCount = 0;
  let cachedPrefix = "?";

  const result = await performRuntimeReload(
    {
      uid: "bot-1",
      requestId: "req-1",
      reloadType: "command-config",
    },
    {
      reloadCommandConfig: () => {
        reloadCount += 1;
        return { prefix: "!" };
      },
      setGlobalPrefix: (nextPrefix) => {
        cachedPrefix = nextPrefix;
      },
      writeReloadState: (uid, state) => ({ uid, ...state }),
    },
  );

  assert.equal(reloadCount, 1);
  assert.equal(cachedPrefix, "!");
  assert.equal(result.status, "ready");
  assert.equal(result.requestId, "req-1");
});
