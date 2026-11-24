import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));

test("offline validation finds required runtime asset directories", () => {
  for (const relativePath of ["assets", "assets/resources", "assets/temp", "src", "dashboard"]) {
    assert.equal(existsSync(path.join(projectRoot, relativePath)), true, relativePath);
  }
});

test("offline validation finds no machine-specific source paths", () => {
  const sourceFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "assets") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.name.endsWith(".js")) sourceFiles.push(fullPath);
    }
  };
  visit(path.join(projectRoot, "src"));
  const forbidden = /\/root\/ndq|Users[\\/]Administrator[\\/]Desktop/;
  for (const filePath of sourceFiles) {
    assert.equal(forbidden.test(readFileSync(filePath, "utf8")), false, filePath);
  }
});

test("offline validation passes JavaScript syntax checks", () => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.name.endsWith(".js")) files.push(fullPath);
    }
  };
  visit(path.join(projectRoot, "src"));
  for (const filePath of files) {
    const result = spawnSync(process.execPath, ["--check", filePath], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${filePath}\n${result.stderr}`);
  }
});
