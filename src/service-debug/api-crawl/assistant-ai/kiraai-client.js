import axios from "axios";

const DEFAULT_BASE_URL = "https://kiraai.vn/api/v1";
const DEFAULT_MODEL = "kira-auto";
const DEFAULT_TIMEOUT_MS = 30000;

let cachedBaseUrl = null;
let cachedModel = null;
let cachedTimeoutMs = null;

function resolveBaseUrl() {
  if (cachedBaseUrl !== null) return cachedBaseUrl;
  const value = process.env.KIRA_BASE_URL;
  cachedBaseUrl = typeof value === "string" && value.trim().length > 0
    ? value.trim().replace(/\/+$/, "")
    : DEFAULT_BASE_URL;
  return cachedBaseUrl;
}

function resolveModel() {
  if (cachedModel !== null) return cachedModel;
  const value = process.env.KIRA_MODEL;
  cachedModel = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_MODEL;
  return cachedModel;
}

function resolveTimeoutMs() {
  if (cachedTimeoutMs !== null) return cachedTimeoutMs;
  const raw = process.env.KIRA_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  cachedTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
  return cachedTimeoutMs;
}

export function resetKiraAiConfigCache() {
  cachedBaseUrl = null;
  cachedModel = null;
  cachedTimeoutMs = null;
}

export function getKiraAiConfig() {
  return Object.freeze({
    apiKey: process.env.KIRA_API_KEY || "",
    baseUrl: resolveBaseUrl(),
    model: resolveModel(),
    timeoutMs: resolveTimeoutMs(),
  });
}

export function isKiraAiConfigured() {
  return typeof process.env.KIRA_API_KEY === "string" && process.env.KIRA_API_KEY.trim().length > 0;
}

function sanitizeError(error, providerLabel = "KiraAI") {
  if (!error) return new Error(`${providerLabel} request failed`);
  if (error.code === "INVALID_RESPONSE" || error.code === "MISSING_API_KEY" || error.code === "INVALID_INPUT") {
    return error;
  }
  if (error.response) {
    const status = error.response.status;
    const message = error.response.data?.error?.message || error.response.data?.message;
    const wrapped = new Error(`${providerLabel} HTTP ${status}${message ? `: ${String(message).slice(0, 200)}` : ""}`);
    wrapped.code = `HTTP_${status}`;
    wrapped.status = status;
    return wrapped;
  }
  if (error.code === "ECONNABORTED" || error.message?.includes("timeout")) {
    const wrapped = new Error(`${providerLabel} request timed out`);
    wrapped.code = "TIMEOUT";
    return wrapped;
  }
  const wrapped = new Error(`${providerLabel} request failed`);
  wrapped.code = error.code || "NETWORK_ERROR";
  return wrapped;
}

export async function callKiraAiChat(question, options = {}) {
  if (!isKiraAiConfigured()) {
    const error = new Error("KIRA_API_KEY is not configured");
    error.code = "MISSING_API_KEY";
    throw error;
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    const error = new Error("Question must be a non-empty string");
    error.code = "INVALID_INPUT";
    throw error;
  }

  const baseUrl = options.baseUrl || resolveBaseUrl();
  const model = options.model || resolveModel();
  const timeoutMs = options.timeoutMs || resolveTimeoutMs();
  const apiKey = process.env.KIRA_API_KEY;

  try {
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages: [{ role: "user", content: question }],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      },
    );

    const content = response?.data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      const error = new Error("KiraAI response missing choices[0].message.content");
      error.code = "INVALID_RESPONSE";
      throw error;
    }
    return content;
  } catch (error) {
    if (error?.code === "INVALID_RESPONSE") {
      throw sanitizeError(error);
    }
    throw sanitizeError(error);
  }
}

export async function callOpenAiCompatibleChat({
  messages,
  apiKey,
  baseUrl,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  providerLabel = "OpenAI-Compatible",
} = {}) {
  const cleanKey = String(apiKey || "").trim();
  if (!cleanKey) {
    const error = new Error(`${providerLabel} API key is not configured`);
    error.code = "MISSING_API_KEY";
    throw error;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new Error("Messages must be a non-empty array");
    error.code = "INVALID_INPUT";
    throw error;
  }

  const cleanBaseUrl = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const cleanModel = String(model || DEFAULT_MODEL).trim();

  try {
    const response = await axios.post(
      `${cleanBaseUrl}/chat/completions`,
      {
        model: cleanModel,
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${cleanKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      },
    );

    const content = response?.data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      const error = new Error(`${providerLabel} response missing choices[0].message.content`);
      error.code = "INVALID_RESPONSE";
      throw error;
    }
    return content.trim();
  } catch (error) {
    throw sanitizeError(error, providerLabel);
  }
}
