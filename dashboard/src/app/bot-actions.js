export const DELETE_CONFIRMATION = "DELETE_SELECTED_BOTS";

// After a lifecycle action the fleet is polled every 2s for up to 60s so the
// two-layer status (PM2 + readiness) settles. On expiry the last observed
// state is shown instead of a fake success.
export const LIFECYCLE_POLL_INTERVAL_MS = 2000;
export const LIFECYCLE_POLL_MAX_MS = 60000;
const LIFECYCLE_ACTIONS = new Set(["start", "stop", "restart"]);

export function createBotActions({ request, refresh = async () => {}, navigate = () => {}, confirmDelete } = {}) {
  const requestImpl = request || (() => { throw new Error("request is required"); });
  const confirmImpl = confirmDelete || (() => globalThis.prompt?.("Type DELETE_SELECTED_BOTS to confirm") || "");

  async function pollUntilSettled(botId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < LIFECYCLE_POLL_MAX_MS) {
      await new Promise((resolve) => setTimeout(resolve, LIFECYCLE_POLL_INTERVAL_MS));
      const snapshot = await refresh();
      const bot = (snapshot?.bots || snapshot?.data?.bots || []).find((item) => item.id === botId);
      if (bot) return bot;
      // Keep polling even if the bot row is missing — expiry shows last state.
    }
    return null;
  }

  async function single(botId, action, payload = {}) {
    const body = await withDeleteConfirmation(botId, action, payload);
    const result = await requestImpl(`/api/bots/${encodeURIComponent(botId)}/actions/${encodeURIComponent(action)}`, { method: "POST", body });
    await refresh();
    if (action === "delete") navigate("overview");
    if (LIFECYCLE_ACTIONS.has(action)) {
      // Fire-and-forget: UI keeps rendering the two-layer status while the
      // poll converges; expiry never fabricates success.
      pollUntilSettled(botId).catch(() => {});
    }
    return result;
  }

  async function bulk(action, botIds, payload = {}) {
    const ids = [...new Set((Array.isArray(botIds) ? botIds : []).filter(Boolean))];
    const body = { ...payload, action, botIds: ids };
    if (action === "delete") body.confirm = await requireDeleteConfirmation(ids, payload.confirm);
    const response = await requestImpl("/api/bots/actions/bulk", { method: "POST", body });
    await refresh();
    const data = response?.data || response || {};
    const results = Array.isArray(data.results) ? data.results : [];
    const successfulIds = results.filter((item) => item.success).map((item) => item.botId || item.id);
    const failedIds = results.filter((item) => !item.success).map((item) => item.botId || item.id);
    if (action === "delete" && !failedIds.length) navigate("overview");
    return { response, successfulIds, failedIds, results };
  }

  async function withDeleteConfirmation(botId, action, payload) {
    if (action !== "delete") return payload;
    return { ...payload, confirm: await requireDeleteConfirmation([botId], payload.confirm) };
  }

  async function requireDeleteConfirmation(ids, provided) {
    const value = provided || await confirmImpl(ids);
    if (value !== DELETE_CONFIRMATION) {
      const error = new Error("Delete confirmation is required");
      error.code = "DELETE_CONFIRMATION_REQUIRED";
      throw error;
    }
    return value;
  }

  return { single, bulk };
}
