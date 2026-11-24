# vdsex FFmpeg Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent remote video sending from failing completely when ffprobe/ffmpeg cannot start, while still rejecting URLs whose media content is invalid.

**Architecture:** Keep remote URLs and the existing Zalo payload unchanged. Make process-launch failures during metadata probing and thumbnail extraction best effort in `sendVideoFactory`, falling back to safe defaults and a derived thumbnail URL. Let actual media-probe failures remain source failures, and strengthen direct URL checks so failed HTTP responses and non-video content are rejected before sending.

**Tech Stack:** Node.js ES modules, native `node:test`, fluent-ffmpeg, axios, existing Zalo API.

## Global Constraints

- Do not change command syntax, caption, mentions, TTL, or the remote `api.sendVideo` contract.
- Do not download full videos or introduce new dependencies.
- Keep failures isolated to the selected source so the existing pool retry behavior can select another source.
- Do not expose sensitive URL/query details in user-facing errors.

---

### Task 1: Add failing regression tests

**Files:**
- Modify: `tests/vdsex-video-pool.test.js`
- Test: `src/api-zalo/apis/sendVideo.js`, `src/service-debug/chat-zalo/chat-special/send-video/send-video.js`

- [x] **Step 1: Add helper behavior tests for metadata and thumbnail fallbacks**
- [x] **Step 2: Add URL response validation tests for rejected status/non-video content**
- [x] **Step 3: Run focused tests and confirm RED because helpers do not exist**

### Task 2: Implement resilient remote-video handling

**Files:**
- Modify: `src/api-zalo/apis/sendVideo.js`
- Modify: `src/service-debug/chat-zalo/chat-special/send-video/send-video.js`

- [x] **Step 1: Extract testable metadata fallback and thumbnail fallback helpers**
- [x] **Step 2: Use fallback metadata and thumbnail derivation without changing payload shape**
- [x] **Step 3: Reject invalid HTTP/content-type responses in direct URL checks**
- [x] **Step 4: Run focused tests and confirm GREEN**

### Task 3: Verify integration

**Files:**
- No additional production files.

- [x] **Step 1: Run vdsex and send-video focused tests**
- [x] **Step 2: Run the complete `npm test` suite using the installed Node runtime**
- [x] **Step 3: Perform a static module-load and dependency check**
