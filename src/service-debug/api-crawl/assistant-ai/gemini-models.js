export const DEFAULT_MODEL_PRIORITY = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-flash-latest",
];

export function getModelPriority(configuredModels = process.env.GEMINI_MODEL_PRIORITY) {
  const models = Array.isArray(configuredModels)
    ? configuredModels
    : String(configuredModels || "").split(",");
  const priority = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  return priority.length > 0 ? priority : [...DEFAULT_MODEL_PRIORITY];
}

export function isRetryableGeminiModelError(error) {
  return error?.status === 404 || error?.status === 429;
}

export async function generateContentWithModelFallback(models, generateContent) {
  let lastError;

  for (const model of models) {
    try {
      return { model, response: await generateContent(model) };
    } catch (error) {
      lastError = error;
      if (!isRetryableGeminiModelError(error)) throw error;
    }
  }

  throw lastError || new Error("No Gemini models configured");
}
