# Nqduan Merge Status

Generated from the current HHH workspace and the Nqduan snapshot at
`C:\Users\Admin\Downloads\Nqduan-share-zalobot-main\Nqduan-share-zalobot-main`.

## Current HHH State

- Canonical commands in `assets/json-data/command.json`: 240
- Canonical commands in `mybot/defaultCommand.json`: 240
- Command registry definitions: 240
- Alias entries in HHH command catalog: 188
- API JS files in `src/api-zalo`: 71
- Service JS files in `src/service-debug`: 132

## Snapshot State

- Canonical commands in Nqduan `assets/json-data/command.json`: 215
- Alias entries in the Nqduan command catalog: 347
- API JS files in Nqduan `src/api-zalo`: 106
- Service JS files in Nqduan `src/Nqduan-service`: 184

## Verified Sync Points

- HHH command baseline now aligns at 240 commands.
- `npm run audit:imports` reports 0 issues.
- `npm test` passes with 565 passing tests and 1 skipped smoke test.
- Provider config writes remain scoped to `.env.local`.
- The phase 5 alias contract still resolves `share` to `sendresourcesfile` and `shr` to `sendsrc`.
- The remaining Nqduan admin commands now include dedicated HHH canonical handlers for `kickimg`, `blockimg`, `kickallmember`, `blockallmember`, `leaveallbox`, `leavelock`, `dispersegroup`, `target`, and `key`.
- Current Nqduan registry open gap versus HHH: 0 canonical commands.
- The older 73-entry diff now fully resolves into canonical HHH coverage.

## Alias Bridges Added In This Pass

- `name`: `myacc`, `myaccount`, `mysetting`, `rename`, `setaccount`, `setavatar-account`, `setavataraccount`, `setavatarbox`, `setavt`, `setavtacc`
- `detail`: `xtt`
- `prservice`: `pr`
- `createqr`: `cqr`, `qr`, `qrcode`
- `sendresourcesfile`: `box`, `filegame`, `se`, `share`
- `sendresourcesimage`: `sendanh`, `sendimage`, `sendqr`
- `sendresourcesvideo`: `sendvideo`, `srv`
- `sendresourcesaudio`: `sendaudio`, `sendvoice`, `sdv`, `sra`
- `getvoice`: `gvc`, `gvoice`, `vc`, `xuankien`
- `sendsrc`: `sharesrc`, `shr`
- `lich`: `calendar`
- `sendstk`: `sendsticker`
- `sendtext`: `rai`, `rải`
- `autojoin`: `auto-join`
- `listblockbot`: `list-block-group`, `lsbot`
- `mute`: `cam`, `câm`
- `unmute`: `sua`, `sửa`, `sủa`

## Remaining Gap

- The broader Nqduan snapshot still contains 44 canonical commands that are not yet represented as canonical HHH commands.
- The current open gap list is tracked in `BOT-DIFF-REPORT.md`; the older 73-entry list is retained there for historical comparison.
- This report is a status snapshot, not a declaration that the full merge plan is complete.
