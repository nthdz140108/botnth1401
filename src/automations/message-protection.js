function normalizeResult(result, rule) {
  if (result && typeof result === "object") {
    return {
      handled: result.handled === true,
      rule: result.rule || rule.name,
      action: result.action || rule.action || null,
    };
  }

  return {
    handled: result === true,
    rule: rule.name,
    action: result === true ? rule.action || "handled" : null,
  };
}

export async function runMessageProtection({ context, rules, onError } = {}) {
  for (const rule of rules || []) {
    // Fast-path: skip rule evaluation if the rule is disabled for this context/group,
    // preserving exact evaluation order and zero side effects when disabled.
    if (typeof rule.enabled === "function") {
      try {
        if (!rule.enabled(context)) {
          continue;
        }
      } catch {
        // Fall through to run handler if check fails
      }
    } else if (rule.enabled !== undefined && !rule.enabled) {
      continue;
    }

    try {
      const result = normalizeResult(await rule.run(context), rule);
      if (result.handled) {
        return result;
      }
    } catch (error) {
      if (typeof onError === "function") {
        onError({ error, rule: rule.name, context });
      } else {
        console.error("[anti] rule failed", {
          threadId: context?.threadId,
          senderId: context?.senderId,
          msgType: context?.message?.data?.msgType,
          rule: rule.name,
          action: rule.action || null,
          error: error?.message || String(error),
        });
      }
    }
  }

  return { handled: false, rule: null, action: null };
}
