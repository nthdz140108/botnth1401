import http from "node:http";

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log("=== 1. Login to V4 Dashboard ===");
  let loginRes = await request(
    {
      hostname: "127.0.0.1",
      port: 4173,
      path: "/api/auth/login",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    { username: "admin", password: "140108" }
  );

  let cookie = loginRes.headers["set-cookie"]?.[0] || "";
  if (!cookie) {
    loginRes = await request(
      {
        hostname: "127.0.0.1",
        port: 4173,
        path: "/api/auth/login",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      { username: "nthdz", password: "140108" }
    );
    cookie = loginRes.headers["set-cookie"]?.[0] || "";
  }

  const csrfCookie = (cookie.match(/csrf_token=([^;]+)/) || [])[1] || "";
  const csrfToken = loginRes.json?.csrfToken || loginRes.json?.data?.csrfToken || loginRes.json?.token || csrfCookie || "";
  console.log("Login status:", loginRes.status, "Cookie:", cookie ? "Obtained" : "None", "CSRF:", csrfToken ? "Obtained" : "None");
  if (!csrfToken) {
    console.log("Login JSON:", loginRes.json);
  }

  console.log("\n=== 2. Start Admin QR Recovery ===");
  const startRes = await request(
    {
      hostname: "127.0.0.1",
      port: 4173,
      path: "/api/system/admin-recovery/start",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-csrf-token": csrfToken,
      },
    },
    { allowAccountChange: false, botId: "admin" }
  );
  console.log("Start Response:", startRes.status, startRes.json);

  console.log("\n=== 3. Polling Status for 10 seconds ===");
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const statusRes = await request({
      hostname: "127.0.0.1",
      port: 4173,
      path: "/api/system/admin-recovery",
      method: "GET",
      headers: { Cookie: cookie },
    });
    console.log(`Poll #${i + 1}:`, {
      state: statusRes.json?.data?.state || statusRes.json?.state,
      hasQrImage: Boolean(statusRes.json?.data?.qrImage || statusRes.json?.data?.qrDataUrl || statusRes.json?.qrImage || statusRes.json?.qrDataUrl),
      message: statusRes.json?.data?.message || statusRes.json?.message,
      error: statusRes.json?.data?.error || statusRes.json?.error,
    });
  }
}

main().catch(console.error);
