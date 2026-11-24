import http from "node:http";

export async function checkBotHealth(options = {}) {
  const {
    host = "127.0.0.1",
    port = process.env.WEB_PORT || process.env.BOT_WEB_PORT || 2000,
    timeoutMs = 5000,
    token = process.env.BOT_WEB_AUTH_TOKEN || process.env.DASHBOARD_TOKEN || null,
  } = options;

  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://${host}:${port}/internal/runtime/health`,
      {
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              statusCode: res.statusCode,
              ok: res.statusCode === 200 && (parsed.ok === true || parsed.status === "healthy" || parsed.status === "ready" || parsed.status === "ok"),
              data: parsed,
            });
          } catch {
            resolve({
              statusCode: res.statusCode,
              ok: res.statusCode === 200,
              raw: data,
            });
          }
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Healthcheck timed out after ${timeoutMs}ms`));
    });

    req.end();
  });
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  checkBotHealth()
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`[windows-healthcheck] FAILED: ${err.message}`);
      process.exit(1);
    });
}
