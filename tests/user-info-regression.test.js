import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  getUserInfoData,
  resolveUserProfile,
  getAllInfoUser,
} from "../src/service-debug/info-service/user-info-data.js";
import {
  userInfoCommand,
  userInfoCommandText,
} from "../src/service-debug/info-service/user-info.js";

after(() => {
  setTimeout(() => process.exit(0), 100).unref();
});

function createMockApi(userInfoResolver, onSendMessage) {
  const sentMessages = [];
  const requestedUserIds = [];

  const api = {
    sentMessages,
    requestedUserIds,
    async getUserInfo(userIds) {
      requestedUserIds.push(userIds);
      if (typeof userInfoResolver === "function") {
        return userInfoResolver(userIds);
      }
      return userInfoResolver;
    },
    async sendMessage(payload, threadId, messageType) {
      if (typeof onSendMessage === "function") {
        await onSendMessage(payload, threadId, messageType);
      }
      sentMessages.push({ payload, threadId, messageType });
      return { status: 0, message: "OK" };
    },
  };

  return api;
}

test("resolveUserProfile: profile with exact UID key in unchanged_profiles", () => {
  const response = {
    unchanged_profiles: {
      "123456": {
        userId: "123456",
        zaloName: "Exact User Unchanged",
        gender: 0,
      },
    },
  };
  const profile = resolveUserProfile(response, "123456");
  assert.ok(profile);
  assert.equal(profile.zaloName, "Exact User Unchanged");
});

test("resolveUserProfile: profile with exact UID key in changed_profiles", () => {
  const response = {
    changed_profiles: {
      "123456": {
        userId: "123456",
        zaloName: "Exact User Changed",
        gender: 1,
      },
    },
  };
  const profile = resolveUserProfile(response, "123456");
  assert.ok(profile);
  assert.equal(profile.zaloName, "Exact User Changed");
});

test("resolveUserProfile: key <uid>_0 in changed_profiles", () => {
  const response = {
    changed_profiles: {
      "123456_0": {
        userId: "123456",
        zaloName: "Versioned Changed User",
        gender: 0,
      },
    },
  };
  const profile = resolveUserProfile(response, "123456");
  assert.ok(profile);
  assert.equal(profile.zaloName, "Versioned Changed User");
});

test("resolveUserProfile: key <uid>_0 in unchanged_profiles", () => {
  const response = {
    unchanged_profiles: {
      "987654_0": {
        userId: "987654",
        zaloName: "Versioned Unchanged User",
        gender: 1,
      },
    },
  };
  const profile = resolveUserProfile(response, "987654");
  assert.ok(profile);
  assert.equal(profile.zaloName, "Versioned Unchanged User");
});

test("resolveUserProfile: profile matching only by userId property (arbitrary key)", () => {
  const response = {
    unchanged_profiles: {
      "some_arbitrary_key": {
        userId: "555666",
        zaloName: "Field Matched User",
        gender: 0,
      },
    },
  };
  const profile = resolveUserProfile(response, "555666");
  assert.ok(profile);
  assert.equal(profile.zaloName, "Field Matched User");
});

test("resolveUserProfile: empty response, mismatched UID, and invalid map data return null", () => {
  assert.equal(resolveUserProfile(null, "123456"), null);
  assert.equal(resolveUserProfile(undefined, "123456"), null);
  assert.equal(resolveUserProfile({}, "123456"), null);
  assert.equal(resolveUserProfile({ unchanged_profiles: null }, "123456"), null);
  assert.equal(resolveUserProfile({ unchanged_profiles: "invalid" }, "123456"), null);

  const mismatchedResponse = {
    unchanged_profiles: {
      "999999_0": {
        userId: "999999",
        zaloName: "Other User",
      },
    },
  };
  assert.equal(resolveUserProfile(mismatchedResponse, "123456"), null);
});

test("resolveUserProfile: does NOT pick the wrong first profile when response contains multiple users", () => {
  const response = {
    unchanged_profiles: {
      "888888_0": {
        userId: "888888",
        zaloName: "First Person",
      },
      "123456_0": {
        userId: "123456",
        zaloName: "Target Person",
      },
    },
  };
  const profile = resolveUserProfile(response, "123456");
  assert.ok(profile);
  assert.equal(profile.zaloName, "Target Person");
  assert.equal(profile.userId, "123456");
});

test("getUserInfoData: normalizes numeric and string userId, passes [uid] to api.getUserInfo", async () => {
  const mockApi = createMockApi((userIds) => ({
    unchanged_profiles: {
      [`${userIds[0]}_0`]: {
        userId: userIds[0],
        zaloName: `User ${userIds[0]}`,
        gender: 0,
      },
    },
  }));

  const data1 = await getUserInfoData(mockApi, 123456);
  assert.ok(data1);
  assert.equal(data1.uid, "123456");
  assert.equal(data1.name, "User 123456");
  assert.deepEqual(mockApi.requestedUserIds[0], ["123456"]);

  const data2 = await getUserInfoData(mockApi, "  789012  ");
  assert.ok(data2);
  assert.equal(data2.uid, "789012");
  assert.deepEqual(mockApi.requestedUserIds[1], ["789012"]);

  // Invalid userId returns null
  assert.equal(await getUserInfoData(mockApi, null), null);
  assert.equal(await getUserInfoData(mockApi, ""), null);
  assert.equal(await getUserInfoData(null, "123456"), null);
});

test("userInfoCommand 4 invocation styles pass correct target UID to API", async () => {
  const mockResponse = {
    unchanged_profiles: {
      "user_self_0": { userId: "user_self", zaloName: "Self User", gender: 0 },
      "user_mention_0": { userId: "user_mention", zaloName: "Mentioned User", gender: 1 },
      "user_direct_0": { userId: "user_direct", zaloName: "Direct User", gender: 0 },
      "thread_target_0": { userId: "thread_target", zaloName: "Target -f User", gender: 0 },
    },
  };

  // 1. Invocation: info self
  {
    const api = createMockApi(mockResponse);
    const message = {
      threadId: "thread-1",
      type: "group",
      data: {
        uidFrom: "user_self",
        content: "!info text",
        mentions: [],
      },
    };
    await userInfoCommand(api, message, "info");
    assert.deepEqual(api.requestedUserIds[0], ["user_self"]);
    assert.equal(api.sentMessages.length, 1);
    assert.match(api.sentMessages[0].payload.msg, /Self User/);
  }

  // 2. Invocation: info mention
  {
    const api = createMockApi(mockResponse);
    const message = {
      threadId: "thread-1",
      type: "group",
      data: {
        uidFrom: "user_self",
        content: "!info text @Mentioned User",
        mentions: [{ uid: "user_mention", pos: 11, len: 15 }],
      },
    };
    await userInfoCommand(api, message, "info");
    assert.deepEqual(api.requestedUserIds[0], ["user_mention"]);
    assert.equal(api.sentMessages.length, 1);
    assert.match(api.sentMessages[0].payload.msg, /Mentioned User/);
  }

  // 3. Invocation: info direct UID
  {
    const api = createMockApi(mockResponse);
    const message = {
      threadId: "thread-1",
      type: "group",
      data: {
        uidFrom: "user_self",
        content: "!info text user_direct",
        mentions: [],
      },
    };
    await userInfoCommand(api, message, "info");
    assert.deepEqual(api.requestedUserIds[0], ["user_direct"]);
    assert.equal(api.sentMessages.length, 1);
    assert.match(api.sentMessages[0].payload.msg, /Direct User/);
  }

  // 4. Invocation: info -f
  {
    const api = createMockApi(mockResponse);
    const message = {
      threadId: "thread_target",
      type: "private",
      data: {
        uidFrom: "user_self",
        idTo: "thread_target",
        content: "!info text -f",
        mentions: [],
      },
    };
    await userInfoCommand(api, message, "info");
    assert.deepEqual(api.requestedUserIds[0], ["thread_target"]);
    assert.equal(api.sentMessages.length, 1);
    assert.match(api.sentMessages[0].payload.msg, /Target -f User/);
  }
});

test("userInfoCommand error handling when user profile is not found", async () => {
  const api = createMockApi({ unchanged_profiles: {} });
  const message = {
    threadId: "thread-1",
    type: "group",
    data: {
      uidFrom: "user_not_found",
      content: "!info text",
      mentions: [],
    },
  };
  await userInfoCommand(api, message, "info");
  assert.equal(api.sentMessages.length, 1);
  assert.match(api.sentMessages[0].payload.msg, /Không thể lấy thông tin người dùng này/);
});

test("userInfoCommand image rendering smoke test calls canvas and sends image attachment", async () => {
  const api = createMockApi({
    unchanged_profiles: {
      "user_img_0": {
        userId: "user_img",
        zaloName: "Canvas User",
        gender: 0,
        status: "Bio text",
      },
    },
  });

  const message = {
    threadId: "thread-1",
    type: "group",
    data: {
      uidFrom: "user_img",
      content: "!info",
      mentions: [],
    },
  };

  await userInfoCommand(api, message, "info");
  assert.equal(api.sentMessages.length, 1);
  assert.ok(api.sentMessages[0].payload.attachments?.length > 0);
});

