import { handleReactionConfirmJoinGroup } from "../commands/bot-manager/remote-action-group.js";
import { handleTikTokReaction } from "../service-debug/api-crawl/tiktok/tiktok-service.js";
import { handleReactionConfirmAutoJoin } from "../service-debug/anti-service/auto-join.js";
import { handleLocmemReaction, trackLocmemReaction } from "../service-debug/locmem/index.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";

// Xử lý sự kiện reaction
export async function reactionEvents(api, reaction, context = {}) {
  const runtimeContext = context?.runtimeContext || getRuntimeContext();
  try {
    trackLocmemReaction(api, reaction, runtimeContext);
  } catch (err) {
    console.error("[locmem] trackLocmemReaction error:", err);
  }
  if (await handleLocmemReaction(api, reaction, { ...context, runtimeContext })) return;
  if (await handleReactionConfirmJoinGroup(api, reaction)) return;
  if (await handleTikTokReaction(api, reaction)) return;
  if (await handleReactionConfirmAutoJoin(api, reaction)) return;
}
