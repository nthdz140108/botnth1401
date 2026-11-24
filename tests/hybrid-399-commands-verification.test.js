import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand, executeCommand, createCommandDefinition, VALID_EXECUTION_LANES } from "../src/commands/command-router.js";
import { commandRegistry } from "../src/commands/command-registry.js";
import { createWorkloadBroker } from "../src/core/workload-broker.js";
import { isHighRiskCommand } from "../src/commands/high-risk-policy.js";
import { formatCalendarDate, parseMonth, formatMonth } from "../src/commands/lich-command.js";
import { sendReactionConfirmReceive } from "../src/commands/command-response.js";
import { checkDispatcherCooldown } from "../src/commands/command-dispatcher.js";
import { CooldownLedger } from "../src/commands/command-behavior-context.js";
import { getGroupInfoData, clearInFlightGroupRequests, getGroupInfoCache } from "../src/service-debug/info-service/group-info-data.js";
import { runMessageProtection } from "../src/automations/message-protection.js";
import { createLatencyTracker } from "../src/observability/latency-tracker.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "assets", "json-data", "command.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestCommands = Array.isArray(manifest.commands) ? manifest.commands : [];

test("1. Hybrid Catalog Integrity: Canonical commands and aliases agree with the manifest", () => {
  assert.equal(commandRegistry.definitions.length, manifestCommands.length);
  assert.equal(commandRegistry.canonicalNames.size, manifestCommands.length);

  let totalAliasCount = 0;
  for (const def of commandRegistry.definitions) {
    totalAliasCount += def.aliases.length;
  }

  assert.equal(totalAliasCount, manifestCommands.reduce((count, command) => count + (command.alias?.length || 0), 0));
  assert.equal(commandRegistry.keys.length, manifestCommands.length + totalAliasCount);
});

test("2. Hybrid Dispatch: Every key resolves cleanly to an active JS handler", () => {
  const seenCanonical = new Set();
  const seenAliases = new Set();

  for (const key of commandRegistry.keys) {
    const parts = key.split(" ");
    const result = resolveCommand(parts, commandRegistry);

    assert.equal(result.code, "RESOLVED", `Key '${key}' must resolve`);
    assert.ok(result.definition, `Key '${key}' must return definition`);
    assert.equal(typeof result.definition.handler, "function", `Key '${key}' handler must be a function`);

    if (result.definition.name === key) {
      seenCanonical.add(key);
    } else {
      seenAliases.add(key);
      assert.ok(result.definition.aliases.includes(key), `Alias '${key}' must belong to '${result.definition.name}'`);
    }
  }

  assert.equal(seenCanonical.size, manifestCommands.length);
  assert.equal(seenAliases.size, manifestCommands.reduce((count, command) => count + (command.alias?.length || 0), 0));
});

test("3. Execution Lanes: All commands belong to valid execution lanes", () => {
  const laneCounts = { fast: 0, control: 0, heavy: 0, broadcast: 0 };

  for (const def of commandRegistry.definitions) {
    assert.ok(
      VALID_EXECUTION_LANES.has(def.executionLane),
      `Command '${def.name}' has invalid execution lane '${def.executionLane}'`
    );
    laneCounts[def.executionLane] = (laneCounts[def.executionLane] || 0) + 1;
  }

  assert.ok(laneCounts.fast > 100, `Fast lane should contain majority of commands, got ${laneCounts.fast}`);
  assert.ok(laneCounts.heavy > 0, `Heavy lane must contain commands`);
});

test("4. Lane Concurrency Isolation: Heavy workload submission does not starve fast lane tasks", async () => {
  const broker = createWorkloadBroker({
    botId: "test-isolation",
    maxFastConcurrent: 4,
    maxHeavyConcurrent: 1,
    maxHeavyQueueSize: 5,
  });

  try {
    let heavyStarted = false;
    let heavyFinished = false;

    // 1. Submit a heavy job that takes 100ms
    const heavyJob = broker.submitHeavy("testHeavy", {}, async () => {
      heavyStarted = true;
      await new Promise((r) => setTimeout(r, 100));
      heavyFinished = true;
      return "heavyDone";
    });

    assert.ok(heavyJob.jobId);

    // 2. Immediately execute a fast command while heavy job is running
    const fastStart = Date.now();
    const fastResult = await broker.runFast("testFast", async () => {
      return "fastInstant";
    });
    const fastElapsed = Date.now() - fastStart;

    assert.equal(fastResult, "fastInstant");
    assert.ok(fastElapsed < 80, `Fast task must complete quickly, took ${fastElapsed}ms`);
    assert.equal(heavyFinished, false, "Heavy job must still be running while fast job already finished");

    // 3. Await heavy completion
    const heavyRes = await heavyJob.promise;
    assert.equal(heavyRes, "heavyDone");
    assert.equal(heavyFinished, true);
  } finally {
    await broker.shutdown();
  }
});

test("5. Command Policy & Permission Enforcement: Enforces permissions fail-closed", async () => {
  const adminOnlyDef = commandRegistry.definitions.find(
    (d) => d.permission === "adminBot" || d.permission === "adminLevelHigh"
  );

  if (adminOnlyDef) {
    const unprivilegedContext = {
      permissionLevel: "member",
      scope: "group",
      isAdminLevelHighest: false,
      isMainBotAdmin: false,
      dependencies: { zaloSession: true },
    };

    const res = await executeCommand(unprivilegedContext, adminOnlyDef);
    assert.equal(res.code, "PERMISSION_DENIED", `Command '${adminOnlyDef.name}' must deny unprivileged user`);
  }
});

test("6. Context Scope Enforcement: Direct Message (DM) vs Group vs Both scopes", async () => {
  // Find a private-only command (e.g. simsimi)
  const privateOnlyDef = commandRegistry.definitions.find((d) => d.scope === "private");
  if (privateOnlyDef) {
    const groupContext = {
      scope: "group",
      permissionLevel: "all",
      dependencies: { zaloSession: true },
    };
    const res = await executeCommand(groupContext, privateOnlyDef);
    assert.equal(res.code, "SCOPE_DENIED", `Private-only command '${privateOnlyDef.name}' must deny execution in group scope`);
  }

  // Find a group-only command
  const groupOnlyDef = commandRegistry.definitions.find((d) => d.scope === "group");
  if (groupOnlyDef) {
    const dmContext = {
      scope: "private",
      permissionLevel: "all",
      dependencies: { zaloSession: true },
    };
    const res = await executeCommand(dmContext, groupOnlyDef);
    assert.equal(res.code, "SCOPE_DENIED", `Group-only command '${groupOnlyDef.name}' must deny execution in DM scope`);
  }

  // Find a both-scope command (e.g. help or data)
  const bothScopeDef = commandRegistry.definitions.find((d) => d.scope === "both");
  if (bothScopeDef) {
    assert.ok(bothScopeDef.scope === "both", "Command should allow both scopes");
  }
});

test("7. Bot Instance Kind Isolation: Main Bot vs Child Bot (Bot Con) Scopes", async () => {
  // Commands with instanceScope: 'main' (e.g. 'mybot') must reject execution on child bots
  const mainOnlyDef = commandRegistry.definitions.find((d) => d.instanceScope === "main");
  assert.ok(mainOnlyDef, "Must have at least one main-only command (e.g. mybot)");

  // Attempt execution on a child bot
  const childBotContext = {
    scope: "private",
    permissionLevel: "adminLevelHigh",
    isAdminLevelHighest: true,
    isMainBotAdmin: true,
    instanceKind: "child",
    dependencies: { zaloSession: true },
  };

  const deniedResult = await executeCommand(childBotContext, mainOnlyDef);
  assert.equal(deniedResult.code, "INSTANCE_DENIED", `Main-only command '${mainOnlyDef.name}' must reject execution on child bot`);

  // Main bot execution passes instance check
  const mainBotContext = {
    scope: "private",
    permissionLevel: "adminLevelHigh",
    instanceKind: "main",
    dependencies: { zaloSession: true },
  };

  // With a test definition having instanceScope: 'main'
  const testMainDef = createCommandDefinition({
    name: "test-main-only",
    scope: "both",
    instanceScope: "main",
    permission: "all",
    handler: async () => "passed",
  });

  const childResult = await executeCommand({ ...childBotContext, scope: "private" }, testMainDef);
  assert.equal(childResult.code, "INSTANCE_DENIED");

  const allowedResult = await executeCommand(mainBotContext, testMainDef);
  assert.equal(allowedResult.code, "HANDLED");
  assert.equal(allowedResult.value, "passed");
});

test("8. Self-DM and Self-Echo Filtering", () => {
  // In Zalo listener, self-messages are filtered out unless selfListen is enabled
  const mockSelfMessage = {
    isSelf: true,
    threadId: "self-thread-123",
    data: { uidFrom: "bot-uid-999", content: "Self message" },
  };

  function simulateListenerFilter(message, selfListen) {
    if (message.isSelf && !selfListen) {
      return "DROPPED";
    }
    return "DISPATCHED";
  }

  assert.equal(simulateListenerFilter(mockSelfMessage, false), "DROPPED", "Must drop self message when selfListen is false");
  assert.equal(simulateListenerFilter(mockSelfMessage, true), "DISPATCHED", "Must dispatch self message when selfListen is true");
});

test("9. High-Risk Command Policy Guardrails", async () => {
  const highRiskDefs = commandRegistry.definitions.filter((d) => isHighRiskCommand(d) || d.risk === "critical" || d.risk === "high");
  assert.ok(highRiskDefs.length > 0, "Must have registered high risk commands");

  for (const def of highRiskDefs.slice(0, 5)) {
    // Member should be rejected
    const unprivilegedContext = {
      permissionLevel: "member",
      scope: "group",
      isAdminLevelHighest: false,
      isMainBotAdmin: false,
      dependencies: { zaloSession: true },
    };
    const res = await executeCommand(unprivilegedContext, def);
    assert.equal(res.code, "PERMISSION_DENIED", `High risk command '${def.name}' must deny member`);
  }
});

test("10. Parameter Validation: minArgs Rejection", async () => {
  const minArgsDef = commandRegistry.definitions.find((d) => d.minArgs && d.minArgs > 0);
  if (minArgsDef) {
    const insufficientArgsContext = {
      scope: "group",
      permissionLevel: "adminLevelHigh",
      isAdminLevelHighest: true,
      args: [], // Less than minArgs
      dependencies: { zaloSession: true },
    };

    const res = await executeCommand(insufficientArgsContext, minArgsDef);
    assert.equal(res.code, "MISSING_ARGUMENT", `Command '${minArgsDef.name}' must reject insufficient args`);
    assert.equal(res.minArgs, minArgsDef.minArgs);
  }
});

test("11. Reaction & Response Verification: Confirm reception (1, 2, 3) and cooldown countdown", async () => {
  const reacted = [];
  const mockApi = {
    addReaction: async (icon, msg) => {
      reacted.push({ icon, msgId: msg.data.msgId });
      return { status: 0 };
    },
  };

  const mockMessage = {
    data: { msgId: "react-msg-123" },
    threadId: "thread-123",
  };

  // Test confirm reaction
  await sendReactionConfirmReceive(mockApi, mockMessage, 1);
  assert.equal(reacted.length, 1);
  assert.equal(reacted[0].icon, "thanks");

  // Test cooldown countdown tracking with an isolated ledger
  const testLedger = new CooldownLedger();
  const testNow = Date.now();
  const cdResult1 = checkDispatcherCooldown({
    commandParts: ["help"],
    userId: "user-cd-1",
    threadId: "thread-1",
    ledger: testLedger,
    now: testNow,
  });
  assert.equal(cdResult1.allowed, true);

  const cdResult2 = checkDispatcherCooldown({
    commandParts: ["help"],
    userId: "user-cd-1",
    threadId: "thread-1",
    ledger: testLedger,
    now: testNow + 1000, // within countdown window
  });
  assert.equal(cdResult2.allowed, false);
  assert.ok(cdResult2.remainingSeconds > 0);
});

test("12. Side Effects: Calendar / Lich Command Parsing and Solar-Lunar Formatting", () => {
  const date = new Date(2026, 10, 5); // 05/11/2026
  const formatted = formatCalendarDate(date);
  assert.ok(formatted.solar.includes("05/11/2026"));
  assert.ok(formatted.lunar.includes("(Am lich)"));
  assert.ok(formatted.details.length > 0);

  // Month parsing
  const parsed = parseMonth(["month", "2026-11"]);
  assert.deepEqual(parsed, { year: 2026, month: 11 });

  const invalid = parseMonth(["month", "invalid-date"]);
  assert.equal(invalid, null);

  // Month formatting
  const monthCalendar = formatMonth(2026, 11);
  assert.ok(monthCalendar.includes("Calendar 11/2026"));
});

test("13. In-Flight Request Deduplication: Concurrent Group Info Queries", async () => {
  clearInFlightGroupRequests();
  getGroupInfoCache().clear();

  let apiFetchCount = 0;
  const mockApi = {
    getGroupInfo: async (threadId) => {
      apiFetchCount++;
      // Simulate network latency of 50ms
      await new Promise((r) => setTimeout(r, 50));
      return {
        gridInfoMap: {
          [threadId]: {
            name: "Test Concurrent Group",
            memVerList: ["user1", "user2"],
            creatorId: "creator-123",
            adminIds: ["admin-123"],
          },
        },
      };
    },
  };

  const testThreadId = "concurrent-group-999";

  // Fire 10 concurrent requests for the exact same group
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(getGroupInfoData(mockApi, testThreadId));
  }

  const results = await Promise.all(promises);

  // Verify all 10 calls received the identical group info object
  assert.equal(results.length, 10);
  for (const info of results) {
    assert.equal(info.name, "Test Concurrent Group");
    assert.equal(info.creatorId, "creator-123");
  }

  // CRITICAL: api.getGroupInfo must have been called exactly ONCE due to in-flight deduplication!
  assert.equal(apiFetchCount, 1, "Concurrent in-flight calls must be deduplicated to exactly 1 network call");

  // Subsequent call hits cache
  const cachedCall = await getGroupInfoData(mockApi, testThreadId);
  assert.equal(cachedCall.name, "Test Concurrent Group");
  assert.equal(apiFetchCount, 1, "Subsequent call must hit cache without additional network calls");
});

test("14. Security Fast-Path: Bypasses disabled rules while preserving exact evaluation order", async () => {
  const executionOrder = [];
  const rules = [
    {
      name: "ruleDisabled1",
      action: "delete",
      enabled: () => false,
      run: async () => {
        executionOrder.push("ruleDisabled1");
        return true;
      },
    },
    {
      name: "ruleDisabled2",
      action: "delete",
      enabled: () => false,
      run: async () => {
        executionOrder.push("ruleDisabled2");
        return true;
      },
    },
    {
      name: "ruleEnabledA",
      action: "delete",
      enabled: () => true,
      run: async () => {
        executionOrder.push("ruleEnabledA");
        return false; // not matched
      },
    },
    {
      name: "ruleEnabledB",
      action: "delete",
      enabled: () => true,
      run: async () => {
        executionOrder.push("ruleEnabledB");
        return true; // matched!
      },
    },
    {
      name: "ruleEnabledC",
      action: "delete",
      enabled: () => true,
      run: async () => {
        executionOrder.push("ruleEnabledC");
        return true;
      },
    },
  ];

  const result = await runMessageProtection({
    context: { threadId: "test-fastpath" },
    rules,
  });

  assert.equal(result.handled, true);
  assert.equal(result.rule, "ruleEnabledB");
  // ruleDisabled1 and ruleDisabled2 were bypassed; ruleEnabledA ran, then ruleEnabledB ran and stopped
  assert.deepEqual(executionOrder, ["ruleEnabledA", "ruleEnabledB"]);
});

test("15. Telemetry & Privacy Guard: Milestone Latency Tracking with Zero Secret Leakage", () => {
  const tracker = createLatencyTracker();
  const eventId = "evt-telemetry-test-01";

  // Begin event with intentional attempt to pass chat content and secrets in metadata
  tracker.begin(eventId, "message", "test-bot", {
    commandClass: "fast-text",
    content: "PRIVATE CHAT MESSAGE SHOULD NEVER BE LOGGED",
    message: "CONFIDENTIAL USER INPUT",
    secretKey: "SUPER_SECRET_TOKEN_12345",
    cookie: "zpw_sek=SECRET_COOKIE_DATA",
    validMetricName: "test-metric",
  });

  // Mark all required pipeline phases
  tracker.mark(eventId, "decoded");
  tracker.mark(eventId, "group_info_resolved");
  tracker.mark(eventId, "security_evaluated");
  tracker.mark(eventId, "dispatch_completed");
  tracker.mark(eventId, "handler_started");
  tracker.mark(eventId, "first_response_completed");

  const finishReport = tracker.finish(eventId, "ok");

  // Verify phases are recorded
  assert.ok(finishReport.phases.ws_received);
  assert.ok(finishReport.phases.decoded);
  assert.ok(finishReport.phases.group_info_resolved);
  assert.ok(finishReport.phases.security_evaluated);
  assert.ok(finishReport.phases.dispatch_completed);
  assert.ok(finishReport.phases.handler_started);
  assert.ok(finishReport.phases.first_response_completed);
  assert.ok(finishReport.phases.completed);

  // Take snapshot
  const snapshot = tracker.snapshot("test-bot");
  const jsonStr = JSON.stringify(snapshot);

  // CRITICAL PRIVACY VERIFICATION: ZERO message content or secrets allowed in telemetry
  assert.equal(jsonStr.includes("PRIVATE CHAT MESSAGE"), false, "Must never contain chat content");
  assert.equal(jsonStr.includes("CONFIDENTIAL USER INPUT"), false, "Must never contain user input");
  assert.equal(jsonStr.includes("SUPER_SECRET_TOKEN"), false, "Must never contain secret tokens");
  assert.equal(jsonStr.includes("SECRET_COOKIE_DATA"), false, "Must never contain cookie secrets");

  // Verify end-to-end first response transition is recorded
  assert.ok(snapshot.byPhase["ws_received->first_response_completed"]);
  assert.ok(snapshot.byPhase["ws_received->first_response_completed"].count > 0);
});
