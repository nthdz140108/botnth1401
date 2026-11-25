import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { commandRegistry } from "../src/commands/command-registry.js";
import { executeCommand, resolveCommand } from "../src/commands/command-router.js";
import { createWorkloadBroker } from "../src/core/workload-broker.js";

const groupMessage = { type: 1, threadId: "group-a", data: { uidFrom: "900" } };

function invoke(api, message = groupMessage, context = {}) {
  const resolved = resolveCommand(["getuser"], commandRegistry);
  assert.equal(resolved.code, "RESOLVED", "getuser must be registered");
  return resolved.definition.handler({ api, message, ...context });
}

function fixture(info, overrides = {}) {
  const sent = [];
  const profileRequests = [];
  const api = {
    async getGroupInfo(threadId) {
      assert.equal(threadId, "group-a");
      return { gridInfoMap: { [threadId]: info } };
    },
    async getGroupMembers(ids) {
      profileRequests.push([...ids]);
      return { profiles: Object.fromEntries(ids.map((id) => {
        const uid = String(id).split("_")[0];
        return [uid, { id: uid, displayName: `Người ${uid}` }];
      })) };
    },
    async sendMessage(payload, threadId, type) {
      sent.push({ text: payload.msg, at: Date.now(), threadId, type });
      return { msgId: String(sent.length) };
    },
    ...overrides,
  };
  return { api, sent, profileRequests };
}

async function finish(t, pending) {
  let done = false;
  let result;
  let failure;
  pending.then((value) => { done = true; result = value; }, (error) => { done = true; failure = error; });
  for (let tick = 0; !done && tick < 1500; tick++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(1000);
  }
  assert.ok(done, "member listing must finish");
  if (failure) throw failure;
  return result;
}

function fakeTime(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
}

function listedUids(sent) {
  return sent.flatMap((entry) => [...entry.text.matchAll(/UID: (\d+)/g)].map((match) => match[1]));
}

test("getuser requires adminBox and agrees with the command manifest", () => {
  const resolved = resolveCommand(["getuser"], commandRegistry);
  assert.equal(resolved.code, "RESOLVED");
  assert.equal(resolved.definition.scope, "group");
  assert.equal(resolved.definition.permission, "adminBox");
  assert.equal(resolved.definition.executionLane, "broadcast");
  const manifest = JSON.parse(fs.readFileSync(new URL("../assets/json-data/command.json", import.meta.url), "utf8"));
  const command = manifest.commands.find((entry) => entry.name === "getuser");
  assert.ok(command?.active);
  assert.equal(command.scope, "group");
  assert.equal(command.permission, "adminBox");
});

test("getuser rejects private messages before accessing group data", async () => {
  const { api, sent } = fixture(null, {
    async getGroupInfo() { assert.fail("private messages must not fetch groups"); },
  });
  await invoke(api, { type: 0, threadId: "900", data: { uidFrom: "900" } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /chỉ.*nhóm/i);
  assert.equal(sent[0].type, 0);
});

test("getuser lists each distinct member with names, UIDs and at least one second between messages", async (t) => {
  fakeTime(t);
  const { api, sent, profileRequests } = fixture({
    name: "Nhóm thử", totalMember: 3, creatorId: "100", adminIds: ["200"],
    memVerList: ["100_2", "200_4", "300_0", "200_4"],
  });
  await finish(t, invoke(api));
  const members = sent.filter((entry) => /UID:/.test(entry.text));
  assert.equal(members.length, 1);
  assert.match(members[0].text, /Người 100[\s\S]*UID: 100[\s\S]*Trưởng nhóm/);
  assert.match(members[0].text, /Người 200[\s\S]*UID: 200[\s\S]*Phó nhóm/);
  assert.match(members[0].text, /Người 300[\s\S]*UID: 300/);
  assert.deepEqual(listedUids(sent), ["100", "200", "300"]);
  assert.deepEqual(profileRequests, [["100_2", "200_4", "300_0"]]);
  for (let index = 1; index < sent.length; index++) {
    assert.ok(sent[index].at - sent[index - 1].at >= 1000, "all responses must respect pacing");
  }
  assert.ok(sent.every((entry) => entry.threadId === "group-a" && entry.type === 1));
});

test("getuser displays API-supplied hidden members without modifying trusted owner or admin data", async (t) => {
  fakeTime(t);
  const info = Object.freeze({
    name: "Ẩn thành viên", totalMember: 2, creatorId: "100", adminIds: Object.freeze([]),
    memVerList: Object.freeze(["100_1", "200_1"]), setting: Object.freeze({ hideMembers: 1 }),
  });
  const before = structuredClone(info);
  const { api, sent } = fixture(info);
  await finish(t, invoke(api));
  assert.equal(listedUids(sent).length, 2);
  assert.match(sent.find((entry) => /UID: 200/.test(entry.text)).text, /UID: 200[^\n]*Thành viên/);
  assert.deepEqual(info, before);
});

test("getuser reports an incomplete hidden roster instead of claiming all members were retrieved", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({
    name: "Ẩn thành viên", totalMember: 50, creatorId: "100", adminIds: ["200"],
    currentMems: [{ id: "100", dName: "Chủ nhóm" }, { id: "200", dName: "Phó nhóm" }],
    setting: { hideMembers: 1 },
  });
  await finish(t, invoke(api));
  assert.equal(listedUids(sent).length, 2);
  const text = sent.map((entry) => entry.text).join("\n");
  assert.match(text, /2\/50/);
  assert.match(text, /chưa đầy đủ|chỉ trả về/i);
  assert.doesNotMatch(text, /đã.*(?:đủ|toàn bộ).*50/i);
});

test("getuser batches profile lookups for groups larger than 500 and preserves every UID", async (t) => {
  fakeTime(t);
  const { api, sent, profileRequests } = fixture({
    totalMember: 501,
    memVerList: Array.from({ length: 501 }, (_, index) => `${1000 + index}_7`),
  });
  await finish(t, invoke(api));
  assert.deepEqual(profileRequests.map((ids) => ids.length), [500, 1]);
  const members = sent.filter((entry) => /UID:/.test(entry.text));
  assert.equal(members.length, 26);
  assert.equal(listedUids(sent).length, 501);
  assert.match(members.at(-1).text, /UID: 1500/);
});

test("getuser prevents overlapping listings for the same API and group", async (t) => {
  fakeTime(t);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { api, sent } = fixture(null, {
    async getGroupInfo() {
      await wait;
      return { gridInfoMap: { "group-a": { totalMember: 1, memVerList: ["100_0"] } } };
    },
  });
  const first = invoke(api);
  const duplicate = await invoke(api);
  assert.equal(duplicate.status, "busy");
  release();
  await finish(t, first);
  assert.equal(sent.filter((entry) => /UID:/.test(entry.text)).length, 1);
});

test("getuser keeps concurrent bots isolated even when their group IDs match", async (t) => {
  fakeTime(t);
  const first = fixture({ totalMember: 1, memVerList: ["100_0"] });
  const second = fixture({ totalMember: 1, memVerList: ["200_0"] });
  await finish(t, Promise.all([invoke(first.api), invoke(second.api)]));
  assert.match(first.sent.find((entry) => /UID:/.test(entry.text)).text, /UID: 100/);
  assert.match(second.sent.find((entry) => /UID:/.test(entry.text)).text, /UID: 200/);
});

test("getuser retains UIDs and embedded names when profile access is denied", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({
    totalMember: 2, memVerList: ["100_0", "200_0"], currentMems: [{ id: "100", dName: "Tên có sẵn" }],
  }, { async getGroupMembers() { throw new Error("permission denied"); } });
  await finish(t, invoke(api));
  const members = sent.filter((entry) => /UID:/.test(entry.text));
  assert.equal(members.length, 1);
  assert.match(members[0].text, /Tên có sẵn/);
  assert.match(members[0].text, /UID: 200/);
});

test("getuser reports group API denial and releases its running lock for retries", async () => {
  const { api, sent } = fixture(null, {
    async getGroupInfo() { throw new Error("sensitive session value"); },
  });
  assert.equal((await invoke(api)).status, "unavailable");
  assert.equal((await invoke(api)).status, "unavailable");
  assert.equal(sent.length, 2);
  assert.ok(sent.every((entry) => /không.*(?:lấy|đọc)/i.test(entry.text)));
  assert.ok(sent.every((entry) => !entry.text.includes("sensitive")));
});

test("getuser stops the listing when Zalo rejects a send and permits a later retry", async (t) => {
  fakeTime(t);
  let sends = 0;
  const { api } = fixture({ totalMember: 3, memVerList: ["100_0", "200_0", "300_0"] }, {
    async sendMessage() {
      sends++;
      if (sends >= 2) throw new Error("send denied");
    },
  });
  const result = await finish(t, invoke(api));
  assert.equal(result.status, "send_failed");
  assert.equal(sends, 2);
  const retry = await finish(t, invoke(api));
  assert.notEqual(retry.status, "busy");
});

test("getuser never borrows a different group's roster when the requested group is absent", async () => {
  const { api, sent } = fixture(null, {
    async getGroupInfo() { return { gridInfoMap: { other: { totalMember: 1, memVerList: ["999_0"] } } }; },
  });
  assert.equal((await invoke(api)).status, "unavailable");
  assert.equal(sent.some((entry) => /UID: 999/.test(entry.text)), false);
});

test("getuser includes memberIds from SDK group responses even without memVerList", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({ totalMember: 2, memberIds: ["100", "200"] });
  await finish(t, invoke(api));
  const members = sent.filter((entry) => /UID:/.test(entry.text));
  assert.equal(members.length, 1);
  assert.match(members[0].text, /UID: 100/);
  assert.match(members[0].text, /UID: 200/);
});

test("getuser respects the server's hasMoreMember signal even when the cached total matches", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({ totalMember: 1, memVerList: ["100_0"], hasMoreMember: 1 });
  await finish(t, invoke(api));
  assert.match(sent[0].text, /chưa đầy đủ|còn.*thành viên/i);
});

test("getuser does not invent member UIDs from malformed server lists", async () => {
  const { api, sent } = fixture({ totalMember: 3, memVerList: "123_0" });
  assert.equal((await invoke(api)).status, "unavailable");
  assert.equal(sent.some((entry) => /UID:/.test(entry.text)), false);
});

test("getuser can finish a paced roster longer than the broadcast broker's default deadline", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({
    totalMember: 1261, memVerList: Array.from({ length: 1261 }, (_, index) => `${100 + index}_0`),
  });
  const broker = createWorkloadBroker({ logger: { error() {}, warn() {} } });
  t.mock.method(console, "error", () => {});
  const definition = resolveCommand(["getuser"], commandRegistry).definition;
  const accepted = await executeCommand({
    api, message: groupMessage, scope: "group", permissionLevel: "adminBox", workloadBroker: broker,
    dependencies: { zaloSession: true },
  }, definition);
  assert.equal(accepted.code, "ACCEPTED");
  await finish(t, broker.drain(120_000));
  assert.equal(broker.snapshot().counters.broadcastFailed, 0);
  assert.equal(broker.snapshot().counters.broadcastCompleted, 1);
  assert.equal(listedUids(sent).length, 1261);
  assert.equal(sent.some((entry) => /timed out/i.test(entry.text)), false);
  await broker.shutdown();
});

test("getuser shares its running lock across API proxies for the same bot and group", async (t) => {
  fakeTime(t);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { api, sent } = fixture(null, {
    getOwnId() { return "810000000000000001"; },
    async getGroupInfo() {
      await wait;
      return { gridInfoMap: { "group-a": { totalMember: 1, memVerList: ["100_0"] } } };
    },
  });
  const first = invoke(api);
  const duplicate = invoke(new Proxy(api, {}));
  release();
  const result = await finish(t, Promise.all([first, duplicate]));
  assert.equal(result[1].status, "busy");
  assert.equal(sent.filter((entry) => /UID:/.test(entry.text)).length, 1);
});

test("getuser shares pacing across successive API proxies for the same bot and group", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({ totalMember: 1, memVerList: ["100_0"] }, {
    getOwnId() { return "810000000000000002"; },
  });
  await finish(t, invoke(new Proxy(api, {})));
  const last = sent.at(-1);
  // Start the next run in the same millisecond as the preceding successful send.
  t.mock.timers.setTime(last.at);
  const start = sent.length;
  await finish(t, invoke(new Proxy(api, {})));
  assert.ok(sent[start].at - last.at >= 1000);
});

test("getuser uses the trusted instance UID when a relay API has no own-ID helper", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({ totalMember: 1, memVerList: ["100_0"] });
  const context = { authorizationSnapshot: { instanceUid: "810000000000000003" } };
  const results = await finish(t, Promise.all([
    invoke(new Proxy(api, {}), groupMessage, context),
    invoke(new Proxy(api, {}), groupMessage, context),
  ]));
  assert.equal(results[1].status, "busy");
  assert.equal(sent.filter((entry) => /UID:/.test(entry.text)).length, 1);
});

test("getuser recovers all 255 hidden-group members through getgi/v2 when getmg-v2 supplies only nine", async (t) => {
  fakeTime(t);
  const pageCalls = [];
  const info = Object.freeze({ groupId: "group-a", totalMember: 255, creatorId: "100", adminIds: Object.freeze(["101"]),
    memVerList: Object.freeze(Array.from({ length: 9 }, (_, index) => `${100 + index}_0`)), setting: Object.freeze({ lockViewMember: 1 }) });
  const { api, sent } = fixture(info, {
    async getGroupInfoV2(groupId, options) {
      pageCalls.push([groupId, options]);
      return { groupId, totalMember: 255, memberIds: Array.from({ length: 255 }, (_, index) => String(100 + index)), hasMoreMember: 0 };
    },
  });
  const result = await finish(t, invoke(api));
  assert.equal(result.sent, 255);
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0][0], "group-a");
  assert.deepEqual(pageCalls[0][1], { mpage: 1, mcount: 100 });
  assert.equal(new Set(listedUids(sent)).size, 255);
  assert.equal(sent.filter((entry) => /UID:/.test(entry.text)).length, 13);
  assert.match(sent[0].text, /255\/255/);
  assert.doesNotMatch(sent[0].text, /chưa đầy đủ/);
  for (let index = 1; index < sent.length; index++) assert.ok(sent[index].at - sent[index - 1].at >= 1000);
});

test("getuser follows member pages and deduplicates overlapping UIDs", async (t) => {
  fakeTime(t);
  const pages = [];
  const { api, sent } = fixture({ totalMember: 5, memVerList: ["100_0"] }, {
    async getGroupInfoV2(groupId, { mpage }) {
      pages.push(mpage);
      return { groupId, totalMember: 5, memberIds: mpage === 1 ? ["100", "200", "300"] : ["300", "400", "500"], hasMoreMember: mpage === 1 ? 1 : 0 };
    },
  });
  await finish(t, invoke(api));
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(listedUids(sent), ["100", "200", "300", "400", "500"]);
});

test("getuser advances past a first detailed page already present in getmg metadata", async (t) => {
  fakeTime(t);
  const pages = [];
  const { api, sent } = fixture({ totalMember: 3, memVerList: ["100_0", "200_0"] }, {
    async getGroupInfoV2(groupId, { mpage }) {
      pages.push(mpage);
      return { groupId, totalMember: 3, memberIds: mpage === 1 ? ["100", "200"] : ["300"], hasMoreMember: mpage === 1 ? 1 : 0 };
    },
  });
  await finish(t, invoke(api));
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(listedUids(sent), ["100", "200", "300"]);
});

test("getuser stops paginating a repeated page and reports the remaining partial roster", async (t) => {
  fakeTime(t);
  let calls = 0;
  const { api, sent } = fixture({ totalMember: 255, memVerList: ["100_0"] }, {
    async getGroupInfoV2(groupId) { calls++; return { groupId, totalMember: 255, memberIds: ["100", "200"], hasMoreMember: 1 }; },
  });
  await finish(t, invoke(api));
  assert.equal(calls, 2);
  assert.deepEqual(listedUids(sent), ["100", "200"]);
  assert.match(sent[0].text, /chưa đầy đủ/);
});

test("getuser retains the known roster if the detailed endpoint is denied or belongs to another group", async (t) => {
  for (const denied of [true, false]) {
    await t.test(String(denied), async (t) => {
      fakeTime(t);
      const { api, sent } = fixture({ totalMember: 255, memVerList: ["100_0"] }, {
        async getGroupInfoV2() { if (denied) throw new Error("denied"); return { groupId: "other", memberIds: ["999"] }; },
      });
      await finish(t, invoke(api));
      assert.deepEqual(listedUids(sent), ["100"]);
      assert.match(sent[0].text, /chưa đầy đủ/);
    });
  }
});

test("getuser packs long profile names into bounded messages without losing members", async (t) => {
  fakeTime(t);
  const { api, sent } = fixture({ totalMember: 45, memVerList: Array.from({ length: 45 }, (_, index) => `${100 + index}_0`) }, {
    async getGroupMembers(ids) { return { profiles: Object.fromEntries(ids.map((id) => [id.split("_")[0], { displayName: "Tên dài ".repeat(45) }])) }; },
  });
  await finish(t, invoke(api));
  assert.equal(listedUids(sent).length, 45);
  for (const message of sent.filter((entry) => /UID:/.test(entry.text))) {
    assert.ok(message.text.length <= 3000);
    assert.ok([...message.text.matchAll(/UID:/g)].length <= 20);
  }
});
