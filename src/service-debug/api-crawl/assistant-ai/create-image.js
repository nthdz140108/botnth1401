import { executeAiImageWorkflow } from "./image-generator-hf.js";
import { getGlobalPrefix } from "../../service.js";
import { removeMention } from "../../../utils/format-util.js";

export async function handleImageGeneration(api, message, aliasCommand, options = {}) {
  const prefix = getGlobalPrefix();
  const prompt = removeMention(message).replace(`${prefix}${aliasCommand}`, "").trim();
  return executeAiImageWorkflow({
    api,
    message,
    prompt,
    aliasCommand,
    isAdminLevelHighest: options?.isAdminLevelHighest,
  });
}