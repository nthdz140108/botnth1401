import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sendMessageFactory } from "../src/api-zalo/apis/sendMessage.js";
import { appContext } from "../src/api-zalo/context.js";
import { decodeAES, encodeAES } from "../src/api-zalo/utils.js";

test("sendMessage preserves outbound clientId in attachment receipt", async () => {
  const secretKey = "12345678901234567890123456789012";
  appContext.secretKey = secretKey;
  appContext.imei = "mock-imei-uuid";
  appContext.cookie = "zpw_sek=123";
  appContext.userAgent = "mock-agent";

  const interceptedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body).get("params");
      const decrypted = params ? JSON.parse(decodeAES(secretKey, params)) : {};
      interceptedRequests.push({ url: req.url, body: decrypted });
      const responsePayload = {
        error_code: 0,
        data: encodeAES(
          secretKey,
          JSON.stringify({ error_code: 0, data: { msgId: "8180842287691" } })
        ),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const fakeApi = {
      zpwServiceMap: {
        chat: [baseUrl],
        group: [baseUrl],
        file: [baseUrl],
      },
      uploadAttachment: async () => [
        {
          fileType: "image",
          photoId: "photo-123",
          width: 100,
          height: 100,
          normalUrl: "https://zalo.mock/img.png",
          hdUrl: "https://zalo.mock/hd.png",
          thumbUrl: "https://zalo.mock/thumb.png",
          totalSize: 1024,
        },
      ],
    };

    const sendMessage = sendMessageFactory(fakeApi);

    const result = await sendMessage(
      { msg: "selection caption", attachments: ["selection-result.png"] },
      "direct-thread-1",
      0
    );

    assert.ok(result.attachment && result.attachment[0], "Expected attachment receipt");
    assert.equal(result.attachment[0].msgId, "8180842287691");
    assert.equal(
      result.attachment[0].cliMsgId,
      String(interceptedRequests[0].body.clientId)
    );
    assert.notEqual(result.attachment[0].cliMsgId, result.attachment[0].msgId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("sendMessage preserves outbound clientId in text receipt", async () => {
  const secretKey = "12345678901234567890123456789012";
  appContext.secretKey = secretKey;
  appContext.imei = "mock-imei-uuid";
  appContext.cookie = "zpw_sek=123";
  appContext.userAgent = "mock-agent";

  const interceptedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body).get("params");
      const decrypted = params ? JSON.parse(decodeAES(secretKey, params)) : {};
      interceptedRequests.push({ url: req.url, body: decrypted });
      const responsePayload = {
        error_code: 0,
        data: encodeAES(
          secretKey,
          JSON.stringify({ error_code: 0, data: { msgId: "8180842287691" } })
        ),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const fakeApi = {
      zpwServiceMap: {
        chat: [baseUrl],
        group: [baseUrl],
        file: [baseUrl],
      },
    };

    const sendMessage = sendMessageFactory(fakeApi);

    const result = await sendMessage(
      { msg: "plain text message" },
      "direct-thread-1",
      0
    );

    assert.ok(result.message, "Expected message receipt");
    assert.equal(result.message.msgId, "8180842287691");
    assert.equal(
      result.message.cliMsgId,
      String(interceptedRequests[0].body.clientId)
    );
    assert.notEqual(result.message.cliMsgId, result.message.msgId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
