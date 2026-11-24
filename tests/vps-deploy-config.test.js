import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSshAuthArgs,
  createBundleName,
  setupAskpass,
  validateVpsConfig,
} from "../deploy/vps-deploy-config.mjs";

test("VPS deployment config accepts a host, SSH user, and valid port", () => {
  assert.deepEqual(
    validateVpsConfig({ host: " bot.example.com ", user: "root", port: "2222" }),
    { host: "bot.example.com", user: "root", port: 2222, identityFile: null, password: null }
  );
});

test("VPS deployment config accepts optional password", () => {
  assert.deepEqual(
    validateVpsConfig({ host: "1.2.3.4", user: "root", port: 22, password: "secret_password" }),
    { host: "1.2.3.4", user: "root", port: 22, identityFile: null, password: "secret_password" }
  );
});

test("VPS deployment config rejects shell metacharacters and invalid ports", () => {
  assert.throws(() => validateVpsConfig({ host: "bot; touch pwned", user: "root", port: 22 }));
  assert.throws(() => validateVpsConfig({ host: "bot.example.com", user: "root", port: 0 }));
  assert.throws(() => validateVpsConfig({ host: "bot.example.com", user: "root", port: 22, password: "bad\npassword" }));
});

test("SSH auth uses an optional private key and otherwise permits interactive OpenSSH auth", () => {
  assert.deepEqual(buildSshAuthArgs({ identityFile: null }), []);
  assert.deepEqual(buildSshAuthArgs({ identityFile: "C:\\keys\\mybot.pem" }), [
    "-i",
    "C:\\keys\\mybot.pem",
  ]);
});

test("setupAskpass returns null when no password given, and sets up askpass env when password given", () => {
  assert.equal(setupAskpass(null), null);
  assert.equal(setupAskpass(""), null);

  const helper = setupAskpass("test123pass");
  assert.ok(helper);
  assert.equal(helper.env.SSH_ASKPASS_REQUIRE, "force");
  assert.equal(helper.env.MYBOT_VPS_SSH_PASS, "test123pass");
  assert.ok(helper.env.SSH_ASKPASS);
  helper.cleanup();
});

test("bundle names are timestamped and do not reuse the legacy bundle path", () => {
  assert.equal(
    createBundleName(new Date("2026-11-03T01:02:03.000Z")),
    "mybot-vps-bundle-20261103T010203Z.tar.gz"
  );
  assert.equal(
    createBundleName(new Date("2026-11-03T01:02:03.000Z"), 1),
    "mybot-vps-bundle-20261103T010203Z-1.tar.gz"
  );
});
