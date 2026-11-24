# Phase 1 Baseline Report

> Captured from the current HHH worktree at `C:\Users\Admin\Downloads\HHH_MYBOT-V3MYBOTQRLOGIN-main\HHH_MYBOT-V3MYBOTQRLOGIN-main` and the Nqduan snapshot at `C:\Users\Admin\Downloads\Nqduan-share-zalobot-main\Nqduan-share-zalobot-main`.

## Preservation Notes

- The HHH worktree already contained uncommitted changes when this baseline was captured.
- Sensitive or stateful files were treated as read-only during capture, including `.env.local`, `assets/json-data/command.json`, `src/commands/command-registry.js`, and `src/dashboard/provider-config-service.js`.
- This report records the current state without overwriting any existing HHH changes.

## HHH Baseline

### Worktree State

- `git status --short` shows the HHH worktree is dirty with a mix of modified and untracked files.
- The baseline therefore reflects the live workspace state, not a clean checkout.

### Registry

- `assets/json-data/command.json`: 195 canonical commands, 180 alias entries.
- `mybot/defaultCommand.json`: 195 canonical commands.

### API Surface

- `src/api-zalo/apis`: 94 `.js` API files.
- `src/api-zalo/index.js`: 40 export lines.

### Service Surface

- `src/service-debug`: 272 total files, 132 `.js` service files.

### Dependency Surface

- `package.json` runtime dependencies: 60.
- `package.json` dev dependencies: 8.
- `package.json` scripts: 8.
- `package.json` export map entries: 1.

### Import Graph

- `npm run audit:imports` scanned 399 files and 1,598 imports.
- `npm run audit:imports` reported 0 issues.

### Test Baseline

- `npm test` completed with 542 passing tests, 9 failing tests, and 1 skipped test.
- The first hard failure is `src/api-zalo/apis/sendCallVoice.js`, which exports `buildCallVoiceRequests` without defining it.
- The failure surfaces in `tests/send-video-mentions.test.js` and `tests/vdsex-video-pool.test.js`.

## Nqduan Inventory

### Registry

- `assets/json-data/command.json`: 216 canonical commands, 133 alias entries.

### API Surface

- `src/api-zalo/apis`: 93 `.js` API files.
- `src/api-zalo/index.js`: 3 export lines.

### Service Surface

- `src/Nqduan-service`: 337 total files, 184 `.js` service files.

## Reproducible Capture Commands

```powershell
git status --short
node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); console.log({deps:Object.keys(pkg.dependencies||{}).length, devDeps:Object.keys(pkg.devDependencies||{}).length, scripts:Object.keys(pkg.scripts||{}).length, exports:Object.keys(pkg.exports||{}).length})"
npm run audit:imports
npm test
```

## Comparison Anchor

- The HHH baseline is intentionally preserved as-is so later merge phases can compare against the current command registry, API export surface, dependency surface, import graph, and test health.
- The Nqduan inventory above is the source-checked reference set for merge coverage work in later phases.
