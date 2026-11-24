# YouTube yt-dlp Follow-up Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoan thien luong YouTube yt-dlp de runtime, metadata, worker, cache va reply dung contract tren Windows/Linux va khi chay tu bat ky working directory nao.

**Architecture:** Giữ `youtube-runtime.js` lam nguon duy nhat cho Deno va cookie options; core bao quanh moi lan chay yt-dlp de parse callable result va gan stage; service/workflow chi dung model metadata chuan. Test se mock executor, worker boundary va Zalo dependencies, sau do smoke test bang video cong khai.

**Tech Stack:** Node 20, ES modules, `youtube-dl-exec`, `worker_threads`, Node test runner, `deno-bin` 2.2.7.

## Global Constraints

- Khong nang dependency.
- Khong thay doi cookie hien tai, `.env.local`, cache schema hoac API Zalo.
- Khong ghi log noi dung cookie.
- Dung `deno.exe` tren Windows va `deno` tren Linux.
- Runtime flags phai la `jsRuntimes: "deno:<absolute-path>"` va `remoteComponents: "ejs:github"`.
- Loi phai giu stage `metadata`, `download`, `runtime`, `upload`, `send`.

---

### Task 1: Lam chac resolver runtime va auth options

**Files:** `src/service-debug/api-crawl/youtube/youtube-runtime.js`, `tests/youtube-runtime-helper.test.js`, `tests/youtube-auth.test.js`

- [ ] Viet test fail cho Windows/Linux, cwd khac project root, binary thieu, va cookie options duoc ghep ma khong lam lo gia tri.
- [ ] Chay test de xac nhan fail voi resolver hien tai.
- [ ] Dung package resolution tu module location, chon binary theo platform inject duoc, tra absolute path, va throw loi cau hinh ro rang neu thieu. Truyen `options.env` den auth helper, khong log cookie.
- [ ] Chay lai test runtime/auth va assert metadata/download nhan cung options.

### Task 2: Chuan hoa metadata va stage errors trong core

**Files:** `src/service-debug/api-crawl/youtube/youtube-core.js`, `tests/youtube-runtime-helper.test.js`, `tests/youtube-core.test.js`

- [ ] Viet test fail cho callable executor, JSON parsed, uu tien `webpage_url` hon `url` stream, reject metadata thieu `videoId/title/url`, va stage `runtime` khi Deno thieu.
- [ ] Chay test de xac nhan fail voi mapping va wrapper hien tai.
- [ ] Gom runtime/auth flags mot noi; normalize alias yt-dlp; validate model; wrap runtime/timeout theo stage.
- [ ] Chay test core/runtime va kiem tra khong duplicate flags.

### Task 3: Bao dam worker dung cung options va stage download

**Files:** `src/service-debug/api-crawl/youtube/youtube-download-worker.js`, `src/service-debug/api-crawl/youtube/youtube-core.js`, `tests/youtube-worker.test.js`

- [ ] Viet test boundary cho runtime path, cookie flags, timeout parity, non-zero exit va timeout.
- [ ] Chay test de xac nhan fail.
- [ ] Bo flags Deno lap lai, gan stage `download`, clear timer/terminate worker an toan.
- [ ] Chay test worker/core va assert file output non-empty.

### Task 4: Sua consumer metadata, cache va error UX

**Files:** `src/service-debug/api-crawl/youtube/youtube-service.js`, `src/service-debug/api-crawl/download/youtube-autodownload-workflow.js`, `tests/youtube-service-workflow.test.js`, `tests/auto-download-youtube.test.js`

- [ ] Viet test hanh vi cho direct command, search reply va auto-download; assert cache key, URL, upload/send ordering va cleanup selection.
- [ ] Chay test de xac nhan suite regex hien tai khong du.
- [ ] Dung model chuan; chi xoa message, `videoSelectionsMap` va `selectionsMapData` sau send thanh cong; unavailable giu selection 60 giay; auto-download phan biet unavailable/auth/runtime/timeout.
- [ ] Chay test consumer/workflow voi mock API/dependencies.

### Task 5: Verification va smoke test

**Files:** `tests/youtube-runtime-helper.test.js`, `tests/youtube-smoke.test.js`

- [ ] Chay `node --test tests/youtube-*.test.js tests/auto-download-youtube.test.js`.
- [ ] Chay `npm test` va ghi so test/pass/fail.
- [ ] Chay smoke co dieu kien voi `YOUTUBE_SMOKE=1`, video `jNQXAC9IVRw`; assert metadata va file download khong rong, cleanup.
- [ ] Chay lint/import audit va review diff khong co cookie content/log hay dependency change.

## Audit Findings

- Resolver dang neo vao `process.cwd()/node_modules/deno-bin/bin`, co the fail khi bot start tu cwd khac; test chua cover.
- `normalizeYoutubeVideoInfo()` dang uu tien `raw.url`, thuong la direct format URL, khong phai webpage URL.
- Loi Deno thieu xay ra truoc `runYoutubeDlp()` nen khong duoc stage `runtime`.
- Worker parity chi duoc assert bang regex source, chua co test runtime boundary.
- Auto-download gom moi exception vao warning generic.
- Reply xoa `videoSelectionsMap` nhung khong xoa `selectionsMapData`, co the de selection stale.
- Tap YouTube 20/20 va full suite 525/525 pass, nhung chua co smoke test cong khai.
