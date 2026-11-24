import test from "node:test";
import assert from "node:assert/strict";
import { loadBotWorkspaceData } from "../../dashboard/src/components/bot-workspace-data.js";

test("bot workspace data keeps core data when QR lookup fails", async () => {
  const calls = [];
  const result = await loadBotWorkspaceData({
    botId: "child",
    request: async (path, options = {}) => {
      calls.push([path, options.method || "GET"]);
      if (path.endsWith("/qr-login")) throw Object.assign(new Error("Not found"), { status: 404, code: "NOT_FOUND" });
      if (path.endsWith("/credential")) return { data: { value: { cookie: {} } } };
      if (path.endsWith("/prefix")) return { data: { prefix: "!" } };
      if (path.endsWith("/config")) return { data: { files: { WEB_CONFIG_PATH: { prefix: "!" } } } };
      if (path.endsWith("/runtime")) return { data: { status: "running" } };
      if (path.endsWith("/child")) return { data: { id: "child", displayName: "Child Bot" } };
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  assert.equal(result.error, "");
  assert.equal(result.qrError, "Not found");
  assert.equal(result.bot.displayName, "Child Bot");
  assert.equal(result.prefix, "!");
  assert.deepEqual(result.files, { WEB_CONFIG_PATH: { prefix: "!" } });
  assert.equal(calls.some(([path]) => path.endsWith("/qr-login")), true);
});
