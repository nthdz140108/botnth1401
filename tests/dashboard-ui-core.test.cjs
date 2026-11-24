const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");

const coreUrl = pathToFileURL(path.join(__dirname, "../dashboard/public/js/core/ui-state.js")).href;
const overlayUrl = pathToFileURL(path.join(__dirname, "../dashboard/public/js/components/overlay.js")).href;

test("router keeps a command filter while a user changes workspaces", async () => {
  const { createRouter } = await import(coreUrl);
  const dom = new JSDOM("<!doctype html><body><section class='page' data-page='dashboard'></section><section class='page' data-page='commands'></section></body>", { url: "http://localhost/#overview" });
  const router = createRouter({ window: dom.window, document: dom.window.document, onNavigate() {} });

  router.start();
  router.setFilter("commands", "ping");
  router.navigate("bots/fleet");
  router.navigate("automation/commands");

  assert.equal(router.getState().filters.commands, "ping");
  assert.equal(router.getState().route, "automation/commands");
  dom.window.close();
});

test("router activates semantic pages and emits one state per hash navigation", async () => {
  const { createRouter } = await import(coreUrl);
  const dom = new JSDOM("<!doctype html><body><a class='nav-item' data-page='dashboard'></a><a class='nav-item' data-page='commands'></a><section class='page' id='page-dashboard' data-page='dashboard'></section><section class='page' id='page-commands' data-page='commands'></section></body>", { url: "http://localhost/#overview" });
  const states = [];
  const router = createRouter({ window: dom.window, document: dom.window.document, onNavigate: (state) => states.push(state) });

  router.start();
  router.navigate("automation/commands");

  assert.equal(dom.window.document.querySelector("#page-dashboard").classList.contains("active"), false);
  assert.equal(dom.window.document.querySelector("#page-commands").classList.contains("active"), true);
  assert.equal(dom.window.document.querySelector(".nav-item[data-page='commands']").classList.contains("active"), true);
  assert.equal(states.at(-1).route, "automation/commands");
  router.destroy();
  dom.window.close();
});

test("overlay traps focus and returns it to the trigger after close", async () => {
  const { createOverlayManager } = await import(overlayUrl);
  const dom = new JSDOM("<!doctype html><body><button id='trigger'>Open</button><section id='dialog' hidden><button id='first'>First</button><button id='last'>Last</button></section></body>");
  const { document, KeyboardEvent } = dom.window;
  const trigger = document.getElementById("trigger");
  const dialog = document.getElementById("dialog");
  const manager = createOverlayManager({ document });

  trigger.focus();
  manager.open(dialog, trigger);
  document.getElementById("last").focus();
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(document.activeElement.id, "first");

  manager.close();
  assert.equal(document.activeElement, trigger);
  dom.window.close();
});

test("overlay confirmation requires an explicit confirmation and restores focus", async () => {
  const { createOverlayManager } = await import(overlayUrl);
  const dom = new JSDOM("<!doctype html><body><button id='trigger'>Delete</button></body>");
  const { document } = dom.window;
  const trigger = document.getElementById("trigger");
  const manager = createOverlayManager({ document });
  let calls = 0;

  const confirmation = manager.confirm({ title: "Delete bot", message: "Cannot be undone", confirmLabel: "Delete", onConfirm: () => { calls += 1; }, trigger });
  assert.equal(calls, 0);
  confirmation.querySelector("[data-confirm]").click();
  assert.equal(calls, 1);
  assert.equal(confirmation.hidden, true);
  assert.equal(document.activeElement, trigger);
  dom.window.close();
});
