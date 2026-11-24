import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const codeExtensions = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json"];
const ignoredDirectoryNames = new Set([
  "node_modules",
  ".codebase-memory",
  ".git",
  ".cache",
  "dist",
  "build",
]);

const files = [];

function isCodeFile(name) {
  return /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(name);
}

async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      await walk(path.join(dir, entry.name));
      continue;
    }
    if (isCodeFile(entry.name)) files.push(path.join(dir, entry.name));
  }
}

async function collectRootFiles() {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !isCodeFile(entry.name)) continue;
    files.push(path.join(root, entry.name));
  }
}

function parseImports(text) {
  const imports = [];
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  const dynamicPattern = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const staticPattern = /(?:import\s+['"]([^'"]+)['"]|from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
  for (const match of stripped.matchAll(staticPattern)) {
    const spec = match[1] || match[2] || match[3];
    if (spec && /^[.]{1,2}\//.test(spec)) imports.push({ spec, isDynamic: false });
  }
  for (const match of stripped.matchAll(dynamicPattern)) {
    const spec = match[1];
    if (spec && /^[.]{1,2}\//.test(spec)) imports.push({ spec, isDynamic: true });
  }
  return imports;
}

function unique(values) {
  return [...new Set(values)];
}

function buildCandidates(file, spec) {
  const base = path.resolve(path.dirname(file), spec);
  const candidates = [];
  if (path.extname(spec)) {
    candidates.push(base);
  } else {
    candidates.push(base);
    for (const extension of codeExtensions) {
      candidates.push(`${base}${extension}`);
    }
    for (const extension of codeExtensions) {
      candidates.push(path.join(base, `index${extension}`));
    }
  }
  return unique(candidates);
}

async function inspectPath(targetPath) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root || path.sep;
  let caseMismatch = false;
  let mismatchPath = absolute;

  for (const segment of segments) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return { status: "missing" };
    }

    const exact = entries.find((entry) => entry.name === segment);
    if (exact) {
      current = path.join(current, exact.name);
      continue;
    }

    const insensitive = entries.find((entry) => entry.name.toLowerCase() === segment.toLowerCase());
    if (!insensitive) {
      return { status: "missing" };
    }

    caseMismatch = true;
    mismatchPath = path.join(current, segment);
    current = path.join(current, insensitive.name);
  }

  try {
    const stat = await fs.stat(current);
    if (!stat.isFile()) {
      return { status: "missing" };
    }
    return {
      status: caseMismatch ? "case-mismatch" : "ok",
      path: current,
      mismatchPath,
    };
  } catch {
    return { status: "missing" };
  }
}

const issues = [];
const imports = [];
const graph = new Map();

await collectRootFiles();
await walk(path.join(root, "src"));
await walk(path.join(root, "dashboard"));

for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  const edges = [];
  for (const { spec, isDynamic } of parseImports(text)) {
    const candidates = buildCandidates(file, spec);
    imports.push({ file, spec, candidates: candidates.length });

    let exactMatch = null;
    let caseMismatch = null;
    for (const candidate of candidates) {
      const inspection = await inspectPath(candidate);
      if (inspection.status === "ok") {
        exactMatch = inspection.path;
        break;
      }
      if (inspection.status === "case-mismatch" && !caseMismatch) {
        caseMismatch = inspection;
      }
    }

    if (exactMatch) {
      if (!isDynamic) {
        edges.push(exactMatch);
      }
      continue;
    }

    if (caseMismatch) {
      issues.push({
        kind: "case-mismatch",
        file,
        spec,
        resolved: caseMismatch.path,
        expected: caseMismatch.mismatchPath,
      });
      continue;
    }

    issues.push({
      kind: "missing",
      file,
      spec,
      resolved: candidates[0],
    });
  }
  graph.set(file, edges);
}

const forbidden = new Set(["src/index.js", "index.js", "bot.js"].map((entry) => path.resolve(root, entry)));
for (const start of files.filter((file) => path.relative(root, file).split(path.sep)[0] === "dashboard")) {
  const queue = [{ file: start, chain: [start] }];
  const seen = new Set([start]);
  while (queue.length) {
    const { file, chain } = queue.shift();
    for (const edge of graph.get(file) || []) {
      const next = path.resolve(edge);
      const nextChain = [...chain, next];
      if (forbidden.has(next)) {
        issues.push({ kind: "forbidden-dashboard-entrypoint", file: start, chain: nextChain });
        continue;
      }
      if (!seen.has(next)) { seen.add(next); queue.push({ file: next, chain: nextChain }); }
    }
  }
}

const summary = {
  scanned: files.length,
  imports: imports.length,
  issues: issues.length,
};

if (issues.length > 0) {
  console.error(`audit-imports found ${issues.length} issue(s).`);
  for (const issue of issues) {
    if (issue.kind === "case-mismatch") {
      console.error(`case-mismatch: ${issue.file} -> ${issue.spec} (resolved ${issue.resolved}, expected ${issue.expected})`);
    } else {
      if (issue.kind === "forbidden-dashboard-entrypoint") {
        console.error(`forbidden-dashboard-entrypoint: ${issue.chain.map((file) => path.relative(root, file)).join(" -> ")}`);
      } else {
        console.error(`missing: ${issue.file} -> ${issue.spec} (expected ${issue.resolved})`);
      }
    }
  }
  process.exitCode = 1;
}

console.log(JSON.stringify(summary, null, 2));
