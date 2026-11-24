import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
const scriptPath = path.join(projectRoot, "scripts", "audit-imports.js");

function createWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "audit-imports-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "dashboard"), { recursive: true });
  return root;
}

function runAudit(cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
  });
}

test("audit-imports passes when relative imports resolve exactly", () => {
  const root = createWorkspace();
  try {
    writeFileSync(path.join(root, "src", "helper.js"), "export const helper = 1;\n");
    writeFileSync(path.join(root, "src", "main.js"), "import { helper } from './helper.js';\nconsole.log(helper);\n");
    writeFileSync(path.join(root, "dashboard", "app.js"), "export const app = {};\n");

    const result = runAudit(root);

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.issues, 0);
    assert.equal(summary.imports, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit-imports reports missing files and case mismatches", () => {
  const root = createWorkspace();
  try {
    writeFileSync(path.join(root, "src", "helper.js"), "export const helper = 1;\n");
    writeFileSync(
      path.join(root, "src", "main.js"),
      [
        "import { helper } from './Helper.js';",
        "import './missing.js';",
        "console.log(helper);",
      ].join("\n"),
    );
    writeFileSync(path.join(root, "dashboard", "app.js"), "export const app = {};\n");

    const result = runAudit(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /case-mismatch/);
    assert.match(result.stderr, /missing/);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.issues, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
