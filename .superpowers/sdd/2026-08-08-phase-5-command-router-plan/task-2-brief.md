# Task 2: Implement Phase 5 registry mappings

**File:** modify only `src/commands/command-registry.js`.

The Phase 5 test now exists at `tests/phase-5-dispatch.test.js` and is RED because the exports do not exist. Read it before editing. Write production code only after that RED checkpoint.

Add this exact frozen canonical list and export it:

```js
export const PHASE_5_COMMANDS = Object.freeze([
  "spamjoin", "xnxx", "ketban", "kb", "soundcloud", "zingmp3",
  "zingchart", "nhaccuatui", "voice", "truyencuoi", "tarrot",
  "poststatus", "createqr", "scanqr", "scanapi", "sendresourcesfile",
  "sendsrc", "sendresourcesvideo", "sendresourcesimage", "sendresourcesaudio",
]);
```

Add Phase 5 metadata using the existing `createCommandDefinition` shape:

- `spamjoin`: aliases `[]`, permission `all`, type `1`, countdown `15`, scope `both`, `minArgs: 2`, risk `high`.
- `xnxx`: permission `all`, type `3`, countdown `30`, scope `group`.
- `ketban`: permission `all`, type `3`, countdown `30`, scope `group`.
- `kb`: permission `all`, type `3`, countdown `30`, scope `group`.
- `soundcloud`: aliases `scl`, `music`, permission `all`, type `1`, countdown `30`.
- `zingmp3`: aliases `zmp3`, `ms3`, `zing`, permission `all`, type `1`, countdown `30`.
- `zingchart`: aliases `topzingmp3`, `zmp3c`, permission `all`, type `1`, countdown `30`.
- `nhaccuatui`: aliases `nct`, `ms2`, permission `all`, type `1`, countdown `30`.
- `voice`: permission `all`, type `1`, countdown `15`.
- `truyencuoi`: permission `all`, type `1`, countdown `15`.
- `tarrot`: permission `all`, type `1`, countdown `15`.
- `poststatus`: aliases `ps`, `status`, `stt`, permission `all`, type `1`, countdown `15`.
- `createqr`: aliases `qr`, `qrcode`, permission `all`, type `1`, countdown `30`.
- `scanqr`: alias `sqr`, permission `all`, type `1`, countdown `15`.
- `scanapi`: alias `sapi`, permission `all`, type `1`, countdown `5`, `minArgs: 1`.
- `sendresourcesfile`: alias `share`, permission `all`, type `1`, countdown `30`, `minArgs: 1`.
- `sendsrc`: alias `sharesrc`, permission `all`, type `1`, countdown `30`, `minArgs: 1`.
- `sendresourcesvideo`: alias `sendvideo`, permission `all`, type `1`, countdown `30`, `minArgs: 1`.
- `sendresourcesimage`: alias `sendanh`, permission `all`, type `1`, countdown `30`, `minArgs: 1`.
- `sendresourcesaudio`: aliases `sendvoice`, `sendaudio`, `sdv`, permission `all`, type `1`, countdown `30`, `minArgs: 1`.

Use these exact lazy adapters and module exports:

```js
spamjoin: lazy("./lenh-debug/spam/remote-join-leave.js", "handleJoinLeaveGroup", (handler, { api, message }) => handler(api, message)),
xnxx: lazy("./lenh-debug/hoang/xnxx.js", "handleXnxxCommand", (handler, { api, message }) => handler(api, message)),
ketban: lazy("../automations/ndq-test.js", "ketbanCommand", (command, { api, message, groupInfo }) => command.execute(api, message, groupInfo)),
kb: lazy("../automations/ndq-test.js", "ketbanTagCommand", (command, { api, message, groupInfo }) => command.execute(api, message, groupInfo)),
soundcloud: lazy("../service-debug/api-crawl/music/soundcloud.js", "handleMusicCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
zingmp3: lazy("../service-debug/api-crawl/music/zingmp3.js", "handleZingMp3Command", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
zingchart: lazy("../service-debug/api-crawl/music/zingmp3.js", "handleTopChartZingMp3", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
nhaccuatui: lazy("../service-debug/api-crawl/music/nhaccuatui.js", "handleNhacCuaTuiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
voice: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleVoiceCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
truyencuoi: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleStoryCommand", (handler, { api, message }) => handler(api, message)),
tarrot: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleTarrotCommand", (handler, { api, message }) => handler(api, message)),
poststatus: lazy("../utils/canvas/status-post.js", "handleCommandStatusPost", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
createqr: lazy("../service-debug/utilities/qr-creater.js", "handleCreateQRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
scanqr: lazy("../service-debug/utilities/qr-scan.js", "handleScanQRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
scanapi: lazy("../service-debug/utilities/scan-api.js", "scanApi", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesfile: lazy("./lenh-debug/send-all/send-resources-file.js", "handleSendFile", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendsrc: lazy("../service-debug/utilities/share.js", "shareSrc", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesvideo: lazy("./lenh-debug/send-all/send-resources-video.js", "handleSendVideo", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesimage: lazy("./lenh-debug/send-all/send-resources-image.js", "handleSendImage", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
sendresourcesaudio: lazy("./lenh-debug/send-all/send-resources-audio.js", "handleSendAudio", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
```

Create and export `createPhase5Registry(overrides = {})` and `phase5Registry`, following phase 4. Append `...createPhase5Registry(overrides).definitions` to `createCommandRegistryForPhases` after phase 4. Do not modify `command-router.js`, `command-dispatcher.js`, handler modules, or tests.

Run after implementation:

```powershell
node --test tests/phase-5-dispatch.test.js
```

Expected GREEN: all tests pass. Also run `node --check src/commands/command-registry.js`.

No live APIs, Zalo calls, spam, or media operations. No git commit is possible. Write a detailed report, including the prior RED evidence, GREEN output, files changed, and concerns, to `.superpowers/sdd/2026-08-08-phase-5-command-router-plan/task-2-report.md`.
