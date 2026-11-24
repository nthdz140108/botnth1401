import test from "node:test";
import assert from "node:assert/strict";
import { parseMyBotCommand, parseDuration } from "../src/commands/mybot/System/mybot-parser.js";

test("parseDuration supports standard units and -1", () => {
  assert.equal(parseDuration("30s"), 30 * 1000);
  assert.equal(parseDuration("30m"), 30 * 60 * 1000);
  assert.equal(parseDuration("30min"), 30 * 60 * 1000);
  assert.equal(parseDuration("1h"), 3600 * 1000);
  assert.equal(parseDuration("12h"), 12 * 3600 * 1000);
  assert.equal(parseDuration("1d"), 24 * 3600 * 1000);
  assert.equal(parseDuration("7d"), 7 * 24 * 3600 * 1000);
  assert.equal(parseDuration("1w"), 7 * 24 * 3600 * 1000);
  assert.equal(parseDuration("1mon"), 30 * 24 * 3600 * 1000);
  assert.equal(parseDuration("1y"), 365 * 24 * 3600 * 1000);
  assert.equal(parseDuration("-1"), -1);
  assert.equal(parseDuration("invalid"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(null), null);
});

test("parseMyBotCommand parses namespace aliases and shortcuts", () => {
  // Shortcut: !clean
  const res1 = parseMyBotCommand({ content: "!clean", aliasCommand: "clean", prefix: "!" });
  assert.equal(res1.action, "clean");
  assert.equal(res1.valid, true);

  // Shortcut: !clean with extra args
  const res1b = parseMyBotCommand({ content: "!clean", aliasCommand: "clean" });
  assert.equal(res1b.action, "clean");

  // !mebot list
  const res2 = parseMyBotCommand({ content: "!mebot list", aliasCommand: "mebot" });
  assert.equal(res2.action, "list");
  assert.equal(res2.valid, true);

  // !mybot help
  const res3 = parseMyBotCommand({ content: "!mybot help", aliasCommand: "mybot" });
  assert.equal(res3.action, "help");
  assert.equal(res3.valid, true);

  // !mybot empty -> help
  const res4 = parseMyBotCommand({ content: "!mybot", aliasCommand: "mybot" });
  assert.equal(res4.action, "help");
});

test("parseMyBotCommand canonicalizes action aliases", () => {
  // delete vs remove
  const del1 = parseMyBotCommand({ content: "!mybot delete 1" });
  assert.equal(del1.action, "delete");
  assert.deepEqual(del1.selector, { type: "index", value: 1 });

  const del2 = parseMyBotCommand({ content: "!mybot remove 1" });
  assert.equal(del2.action, "delete");
  assert.deepEqual(del2.selector, { type: "index", value: 1 });

  // stop vs shutdown
  const stop1 = parseMyBotCommand({ content: "!mybot stop 2" });
  assert.equal(stop1.action, "stop");
  const stop2 = parseMyBotCommand({ content: "!mybot shutdown 2" });
  assert.equal(stop2.action, "stop");

  // extend vs active (active is now separate trial command)
  const ext1 = parseMyBotCommand({ content: "!mybot extend 1 30d" });
  assert.equal(ext1.action, "extend");
  assert.equal(ext1.durationMs, 30 * 24 * 3600 * 1000);
  assert.deepEqual(ext1.selector, { type: "index", value: 1 });

  const act1 = parseMyBotCommand({ content: "!mybot active" });
  assert.equal(act1.action, "active");

  // qrlogin vs getlogin
  const qr1 = parseMyBotCommand({ content: "!mybot qrlogin" });
  assert.equal(qr1.action, "qrlogin");
  const qr2 = parseMyBotCommand({ content: "!mybot getlogin" });
  assert.equal(qr2.action, "qrlogin");

  // login vs create
  const login1 = parseMyBotCommand({ content: '!mybot login "imei_123" {"foo":"bar"}' });
  assert.equal(login1.action, "create");
  const login2 = parseMyBotCommand({ content: '!mybot create "imei_123" {"foo":"bar"}' });
  assert.equal(login2.action, "create");

  // minus
  const minus = parseMyBotCommand({ content: "!mybot minus 1 7d" });
  assert.equal(minus.action, "minus");
  assert.equal(minus.durationMs, 7 * 24 * 3600 * 1000);
  assert.deepEqual(minus.selector, { type: "index", value: 1 });
});

test("parseMyBotCommand parses set, style, and showinfo", () => {
  // set name -> ownerName
  const setName = parseMyBotCommand({ content: "!mybot set name Thanh Hung Pro" });
  assert.equal(setName.action, "set");
  assert.equal(setName.setField, "ownerName");
  assert.equal(setName.setValue, "Thanh Hung Pro");

  // set nameserver -> nameServer
  const setNameServer = parseMyBotCommand({ content: "!mybot set nameServer MyBot Official" });
  assert.equal(setNameServer.action, "set");
  assert.equal(setNameServer.setField, "nameServer");
  assert.equal(setNameServer.setValue, "MyBot Official");

  // set desc -> description
  const setDesc = parseMyBotCommand({ content: "!mybot set desc Bot sieu cap" });
  assert.equal(setDesc.action, "set");
  assert.equal(setDesc.setField, "description");
  assert.equal(setDesc.setValue, "Bot sieu cap");

  // set disallowed fields -> invalid
  const setBotId = parseMyBotCommand({ content: "!mybot set botId 123" });
  assert.equal(setBotId.valid, false);
  assert.equal(setBotId.errorReason, "disallowed_or_invalid_field");

  // style color
  const stColor = parseMyBotCommand({ content: "!mybot style color db342e" });
  assert.equal(stColor.action, "style");
  assert.equal(stColor.styleSubAction, "color");
  assert.equal(stColor.styleColor, "db342e");

  // style icon
  const stIcon = parseMyBotCommand({ content: "!mybot style icon ⚡" });
  assert.equal(stIcon.action, "style");
  assert.equal(stIcon.styleSubAction, "icon");
  assert.equal(stIcon.styleIcon, "⚡");

  // style size (target-first)
  const stSizeTarget = parseMyBotCommand({ content: "!mybot style size nameServer 18" });
  assert.equal(stSizeTarget.action, "style");
  assert.equal(stSizeTarget.styleSubAction, "size");
  assert.equal(stSizeTarget.styleTarget, "nameServer");
  assert.equal(stSizeTarget.styleSizeNameServer, "18");

  const stSizeAll = parseMyBotCommand({ content: "!mybot style size all 20" });
  assert.equal(stSizeAll.styleTarget, "all");
  assert.equal(stSizeAll.styleSizeNameServer, "20");
  assert.equal(stSizeAll.styleSizeText, "20");

  // style type (target-first)
  const stTypeTarget = parseMyBotCommand({ content: "!mybot style type nameServer bold,italic" });
  assert.equal(stTypeTarget.action, "style");
  assert.equal(stTypeTarget.styleSubAction, "type");
  assert.equal(stTypeTarget.styleTarget, "nameServer");
  assert.equal(stTypeTarget.styleType, "bold,italic");

  const stTypeText = parseMyBotCommand({ content: "!mybot style type text none" });
  assert.equal(stTypeText.styleTarget, "text");
  assert.equal(stTypeText.styleType, "none");

  // style reset
  const stReset = parseMyBotCommand({ content: "!mybot style reset" });
  assert.equal(stReset.action, "style");
  assert.equal(stReset.styleSubAction, "reset");

  // showinfo
  const infoAll = parseMyBotCommand({ content: "!mybot showinfo all" });
  assert.equal(infoAll.action, "showinfo");
  assert.deepEqual(infoAll.selector, { type: "all" });

  const infoSelf = parseMyBotCommand({ content: "!mybot showinfo" });
  assert.equal(infoSelf.action, "showinfo");
  assert.deepEqual(infoSelf.selector, { type: "self" });
});

test("parseMyBotCommand parses selectors: index, UID, CSV, all, self", () => {
  // Index
  const rIndex = parseMyBotCommand({ content: "!mybot restart 5" });
  assert.deepEqual(rIndex.selector, { type: "index", value: 5 });

  // Real Zalo UID (long numeric string > 10 digits)
  const rUid = parseMyBotCommand({ content: "!mybot restart 36636267278442919" });
  assert.deepEqual(rUid.selector, { type: "uid", value: "36636267278442919" });

  // CSV
  const rCsv = parseMyBotCommand({ content: "!mybot restart 1,2,3" });
  assert.deepEqual(rCsv.selector, { type: "multiple", raw: "1,2,3", items: ["1", "2", "3"] });

  // all
  const rAll = parseMyBotCommand({ content: "!mybot restart all" });
  assert.deepEqual(rAll.selector, { type: "all" });

  // self (no target provided)
  const rSelf = parseMyBotCommand({ content: "!mybot restart" });
  assert.deepEqual(rSelf.selector, { type: "self" });
});
