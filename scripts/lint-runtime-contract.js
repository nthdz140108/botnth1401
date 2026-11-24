#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandRegistry } from "../src/commands/command-registry.js";
import { VALID_EXECUTION_LANES } from "../src/commands/command-router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

let errorCount = 0;
function assertLint(condition, message) {
  if (!condition) {
    console.error(`[LINT-ERROR] ${message}`);
    errorCount++;
  } else {
    console.log(`[LINT-PASS] ${message}`);
  }
}

console.log("=== LINT RUNTIME CONTRACT ===");

// 1. Check all commands have valid executionLane
console.log("\n1. Checking Command Registry Execution Lanes...");
const definitions = commandRegistry.definitions || [];
assertLint(definitions.length > 0, `Command registry definitions loaded (${definitions.length} commands found)`);

let invalidLanes = 0;
for (const cmd of definitions) {
  if (!VALID_EXECUTION_LANES.has(cmd.executionLane)) {
    invalidLanes++;
    console.error(`  - Command "${cmd.name}" has invalid executionLane: ${cmd.executionLane}`);
  }
}
assertLint(invalidLanes === 0, `All ${definitions.length} commands have explicit, valid execution lanes`);

// 2. Check no direct old coordinator imports in src/index.js
console.log("\n2. Checking Coordinator Isolation in src/index.js...");
const indexContent = fs.readFileSync(path.join(projectRoot, "src", "index.js"), "utf-8");
assertLint(
  !indexContent.includes("createReconnectCoordinator") &&
  !indexContent.includes("createInboundCoordinator") &&
  !indexContent.includes("createInboundDispatcher") &&
  !indexContent.includes("createFastPathDispatcher"),
  "src/index.js does not directly instantiate internal coordinators (delegated to createRuntimeLifecycle)"
);
assertLint(
  !indexContent.includes("_reconnectCoordinator") &&
  !indexContent.includes("_inboundCoordinator"),
  "src/index.js contains no stray legacy coordinator global references"
);

// 3. Check Runtime Bridge isolation in src/web-service/web-server.js
console.log("\n3. Checking Runtime Bridge Isolation in src/web-service/web-server.js...");
const webServerContent = fs.readFileSync(path.join(projectRoot, "src", "web-service", "web-server.js"), "utf-8");
assertLint(
  !webServerContent.includes("registerDashboardApi"),
  "src/web-service/web-server.js does not register dashboard API routes"
);
assertLint(
  !webServerContent.includes("express.static") &&
  !webServerContent.includes("dashboard/dist"),
  "src/web-service/web-server.js does not serve SPA static assets"
);
assertLint(
  webServerContent.includes("127.0.0.1"),
  "src/web-service/web-server.js is hard-bound to 127.0.0.1 loopback only"
);

// 4. Check Exit codes standardization
console.log("\n4. Checking Exit Code Standardization...");
const runtimeInstanceContent = fs.readFileSync(path.join(projectRoot, "src", "core", "runtime-instance.js"), "utf-8");
const restartRequestContent = fs.readFileSync(path.join(projectRoot, "src", "utils", "restart-request.js"), "utf-8");
assertLint(
  runtimeInstanceContent.includes("RESTART_EXIT_CODE = 10") &&
  restartRequestContent.includes("RESTART_EXIT_CODE = 10"),
  "RESTART_EXIT_CODE is standardized to 10 across runtime-instance and restart-request"
);

if (errorCount > 0) {
  console.error(`\nFAILED: Runtime contract lint failed with ${errorCount} errors.`);
  process.exit(1);
}

console.log("\nPASSED: Runtime contract lint passed successfully!");
process.exit(0);
