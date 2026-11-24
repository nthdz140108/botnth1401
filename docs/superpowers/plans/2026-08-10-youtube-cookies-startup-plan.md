# YouTube Cookies Startup Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure every bot startup path loads `.env.local` before YouTube services and their worker threads read `YOUTUBE_COOKIES_*`.

**Architecture:** Reuse `loadProviderEnvironment` from `src/bootstrap.js` and make `bot.js` perform that initialization before dynamically importing `index.js`. The existing `youtube-auth.js` helper remains the single mapping from environment variables to yt-dlp options, so cookie values never cross the worker payload.

**Tech Stack:** Node.js ESM, `dotenv`, Node built-in test runner.

## Global Constraints

- `YOUTUBE_COOKIES_FILE` takes precedence over `YOUTUBE_COOKIES_FROM_BROWSER`.
- Cookie contents must not be logged, committed, or sent through worker messages.
- Existing unauthenticated behavior remains unchanged when both variables are empty.

---

### Task 1: Add startup ordering regression coverage

**Files:**
- Modify: `tests/youtube-auth.test.js`
- Test fixture: `src/bootstrap.js` (loaded by the test without starting the runtime)

**Interfaces:**
- Consumes: `loadProviderEnvironment({ root })` from `src/bootstrap.js`.
- Produces: A test that proves `.env.local` values are visible through `process.env` after bootstrap initialization.

- [ ] **Step 1: Write the failing test**

  Add a test that creates a temporary `.env.local`, clears `YOUTUBE_COOKIES_FROM_BROWSER`, invokes `loadProviderEnvironment({ root: tempRoot })`, and asserts the configured value is loaded.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run `node --test tests/youtube-auth.test.js`.
  Expected: the new startup test fails because the current test process has no bootstrap call before reading the environment.

### Task 2: Initialize environment before bot runtime import

**Files:**
- Modify: `bot.js`

**Interfaces:**
- Consumes: `loadProviderEnvironment` from `./src/bootstrap.js`.
- Produces: `startDirect` loaded only after environment files are processed.

- [ ] **Step 1: Implement the minimal startup ordering change**

  Replace the static `startDirect` import with `import { loadProviderEnvironment } from './src/bootstrap.js';`, call `loadProviderEnvironment();`, then dynamically import `./index.js` and destructure `startDirect` before the existing bot startup logic runs.

- [ ] **Step 2: Run the focused YouTube tests**

  Run `node --test tests/youtube-auth.test.js`.
  Expected: all YouTube auth tests pass, including the startup environment regression.

### Task 3: Verify the full relevant test suite

**Files:**
- No additional files.

- [ ] **Step 1: Run all repository tests**

  Run `npm test` from the nested project root.
  Expected: exit code 0 with no failed tests.

- [ ] **Step 2: Inspect the final diff**

  Confirm only the startup import/order and focused regression test changed; verify no cookie values or temporary files are present in tracked source.
