import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { phase1Registry, phase2Registry, phase11Registry } from "../src/commands/command-registry.js";
import { COMMAND_PERMISSION_POLICY } from "../src/commands/command-permission-policy.js";
import { handleImageGeneration } from "../src/service-debug/api-crawl/assistant-ai/create-image.js";
import { handleGeminiMakeCommand } from "../src/commands/gemini-make-command.js";
import { askGeminiCommand } from "../src/service-debug/api-crawl/assistant-ai/gemini.js";
import { handleStickerAiCommand } from "../src/commands/sticker-ai-command.js";
import { __test as __hfTest } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/hf.js";

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

test("ai-image-permissions: registry & policy require adminLevelHigh for all image commands", () => {
  // 1. Check phase1Registry "gemini make"
  const geminiMake = phase1Registry.definitions.find((d) => d.name === "gemini make");
  assert.ok(geminiMake, "gemini make must be registered");
  assert.equal(geminiMake.permission, "adminLevelHigh", "gemini make must require adminLevelHigh");
  assert.equal(COMMAND_PERMISSION_POLICY["gemini make"].requiredRole, "adminLevelHigh");

  // 2. Check phase2Registry "create-image"
  const createImage = phase2Registry.definitions.find((d) => d.name === "create-image");
  assert.ok(createImage, "create-image must be registered");
  assert.equal(createImage.permission, "adminLevelHigh", "create-image must require adminLevelHigh");
  assert.equal(COMMAND_PERMISSION_POLICY["create-image"].requiredRole, "adminLevelHigh");

  // 3. Check phase11Registry "createimageai"
  const createImageAi = phase11Registry.definitions.find((d) => d.name === "createimageai");
  assert.ok(createImageAi, "createimageai must be registered");
  assert.equal(createImageAi.permission, "adminLevelHigh", "createimageai must require adminLevelHigh");
  assert.equal(COMMAND_PERMISSION_POLICY.createimageai.requiredRole, "adminLevelHigh");

  // 4. Check phase11Registry "sticker ai"
  const stickerAi = phase11Registry.definitions.find((d) => d.name === "sticker ai");
  assert.ok(stickerAi, "sticker ai must be registered");
  assert.equal(stickerAi.permission, "adminLevelHigh", "sticker ai must require adminLevelHigh");
  assert.equal(COMMAND_PERMISSION_POLICY["sticker ai"].requiredRole, "adminLevelHigh");
});

test("ai-image-enforcement: non-admin callers are denied immediately", async () => {
  const sentMessages = [];
  const fakeApi = {
    currentUserId: "bot_123",
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return { msgId: "test_msg" };
    },
  };

  const normalUserMessage = {
    senderID: "user_normal_456",
    threadId: "thread_123",
    type: 1,
    data: {
      content: "!createimageai một con rồng",
      uidFrom: "user_normal_456",
      dName: "Người Dùng",
    },
  };

  const hasDeniedMsg = () =>
    sentMessages.some((m) => {
      const text = typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
      return text.includes("chỉ dành riêng cho Admin tối cao");
    });


  // 1. createimageai
  sentMessages.length = 0;
  await handleImageGeneration(fakeApi, normalUserMessage, "createimageai", { isAdminLevelHighest: false });
  assert.ok(hasDeniedMsg(), "createimageai must reject non-admin");

  // 2. gemini make
  sentMessages.length = 0;
  await handleGeminiMakeCommand({
    api: fakeApi,
    message: { ...normalUserMessage, data: { ...normalUserMessage.data, content: "!gemini make một con rồng" } },
    isAdminLevelHighest: false,
  });
  assert.ok(hasDeniedMsg(), "gemini make must reject non-admin");

  // 3. gemini ask with drawing request
  sentMessages.length = 0;
  await askGeminiCommand(
    fakeApi,
    { ...normalUserMessage, data: { ...normalUserMessage.data, content: "!gemini vẽ ảnh con mèo con" } },
    "gemini",
    { isAdminLevelHighest: false }
  );
  assert.ok(hasDeniedMsg(), "gemini image request must reject non-admin");

  // 4. sticker ai
  sentMessages.length = 0;
  await handleStickerAiCommand({
    api: fakeApi,
    message: { ...normalUserMessage, data: { ...normalUserMessage.data, content: "!stk ai một con mèo" } },
    isAdminLevelHighest: false,
  });
  assert.ok(hasDeniedMsg(), "sticker ai must reject non-admin");

});

test("ai-image-execution: admin caller creates image via Hugging Face without opening browser", async () => {
  const prevEnv = process.env.HF_TOKEN;
  process.env.HF_TOKEN = "hf_test_mock_token";

  const clientCalls = [];
  const mockHfClient = {
    textToImage: async (params, options) => {
      clientCalls.push({ method: "textToImage", params, options });
      return new Response(FAKE_PNG, { headers: { "content-type": "image/png" } });
    },
    imageToImage: async (params, options) => {
      clientCalls.push({ method: "imageToImage", params, options });
      return new Response(FAKE_PNG, { headers: { "content-type": "image/png" } });
    },
  };
  __hfTest.setMockClientForTests(mockHfClient);

  const sentMessages = [];
  const fakeApi = {
    currentUserId: "bot_123",
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return { msgId: "msg_out" };
    },
  };

  const adminMessage = {
    senderID: "admin_high_uid",
    threadId: "thread_123",
    type: 1,
    data: {
      content: "!createimageai siêu xe tương lai",
      uidFrom: "admin_high_uid",
      dName: "Admin Tối Cao",
    },
  };

  try {
    // 1. Execute createimageai with admin privileges
    await handleImageGeneration(fakeApi, adminMessage, "createimageai", { isAdminLevelHighest: true });

    assert.equal(clientCalls.length, 1);
    assert.equal(clientCalls[0].method, "textToImage");
    assert.equal(clientCalls[0].params.inputs, "siêu xe tương lai");
    assert.equal(clientCalls[0].params.model, "stabilityai/stable-diffusion-xl-base-1.0");

    const attachmentSend = sentMessages.find(
      (m) => m.payload && Array.isArray(m.payload.attachments) && m.payload.attachments.length > 0
    );
    assert.ok(attachmentSend, "Must send message with attachments");
    const filePath = attachmentSend.payload.attachments[0];
    assert.ok(filePath, "Attachment path must be provided");
    assert.ok(fs.existsSync(filePath), "Temp image file must exist immediately after creation");
    try { fs.unlinkSync(filePath); } catch {}

    // 2. Execute gemini make with admin privileges
    clientCalls.length = 0;
    sentMessages.length = 0;
    await handleGeminiMakeCommand({
      api: fakeApi,
      message: { ...adminMessage, data: { ...adminMessage.data, content: "!gemini make phi thuyền không gian" } },
      isAdminLevelHighest: true,
    });
    assert.equal(clientCalls.length, 1);
    assert.equal(clientCalls[0].params.inputs, "phi thuyền không gian");
    assert.ok(sentMessages.some((m) => m.payload && Array.isArray(m.payload.attachments)));

    // 3. Execute askGeminiCommand drawing request with admin privileges
    clientCalls.length = 0;
    sentMessages.length = 0;
    await askGeminiCommand(
      fakeApi,
      { ...adminMessage, data: { ...adminMessage.data, content: "!gemini vẽ ảnh lâu đài cát bên bờ biển" } },
      "gemini",
      { isAdminLevelHighest: true }
    );
    assert.equal(clientCalls.length, 1);
    assert.equal(clientCalls[0].params.inputs, "lâu đài cát bên bờ biển");
    assert.ok(sentMessages.some((m) => m.payload && Array.isArray(m.payload.attachments)));

    // 4. Empty prompt validation
    sentMessages.length = 0;
    await handleImageGeneration(fakeApi, { ...adminMessage, data: { ...adminMessage.data, content: "!createimageai " } }, "createimageai", { isAdminLevelHighest: true });
    assert.ok(
      sentMessages.some((m) => JSON.stringify(m.payload).includes("Vui lòng nhập mô tả ảnh")),
      "Must warn on empty prompt"
    );
  } finally {
    __hfTest.resetSharedClientForTests();
    if (prevEnv) process.env.HF_TOKEN = prevEnv;
    else delete process.env.HF_TOKEN;
  }
});

