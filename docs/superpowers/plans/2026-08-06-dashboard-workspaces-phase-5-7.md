# Dashboard Workspaces Phase 5-7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the five remaining dashboard workspaces, UTF-8/accessibility cleanup, and desktop browser verification.

**Architecture:** Preserve the existing DOM and socket/API calls while extracting registrations for related legacy initializers into five ES modules. Keep `app.js` as the compatibility bridge and execute modules through `dashboard-bootstrap.js`.

**Tech Stack:** Express, Socket.IO, plain JavaScript ES modules, Node test runner, JSDOM, Puppeteer.

## Global Constraints

- Keep Express, plain JavaScript, all existing endpoints, legacy hashes, and `startBot`, `stopBot`, `deleteBot` browser globals.
- Do not alter bot core, database, authentication, roles, audit behavior, or user data in `assets/`.
- Support dark-only desktop operation at 1280px and above, local assets, and `prefers-reduced-motion`.
- Never expose cookie, IMEI, user agent, or credentials through Overview events or unmasked Credentials defaults.

---

### Task 1: Define workspace registration contracts

**Files:**
- Create: `dashboard/public/js/workspaces/bots.js`
- Create: `dashboard/public/js/workspaces/automation.js`
- Create: `dashboard/public/js/workspaces/messaging.js`
- Create: `dashboard/public/js/workspaces/groups-security.js`
- Create: `dashboard/public/js/workspaces/system.js`
- Test: `tests/dashboard-workspaces.test.cjs`

**Interfaces:** Each module exports `initXWorkspace(initializers)`. A missing initializer is ignored; each supplied initializer runs once.

- [ ] Write failing tests for assigned initializers and missing-DOM-safe initialization.
- [ ] Run `node --test tests/dashboard-workspaces.test.cjs` and verify module import failures.
- [ ] Implement the five minimal module exports.
- [ ] Re-run `node --test tests/dashboard-workspaces.test.cjs` and verify passing behavior.

### Task 2: Move application registration to workspace modules

**Files:**
- Modify: `dashboard/public/js/core/dashboard-bootstrap.js`
- Modify: `dashboard/public/js/app.js`
- Test: `tests/dashboard-workspaces.test.cjs`

**Interfaces:** `bootstrapDashboard(context)` invokes each workspace exactly once. `app.js` exposes existing legacy globals.

- [ ] Add a failing test asserting all five workspace registrations receive their intended functions.
- [ ] Run `node --test tests/dashboard-workspaces.test.cjs` and observe the assertion fail.
- [ ] Import workspace modules and delegate registration from bootstrap.
- [ ] Re-run the workspace test and existing router/UI tests.

### Task 3: Correct dashboard source encoding and credential masking

**Files:**
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/js/app.js`
- Modify: `dashboard/public/js/components/command-palette.js`
- Test: `tests/check-dashboard-utf8.cjs`, `tests/dashboard-shell.test.cjs`

- [ ] Write a failing credential visibility test and run it.
- [ ] Replace mojibake source literals with Vietnamese UTF-8 and add an explicit reveal control for Credentials.
- [ ] Run `node tests/check-dashboard-utf8.cjs` and dashboard shell tests.

### Task 4: Verify interactive and desktop behavior

**Files:**
- Modify: `tests/dashboard-browser.test.cjs`
- Test: `tests/dashboard-browser.test.cjs`, root `npm test`

- [ ] Add failing browser assertions at 1280x720, 1440x900, and 1920x1080 for no horizontal overflow, visible chart pixels, and palette focus.
- [ ] Run the browser test to establish the baseline.
- [ ] Fix only observed dashboard regressions.
- [ ] Run `npm test`, `node tests/check-dashboard-utf8.cjs`, and browser tests as final evidence.
