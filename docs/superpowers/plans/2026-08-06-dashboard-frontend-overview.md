# Dashboard Frontend and Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the six-workspace Cyber Operations shell and realtime Overview workspace while preserving every existing dashboard operation.

**Architecture:** Retain `app.js` as bootstrap and global compatibility bridge. Add small ES modules for routing, accessible overlays, command palette, and overview rendering; route changes toggle the existing page sections so legacy APIs and action handlers continue to work. The overview module consumes the completed `/api/dashboard/overview` contract and dashboard Socket.IO events.

**Tech Stack:** Express, Socket.IO, browser ES modules, plain HTML/CSS/JavaScript, Chart.js, Node test runner, JSDOM, Puppeteer.

## Global Constraints

- Keep plain JavaScript, Express, current dashboard APIs, existing page actions, and `startBot`, `stopBot`, and `deleteBot` browser globals.
- Do not change bot core, database, authentication, roles, audit trail, or any user data in `assets/`.
- Support desktop at 1280px and above, dark-only styling, local dependency assets, and `prefers-reduced-motion`.
- Legacy hashes and documented workspace routes must resolve to the same existing functional sections.
- Overview never exposes cookies, IMEIs, user agents, credentials, or user-identifying activity.

---

### Task 1: Lock routing and shared interaction contracts

**Files:**
- Modify: `dashboard/public/js/core/router.js`
- Create: `dashboard/public/js/core/ui-state.js`
- Create: `dashboard/public/js/components/overlay.js`
- Modify: `tests/dashboard-router.test.cjs`
- Create: `tests/dashboard-ui-core.test.cjs`

**Interfaces:**
- `resolveRoute(hash)` returns `{ route, page }` for all legacy and workspace hashes.
- `createRouter({ window, document, onNavigate })` exposes `start()`, `navigate(route)`, and `getState()`.
- `createOverlayManager({ document })` exposes `open(element, trigger)`, `close()`, and `confirm(options)`.

- [ ] **Step 1: Write failing router and UI tests**

```js
test("router retains filter state when navigating through a legacy hash", () => {
  const router = createRouter({ window, document, onNavigate() {} });
  router.start();
  router.getState().filters.commands = "ping";
  router.navigate("bots/fleet");
  router.navigate("automation/commands");
  assert.equal(router.getState().filters.commands, "ping");
});

test("overlay traps Tab focus and restores its triggering control", () => {
  const manager = createOverlayManager({ document });
  manager.open(dialog, trigger);
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  manager.close();
  assert.equal(document.activeElement, trigger);
});
```

- [ ] **Step 2: Run tests and observe expected module failures**

Run: `node --test tests/dashboard-router.test.cjs tests/dashboard-ui-core.test.cjs`

Expected: failure because `ui-state.js` and `overlay.js` do not exist, then the filter/focus assertions fail before implementation.

- [ ] **Step 3: Implement minimal route and focus behavior**

```js
export function createRouter({ window, document, onNavigate }) {
  const state = { route: "overview", filters: {} };
  return { start, navigate, getState: () => state };
}
```

Map every documented new route and legacy hash in `router.js`; activate one `.page` and one `.nav-item`; persist in-memory filters. Implement focus cycling between visible focusable dialog elements, Escape close, and a confirmation dialog that only invokes its action after explicit confirmation.

- [ ] **Step 4: Verify unit tests**

Run: `node --test tests/dashboard-router.test.cjs tests/dashboard-ui-core.test.cjs`

Expected: all routing, legacy alias, focus restoration, confirmation, and keyboard tests pass.

### Task 2: Build the phase 3 shell and command palette

**Files:**
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/css/style.css`
- Modify: `dashboard/public/js/app.js`
- Create: `dashboard/public/js/components/command-palette.js`
- Create: `tests/dashboard-shell.test.cjs`

**Interfaces:**
- `createCommandPalette({ document, router, getBots, getGroups })` exposes `open()`, `close()`, and `search(query)`.
- `app.js` imports the router, overlay manager, and palette, then assigns compatibility globals on `window`.

- [ ] **Step 1: Write failing shell tests**

```js
test("Ctrl+K opens a searchable palette with workspace, bot, and group results", () => {
  const palette = createCommandPalette({ document, router, getBots: () => [{ name: "Alpha" }], getGroups: () => [{ name: "Ops" }] });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  assert.equal(palette.search("ops")[0].label, "Ops");
});

test("shell exposes an aria-live toast container and six workspace labels", () => {
  assert.ok(document.querySelector("[aria-live='polite']"));
  assert.equal(document.querySelectorAll("[data-workspace]").length, 6);
});
```

- [ ] **Step 2: Run shell tests and verify RED**

Run: `node --test tests/dashboard-shell.test.cjs`

Expected: failure because the command-palette module and semantic shell hooks are absent.

- [ ] **Step 3: Implement the shell, token CSS, and palette**

Add semantic workspace navigation with `data-workspace` and canonical hashes. Add local Chart.js and local icon/font links already installed or copied into dashboard public assets; do not load CDN resources. Add the exact Cyber Operations tokens, 6-8px radius, technical grid, status-only pulse/sweep, reduced-motion overrides, visible keyboard focus, aria-live toast container, and stable desktop grid tracks. Replace `UI_COPY` mojibake workaround by correct UTF-8 Vietnamese source text.

The palette must use dialog semantics, filter workspace/bot/group records, navigate a selected workspace, and return focus on close. Existing modal callers use the shared focus manager and dangerous action callers use `confirm()`.

- [ ] **Step 4: Verify shell and UTF-8 checks**

Run: `node --test tests/dashboard-shell.test.cjs tests/dashboard-router.test.cjs tests/dashboard-ui-core.test.cjs`

Run: `node tests/check-dashboard-utf8.cjs`

Expected: all shell tests pass and UTF-8 checker reports `dashboard utf8 check passed`.

### Task 3: Add test-driven Overview rendering and realtime state

**Files:**
- Create: `dashboard/public/js/workspaces/overview.js`
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/js/app.js`
- Modify: `dashboard/public/css/style.css`
- Create: `tests/dashboard-overview-ui.test.cjs`

**Interfaces:**
- `createOverviewWorkspace({ document, fetchImpl, chartFactory, now })` exposes `load(range)`, `applyMetrics(metrics)`, `applyActivity(activity)`, `checkStale()`, and `destroy()`.
- `load(range)` fetches `/api/dashboard/overview?range=${range}` and resolves after rendering.

- [ ] **Step 1: Write failing Overview tests**

```js
test("overview renders API KPIs, health text, fleet priority, activity, and chart series", async () => {
  const overview = createOverviewWorkspace({ document, fetchImpl: async () => jsonResponse(fixture), chartFactory: createChartSpy, now: clock });
  await overview.load("24h");
  assert.match(document.querySelector("#overviewBots").textContent, /2.*3/);
  assert.equal(document.querySelector("#overviewFleet tbody tr").dataset.status, "error");
  assert.equal(chartCalls[0].data.datasets.length, 3);
});

test("overview presents retryable error and stale state after 45 seconds without metrics", async () => {
  const overview = createOverviewWorkspace({ document, fetchImpl: async () => { throw new Error("offline"); }, chartFactory, now: clock });
  await overview.load("24h");
  assert.ok(document.querySelector("#overviewRetry"));
  clock.advance(45001);
  assert.equal(overview.checkStale(), true);
});
```

- [ ] **Step 2: Run Overview tests and verify RED**

Run: `node --test tests/dashboard-overview-ui.test.cjs`

Expected: failure because the overview module and DOM targets do not exist.

- [ ] **Step 3: Implement the minimal Overview workspace**

Create a dedicated overview section with range segmented controls, six KPI targets, health text/status targets, a fixed-height `canvas`, fleet table, activity timeline, retry button, and a bot detail drawer. Render loading skeletons while fetching, an empty state for empty fleet/activity, and a retryable error state for rejected responses. Order fleet error then offline then online. Create/update exactly three datasets for messages, alerts, and online bots.

Treat `dashboard:metrics` as a data refresh signal and `dashboard:activity` as an append-only safe activity. Track `lastMetricsAt`; `checkStale()` marks an explicit text status at 45,000ms. In `app.js`, register socket listeners once and call the workspace methods only after it is created.

- [ ] **Step 4: Verify Overview tests**

Run: `node --test tests/dashboard-overview-ui.test.cjs tests/dashboard-overview-contract.test.cjs`

Expected: all rendering, sorting, chart, empty/error/retry, realtime, and stale-state tests pass.

### Task 4: Integrate regressions and verify browser output

**Files:**
- Modify: `package.json`
- Create: `tests/dashboard-browser.test.cjs`

**Interfaces:**
- Root `npm test` includes all dashboard UI tests.
- Browser test starts dashboard against controlled data and captures Overview at required desktop viewport sizes.

- [ ] **Step 1: Write failing browser assertions**

```js
for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
  test(`overview fits ${viewport.width}x${viewport.height}`, async () => {
    await page.setViewportSize(viewport);
    await page.goto(dashboardUrl + "#overview");
    assert.equal(await page.locator("#overviewTraffic canvas").evaluate((canvas) => canvas.width > 0 && canvas.height > 0), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  });
}
```

- [ ] **Step 2: Run browser tests and verify RED**

Run: `node --test tests/dashboard-browser.test.cjs`

Expected: failure until phase 3 shell and Overview DOM are implemented.

- [ ] **Step 3: Add root test coverage and fix only observed regressions**

Extend `npm test` with the new UI tests. Start the dashboard on an unused local port in the browser harness, wait for Overview loading to settle, inspect keyboard focus in the palette/drawer, and add screenshot assertions for overlap and blank canvas. Adjust only dashboard code necessary for failing assertions.

- [ ] **Step 4: Run the complete verification suite**

Run: `npm test`

Run: `node tests/check-dashboard-utf8.cjs`

Run: `node --test tests/dashboard-browser.test.cjs`

Expected: all Node tests, UTF-8 validation, and browser checks pass with no missing-element console noise.
