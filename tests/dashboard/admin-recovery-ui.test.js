import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const { transform } = require("esbuild");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const modalSourcePath = path.join(projectRoot, "dashboard", "src", "components", "admin-recovery-modal.jsx");
const tmpRenderDir = path.join(projectRoot, "node_modules", ".admin-recovery-modal-test");

const source = fs.readFileSync(modalSourcePath, "utf8");
fs.mkdirSync(tmpRenderDir, { recursive: true });
const { code } = await transform(source, { loader: "jsx", jsx: "automatic", format: "esm" });
const modalModulePath = path.join(tmpRenderDir, "admin-recovery-modal.mjs");
fs.writeFileSync(modalModulePath, code);
const { AdminRecoveryModal, formatBangkokExpiry, formatCountdown } = await import(`${pathToFileURL(modalModulePath).href}?t=${Date.now()}`);

test.after(() => {
  fs.rmSync(tmpRenderDir, { recursive: true, force: true });
});

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BASE_NOW = Date.parse("2026-08-31T00:00:00.000Z");
const EXPIRES_AT = "2026-08-31T00:01:30.000Z";
const ACTIVE = {
  state: "waiting_scan",
  sessionId: "session-a",
  createdAt: "2026-08-31T00:00:00.000Z",
  expiresAt: EXPIRES_AT,
  qrImage: PNG_DATA_URL,
};

function renderModal(recovery, extra = {}) {
  return renderToStaticMarkup(React.createElement(AdminRecoveryModal, { recovery, onDismiss: () => {}, nowMs: BASE_NOW, ...extra }));
}

test("active recovery renders the QR data URL image directly", () => {
  const html = renderModal(ACTIVE);
  assert.ok(html.includes(`src="${PNG_DATA_URL}"`), `QR data URL missing from: ${html}`);
});

test("active recovery exposes accessible dialog semantics", () => {
  const html = renderModal(ACTIVE);
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-modal="true"'));
  assert.ok(html.includes('aria-labelledby="admin-recovery-title"'));
  assert.ok(html.includes('id="admin-recovery-title"'));
  assert.ok(html.includes('aria-describedby="admin-recovery-desc"'));
});

test("active recovery shows the Bangkok-local expiry timestamp", () => {
  const html = renderModal(ACTIVE);
  const bangkok = formatBangkokExpiry(EXPIRES_AT);
  assert.ok(bangkok.includes("07:01:30"), `Bangkok time should be 07:01:30 ICT, got ${bangkok}`);
  assert.ok(bangkok.includes("31/08/2026"), `Bangkok date should be 31/08/2026, got ${bangkok}`);
  assert.ok(html.includes(bangkok), `formatted expiry missing from modal html: ${html}`);
});

test("active recovery shows a countdown that reaches zero at expiry", () => {
  assert.equal(formatCountdown(EXPIRES_AT, BASE_NOW), "01:30");
  assert.equal(formatCountdown(EXPIRES_AT, BASE_NOW + 60000), "00:30");
  assert.equal(formatCountdown(EXPIRES_AT, BASE_NOW + 120000), "00:00");
  assert.equal(formatCountdown(EXPIRES_AT, BASE_NOW + 999999), "00:00");
  const html = renderModal(ACTIVE);
  assert.ok(html.includes('class="recovery-countdown"'));
  assert.ok(html.includes(">01:30<"));
});

test("active recovery shows waiting-scan and waiting-confirm state copy", () => {
  const waitingScan = renderModal(ACTIVE);
  assert.ok(waitingScan.includes("Chờ quét"));
  const confirm = renderModal({ ...ACTIVE, state: "waiting_confirm" });
  assert.ok(confirm.includes("Chờ xác nhận"));
  assert.ok(confirm.includes(`src="${PNG_DATA_URL}"`), "QR stays visible while waiting for confirm");
});

test("active recovery shows warning and dashboard-only security copy", () => {
  const html = renderModal(ACTIVE);
  assert.ok(html.toLowerCase().includes("không chia sẻ"), "warning text missing");
  assert.ok(html.includes("no-store"));
  assert.ok(html.includes("localStorage"));
  assert.ok(html.includes("sessionStorage"));
});

test("terminal states remove the QR and close the modal", () => {
  for (const state of ["expired", "failed", "cancelled", "success"]) {
    const html = renderModal({ ...ACTIVE, state });
    assert.equal(html, "", `modal should render nothing for terminal state ${state}`);
  }
  const expiredNoQr = renderModal({ state: "expired" });
  assert.equal(expiredNoQr, "");
});

test("modal renders nothing when recovery payload is missing or has no QR", () => {
  assert.equal(renderModal(null), "");
  assert.equal(renderModal({ state: "waiting_scan", sessionId: "session-a" }), "");
});

test("modal never persists the QR into web storage", () => {
  const html = renderModal(ACTIVE);
  assert.ok(!html.includes("localStorage.setItem"));
  assert.ok(!html.includes("sessionStorage.setItem"));
  assert.ok(html.includes(`src="${PNG_DATA_URL}"`));
});
