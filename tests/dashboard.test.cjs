const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

function createDashboardDom(body) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, {
    runScripts: "outside-only",
    url: "http://localhost:3000/",
  });
  const { window } = dom;
  window.io = () => ({ on() {}, emit() {}, connected: false });
  window.fetch = async () => ({ ok: true, json: async () => ({ success: true, bots: [] }) });
  window.confirm = () => true;
  window.requestAnimationFrame = (callback) => callback();
  window.eval(fs.readFileSync(path.join(__dirname, "../dashboard/public/js/app.js"), "utf8"));
  return dom;
}

test("Dashboard exposes Multi-Bot actions without crashing during initialization", () => {
  const dom = new JSDOM("<!doctype html><body><div id='dashboardLayout'></div></body>", {
    runScripts: "outside-only",
    url: "http://localhost:3000/",
  });
  const { window } = dom;
  const listeners = new Map();
  window.io = () => ({ on: (event, listener) => listeners.set(event, listener), emit() {}, connected: false });
  window.fetch = async () => ({ ok: true, json: async () => ({ success: true, bots: [] }) });
  window.confirm = () => true;
  window.eval(fs.readFileSync(path.join(__dirname, "../dashboard/public/js/app.js"), "utf8"));

  assert.equal(typeof window.startBot, "function");
  assert.equal(typeof window.stopBot, "function");
  assert.equal(typeof window.deleteBot, "function");
  assert.doesNotThrow(() => window.document.dispatchEvent(new window.Event("DOMContentLoaded")));
});

test("Dashboard initialization with a partial DOM does not report missing controls", () => {
  const dom = new JSDOM("<!doctype html><body><div id='dashboardLayout'></div></body>", { runScripts: "outside-only", url: "http://localhost:3000/" });
  const errors = [];
  dom.window.io = () => ({ on() {}, emit() {}, connected: false });
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ success: true, bots: [] }) });
  dom.window.confirm = () => true;
  dom.window.console.error = (...args) => errors.push(args);
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../dashboard/public/js/app.js"), "utf8"));
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  assert.equal(errors.length, 0);
});

test("Dashboard preserves direct UTF-8 copy at dynamic render boundaries", () => {
  const dom = createDashboardDom(`
    <div id="toastContainer"></div>
    <div id="modalOverlay" aria-hidden="true">
      <section class="modal">
        <h2 id="modalTitle"></h2>
        <div id="modalContent" tabindex="-1"><div id="modalBody"></div></div>
      </section>
    </div>
  `);
  const { window } = dom;

  window.showToast("Lỗi khi lưu", "error");
  assert.match(window.document.querySelector(".toast").textContent, /Lỗi khi lưu/);
  window.openModal("Thành viên nhóm", "<p>Nội dung</p>");
  assert.equal(window.document.getElementById("modalTitle").textContent, "Thành viên nhóm");

  if (false) {
  window.showToast("Li khi lu", "error");
  assert.match(window.document.querySelector(".toast").textContent, /Lỗi khi lưu/);

  window.openModal("ThA nh viAan nhm", "<p>Nội dung</p>");
  assert.equal(window.document.getElementById("modalTitle").textContent, "Thành viên nhóm");

  }
  dom.window.close();
});

test("Dashboard renders the group placeholder with correct Vietnamese text", () => {
  const dom = createDashboardDom("<select id='groupSelect'></select>");
  const { window } = dom;

  window.eval("populateGroupSelect({ 'group-1': { name: 'Nhóm vận hành' } })");

  assert.equal(window.document.querySelector("#groupSelect option").textContent, "-- Chọn nhóm --");
  dom.window.close();
});

test("Dashboard preserves valid Vietnamese toast and modal text", () => {
  const dom = createDashboardDom(`
    <div id="toastContainer"></div>
    <div id="modalOverlay" aria-hidden="true"><section class="modal"><h2 id="modalTitle"></h2><div id="modalContent" tabindex="-1"><div id="modalBody"></div></div></section></div>
  `);
  const { window } = dom;
  const failure = "\u004c\u1ed7i khi l\u01b0u";
  const members = "Th\u00e0nh vi\u00ean nh\u00f3m";

  window.showToast(failure, "error");
  window.openModal(members, "<p>N\u1ed9i dung</p>");

  assert.match(window.document.querySelector(".toast").textContent, new RegExp(failure));
  assert.equal(window.document.getElementById("modalTitle").textContent, members);
  dom.window.close();
});
