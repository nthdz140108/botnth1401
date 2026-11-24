import fs from "node:fs";
import { Zalo } from "../src/api-zalo/index.js";

async function main() {
  const botConfig = JSON.parse(fs.readFileSync("/opt/mybot/assets/config.json", "utf8"));
  const zalo = new Zalo({
    cookie: botConfig.cookie,
    imei: botConfig.imei,
    userAgent: botConfig.userAgent,
  });
  try {
    const api = await zalo.login();
    console.log("LOGIN SUCCESS! UID:", api.getOwnId());
  } catch (err) {
    console.error("LOGIN FAILED:", err.message);
  }
}

main();
