const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const paletteUrl = pathToFileURL(path.join(__dirname, "../dashboard/public/js/components/command-palette.js")).href;

test("Ctrl+K opens a palette that searches workspaces, bots, and groups", async () => {
  const { createCommandPalette } = await import(paletteUrl);
  const dom = new JSDOM("<!doctype html><body></body>");
  const router = { navigate(route) { this.route = route; } };
  const palette = createCommandPalette({ document: dom.window.document, router, getBots: () => [{ name: "Alpha" }], getGroups: () => [{ name: "Ops Core" }] });

  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  assert.equal(dom.window.document.querySelector("#commandPalette").hidden, false);
  assert.equal(palette.search("ops")[0].label, "Ops Core");
  assert.equal(palette.search("fleet")[0].route, "bots/fleet");
  dom.window.close();
});

test("palette traps focus, supports keyboard selection, and restores its trigger", async () => {
  const { createCommandPalette } = await import(paletteUrl);
  const dom = new JSDOM("<!doctype html><body><button id='trigger'>Search</button></body>");
  const router = { navigate(route) { this.route = route; } };
  const trigger = dom.window.document.getElementById("trigger");
  trigger.focus();
  const palette = createCommandPalette({ document: dom.window.document, router });

  palette.open(trigger);
  const input = dom.window.document.querySelector("#commandPalette input");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(router.route, "bots/fleet");
  assert.equal(dom.window.document.querySelector("#commandPalette").hidden, true);
  assert.equal(dom.window.document.activeElement, trigger);
  dom.window.close();
});
