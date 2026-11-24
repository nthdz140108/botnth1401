import sharp from "sharp";
import {
  createBlockSpamImage,
  createWelcomeImage,
  createGoodbyeImage,
  createKickImage,
} from "../utils/canvas/event-image.js";

if (typeof sharp?.cache === "function") sharp.cache(false);
if (typeof sharp?.concurrency === "function") sharp.concurrency(1);

process.on("disconnect", () => {
  process.exit(0);
});

process.on("message", async (msg) => {
  const { taskId, type, data } = msg || {};
  if (!taskId) return;

  try {
    if (type === "blockSpam") {
      const { userInfo, groupName, groupType, gender } = data || {};
      const imagePath = await createBlockSpamImage(userInfo, groupName, groupType, gender);
      process.send?.({ taskId, success: true, result: { imagePath } });
      return;
    }

    if (type === "welcome") {
      const { userInfo, groupName, groupType, userActionName, isAdmin } = data || {};
      const imagePath = await createWelcomeImage(userInfo, groupName, groupType, userActionName, isAdmin);
      process.send?.({ taskId, success: true, result: { imagePath } });
      return;
    }

    if (type === "goodbye") {
      const { userInfo, groupName, groupType, isAdmin } = data || {};
      const imagePath = await createGoodbyeImage(userInfo, groupName, groupType, isAdmin);
      process.send?.({ taskId, success: true, result: { imagePath } });
      return;
    }

    if (type === "kick") {
      const { userInfo, groupName, groupType, gender, userActionName, isAdmin } = data || {};
      const imagePath = await createKickImage(userInfo, groupName, groupType, gender, userActionName, isAdmin);
      process.send?.({ taskId, success: true, result: { imagePath } });
      return;
    }

    if (type === "ping") {
      process.send?.({ taskId, success: true, result: "pong" });
      return;
    }

    process.send?.({ taskId, success: false, error: `Unknown canvas task type: ${type}` });
  } catch (error) {
    process.send?.({
      taskId,
      success: false,
      error: error?.message || String(error),
    });
  }
});
