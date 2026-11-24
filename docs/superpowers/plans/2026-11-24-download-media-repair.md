# Autodownload and video delivery repair

Goal: implement the user's approved repair brief for self-authored Zalo links, TikTok delivery, YouTube/AIO regression safety, and incremental VPS distribution.

Execution: inline in the existing isolated worktree on `codex/locmem-recovery`.

1. Add URL/preview reader and outbound-ID registry. Claim client IDs before text/link requests, add message IDs on receipt, and deduplicate autodownload per bot/thread/message. Prefix commands and consumed replies take precedence; group protection stays upstream.
2. Reuse local video preparation, optionally converting incompatible video to MP4 H.264/AAC. Upload first-frame JPEG and measured video; share complete payload across TikTok, YouTube, and both AIO senders. Audio/image modes remain supported.
3. Reject incomplete video caches, save full metadata only after successful video send, preserve error code and stage, never retry a media send after upload, and clean temporary media/progress in finally blocks.
4. Verify input/echo/dedup, short portrait video, conversion, cache miss/hit, send rejection 114, slideshow/audio, YouTube menus, and Facebook/Instagram/CapCut routing. Run media suite and full suite, review changes, check VPS media preparation without sending Zalo messages, commit and dry-run incremental deployment, then push requested branch.

Acceptance requiring the user: after BAT update, send the same TikTok link using `!tt`, `!download`, and a plain paste in the Zalo group; confirm playback on the phone, YouTube, and recovery after a failed send. Automated tests cannot establish phone-visible delivery.

Progress:
- Input/registry tests observed failing before implementation, then passing.
- Shared upload/payload tests observed failing before implementation, then passing.
- Initial media regression run: 117 passed, 1 opt-in live YouTube test skipped.
- Existing tests with fake video bytes now inject the external media preparation boundary; measured file size assertions use actual fixture bytes.

Review focus: echoes before receipts; command/selection priority; no second media attempt after upload; cache completeness and commit timing; normalized file ownership on every failure.

- Independent review: two important findings (mention prefix and audio container classification), reproduced with failing tests and fixed; both regression tests pass.
- Final focused run: 143 tests, 142 pass, 1 opt-in live YouTube skip, 0 fail. Includes incremental deployment and original command/service regression tests.
- VPS preparation smoke: MP4 portrait 180x320, 400 ms, 6426 bytes; WebM normalized to MP4 portrait 180x320, 407 ms, 6506 bytes. Both produced a 584-byte JPEG. No Zalo sends or release switch performed.
- Ruling: retain unrelated baseline dashboard/latency/ANSI test failures rather than change those production subsystems within the media repair. Full-suite results are recorded in the delivery report.
- Final routing check selects only the first supported URL for explicit download commands. Final focused verification: 144 tests, 143 pass, 1 skip, 0 fail. Full run: 2,239 tests, 2,211 pass, 5 known baseline failures, 23 skip. See `docs/download-media-repair-2026-11-24.md` for failure names and acceptance limits.
