import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getInstanceKind, getBotName, resetCache, setEnvVars } from "../src/utils/env.js";
import { resolveInstanceKind } from "../src/utils/env.js";

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instance-kind-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot"), { recursive: true });
  return root;
}

function writeRoleRegistry(root, adminBotId) {
  fs.writeFileSync(path.join(root, "mybot", "role-registry.json"), JSON.stringify({ adminBotId }), "utf8");
}

test("resolveInstanceKind treats the admin alias and registered admin id as main", () => {
  assert.equal(resolveInstanceKind("admin"), "main");
  assert.equal(resolveInstanceKind("admin", { adminBotId: "999" }), "main");
  assert.equal(resolveInstanceKind("999", { adminBotId: "999" }), "main");
  assert.equal(resolveInstanceKind("888", { adminBotId: "999" }), "child");
  assert.equal(resolveInstanceKind("", { adminBotId: "999" }), "child");
  assert.equal(resolveInstanceKind(null), "child");
});

test("getInstanceKind resolves child processes from their bot identity", () => {
  const root = makeProjectRoot();
  try {
    setEnvVars({ PROJECT_ROOT: root });
    writeRoleRegistry(root, "999");

    setEnvVars({ BOT_NAME: "999", PROJECT_ROOT: root });
    assert.equal(getBotName(), "admin");
    assert.equal(getInstanceKind(), "main");

    setEnvVars({ BOT_NAME: "777", PROJECT_ROOT: root });
    assert.equal(getBotName(), "777");
    assert.equal(getInstanceKind(), "child");
  } finally {
    resetCache();
  }
});

test("getInstanceKind defaults to the main instance without env identity", () => {
  const root = makeProjectRoot();
  try {
    delete process.env.BOT_NAME;
    delete process.env.name;
    delete process.env.Cursor;
    delete process.env.BOT_ID;
    delete process.env.PM2_NAME;
    delete process.argv[2];
    setEnvVars({ PROJECT_ROOT: root });
    assert.equal(getInstanceKind(), "main");
  } finally {
    resetCache();
  }
});

const IDENTITY_ENV_KEYS = ["BOT_NAME", "BOT_ID", "name", "Cursor", "PM2_NAME"];

function captureIdentitySnapshot() {
  return {
    env: Object.fromEntries(IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]])),
    argv2: process.argv[2],
  };
}

function restoreIdentitySnapshot(snapshot) {
  for (const key of IDENTITY_ENV_KEYS) {
    const value = snapshot.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (snapshot.argv2 === undefined) delete process.argv[2];
  else process.argv[2] = snapshot.argv2;
}

test("inherited legacy admin name cannot override launcher-provided child identity", () => {
  const root = makeProjectRoot();
  const snapshot = captureIdentitySnapshot();
  try {
    setEnvVars({ PROJECT_ROOT: root });
    writeRoleRegistry(root, "999");

    process.env.name = "admin";
    process.env.Cursor = "admin";
    process.env.PM2_NAME = "admin";
    delete process.argv[2];

    setEnvVars({ BOT_NAME: "777", PROJECT_ROOT: root });
    assert.equal(getBotName(), "777");
    assert.equal(getInstanceKind(), "child");
  } finally {
    restoreIdentitySnapshot(snapshot);
    resetCache();
  }
});

test("startup argument identity beats inherited legacy admin name", () => {
  const root = makeProjectRoot();
  const snapshot = captureIdentitySnapshot();
  try {
    setEnvVars({ PROJECT_ROOT: root });
    writeRoleRegistry(root, "999");

    process.env.name = "admin";
    delete process.env.BOT_NAME;
    delete process.env.BOT_ID;

    process.argv[2] = "777";
    assert.equal(getBotName(), "777");
    assert.equal(getInstanceKind(), "child");
  } finally {
    restoreIdentitySnapshot(snapshot);
    resetCache();
  }
});

test("BOT_NAME=admin stays main even when legacy aliases disagree", () => {
  const root = makeProjectRoot();
  const snapshot = captureIdentitySnapshot();
  try {
    setEnvVars({ PROJECT_ROOT: root });
    writeRoleRegistry(root, "999");

    process.env.name = "777";
    process.env.PM2_NAME = "777";

    setEnvVars({ BOT_NAME: "admin", PROJECT_ROOT: root });
    assert.equal(getBotName(), "admin");
    assert.equal(getInstanceKind(), "main");
  } finally {
    restoreIdentitySnapshot(snapshot);
    resetCache();
  }
});

test("registered admin uid stays main regardless of legacy aliases", () => {
  const root = makeProjectRoot();
  const snapshot = captureIdentitySnapshot();
  try {
    setEnvVars({ PROJECT_ROOT: root });
    writeRoleRegistry(root, "999");

    process.env.name = "admin";
    process.env.Cursor = "admin";

    setEnvVars({ BOT_NAME: "999", PROJECT_ROOT: root });
    assert.equal(getBotName(), "admin");
    assert.equal(getInstanceKind(), "main");

    delete process.env.BOT_NAME;
    process.env.BOT_ID = "999";
    resetCache();
    assert.equal(getBotName(), "admin");
    assert.equal(getInstanceKind(), "main");
  } finally {
    restoreIdentitySnapshot(snapshot);
    resetCache();
  }
});
