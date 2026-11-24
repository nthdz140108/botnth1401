import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PHASE_10_COMMANDS, PHASE_11_COMMANDS, commandRegistry } = await import(pathToFileURL(path.join(projectRoot, 'src/commands/command-registry.js')).href);
const { parseCommandContent } = await import(pathToFileURL(path.join(projectRoot, 'src/commands/command-parser.js')).href);
const { resolveCommand } = await import(pathToFileURL(path.join(projectRoot, 'src/commands/command-router.js')).href);
const { readCommandConfig } = await import(pathToFileURL(path.join(projectRoot, 'src/utils/io-json.js')).href);
const { sendReactionConfirmReceive } = await import(pathToFileURL(path.join(projectRoot, 'src/commands/command-response.js')).href);

test('all ported commands from Nqduan have valid reaction types (1, 2, 3, 5) in runtime config', () => {
  const config = readCommandConfig();
  const list = config.commands || [];
  const map = new Map(list.map(c => [c.name, c]));

  const ported = [...PHASE_10_COMMANDS, ...PHASE_11_COMMANDS];
  for (const name of ported) {
    const cmd = map.get(name);
    assert.ok(cmd, `Command ${name} must exist in runtime command config`);
    assert.ok([1, 2, 3, 5].includes(cmd.type), `Command ${name} type (${cmd.type}) must be in [1, 2, 3, 5] for auto-reaction`);
  }
});

test('sendReactionConfirmReceive reacts with "thanks" for all ported command types', async () => {
  let reactionSent = null;
  const mockApi = {
    addReaction: async (reactionType, message) => {
      reactionSent = reactionType;
      return true;
    }
  };

  const mockMsg = {
    threadId: "test-thread",
    msgId: "test-msg-1",
    data: { msgId: "test-msg-1", uidFrom: "12345" }
  };

  // Test type 1
  reactionSent = null;
  const res1 = await sendReactionConfirmReceive(mockApi, { ...mockMsg, msgId: "m1" }, 1);
  assert.equal(res1, true);
  assert.equal(reactionSent, "thanks");

  // Test type 3
  reactionSent = null;
  const res3 = await sendReactionConfirmReceive(mockApi, { ...mockMsg, msgId: "m3" }, 3);
  assert.equal(res3, true);
  assert.equal(reactionSent, "thanks");

  // Test type 5
  reactionSent = null;
  const res5 = await sendReactionConfirmReceive(mockApi, { ...mockMsg, msgId: "m5" }, 5);
  assert.equal(res5, true);
  assert.equal(reactionSent, "thanks");

  // Test type 99 (invalid) -> should not react
  reactionSent = null;
  const res99 = await sendReactionConfirmReceive(mockApi, { ...mockMsg, msgId: "m99" }, 99);
  assert.equal(res99, false);
  assert.equal(reactionSent, null);
});
