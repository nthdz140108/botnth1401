import { GoogleGenAI, Modality } from "@google/genai";

export async function generateImage(prompt) {
  const apiKey = String(process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "")
    .split(",")
    .map((key) => key.trim())
    .find(Boolean);
  if (!apiKey) {
    const error = new Error("GEMINI_API_KEYS is not configured");
    error.code = "MISSING_DEPENDENCY";
    throw error;
  }

  const ai = new GoogleGenAI({
    apiKey,
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash-preview-image-generation",
    contents: prompt,
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  let imageBuffer = null;
  let text = "";

  for (const part of response.candidates[0].content.parts) {
    if (part.text) text = part.text;
    if (part.inlineData) imageBuffer = Buffer.from(part.inlineData.data, "base64");
  }

  return { text, imageBuffer };
}
