import { executeAiImageWorkflow } from "./image-generator-hf.js";
import { getGlobalPrefix } from "../../service.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";

export async function handleImageGeneration(api, message, aliasCommand = "createimageai", options = {}) {
  const prefix = getGlobalPrefix();
  const prompt = extractCommandBody(message, prefix, aliasCommand || "createimageai");
  return executeAiImageWorkflow({
    api,
    message,
    prompt,
    aliasCommand,
    isAdminLevelHighest: options?.isAdminLevelHighest,
    mode: "photo",
  });
}
