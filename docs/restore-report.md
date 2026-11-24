# Restore Report

Snapshot: `C:\Users\Admin\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-snapshots\main-before-restore-20260806-155231`

The source hash comparison found 154 common `src` files differing between `main2` and `main`. Protected API, QR, multi-bot, runtime, dashboard, launcher, credential, registry, and operational-data boundaries were retained. The behavior-bearing changes applied in this pass were limited to:

| File | Restored behavior |
| --- | --- |
| `src/commands/command-response.js` | One boolean reaction helper; type `1`/`5` only; canonical `/-thanks`; one call; reaction errors are logged and swallowed. |
| `src/commands/command.js` | Shared helper only; canonical command name on private/group dispatch; `groupEnabled`/`privateEnabled` gates remain external; reaction eligibility is type `1`/`5`. |
| `src/utils/util.js` | Cache path resolves from project root. |
| `src/commands/spamsms/spsms.js` | Blacklist, admin, and Python paths resolve from project root. |
| `src/service-debug/utilities/speedtest.js` | Runtime temp directory is created before image output. |

The remaining divergent files are retained as current integration adapters or protected compatibility changes; no blind file-level rollback was performed.

Verification:

- `npm test`: 77 passing, 0 failing.
- `npm run test:offline`: 77 test suite checks plus 3 offline validation checks passing.
- `node --check`: 270/270 JavaScript files passing.
- Operational manifest: 0 mismatches.
- Assets manifest: 46/46 files unchanged; `assets/temp` excluded as requested.

Residual risk: real Zalo login/API behavior was intentionally not exercised offline.
