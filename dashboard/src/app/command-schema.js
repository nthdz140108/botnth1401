import { apiRequest } from "./api.js";

let cache = null;

export async function fetchBehaviorSchema({ force = false } = {}) {
  if (cache && !force) return cache;
  const result = await apiRequest("/api/commands/behavior-schema");
  cache = result.data || result;
  return cache;
}
