import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard group settings and web-service config use enableDownload only", () => {
  const dashboardSource = readFileSync(new URL("../dashboard/public/js/app.js", import.meta.url), "utf8");
  const webServiceSource = readFileSync(new URL("../src/web-service/change-status-config.js", import.meta.url), "utf8");

  assert.match(dashboardSource, /\{\s*key:\s*"enableDownload",\s*label:\s*"Tự động tải video"\s*\}/);
  assert.doesNotMatch(dashboardSource, /key:\s*"autodownload",\s*label:\s*"Tự động tải video"/);
  assert.match(webServiceSource, /case "atd":[\s\S]*case "autodownload":[\s\S]*case "enableDownload":[\s\S]*enableDownload = isActive;/);
  assert.doesNotMatch(webServiceSource, /autodownload = isActive;/);
});
