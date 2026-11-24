# Phase 7 Command Router Design

## Goal

Register the exact 20 Phase 7 commands through the existing command registry,
preserve the legacy group/private wrapper signatures, and verify scope,
permission, active state, aliases, and handler error conversion without live
Zalo or external-provider side effects.

## Current context

Phase 6 already provides `createPhase6Registry`, lazy handler factories, the
shared router, and `dispatchCommand`. The aggregate registry currently contains
120 canonical definitions. `handleCommand` and `handleCommandPrivate` already
dispatch registered commands before their legacy switch, so Phase 7 can be
added as the next registry segment while the old switch remains as a fallback
compatibility path.

## Canonical definitions and metadata

All Phase 7 definitions are group-only, type 3, and use a one-second
countdown. Permission and active state mirror `assets/json-data/command.json`:

| Command | Aliases | Permission | Active |
| --- | --- | --- | --- |
| sendstk | none | adminBot | false |
| sendtask | autosend | adminBot | false |
| welcome | wl, wlc | adminBot | true |
| bye | none | adminBot | true |
| updategroup | none | adminBot | true |
| antibadword | atbw, loctu, loctukhoa, loctk, badword, bw | adminBot | true |
| antisetup | none | adminBot | true |
| antibot | none | adminBot | true |
| antiblockall | none | adminBot | true |
| antisdt | none | adminBot | true |
| antilink | xoalink, loclink | adminBot | true |
| autojoin | none | all | true |
| antijoin | none | adminBot | true |
| antiforward | none | adminBot | true |
| antitag | none | adminBot | true |
| antistickerlag | antistklag | adminBot | true |
| antisticker | antistk | adminBot | true |
| antispam | chongspam | adminBot | true |
| antinude | chongnude | adminBot | true |
| antiundo | chongundo | adminBot | true |

No Phase 7 command requires MySQL or an environment API key. Handler failures
must be converted to `HANDLER_ERROR` by the common router, and disabled
commands must be rejected before their handlers are loaded or invoked.

## Handler adapters

`createPhase7Handlers(loadModule)` will use the existing lazy adapter pattern.
Every adapter passes `(api, message, groupSettings)` to the positional handler:

- `sendstk` -> `handleSendStickerCommand` in `commands/lenh-debug/send-all/sendsticker.js`
- `sendtask` -> `handleSendTaskCommand` in `commands/bot-manager/utilities.js`
- `welcome`, `bye`, `updategroup` -> `handleWelcomeBye` in `commands/bot-manager/welcome-bye.js`
- `antibadword` -> `handleAntiBadWordCommand` in `anti-service/anti-badword.js`
- `antisetup` -> `handleSetupAntiCommand` in `anti-service/setup-anti.js`
- `antibot` -> `handleAntiBotCommand` in `anti-service/anti-bot.js`
- `antiblockall` -> `handleAntiKickBlockCommand` in `anti-service/anti-kick-all.js`
- `antisdt` -> `handleAntiPhoneNumberCommand` in `anti-service/anti-phone-number.js`
- `antilink` -> `handleAntiLinkCommand` in `anti-service/anti-link.js`
- `autojoin` -> `handleAutoJoinCommand` in `anti-service/auto-join.js`
- `antijoin` -> `handleAntiJoinLeaveCommand` in `anti-service/anti-join-leave.js`
- `antiforward` -> `handleAntiForwardCommand` in `anti-service/anti-forward.js`
- `antitag` -> `handleAntiTagCommand` in `anti-service/anti-tag.js`
- `antistickerlag` -> `handleAntiEffectStickerCommand` in `anti-service/anti-stickerlag.js`
- `antisticker` -> `handleAntiAllEffectStickerCommand` in `anti-service/anti-sticker.js`
- `antispam` -> `handleAntiSpamCommand` in `anti-service/anti-spam.js`
- `antinude` -> `handleAntiNudeCommand` in `anti-service/anti-nude/anti-nude.js`
- `antiundo` -> `handleAntiUndoCommand` in `anti-service/anti-undo.js`

The three shared welcome adapters pass the canonical command name as an
optional fourth argument so canonical behavior is preserved when `wl` or
`wlc` is resolved through the registry. The legacy three-argument call remains
valid and continues parsing the message content.

## Error and dependency handling

Tests inject handlers and a fake module loader. This proves each lazy path and
argument list without scheduling intervals, sending stickers, reading provider
credentials, or invoking the Zalo API. Contract tests cover group/private
scope denial, `adminBot` permission denial, disabled `sendstk`/`sendtask`, and
structured handler failures. A registry smoke test dispatches all 20 commands
with `dbReady: true` and verifies none returns `DB_BLOCKED`.

## Compatibility and verification

The wrapper signatures and existing legacy switch cases remain unchanged.
`commandRegistry` grows from 120 to 140 canonical definitions and all Phase 1
through Phase 7 aliases must remain collision-free. Verification consists of
focused Phase 7 tests, the full `npm test`, JavaScript syntax checks, and a
mock-only smoke dispatch; no live login or network credentials are required.
