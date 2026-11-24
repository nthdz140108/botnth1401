import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

const commandsToTest = [
  ["src/commands/bot-manager/active-bot.js", "handleActiveBotUser", "!bot on"],
  ["src/commands/bot-manager/active-bot.js", "handleActiveBotUser", "!bot off"],
  ["src/commands/bot-manager/welcome-bye.js", "handleWelcomeBye", "!welcome on"],
  ["src/commands/bot-manager/welcome-bye.js", "handleWelcomeBye", "!bye on"],
  ["src/commands/bot-manager/welcome-bye.js", "handleApprove", "!approve"],
  ["src/commands/bot-manager/admin-manager.js", "handleListAdmin", "!listadmin"],
  ["src/service-debug/anti-service/mute-user.js", "handleMuteList", "!listmute"],
  ["src/service-debug/anti-service/white-list.js", "handleWhiteList", "!whitelist"],
  ["src/service-debug/anti-service/anti-badword.js", "handleAntiBadWordCommand", "!antibadword on"],
  ["src/service-debug/anti-service/anti-link.js", "handleAntiLinkCommand", "!antilink on"],
  ["src/service-debug/anti-service/anti-spam.js", "handleAntiSpamCommand", "!antispam on"],
  ["src/service-debug/anti-service/anti-undo.js", "handleAntiUndoCommand", "!antiundo on"],
  ["src/service-debug/anti-service/anti-bot.js", "handleAntiBotCommand", "!antibot on"],
  ["src/service-debug/anti-service/anti-photo.js", "handleAntiPhotoVideo", "!antiphoto on"],
  ["src/service-debug/anti-service/anti-video.js", "handleAntiVideo", "!antivideo on"],
  ["src/service-debug/anti-service/anti-voice.js", "handleAntiVoice", "!antivoice on"],
  ["src/service-debug/anti-service/anti-text.js", "handleAntiText", "!antitext on"],
  ["src/service-debug/anti-service/anti-file.js", "handleAntiFile", "!antifile on"],
  ["src/service-debug/anti-service/anti-tag.js", "handleAntiTagCommand", "!antitag on"],
  ["src/service-debug/anti-service/anti-sticker.js", "handleAntiAllEffectStickerCommand", "!antisticker on"],
  ["src/service-debug/anti-service/anti-stickerlag.js", "handleAntiEffectStickerCommand", "!antistickerlag on"],
  ["src/service-debug/anti-service/anti-stickereffect.js", "handleAntiStickerEffect", "!antistickereffect on"],
  ["src/service-debug/anti-service/anti-join-leave.js", "handleAntiJoinLeaveCommand", "!antijoin on"],
  ["src/service-debug/anti-service/anti-kick-all.js", "handleAntiKickBlockCommand", "!antiblockall on"],
  ["src/service-debug/anti-service/anti-forward.js", "handleAntiForwardCommand", "!antiforward on"],
  ["src/service-debug/anti-service/anti-phone-number.js", "handleAntiPhoneNumberCommand", "!antisdt on"],
  ["src/service-debug/anti-service/anti-nude/anti-nude.js", "handleAntiNudeCommand", "!antinude on"],
  ["src/service-debug/anti-service/setup-anti.js", "handleSetupAntiCommand", "!antisetup on"],
  ["src/commands/lenh-debug/send-all/autosendtext.js", "handleAutoSendTextCommand", "!sendtext on"],
  ["src/commands/bot-manager/group-manage.js", "handleSettingGroupCommand", "!settinggroup"],
  ["src/commands/bot-manager/admin-manager.js", "handleAdminHighLevelCommands", "!add"],
  ["src/commands/bot-manager/admin-manager.js", "handleAdminHighLevelCommands", "!remove"],
  ["src/commands/bot-manager/group-manage.js", "handleKick", "!kick"],
  ["src/commands/bot-manager/group-manage.js", "handleBlock", "!block"],
  ["src/commands/bot-manager/group-manage.js", "handleTaget", "!taget"],
  ["src/commands/bot-manager/group-manage.js", "handleKickAll", "!kickall"],
  ["src/commands/bot-manager/group-manage.js", "handleBlockAll", "!blockall"],
  ["src/service-debug/anti-service/mute-user.js", "handleMuteUser", "!mute"],
  ["src/service-debug/anti-service/mute-user.js", "handleUnmuteUser", "!unmute"],
  ["src/commands/bot-manager/utilities.js", "handleChangeGroupLink", "!changelink"],
  ["src/commands/bot-manager/utilities.js", "handleSendTaskCommand", "!sendtask on"],
  ["src/commands/lenh-debug/send-all/sendsticker.js", "handleSendStickerCommand", "!sendstk on"],
];

async function runAllCommandTests() {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "group-cmd-test-"));
  const settingsPath = path.join(runtimeRoot, "group-settings.json");
  const configPath = path.join(runtimeRoot, "test-bot.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "test-bot", name: "test-bot", groupSettingsPath: settingsPath })
  );

  const payload = commandsToTest.map(([modulePath, exportName, commandContent]) => ({
    moduleUrl: pathToFileURL(path.join(projectRoot, modulePath)).href,
    modulePath,
    exportName,
    commandContent,
  }));

  const script = `
    const commands = ${JSON.stringify(payload)};
    const results = [];
    for (const { moduleUrl, modulePath, exportName, commandContent } of commands) {
      try {
        const module = await import(moduleUrl);
        const groupSettings = {
          "test-thread": {
            nameGroup: "Test Group",
            activeBot: true,
            muteList: {},
            whiteList: {},
            adminList: {}
          }
        };
        const message = {
          threadId: "test-thread",
          type: "group",
          data: {
            content: commandContent,
            mentions: [],
            dName: "Admin User",
            uidFrom: "admin-1"
          }
        };
        const groupAdmins = ["admin-1"];
        const groupInfo = {
          grid: "test-thread",
          name: "Test Group",
          creatorId: "admin-1",
          adminIds: ["admin-1"],
          setting: {
            lockSendMsg: 0,
            lockViewMember: 0,
            joinAppr: 0
          }
        };
        const api = {
          sendMessage: async () => ({ status: 0 }),
          sendGroupMessage: async () => ({ status: 0 }),
          sendReaction: async () => undefined,
          handleGroupPendingMembers: async () => undefined,
          getGroupInfo: async () => groupInfo,
          getUserInfo: async () => ({ name: "Admin User", dName: "Admin User", uid: "admin-1" }),
          updateGroupSetting: async () => undefined,
        };

        const fn = module[exportName];
        if (typeof fn !== "function") {
          throw new Error("Export " + exportName + " is not a function in " + modulePath);
        }
        const value = await fn(api, message, groupSettings, groupAdmins, true);
        results.push({ commandContent, ok: true, value });
      } catch (err) {
        results.push({ commandContent, ok: false, error: err.stack || err.message });
      }
    }
    process.stdout.write("__RESULT__" + JSON.stringify(results) + "__END__");
    process.exit(0);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SKIP_ENV_VALIDATION: "1",
      PROJECT_ROOT: projectRoot,
      CONFIG_PATH: configPath,
      BOT_ID: "test-bot",
    },
    timeout: 30000,
  });

  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `Subprocess output did not match expected structure: ${stdout}`);
  return JSON.parse(match[1]);
}

test("all group commands execute without runtime errors in batched runner", async () => {
  const results = await runAllCommandTests();
  assert.equal(results.length, commandsToTest.length);
  for (const r of results) {
    assert.equal(r.ok, true, `Command ${r.commandContent} threw: ${r.error}`);
  }
});
