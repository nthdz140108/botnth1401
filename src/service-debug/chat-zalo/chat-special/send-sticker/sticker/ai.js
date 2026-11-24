/**
 * Sticker AI Module — Powered by Hugging Face Inference API
 *
 * Models:
 * - Text-to-Image (T2I): black-forest-labs/FLUX.1-schnell
 * - Image-to-Image (I2I): Qwen/Qwen-Image-Edit-2509
 *
 * Gemini Web broker is completely removed from the sticker pipeline.
 */

import {
  generateStickerImageHF,
  hasHuggingFaceConfig,
  getHuggingFaceConfig,
  HfInferenceError,
  __test as __hfTest,
} from "./hf.js";

export { hasHuggingFaceConfig, getHuggingFaceConfig, HfInferenceError };

export async function generateStickerImage({ prompt, referenceBuffer, referenceMimeType }) {
  const result = await generateStickerImageHF({
    prompt,
    referenceBuffer,
    referenceMimeType,
  });

  return {
    imageBuffer: result.imageBuffer,
    mimeType: result.mimeType,
    provider: result.provider,
    model: result.model,
    filePath: null,
    jobId: null,
  };
}

export async function deleteBrokerJob(_jobId) {
  // No-op: Hugging Face inference does not require broker job deletion
}

export function hasGeminiConfig() {
  // Alias for backward compatibility if probed
  return hasHuggingFaceConfig();
}

export const __test = {
  ...__hfTest,
};