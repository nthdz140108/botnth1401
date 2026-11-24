# vdsex yt-dlp Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep `vdsex` sending one random video per command while combining the existing direct-URL pool with a second pool of yt-dlp-supported source URLs.

**Architecture:** Add a small, testable video-pool module that loads and combines source files, selects candidates, and resolves yt-dlp candidates through an injected downloader. Extend only the `sex` command configuration with `vdsex-ytdlp.txt`; the existing direct URL path and Zalo `api.sendVideo` contract remain in place.

**Tech Stack:** Node.js 20, native `node:test`, ES modules, `yt-dlp-exec`, existing axios/fs/path/Zalo APIs.

## Global Constraints

- Send at most one video for each `vdsex` invocation.
- Keep `vdsex.txt` and its direct URL behavior unchanged.
- Combine entries from both pools before random selection.
- Pass a remote URL to `api.sendVideo`; do not send local temporary files.
- Do not delete yt-dlp source entries after resolution failures.
- Do not change command syntax, permissions, countdown, caption, mentions, TTL, or the existing user-facing failure message.
- No network access in unit tests; inject the downloader.

---

### Task 1: Add failing video-pool tests

**Files:**
- Create: `tests/vdsex-video-pool.test.js`
- Reference: `src/service-debug/chat-zalo/chat-special/data-send/vdsex.txt`

**Interfaces:**
- Tests define the expected public functions: `readVideoPool`, `combineVideoPools`, `pickRandomVideoSource`, and `resolveVideoSource` from `src/service-debug/chat-zalo/chat-special/send-video/video-pool.js`.

- [ ] **Step 1: Write tests for source loading and combined selection**

Use `node:test` and `assert/strict`. Inject `existsSync` and `readFileSync` implementations so tests use in-memory file contents. Assert that blank lines are ignored, direct and yt-dlp candidates retain their `kind`, and `pickRandomVideoSource` can select entries from either combined pool with a deterministic random function.

```js
test("combines direct and yt-dlp sources into one random pool", () => {
  const files = new Map([
    ["vdsex.txt", "https://old.example/one.mp4\n\nhttps://old.example/two.mp4\n"],
    ["vdsex-ytdlp.txt", "https://new.example/one\n"],
  ]);
  const read = readVideoPool({
    files: ["vdsex.txt", "vdsex-ytdlp.txt"],
    readFileSync: file => files.get(file),
    existsSync: () => true,
  });
  const selected = pickRandomVideoSource(read, () => 0.8);
  assert.deepEqual(read, [
    { url: "https://old.example/one.mp4", kind: "direct" },
    { url: "https://old.example/two.mp4", kind: "direct" },
    { url: "https://new.example/one", kind: "ytdlp" },
  ]);
  assert.deepEqual(selected, { url: "https://new.example/one", kind: "ytdlp" });
});
```

- [ ] **Step 2: Write tests for direct passthrough and yt-dlp resolution**

Assert that direct candidates return their original URL without calling the injected downloader. Assert that a yt-dlp candidate calls the downloader with `getUrl`, `noPlaylist`, an MP4-compatible format, and returns the first non-empty stdout line. Assert that empty stdout rejects with an actionable error.

```js
test("passes direct source through without invoking yt-dlp", async () => {
  let calls = 0;
  const result = await resolveVideoSource(
    { url: "https://cdn.example/video.mp4", kind: "direct" },
    async () => { calls += 1; }
  );
  assert.equal(result, "https://cdn.example/video.mp4");
  assert.equal(calls, 0);
});

test("resolves yt-dlp source to a direct media URL", async () => {
  let options;
  const result = await resolveVideoSource(
    { url: "https://video.example/watch/123", kind: "ytdlp" },
    async (_url, nextOptions) => {
      options = nextOptions;
      return { stdout: "https://cdn.example/resolved.mp4\n" };
    }
  );
  assert.equal(result, "https://cdn.example/resolved.mp4");
  assert.equal(options.getUrl, true);
  assert.equal(options.noPlaylist, true);
  assert.match(options.format, /mp4/);
});
```

- [ ] **Step 3: Run the focused test and verify the expected RED failure**

Run: `node --test tests/vdsex-video-pool.test.js`

Expected: FAIL because `video-pool.js` and its exported functions do not exist yet. Fix only test syntax/setup errors if the failure is not caused by the missing implementation.

### Task 2: Implement the testable source-pool module

**Files:**
- Create: `src/service-debug/chat-zalo/chat-special/send-video/video-pool.js`
- Test: `tests/vdsex-video-pool.test.js`

**Interfaces:**
- `readVideoPool({ files, readFileSync = fs.readFileSync, existsSync = fs.existsSync })` returns `Array<{ url: string, kind: "direct" | "ytdlp" }>`.
- `pickRandomVideoSource(sources, random = Math.random)` returns one candidate or `null` for an empty list.
- `resolveVideoSource(candidate, downloader = ytdlp)` returns a direct URL string or rejects when yt-dlp produces no URL.

- [ ] **Step 1: Implement source parsing and random selection**

Read each existing file only when it exists, trim entries, ignore blank lines and lines beginning with `#`, and assign `kind: "direct"` to the first file and `kind: "ytdlp"` to the second file. Use `Math.floor(random() * sources.length)` and return `null` when no candidates exist.

- [ ] **Step 2: Implement yt-dlp resolution**

Import `yt-dlp-exec` as the default downloader. Return direct candidates unchanged. For yt-dlp candidates invoke the downloader with:

```js
{
  getUrl: true,
  noPlaylist: true,
  noWarnings: true,
  quiet: true,
  format: "best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best"
}
```

Trim stdout, use the first non-empty line, and throw when stdout is empty or not a string.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `node --test tests/vdsex-video-pool.test.js`

Expected: all focused tests pass with no warnings.

### Task 3: Integrate the combined pool into `vdsex`

**Files:**
- Modify: `src/service-debug/chat-zalo/chat-special/send-video/send-video.js:1-70,178-239`
- Create: `src/service-debug/chat-zalo/chat-special/data-send/vdsex-ytdlp.txt`
- Test: `tests/vdsex-video-pool.test.js`

**Interfaces:**
- `VIDEO_TYPES.sex.variants.default` adds `ytdlpSource: "vdsex-ytdlp.txt"`.
- `handleApiSourceVideo` loads `source` and optional `ytdlpSource`, resolves the selected candidate, then keeps the current `api.sendVideo` payload.

- [ ] **Step 1: Add an integration regression test before production changes**

Add a test-level contract assertion that the `sex` configuration points to both `vdsex.txt` and `vdsex-ytdlp.txt`, and that the new source file is allowed to be missing/empty without breaking the direct pool. Run the focused test and confirm it fails because the config has no `ytdlpSource` yet.

- [ ] **Step 2: Wire the new config and helpers**

Import the video-pool helpers. Add `ytdlpSource` only to the `sex` default variant. In `handleApiSourceVideo`, load both configured files and attempt untried candidates up to `CONFIG.maxRetries` (or until the pool is exhausted). Resolve each candidate before `checkVideoUrl`, then reuse the existing sender payload and TTL. Keep the existing direct-file cleanup behavior only for direct candidates; never rewrite `vdsex-ytdlp.txt`.

- [ ] **Step 3: Add the new pool file with format guidance**

Create `vdsex-ytdlp.txt` as an empty user-maintained source pool with two ASCII comment lines explaining that each non-comment line must be a video-page URL supported by yt-dlp. Do not alter the existing `vdsex.txt` contents.

- [ ] **Step 4: Run focused and command contract tests**

Run: `node --test tests/vdsex-video-pool.test.js tests/phase-2-dispatch.test.js`

Expected: all selected tests pass, the command remains registered as `vdsex`, and no unrelated command behavior changes.

### Task 4: Verify the complete repository change

**Files:**
- Modify only the files listed in Tasks 1-3.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 2: Check the package and diff surface**

Run: `npm ls yt-dlp-exec --depth=0` and `git status --short`.

Expected: `yt-dlp-exec@1.0.2` is installed. Since this downloaded repo has no `.git` metadata, report that `git status` cannot run rather than changing unrelated files.

- [ ] **Step 3: Perform a static integration check**

Run: `node --input-type=module -e "import('./src/service-debug/chat-zalo/chat-special/send-video/video-pool.js').then(() => console.log('video pool module loaded'))"`

Expected: prints `video pool module loaded` and exits successfully.

