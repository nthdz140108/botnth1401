import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";

const SECRET = fs.readFileSync("/opt/mybot/mybot/.internal_secret", "utf8").trim();

function bridgeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const rawBody = body ? JSON.stringify(body) : "";
    const timestamp = Date.now().toString();
    const payloadToSign = `${timestamp}.${rawBody}`;
    const signature = crypto.createHmac("sha256", SECRET).update(payloadToSign).digest("hex");

    const headers = {
      "x-internal-signature": signature,
      "x-internal-timestamp": timestamp,
    };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(rawBody);
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 4174,
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(rawBody);
    }
    req.end();
  });
}

async function run() {
  console.log("=== 1. KIỂM TRA SNAPSHOT BAN ĐẦU ===");
  const snap1 = await bridgeRequest("GET", "/bridge/snapshot");
  console.log("Status:", snap1.status);
  console.log("Fleet bots count:", snap1.json?.data?.bots?.length);
  const adminBot1 = snap1.json?.data?.bots?.find((b) => b.id === "admin");
  console.log("Admin bot details:", {
    id: adminBot1?.id,
    name: adminBot1?.displayName,
    uid: adminBot1?.uid,
    status: adminBot1?.status,
    connected: adminBot1?.connected,
    cookieDead: adminBot1?.cookieDead,
  });

  console.log("\n=== 2. THỬ THAO TÁC TẮT BOT (HOT STANDBY) ===");
  const t0 = Date.now();
  const stopRes = await bridgeRequest("POST", "/bridge/bots/admin/action", {
    action: "standby",
  });
  const stopDuration = Date.now() - t0;
  console.log(`Kết quả Tắt (Standby) sau ${stopDuration}ms:`, stopRes.status, stopRes.json);

  // Chờ 1.5 giây và kiểm tra snapshot
  await new Promise((r) => setTimeout(r, 1500));
  const snap2 = await bridgeRequest("GET", "/bridge/snapshot");
  const adminBot2 = snap2.json?.data?.bots?.find((b) => b.id === "admin");
  console.log("Trạng thái sau khi Tắt:", {
    status: adminBot2?.status,
    connected: adminBot2?.connected,
  });

  console.log("\n=== 3. THỬ THAO TÁC BẬT LẠI BOT (RESUME / START) ===");
  const t1 = Date.now();
  const startRes = await bridgeRequest("POST", "/bridge/bots/admin/action", {
    action: "resume",
  });
  const startDuration = Date.now() - t1;
  console.log(`Kết quả Bật lại (Resume) sau ${startDuration}ms:`, startRes.status, startRes.json);

  // Chờ 2.5 giây để WebSocket thiết lập lại và lấy snapshot
  await new Promise((r) => setTimeout(r, 2500));
  const snap3 = await bridgeRequest("GET", "/bridge/snapshot");
  const adminBot3 = snap3.json?.data?.bots?.find((b) => b.id === "admin");
  console.log("Trạng thái sau khi Bật lại:", {
    status: adminBot3?.status,
    connected: adminBot3?.connected,
    cookieDead: adminBot3?.cookieDead,
  });

  console.log("\n=== 4. TỔNG KẾT NGHIỆM THU ===");
  const standbyOk = adminBot2?.status === "standby" || adminBot2?.connected === false;
  const resumeOk = adminBot3?.status === "running" || adminBot3?.connected === true;
  console.log("Tắt bot chờ nóng thành công:", standbyOk ? "PASS ✅" : "FAIL ❌");
  console.log("Bật bot thức dậy thành công:", resumeOk ? "PASS ✅" : "FAIL ❌");
  console.log("Thời gian Tắt:", `${stopDuration}ms`);
  console.log("Thời gian Bật lại:", `${startDuration}ms`);
}

run().catch(console.error);
