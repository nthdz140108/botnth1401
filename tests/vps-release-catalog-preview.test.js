import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildPreview } from "../deploy/patch-preview.mjs";
import { createPatchPackage } from "../deploy/patch-package.mjs";
import { validatePatchPackage } from "../deploy/patch-validate.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-catalog-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  const catalog = { prefix: "!", commands: [{ name: "help", permission: "all", active: true }] };
  const paths = ["assets/json-data/command.json", "mybot/defaultCommand.json"];
  const write = (name, text) => { const file = path.join(repo, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  for (const name of paths) write(name, JSON.stringify(catalog));
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const addition = { name: "getuser", scope: "group", permission: "all", active: true };
  for (const name of paths) write(name, JSON.stringify({ ...catalog, commands: [...catalog.commands, addition] }));
  write("src/utils/release-command-defaults.js", `export default ${JSON.stringify([addition])};\n`);
  return { root, repo, git, write, catalog, addition, paths, base, commit() { git("add", "."); git("commit", "-qm", "target"); return git("rev-parse", "HEAD"); } };
}

test("BAT packaging delivers additive command defaults as code accepted by the existing VPS validator", (t) => {
  const f = fixture(t), target = f.commit();
  const preview = buildPreview({ repo: f.repo, base: f.base, target });
  assert.deepEqual(preview.files.map((file) => file.path), ["src/utils/release-command-defaults.js"]);
  const output = path.join(f.root, "payload");
  createPatchPackage({ repo: f.repo, base: f.base, target, output });
  const manifest = validatePatchPackage(output);
  assert.equal(manifest.files.length, 1);
  assert.equal(fs.existsSync(path.join(output, "files", "assets")), false);
  assert.equal(fs.existsSync(path.join(output, "files", "mybot")), false);
});

test("preview rejects changing existing command settings alongside a backed addition", (t) => {
  const f = fixture(t);
  f.write(f.paths[0], JSON.stringify({ ...f.catalog, commands: [{ ...f.catalog.commands[0], active: false }, f.addition] }));
  assert.throws(() => buildPreview({ repo: f.repo, base: f.base, target: f.commit() }), /manual|catalog/i);
});

test("preview rejects additions not mirrored by the target release defaults", (t) => {
  const f = fixture(t);
  f.write("src/utils/release-command-defaults.js", "export default [];\n");
  assert.throws(() => buildPreview({ repo: f.repo, base: f.base, target: f.commit() }), /manual|catalog/i);
});

test("preview rejects prefix changes, removals and unrelated runtime assets", async (t) => {
  for (const change of ["prefix", "remove", "runtime"]) {
    await t.test(change, (t) => {
      const f = fixture(t);
      if (change === "prefix") f.write(f.paths[0], JSON.stringify({ prefix: "$", commands: [...f.catalog.commands, f.addition] }));
      if (change === "remove") f.write(f.paths[0], JSON.stringify({ ...f.catalog, commands: [f.addition] }));
      if (change === "runtime") f.write("assets/config.json", "{}");
      assert.throws(() => buildPreview({ repo: f.repo, base: f.base, target: f.commit() }), /manual|catalog/i);
    });
  }
});
