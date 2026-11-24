import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { appContext } from "../src/api-zalo/context.js";
import { decodeAES, encodeAES } from "../src/api-zalo/utils.js";

async function serverFixture(t, body) {
  const previous = { ...appContext };
  Object.assign(appContext, { secretKey: Buffer.from("0123456789abcdef").toString("base64"), imei: "test-imei", cookie: "test=1", userAgent: "test" });
  t.after(() => Object.assign(appContext, previous));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ path: url.pathname, type: url.searchParams.get("zpw_type"), version: url.searchParams.get("zpw_ver"), method: req.method,
      params: JSON.parse(decodeAES(appContext.secretKey, url.searchParams.get("params"))) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { getGroupInfoV2Factory } = await import("../src/api-zalo/apis/getGroupInfoV2.js");
  return { request: getGroupInfoV2Factory({ zpwServiceMap: { group: [`http://127.0.0.1:${server.address().port}`] } }), requests };
}

test("getGroupInfoV2 sends the documented encrypted GET payload and decodes the roster", async (t) => {
  const fixture = await serverFixture(t, () => ({ data: encodeAES(appContext.secretKey, JSON.stringify({ error_code: 0, data: { groupId: "123", memberIds: ["100", "200"], totalMember: 2 } })) }));
  const result = await fixture.request("123", { mpage: 2, mcount: 100 });
  assert.deepEqual(result.memberIds, ["100", "200"]);
  assert.deepEqual(fixture.requests, [{ path: "/api/group/getgi/v2", type: "30", version: "671", method: "GET",
    params: { grid: "123", avatar_size: 120, member_avatar_size: 120, mpage: 2, mcount: 100 } }]);
});

test("getGroupInfoV2 propagates outer server errors rather than returning an empty success", async (t) => {
  const fixture = await serverFixture(t, () => ({ error_code: 123, error_message: "access denied" }));
  await assert.rejects(fixture.request("123"), (error) => error.code === 123);
});

test("getGroupInfoV2 rejects wrong group IDs and invalid page inputs", async (t) => {
  const fixture = await serverFixture(t, () => ({ data: encodeAES(appContext.secretKey, JSON.stringify({ error_code: 0, data: { groupId: "999", memberIds: ["100"] } })) }));
  await assert.rejects(fixture.request("123"), /group/i);
  await assert.rejects(fixture.request("123", { mpage: 0 }), /page|mpage/i);
  await assert.rejects(fixture.request("123", { mcount: 0 }), /count|mcount/i);
});
