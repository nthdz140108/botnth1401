# QC direct-message refusal diagnosis — 2026-11-28

## Production evidence

Read-only VPS inspection at baseline `ba740340f6e90a7e3170359ede2801c983fe89ea` reproduced the user's reported campaign results from durable checkpoints:

- Main/admin: completed, 251 unique recipients, 2 success and 249 failed.
- One child: completed, 189 recipients, 2 success, 18 failed and 169 unconfirmed.
- Main's PM2 error log contained repeated direct-message HTTP 200 application refusals, code 123, `Không thể nhận tin nhắn từ bạn.` Child logs also contained codes 126 and 127 with that message.

These are server refusals, not evidence of invalid roster IDs or an SDK transport retry bug. The exact restriction behind those codes (recipient permissions, account restriction, or another Zalo policy) is not established by the generic server message. Group roster visibility does not establish permission to deliver private messages. Do not claim this patch makes refused recipients reachable.

## Change

- Persist a bounded error code and numeric HTTP status per attempted recipient without storing message text, request URLs, credentials or raw responses.
- Include the most frequent error codes and their counts in QC status/final reports.
- Stop after five consecutive confirmed refusals with codes 123/126/127, retaining pending recipients and terminal `delivery_blocked` status; a success or other outcome resets this streak.
- Stop on explicit HTTP/application 429 with terminal `rate_limited` status.
- Preserve these terminal states across checkpoint reload and keep existing no-retry/ambiguous-receipt behavior. No automatic resume, resend, friendship requests or alternative transport to bypass a refusal.

## Verification

- Three new regression cases failed against the preceding implementation, then passed after the fix.
- Final QC and outbound suite: 86 passed, 0 failed, including the fourth regression for separated refusal streaks. Campaign suite: 17 passed, 0 failed.
- ESLint on changed production source passed. Tests are excluded by repository ESLint configuration; including the test path yielded an ignored-file warning, then production lint was run separately.
- Read-only independent review found no blocking issue; its streak-reset test suggestion is covered by the fourth regression.
- Full project suite was not rerun for this scoped campaign change. Previous whole-suite failures are documented separately; no claim of a green whole-project suite.
- Real delivery to the refused accounts has not been established. Production deployment and post-restart status are recorded in the chat, with the actual target commit.
