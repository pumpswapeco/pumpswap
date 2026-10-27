"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = exports.REQUIRED_ENV_VARS = void 0;
exports.validateConfig = validateConfig;
exports.getConfig = getConfig;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "..", ".env") });
exports.REQUIRED_ENV_VARS = [
    "GEMINI_API_KEY",
    "GEMINI_EMBED_MODEL",
    "INDEX_PATH",
];
function validateConfig() {
    const missing = [];
    for (const name of exports.REQUIRED_ENV_VARS) {
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
function getConfig() {
    const validationError = validateConfig();
    if (validationError) {
        throw validationError;
    }
    const port = parseInt(process.env.PORT || "3000", 10);
    const geminiBaseUrl = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
    const geminiApiKey = process.env.GEMINI_API_KEY || "";
    const geminiEmbedModel = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
    const chatModel = process.env.GEMINI_CHAT_MODEL || "gemini-1.5-flash";
    const indexPath = path_1.default.resolve(__dirname, "..", process.env.INDEX_PATH || "public/index.json");
    const authSecret = process.env.AUTH_SECRET || "dev-only-secret-change-me";
    const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10);
    const rateLimitMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60", 10);
    const maxResponseSizeBytes = parseInt(process.env.MAX_RESPONSE_SIZE_BYTES || "52428800", 10);
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
exports.config = getConfig();
//# sourceMappingURL=config.js.map