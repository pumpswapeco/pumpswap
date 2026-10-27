import dotenv from "dotenv";
import path from "path";
import type { ConfigValidationError, ServerConfig } from "./types";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export const REQUIRED_ENV_VARS = [
  "GEMINI_API_KEY",
  "GEMINI_EMBED_MODEL",
  "INDEX_PATH",
] as const;

export type EnvVarName = (typeof REQUIRED_ENV_VARS)[number];

export function validateConfig(): ConfigValidationError | null {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    if (!process.env[name]) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      name: "ConfigValidationError",
      message: `Missing required environment variables: ${missing.join(", ")}`,
      details: missing,
    };
  }
  return null;
}

export function getConfig(): ServerConfig {
  const validationError = validateConfig();
  if (validationError) {
    throw validationError;
  }

  const port = parseInt(process.env.PORT || "3000", 10);
  const geminiBaseUrl = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
  const geminiApiKey = process.env.GEMINI_API_KEY || "";
  const geminiEmbedModel = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
  const chatModel = process.env.GEMINI_CHAT_MODEL || "gemini-1.5-flash";
  const indexPath = path.resolve(__dirname, "..", process.env.INDEX_PATH || "public/index.json");
  const authSecret = process.env.AUTH_SECRET || "dev-only-secret-change-me";
  const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10);
  const rateLimitMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60", 10);
  const maxResponseSizeBytes = parseInt(
    process.env.MAX_RESPONSE_SIZE_BYTES || "52428800",
    10
  );
  const allowOrigins = process.env.ALLOW_ORIGINS || "*";

  return {
    port,
    geminiBaseUrl,
    geminiApiKey,
    geminiEmbedModel,
    chatModel,
    indexPath,
    authSecret,
    rateLimitWindowMs,
    rateLimitMaxRequests,
    maxResponseSizeBytes,
    allowOrigins,
  };
}

export const config = getConfig();