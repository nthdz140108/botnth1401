import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";

const SECRET = fs.readFileSync("/opt/mybot/mybot/.internal_secret", "utf8").trim();
console.log("SECRET loaded:", SECRET.slice(0, 6) + "...");

const timestamp = Date.now().toString();
const payloadToSign = `${timestamp}.`;
const signature = crypto.createHmac("sha256", SECRET).update(payloadToSign).digest("hex");
console.log("Signing payload:", payloadToSign);
console.log("Signature:", signature);

console.log("Sending GET /bridge/snapshot...");
const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 4174,
    path: "/bridge/snapshot",
    method: "GET",
    headers: {
      "x-internal-signature": signature,
      "x-internal-timestamp": timestamp,
    },
    timeout: 5000,
  },
  (res) => {
    console.log("Got response status:", res.statusCode);
    let data = "";
    res.on("data", (c) => {
      console.log("Got chunk:", c.length, "bytes");
      data += c;
    });
    res.on("end", () => {
      console.log("Response end. Full length:", data.length);
      try {
        const json = JSON.parse(data);
        console.log("Parsed JSON successfully!");
        console.log("Bots count:", json.data?.bots?.length);
        console.log("First bot:", json.data?.bots?.[0]?.id, "status:", json.data?.bots?.[0]?.status);
      } catch (e) {
        console.log("Raw data:", data);
      }
    });
  }
);

req.on("timeout", () => {
  console.error("HTTP request TIMEOUT after 5000ms!");
  req.destroy();
});

req.on("error", (err) => {
  console.error("HTTP request ERROR:", err);
});

req.end();
console.log("req.end() called.");
