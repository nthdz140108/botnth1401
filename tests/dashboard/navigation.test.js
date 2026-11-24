import test from "node:test";
import assert from "node:assert/strict";
import { DASHBOARD_VIEWS, getDashboardView } from "../../dashboard/src/app/navigation.js";

test("exposes the slim 7-view 100%-functional dashboard navigation contract", () => {
  assert.equal(DASHBOARD_VIEWS.length, 7);
  assert.deepEqual(getDashboardView("overview"), DASHBOARD_VIEWS[0]);
  assert.equal(getDashboardView("commands").label, "Commands");
  assert.equal(getDashboardView("chat-access").label, "Chat access");
  assert.deepEqual(getDashboardView("system"), DASHBOARD_VIEWS.find((view) => view.id === "system"));
  assert.equal(getDashboardView("missing").id, "overview");
});
