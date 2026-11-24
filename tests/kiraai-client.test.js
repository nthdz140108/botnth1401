import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  callKiraAiChat,
  getKiraAiConfig,
  isKiraAiConfigured,
  resetKiraAiConfigCache,
} from "../src/service-debug/api-crawl/assistant-ai/kiraai-client.js";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        Promise.resolve(handler(req, res, body))
          .catch((err) => {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { message: err?.message || "internal error" } }));
          });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test.beforeEach(() => {
  delete process.env.KIRA_API_KEY;
  delete process.env.KIRA_BASE_URL;
  delete process.env.KIRA_MODEL;
  delete process.env.KIRA_TIMEOUT_MS;
  resetKiraAiConfigCache();
});

test("callKiraAiChat posts to /chat/completions with Bearer auth and kira-auto model", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  resetKiraAiConfigCache();

  let captured = null;
  const { server, url } = await startServer((req, res, body) => {
    captured = {
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: JSON.parse(body),
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "Xin chào" } }] }));
  });

  try {
    const result = await callKiraAiChat("hello", { baseUrl: url });
    assert.equal(result, "Xin chào");
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/chat/completions");
    assert.equal(captured.auth, "Bearer test-secret-key");
    assert.match(captured.contentType, /application\/json/);
    assert.equal(captured.body.model, "kira-auto");
    assert.deepEqual(captured.body.messages, [{ role: "user", content: "hello" }]);
  } finally {
    await stopServer(server);
  }
});

test("callKiraAiChat throws MISSING_API_KEY when KIRA_API_KEY is empty", async () => {
  let calls = 0;
  const { server, url } = await startServer(async () => {
    calls += 1;
  });

  try {
    await assert.rejects(
      callKiraAiChat("hello", { baseUrl: url }),
      (err) => err.code === "MISSING_API_KEY",
    );
    assert.equal(calls, 0, "HTTP server should never be reached without API key");
  } finally {
    await stopServer(server);
  }
});

test("callKiraAiChat rejects empty question without HTTP call", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  resetKiraAiConfigCache();
  let calls = 0;
  const { server, url } = await startServer(async () => { calls += 1; });
  try {
    await assert.rejects(
      callKiraAiChat("   ", { baseUrl: url }),
      (err) => err.code === "INVALID_INPUT",
    );
    assert.equal(calls, 0);
  } finally {
    await stopServer(server);
  }
});

test("callKiraAiChat reports HTTP_401 without leaking Authorization header", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  resetKiraAiConfigCache();

  const { server, url } = await startServer((req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "unauthorized" } }));
  });

  try {
    await assert.rejects(
      callKiraAiChat("hello", { baseUrl: url }),
      (err) => err.code === "HTTP_401" && err.status === 401 && !String(err.message).includes("test-secret-key"),
    );
  } finally {
    await stopServer(server);
  }
});

test("callKiraAiChat reports HTTP_429 and HTTP_5xx", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  resetKiraAiConfigCache();

  for (const [status, expectedCode] of [[429, "HTTP_429"], [503, "HTTP_503"]]) {
    const { server, url } = await startServer((req, res) => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    try {
      await assert.rejects(
        callKiraAiChat("hello", { baseUrl: url }),
        (err) => err.code === expectedCode,
      );
    } finally {
      await stopServer(server);
    }
  }
});

test("callKiraAiChat throws INVALID_RESPONSE on malformed payload", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  resetKiraAiConfigCache();
  const { server, url } = await startServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [] }));
  });
  try {
    await assert.rejects(
      callKiraAiChat("hello", { baseUrl: url }),
      (err) => err.code === "INVALID_RESPONSE",
    );
  } finally {
    await stopServer(server);
  }
});

test("callKiraAiChat sends only the current question (no history or system prompt)", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  resetKiraAiConfigCache();
  let captured;
  const { server, url } = await startServer((req, res, body) => {
    captured = JSON.parse(body);
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  try {
    await callKiraAiChat("Câu hỏi duy nhất", { baseUrl: url });
    assert.equal(captured.messages.length, 1);
    assert.equal(captured.messages[0].role, "user");
    assert.equal(captured.messages[0].content, "Câu hỏi duy nhất");
    assert.equal(Object.prototype.hasOwnProperty.call(captured, "system"), false);
  } finally {
    await stopServer(server);
  }
});

test("getKiraAiConfig returns defaults when no overrides set", () => {
  process.env.KIRA_API_KEY = "x";
  resetKiraAiConfigCache();
  const cfg = getKiraAiConfig();
  assert.equal(cfg.baseUrl, "https://kiraai.vn/api/v1");
  assert.equal(cfg.model, "kira-auto");
  assert.equal(cfg.timeoutMs, 30000);
});

test("getKiraAiConfig honors overrides", () => {
  process.env.KIRA_API_KEY = "x";
  process.env.KIRA_BASE_URL = "https://example.test/api/v1/";
  process.env.KIRA_MODEL = "kira-fast";
  process.env.KIRA_TIMEOUT_MS = "12000";
  resetKiraAiConfigCache();
  const cfg = getKiraAiConfig();
  assert.equal(cfg.baseUrl, "https://example.test/api/v1");
  assert.equal(cfg.model, "kira-fast");
  assert.equal(cfg.timeoutMs, 12000);
});

test("isKiraAiConfigured is false when KIRA_API_KEY is missing/empty", () => {
  delete process.env.KIRA_API_KEY;
  resetKiraAiConfigCache();
  assert.equal(isKiraAiConfigured(), false);
  process.env.KIRA_API_KEY = "   ";
  resetKiraAiConfigCache();
  assert.equal(isKiraAiConfigured(), false);
  process.env.KIRA_API_KEY = "real-key";
  resetKiraAiConfigCache();
  assert.equal(isKiraAiConfigured(), true);
});

test("callKiraAiChat handles a slow server with timeout code", async () => {
  process.env.KIRA_API_KEY = "test-secret-key";
  process.env.KIRA_TIMEOUT_MS = "50";
  resetKiraAiConfigCache();
  const { server, url } = await startServer(async (req, res) => {
    await new Promise((r) => setTimeout(r, 200));
    res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
  });
  try {
    await assert.rejects(
      callKiraAiChat("hello", { baseUrl: url }),
      (err) => err.code === "TIMEOUT" || err.code === "ECONNABORTED",
    );
  } finally {
    await stopServer(server);
  }
});