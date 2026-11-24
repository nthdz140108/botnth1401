function getPrompt(message, prefix, removeMentionFn) {
  const content = removeMentionFn(message).trim();
  return content.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*(?:gemini\\s+make|create-image|createimg)\\b`, "i"), "").trim();
}

export async function handleGeminiMakeCommand({ api, message, isAdminLevelHighest = false, aliasCommand = "gemini make" }) {
  const [{ executeAiImageWorkflow }, { getGlobalPrefix }, { removeMention }] = await Promise.all([
    import("../service-debug/api-crawl/assistant-ai/image-generator-hf.js"),
    import("../service-debug/service.js"),
    import("../utils/format-util.js"),
  ]);
  const prefix = getGlobalPrefix();
  const prompt = getPrompt(message, prefix, removeMention);
  return executeAiImageWorkflow({
    api,
    message,
    prompt,
    aliasCommand,
    isAdminLevelHighest,
  });
}