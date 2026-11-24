import { LRUCache } from "lru-cache";
import { renderTemplate } from "../dashboard/command-response-template.js";
import {
  isWithinSchedule,
  evaluateRestrictions,
  resolveCooldownSeconds,
  cooldownBucket,
  checkHourlyLimit,
} from "./command-behavior-runtime.js";

const RESULT_TO_TEMPLATE = {
  KILL_SWITCH_ACTIVE: "onKillSwitch",
  SCOPE_DENIED: "onScopeDenied",
  PERMISSION_DENIED: "onPermissionDenied",
};

export function getBehaviorForCommand(commandPolicy) {
  const behavior = commandPolicy?.behavior;
  return behavior && typeof behavior === "object" ? behavior : null;
}

export function evaluateBehaviorGate({ behavior, threadId, senderId, now = new Date() }) {
  if (!behavior) return { code: "OK" };
  if (behavior.operation?.killSwitch === true) return { code: "KILL_SWITCH_ACTIVE" };
  if (!isWithinSchedule(now, behavior.operation?.scheduleWindows)) return { code: "OUT_OF_SCHEDULE" };
  const verdict = evaluateRestrictions(behavior, { threadId, senderId });
  if (!verdict.allowed) return { code: verdict.reason };
  return { code: "OK" };
}

export class CooldownLedger {
  constructor({ max = 5000, ttl = 60 * 60 * 1000 } = {}) {
    this.usage = new LRUCache({ max, ttl });
  }

  consume({ behavior, fallbackCountdownSeconds, userId, threadId, now = Date.now() }) {
    const mode = behavior?.operation?.cooldownMode || "perUser";
    const bucket = cooldownBucket(mode, { userId, threadId });
    const seconds = resolveCooldownSeconds(behavior, fallbackCountdownSeconds);
    const existing = this.usage.get(bucket);
    const history = Array.isArray(existing) ? [...existing] : [];
    if (seconds > 0) {
      const lastAt = history.length ? Math.max(...history) : 0;
      const remainingMs = lastAt + seconds * 1000 - now;
      if (remainingMs > 0) {
        return { allowed: false, remainingSeconds: Math.ceil(remainingMs / 1000) };
      }
    }
    const limit = Number(behavior?.operation?.maxUsesPerHour || 0);
    const hourly = checkHourlyLimit(history, limit, now);
    if (!hourly.allowed) {
      return { allowed: false, remainingSeconds: Math.ceil(hourly.oldestRemainingMs / 1000), reasonCode: "MAX_USES_PER_HOUR" };
    }
    history.push(now);
    const filtered = history.filter((ts) => ts > now - 60 * 60 * 1000);
    if (filtered.length === 0) {
      this.usage.delete(bucket);
    } else {
      this.usage.set(bucket, filtered);
    }
    return { allowed: true, remainingSeconds: 0 };
  }

  prune(now = Date.now()) {
    const cutoff = now - 60 * 60 * 1000;
    for (const [bucket, history] of this.usage.entries()) {
      const filtered = (history || []).filter((ts) => ts > cutoff);
      if (filtered.length === 0) {
        this.usage.delete(bucket);
      } else {
        this.usage.set(bucket, filtered);
      }
    }
  }

  clear() {
    this.usage.clear();
  }
}

export function renderBehaviorMessage(behavior, code, vars) {
  if (!behavior?.responses?.useCustomTemplates) return null;
  const key = RESULT_TO_TEMPLATE[code] || code;
  const template = behavior.responses.templates?.[uncapitalize(key)];
  return renderTemplate(template, vars);
}

export function buildTemplateVars({ prefix, command, user, userId, thread, remaining, reason, behavior } = {}) {
  const params = {};
  const items = Array.isArray(behavior?.params?.items) ? behavior.params.items : [];
  for (const item of items) {
    const key = String(item?.key ?? "").trim();
    if (!key) continue;
    params[key] = item?.value ?? item?.defaultValue ?? "";
  }
  return { prefix, command, user, userId, thread, remaining, reason, params };
}

function uncapitalize(value) {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}
