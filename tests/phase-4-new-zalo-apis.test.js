import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appContext } from "../src/api-zalo/context.js";
import { encodeAES } from "../src/api-zalo/utils.js";
import { ZaloApiError } from "../src/api-zalo/Errors/ZaloApiError.js";
import { acceptGroupInviteFactory } from "../src/api-zalo/apis/acceptGroupInvite.js";
import { fetchAccountInfoFactory } from "../src/api-zalo/apis/account-info.js";
import { acceptFriendRequestFactory } from "../src/api-zalo/apis/acpFriendRequest.js";
import { addFriendFactory } from "../src/api-zalo/apis/addFriend.js";
import { blockUserFactory } from "../src/api-zalo/apis/blockUser.js";
import { changeAccountAvatarFactory } from "../src/api-zalo/apis/changeAccountAvatar.js";
import { changeAccountSettingFactory } from "../src/api-zalo/apis/changeAccountSettings.js";
import { changeFriendAliasFactory } from "../src/api-zalo/apis/changeFriendAlias.js";
import { deleteAvatarFactory } from "../src/api-zalo/apis/deleteavatar.js";
import { deleteGroupInviteBoxFactory } from "../src/api-zalo/apis/deleteGroupInviteBox.js";
import { disperseGroupFactory } from "../src/api-zalo/apis/disperseGroup.js";
import { getAvatarListFactory } from "../src/api-zalo/apis/getavatarlist.js";
import { getBlockedGroupMembersFactory } from "../src/api-zalo/apis/getBlockMemberList.js";
import { getFriendRequestsFactory } from "../src/api-zalo/apis/getFriendRequests.js";
import { getFriendRequestStatusFactory } from "../src/api-zalo/apis/getFriendRequestStatus.js";
import { getGroupBlockedMemberFactory } from "../src/api-zalo/apis/getGroupBlockedMember.js";
import { getGroupInviteBoxListFactory } from "../src/api-zalo/apis/getGroupInviteBoxList.js";
import { getPendingFriendRequestsFactory } from "../src/api-zalo/apis/getPendingFriendRequests.js";
import { getPollDetailFactory } from "../src/api-zalo/apis/getPollDetail.js";
import { getSettingsFactory } from "../src/api-zalo/apis/getSettings.js";
import { rejectFriendRequestFactory } from "../src/api-zalo/apis/rejectFriendRequest.js";
import { removeFriendFactory } from "../src/api-zalo/apis/removeFriend.js";
import { removeFriendAliasFactory } from "../src/api-zalo/apis/removeFriendAlias.js";
import { removeGroupBlockedMemberFactory } from "../src/api-zalo/apis/removeGroupBlockedMember.js";
import { sendCallVoiceFactory } from "../src/api-zalo/apis/SendCallVoice.js";
import { updateLangFactory } from "../src/api-zalo/apis/setlangaccount.js";
import { setMuteFactory } from "../src/api-zalo/apis/setmute.js";
import { setMuteGroupFactory } from "../src/api-zalo/apis/setMuteGroup.js";
import { reuseAvatarFactory } from "../src/api-zalo/apis/setoldavatar.js";
import { setPinnedConversationsFactory } from "../src/api-zalo/apis/setPinnedConversations.js";
import { unblockUserFactory } from "../src/api-zalo/apis/unblockUser.js";
import { undoFriendRequestFactory } from "../src/api-zalo/apis/undoFriendRequests.js";
import { updateProfileFactory } from "../src/api-zalo/apis/updateProfile.js";
import { updateSettingsFactory } from "../src/api-zalo/apis/updateSettings.js";

const secretKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function makeApi(baseUrl) {
  return {
    zpwServiceMap: {
      friend: [baseUrl],
      group: [baseUrl],
      profile: [baseUrl],
      file: [baseUrl],
      alias: [baseUrl],
      conversation: [baseUrl],
      voice_call: [baseUrl],
    },
  };
}

function setContext() {
  appContext.secretKey = secretKey;
  appContext.imei = "imei-test";
  appContext.cookie = "foo=bar";
  appContext.userAgent = "HHH-Test-Agent/1.0";
  appContext.language = "vi";
  appContext.uid = "uid-test";
}

async function withServer(handler) {
  return await new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
    server.on("error", reject);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const apiCases = [
  ["acceptGroupInvite", acceptGroupInviteFactory, ["group-1"]],
  ["fetchAccountInfo", fetchAccountInfoFactory, []],
  ["acceptFriendRequest", acceptFriendRequestFactory, ["friend-1"]],
  ["addFriend", addFriendFactory, ["friend-1", "hello"]],
  ["blockUser", blockUserFactory, ["friend-2"]],
  ["changeAccountSetting", changeAccountSettingFactory, ["nickname", "2000-01-01", 1, {}, "vi"]],
  ["changeFriendAlias", changeFriendAliasFactory, ["Alias", "friend-3"]],
  ["deleteAvatar", deleteAvatarFactory, ["avatar-2"]],
  ["deleteGroupInviteBox", deleteGroupInviteBoxFactory, ["group-2", true]],
  ["disperseGroup", disperseGroupFactory, ["group-3"]],
  ["getAvatarList", getAvatarListFactory, [2, 1]],
  ["getBlockedGroupMembers", getBlockedGroupMembersFactory, ["thread-1"]],
  ["getFriendRequests", getFriendRequestsFactory, []],
  ["getFriendRequestStatus", getFriendRequestStatusFactory, ["friend-4"]],
  ["getGroupBlockedMember", getGroupBlockedMemberFactory, [{ page: 1 }, "group-4"]],
  ["getGroupInviteBoxList", getGroupInviteBoxListFactory, [{}]],
  ["getPendingFriendRequests", getPendingFriendRequestsFactory, []],
  ["getPollDetail", getPollDetailFactory, ["poll-1"]],
  ["getSettings", getSettingsFactory, []],
  ["rejectFriendRequest", rejectFriendRequestFactory, ["friend-5"]],
  ["removeFriend", removeFriendFactory, ["friend-6"]],
  ["removeFriendAlias", removeFriendAliasFactory, ["friend-7"]],
  ["removeGroupBlockedMember", removeGroupBlockedMemberFactory, ["member-1", "group-5"]],
  ["updateLang", updateLangFactory, ["VI"]],
  ["setMute", setMuteFactory, ["thread-2", 10, 1, 1]],
  ["setMuteGroup", setMuteGroupFactory, ["group-6", true]],
  ["reuseAvatar", reuseAvatarFactory, ["avatar-3"]],
  ["setPinnedConversations", setPinnedConversationsFactory, [true, "thread-3"]],
  ["unblockUser", unblockUserFactory, ["friend-8"]],
  ["undoFriendRequest", undoFriendRequestFactory, ["friend-9"]],
  ["updateProfile", updateProfileFactory, [{ name: "New Name" }]],
  ["updateSettings", updateSettingsFactory, ["theme", "dark"]],
];

test("new HHH Zalo APIs are bound and round-trip request/response payloads", async () => {
  setContext();
  const requests = [];
  const server = await withServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ path: req.url, method: req.method, body });
    const payload = {
      error_code: 0,
      data: {
        path: req.url,
        method: req.method,
        body,
      },
    };
    const encrypted = encodeAES(secretKey, JSON.stringify(payload));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: encrypted }));
  });

  try {
    for (const [name, factory, args] of apiCases) {
      const before = requests.length;
      const api = makeApi(server.baseUrl);
      const fn = factory(api);
      assert.equal(typeof fn, "function", name);
      await fn(...args);
      assert.equal(requests.length > before, true, name);
      const lastRequest = requests[requests.length - 1];
      assert.equal(lastRequest.path.includes("/api/"), true, name);
      assert.equal(lastRequest.method === "GET" || lastRequest.method === "POST", true, name);
    }
  } finally {
    await server.close();
  }
});

test("changeAccountAvatar uploads through the file service and parses the response", async () => {
  setContext();
  const tempDir = await mkdtemp(join(tmpdir(), "hhh-avatar-"));
  const filePath = join(tempDir, "avatar.jpg");
  await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = await withServer(async (req, res) => {
    const body = await readBody(req);
    const payload = {
      error_code: 0,
      data: { path: req.url, method: req.method, body },
    };
    const encrypted = encodeAES(secretKey, JSON.stringify(payload));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: encrypted }));
  });

  try {
    const fn = changeAccountAvatarFactory(makeApi(server.baseUrl));
    const result = await fn(filePath);
    const payload = result?.data ?? result;
    assert.equal(payload.method, "POST");
    assert.match(payload.path, /\/api\/profile\/upavatar/);
    assert.match(payload.body, /name="fileContent"/);
  } finally {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sendCallVoice performs the request/confirm handshake", async () => {
  setContext();
  let step = 0;
  const server = await withServer(async (req, res) => {
    const body = await readBody(req);
    step += 1;
    const payload = step === 1
      ? { error_code: 0, data: { rtcpIP: "1.1.1.1", rtpIP: "2.2.2.2", sessId: "sess-1", path: req.url, method: req.method, body } }
      : { error_code: 0, data: { path: req.url, method: req.method, body } };
    const encrypted = encodeAES(secretKey, JSON.stringify(payload));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: encrypted }));
  });

  try {
    const fn = sendCallVoiceFactory(makeApi(server.baseUrl));
    const result = await fn("user-1");
    const payload = result?.data ?? result;
    assert.equal(step, 2);
    assert.match(payload.path, /\/api\/voicecall\/request/);
    assert.equal(payload.method, "POST");
  } finally {
    await server.close();
  }
});

test("new HHH Zalo APIs surface ZaloApiError when the backend reports an error", async () => {
  setContext();
  const server = await withServer(async (_req, res) => {
    const payload = {
      error_code: 403,
      error_message: "forbidden",
      data: {},
    };
    const encrypted = encodeAES(secretKey, JSON.stringify(payload));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: encrypted }));
  });

  try {
    const fn = rejectFriendRequestFactory(makeApi(server.baseUrl));
    const result = await fn("friend-10");
    assert.equal(result.error.code, 403);
  } finally {
    await server.close();
  }
});
