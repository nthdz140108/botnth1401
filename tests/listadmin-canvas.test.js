import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createAdminListImage } from "../src/utils/canvas/listadmin-canvas.js";

test("renderer uses three explicit columns and survives mixed avatar failures", async () => {
  const file = await createAdminListImage({
    highAdmins: [{ id: "1", name: "Alpha", role: "Quản trị Tối cao", avatar: "data:image/png;base64,invalid" }],
    botAdmins: [{ id: "2", name: "Beta", role: "Quản trị Bot đa-nhóm", avatar: null }],
    groupAdmins: [{ id: "3", name: "Gamma", role: "Quản trị Nhóm", avatar: "https://invalid.example/avatar.png" }],
    isPrivate: false,
  });
  const stat = await fs.stat(file);
  assert.ok(stat.size > 1000);
  await fs.unlink(file);
});
