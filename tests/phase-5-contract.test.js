import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import {
  PHASE_1_COMMANDS,
  PHASE_2_COMMANDS,
  PHASE_3_COMMANDS,
  PHASE_4_COMMANDS,
  PHASE_5_COMMANDS,
  PHASE_6_COMMANDS,
  PHASE_7_COMMANDS,
  PHASE_8_COMMANDS,
  PHASE_9_COMMANDS,
  PHASE_10_COMMANDS,
  PHASE_11_COMMANDS,
  createPhase5Handlers,
  createCommandRegistryForPhases,
  createPhase5Registry,
} from "../src/commands/command-registry.js";
import { createCommandDefinition, createCommandRegistry } from "../src/commands/command-router.js";

const mockContext = {
  scope: "group",
  permissionLevel: "adminBot",
  isMainBotAdmin: true,
  config: {},
  dbReady: true,
  dependencies: {
    zaloSession: true,
    python: true,
    ffmpeg: true,
    ffprobe: true,
  },
  api: {},
  message: {},
  groupSettings: {},
};

const overridesFor = (names, handler = async ({ aliasCommand }) => aliasCommand) => Object.fromEntries(
  names.map((name) => [name, handler]),
);

const registryWith = (name, handler = async () => "ok") => createPhase5Registry({ [name]: handler });

test("Phase 5 exposes a testable lazy-handler factory", () => {
  assert.equal(typeof createPhase5Handlers, "function");
});

test("Phase 5 lazy handlers load the expected exports with the expected arguments", async () => {
  const api = {};
  const message = {};
  const groupInfo = {};
  const loadedPaths = [];
  const expectedMappings = [
    ["spamjoin", "./lenh-debug/spam/remote-join-leave.js", "handleJoinLeaveGroup"],
    ["ketban", "../automations/ndq-test.js", "ketbanCommand"],
    ["kb", "../automations/ndq-test.js", "ketbanTagCommand"],
    ["soundcloud", "../service-debug/api-crawl/music/soundcloud.js", "handleMusicCommand"],
    ["zingmp3", "../service-debug/api-crawl/music/zingmp3.js", "handleZingMp3Command"],
    ["zingchart", "../service-debug/api-crawl/music/zingmp3.js", "handleTopChartZingMp3"],
    ["nhaccuatui", "../service-debug/api-crawl/music/nhaccuatui.js", "handleNhacCuaTuiCommand"],
    ["voice", "../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleVoiceCommand"],
    ["truyencuoi", "../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleStoryCommand"],
    ["tarrot", "../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleTarrotCommand"],
    ["poststatus", "../utils/canvas/status-post.js", "handleCommandStatusPost"],
    ["createqr", "../service-debug/utilities/qr-creater.js", "handleCreateQRCommand"],
    ["scanqr", "../service-debug/utilities/qr-scan.js", "handleScanQRCommand"],
    ["scanapi", "../service-debug/utilities/scan-api.js", "scanApi"],
    ["sendresourcesfile", "./lenh-debug/send-all/send-resources-file.js", "handleSendFile"],
    ["sendsrc", "../service-debug/utilities/share.js", "shareSrc"],
    ["sendresourcesvideo", "./lenh-debug/send-all/send-resources-video.js", "handleSendVideo"],
    ["sendresourcesimage", "./lenh-debug/send-all/send-resources-image.js", "handleSendImage"],
    ["sendresourcesaudio", "./lenh-debug/send-all/send-resources-audio.js", "handleSendAudio"],
  ];
  const aliasCommands = new Set([
    "soundcloud",
    "zingmp3",
    "zingchart",
    "nhaccuatui",
    "voice",
    "poststatus",
    "createqr",
    "scanqr",
    "scanapi",
    "sendresourcesfile",
    "sendsrc",
    "sendresourcesvideo",
    "sendresourcesimage",
    "sendresourcesaudio",
  ]);
  const aliasCommand = "mock-alias";
  const loadModule = async (modulePath) => {
    loadedPaths.push(modulePath);
    return new Proxy({}, {
      get(_target, exportName) {
        if (exportName === "then") return undefined;
        if (exportName === "ketbanCommand" || exportName === "ketbanTagCommand") {
          return { execute: (...args) => ({ exportName, args }) };
        }
        return (...args) => ({ exportName, args });
      },
    });
  };
  const handlers = createPhase5Handlers(loadModule);

  for (const [command, modulePath, exportName] of expectedMappings) {
    const result = await handlers[command]({
      api,
      message,
      groupInfo,
      aliasCommand,
    });

    const expectedArgs = aliasCommands.has(command)
      ? [api, message, aliasCommand]
      : command === "ketban" || command === "kb"
        ? [api, message, groupInfo]
        : [api, message];

    assert.equal(result.exportName, exportName, command);
    assert.deepEqual(result.args, expectedArgs, command);
  }

  const uniqueExpectedPaths = [...new Set(expectedMappings.map(([, modulePath]) => modulePath))];
  assert.deepEqual(loadedPaths, uniqueExpectedPaths);
});

test("group-only Phase 5 commands deny private dispatch without invoking overrides", async () => {
  for (const command of ["ketban", "kb"]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...mockContext,
      scope: "private",
      commandParts: [command],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    assert.equal(result.code, "SCOPE_DENIED", command);
    assert.equal(result.definition.name, command);
    assert.equal(invoked, false, command);
  }
});

test("input-required Phase 5 commands reject missing arguments without invoking overrides", async () => {
  for (const command of [
    "spamjoin",
    "scanapi",
    "sendsrc",
    "sendresourcesfile",
    "sendresourcesvideo",
    "sendresourcesimage",
    "sendresourcesaudio",
  ]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...mockContext,
      commandParts: [command],
    }, registryWith(command, async () => {
      invoked = true;
    }));

    const expectedCode = "MISSING_ARGUMENT";
    assert.equal(result.code, expectedCode, command);
    assert.equal(result.definition.name, command);
    assert.equal(invoked, false, command);
  }
});

test("enabled Phase 5 sendresources commands dispatch for high-level admins", async () => {
  for (const command of [
    "sendresourcesfile",
    "sendresourcesvideo",
    "sendresourcesimage",
    "sendresourcesaudio",
  ]) {
    let invoked = false;
    const result = await dispatchCommand({
      ...mockContext,
      permissionLevel: "adminLevelHigh",
      commandParts: [command, "sample"],
    }, registryWith(command, async () => {
      invoked = true;
      return "ok";
    }));

    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.definition.name, command);
    assert.equal(invoked, true, command);
  }
});

test("Phase 5 handler failures become structured errors preserving the thrown message", async () => {
  const result = await dispatchCommand({
    ...mockContext,
    commandParts: ["voice"],
  }, registryWith("voice", async () => {
    throw new Error("phase 5 provider failed");
  }));

  assert.equal(result.code, "HANDLER_ERROR");
  assert.equal(result.definition.name, "voice");
  assert.equal(result.error.message, "phase 5 provider failed");
});

test("Phase 5 aliases resolve case-insensitively to canonical commands", async () => {
  const aliases = {
    SCL: "soundcloud",
    MUSIC: "soundcloud",
    ZMP3: "zingmp3",
    MS3: "zingmp3",
    ZING: "zingmp3",
    TOPZINGMP3: "zingchart",
    ZMP3C: "zingchart",
    NCT: "nhaccuatui",
    MS2: "nhaccuatui",
    PS: "poststatus",
    STATUS: "poststatus",
    STT: "poststatus",
    QR: "createqr",
    QRCODE: "createqr",
    SQR: "scanqr",
    SAPI: "scanapi",
    SHARE: "sendresourcesfile",
    SHARESRC: "sendsrc",
    SENDVIDEO: "sendresourcesvideo",
    SENDANH: "sendresourcesimage",
    SENDVOICE: "sendresourcesaudio",
    SENDAUDIO: "sendresourcesaudio",
    SDV: "sendresourcesaudio",
  };
  const registry = createPhase5Registry(overridesFor(PHASE_5_COMMANDS));

  for (const [alias, canonical] of Object.entries(aliases)) {
    const result = await dispatchCommand({
      ...mockContext,
      permissionLevel: "adminLevelHigh",
      commandParts: [alias, "sample"],
    }, registry);

    assert.equal(result.code, "HANDLED", alias);
    assert.equal(result.definition.name, canonical, alias);
    assert.equal(result.value, alias.toLowerCase(), alias);
  }
});

test("Phase 5 definitions and aggregate lookup keys are unique and aggregate to 219 definitions", () => {
  const phase5 = createPhase5Registry(overridesFor(PHASE_5_COMMANDS));
  const names = phase5.definitions.map(({ name }) => name);
  const keys = [...phase5.lookup.keys()];

  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(keys).size, keys.length);

  const aggregate = createCommandRegistryForPhases(overridesFor([
    ...PHASE_1_COMMANDS,
    ...PHASE_2_COMMANDS,
    ...PHASE_3_COMMANDS,
    ...PHASE_4_COMMANDS,
    ...PHASE_5_COMMANDS,
    ...PHASE_6_COMMANDS,
    ...PHASE_7_COMMANDS,
    ...PHASE_8_COMMANDS,
    ...PHASE_9_COMMANDS,
    ...PHASE_10_COMMANDS,
    ...PHASE_11_COMMANDS,
  ]));
  assert.equal(aggregate.definitions.length, 219);
  assert.equal(new Set(aggregate.definitions.map(({ name }) => name)).size, 219);
  assert.equal(new Set(aggregate.lookup.keys()).size, aggregate.lookup.size);
});

test("the common router enforces permission denial for a restricted custom fixture", async () => {
  const restricted = createCommandRegistry([
    createCommandDefinition({
      name: "phase5-permission-fixture",
      permission: "adminBot",
      handler: async () => "no",
    }),
  ]);
  const result = await dispatchCommand({
    commandParts: ["phase5-permission-fixture"],
    scope: "group",
    permissionLevel: "all",
  }, restricted);

  assert.equal(result.code, "PERMISSION_DENIED");
});
