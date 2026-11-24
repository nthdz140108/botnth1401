# YouTube yt-dlp Cookies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure yt-dlp authentication for both YouTube metadata and media downloads through local environment variables.

**Architecture:** Add `youtube-auth.js` as the single mapping boundary from environment variables to yt-dlp flags. Import it from the main YouTube service and its worker so both subprocess calls receive the same optional auth configuration. Keep cookie values out of worker data, source files, and logs.

**Tech Stack:** Node.js 20, native `node:test`, ES modules, `youtube-dl-exec`, `dotenv`.

## Global Constraints

- `YOUTUBE_COOKIES_FILE` takes precedence over `YOUTUBE_COOKIES_FROM_BROWSER`.
- Empty or whitespace-only variables produce no authentication flags.
- Never log cookie contents or include them in `workerData`.
- Preserve existing YouTube error handling and download formats.
- Do not reuse the Zalo cookies in `assets/config.json` for YouTube.

---

### Task 1: Add the authentication helper regression tests

**Files:**
- Create: `tests/youtube-auth.test.js`
- Reference: `src/service-debug/api-crawl/youtube/youtube-auth.js`

**Interfaces:**
- Produces expected `getYoutubeAuthOptions(env)` behavior for the implementation task.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getYoutubeAuthOptions } from "../src/service-debug/api-crawl/youtube/youtube-auth.js";

test("returns no auth flags when YouTube cookie settings are empty", () => {
  assert.deepEqual(getYoutubeAuthOptions({}), {});
  assert.deepEqual(getYoutubeAuthOptions({ YOUTUBE_COOKIES_FILE: "  " }), {});
});

test("uses a cookie file when configured", () => {
  assert.deepEqual(getYoutubeAuthOptions({ YOUTUBE_COOKIES_FILE: "cookies/youtube.txt" }), {
    cookies: path.resolve("cookies/youtube.txt"),
  });
});

test("uses browser cookies when configured", () => {
  assert.deepEqual(getYoutubeAuthOptions({ YOUTUBE_COOKIES_FROM_BROWSER: "chrome:Default" }), {
    cookiesFromBrowser: "chrome:Default",
  });
});

test("prefers an explicit cookie file over browser cookies", () => {
  const options = getYoutubeAuthOptions({
    YOUTUBE_COOKIES_FILE: "youtube-cookies.txt",
    YOUTUBE_COOKIES_FROM_BROWSER: "edge",
  });
  assert.equal(options.cookiesFromBrowser, undefined);
  assert.match(options.cookies, /youtube-cookies\.txt$/i);
});
```

Use `path.resolve("cookies/youtube.txt")` in the assertion so the expected path is platform-independent and the test fails because the helper module is not present.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/youtube-auth.test.js`

Expected: fail because `youtube-auth.js` does not exist yet, not because of a test syntax error.

### Task 2: Implement the shared auth mapping

**Files:**
- Create: `src/service-debug/api-crawl/youtube/youtube-auth.js`
- Test: `tests/youtube-auth.test.js`

**Interfaces:**
- `getYoutubeAuthOptions(env = process.env)` returns an object accepted by `youtube-dl-exec`.

- [ ] **Step 1: Implement the minimal helper**

```js
import path from "node:path";

export function getYoutubeAuthOptions(env = process.env) {
  const cookieFile = env.YOUTUBE_COOKIES_FILE?.trim();
  if (cookieFile) return { cookies: path.resolve(cookieFile) };

  const browser = env.YOUTUBE_COOKIES_FROM_BROWSER?.trim();
  if (browser) return { cookiesFromBrowser: browser };

  return {};
}
```

- [ ] **Step 2: Run focused tests and verify GREEN**

Run: `node --test tests/youtube-auth.test.js`

Expected: all four tests pass with zero failures.

### Task 3: Integrate auth into both YouTube yt-dlp calls

**Files:**
- Modify: `src/service-debug/api-crawl/youtube/youtube-service.js`
- Modify: `src/service-debug/api-crawl/youtube/youtube-download-worker.js`
- Test: `tests/youtube-auth.test.js`

**Interfaces:**
- Both call sites import `getYoutubeAuthOptions` from the shared helper.

- [ ] **Step 1: Add the failing static integration assertions**

Read both source files in the test and assert that each imports `youtube-auth.js` and calls `getYoutubeAuthOptions`. Run the focused test and confirm the assertions fail before production edits.

- [ ] **Step 2: Add the helper import and spread its result**

In `youtube-service.js`, import the helper next to the local YouTube imports and spread `getYoutubeAuthOptions()` into the `getYoutubeVideoInfo` options object. In `youtube-download-worker.js`, import the helper and spread it into the existing options object after the shared flags. Do not add cookie values to `workerData`.

- [ ] **Step 3: Run focused and static tests**

Run: `node --test tests/youtube-auth.test.js`

Expected: all helper and integration assertions pass.

### Task 4: Document local configuration

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add safe example variables**

Add empty variables only:

```dotenv
YOUTUBE_COOKIES_FILE=
YOUTUBE_COOKIES_FROM_BROWSER=
```

- [ ] **Step 2: Add Windows setup instructions**

Explain that `YOUTUBE_COOKIES_FROM_BROWSER=chrome` or `edge` uses the logged-in browser profile, while `YOUTUBE_COOKIES_FILE` points to a Netscape-format `cookies.txt`. Tell the user to close the browser before starting the bot when browser-cookie access is blocked, and never commit or share the cookie file.

### Task 5: Verify the complete change

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/youtube-auth.test.js`

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 3: Run a static module check**

Run: `node --input-type=module -e "import('./src/service-debug/api-crawl/youtube/youtube-auth.js').then(() => console.log('youtube auth module loaded'))"`

Expected: prints `youtube auth module loaded` and exits successfully.
