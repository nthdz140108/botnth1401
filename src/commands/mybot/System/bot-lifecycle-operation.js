import path from 'node:path';
import crypto from 'node:crypto';
import { withRegistryLock } from './registry-lock.js';
import { loadMyBotsRegistry, saveMyBotsRegistry } from './mybots-registry.js';

const registryFile = root => path.join(root, 'mybot', 'mybots.json');
export function cancelledStart() {
  return Object.assign(new Error('Startup was cancelled by a newer lifecycle operation'), { code: 'START_CANCELLED', stage: 'lifecycle', status: 409 });
}
export async function beginBotStartOperation(botKey, { root, operationId = null } = {}) {
  const file = registryFile(root);
  return withRegistryLock(file, () => {
    const registry = loadMyBotsRegistry(file);
    const record = registry[botKey];
    if (!record) throw Object.assign(new Error('Bot not found'), { code: 'BOT_NOT_FOUND', status: 404 });
    if (operationId) {
      if (record.operationId !== operationId || record.desiredStatus !== 'running') throw cancelledStart();
      return operationId;
    }
    const id = `start_${crypto.randomUUID()}`;
    registry[botKey] = { ...record, operationId: id, operationAction: 'start', desiredStatus: 'running' };
    saveMyBotsRegistry(registry, file);
    return id;
  });
}
export async function invalidateBotStartOperation(botKey, { root } = {}) {
  const file = registryFile(root);
  return withRegistryLock(file, () => {
    const registry = loadMyBotsRegistry(file);
    if (!registry[botKey]) return null;
    const id = `stop_${crypto.randomUUID()}`;
    registry[botKey] = { ...registry[botKey], operationId: id, operationAction: 'stop', desiredStatus: 'stopped' };
    saveMyBotsRegistry(registry, file);
    return id;
  });
}
export function isBotStartOperationCurrent(botKey, operationId, { root } = {}) {
  const record = loadMyBotsRegistry(registryFile(root))[botKey];
  return Boolean(record && record.operationId === operationId && record.desiredStatus === 'running');
}
export function withCurrentBotStartOperation(botKey, operationId, { root } = {}, callback) {
  return withRegistryLock(registryFile(root), () => {
    if (!isBotStartOperationCurrent(botKey, operationId, { root })) throw cancelledStart();
    return callback();
  });
}
