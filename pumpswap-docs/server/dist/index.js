"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const config_1 = require("./config");
const rag_1 = require("./rag");
const rateLimiter_1 = require("./rateLimiter");
const app = (0, express_1.default)();
const rawAllowOrigins = config_1.config.allowOrigins;
const allowOrigins = Array.isArray(rawAllowOrigins)
    ? rawAllowOrigins
    : String(rawAllowOrigins)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
app.use((0, cors_1.default)({ origin: allowOrigins.length > 0 ? allowOrigins : "*" }));
function sanitizeError(err) {
    const apiKey = config_1.config.geminiApiKey;
    const redact = (input) => {
        let result = input;
        if (apiKey && apiKey.length > 0) {
            result = result.split(apiKey).join("[REDACTED]");
        }
        result = result.replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]");
        result = result.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
        return result;
    };
    if (err instanceof Error) {
        return {
            message: redact(err.message),
            stack: err.stack ? redact(err.stack) : undefined,
        };
    }
    return { message: redact(String(err)) };
}
app.use(express_1.default.json({ limit: "1mb" }));
const rateLimitMiddleware = (req, res, next) => {
    const key = req.ip ?? "unknown";
    const { allowed, remaining, resetTime } = rateLimiter_1.rateLimiter.isAllowed(key);
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetTime));
    if (!allowed) {
        return res.status(429).json({ error: "Too many requests. Please try again later." });
    }
    next();
};
app.get("/health", (_req, res) => {
    const index = rag_1.retriever.getIndex();
    res.status(200).json({
        status: "ok",
        indexLoaded: index !== null,
        chunkCount: index ? index.chunkCount : 0,
    });
});
app.post("/api/chat", rateLimitMiddleware, async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== "string" || message.trim().length === 0) {
        return res.status(400).json({ error: "A non-empty 'message' field is required." });
    }
    try {
        await rag_1.retriever.ensureIndex();
        const { chunks } = await rag_1.retriever.retrieve(message);
        const result = await rag_1.retriever.generateAnswer(message, chunks);
        return res.status(200).json(result);
    }
    catch (err) {
        const safe = sanitizeError(err);
        console.error("[/api/chat] Error:", safe.message);
        if (safe.stack) {
            console.error("[/api/chat] Stack:", safe.stack);
        }
        const msg = safe.message;
        if (msg.includes("index not available") ||
            msg.includes("No index loaded") ||
            msg.includes("Run 'pnpm index'")) {
            return res.status(503).json({
                error: "Search index not available. Run 'pnpm index' to build it, then restart the server.",
            });
        }
        return res.status(500).json({ error: "Internal server error." });
    }
});
app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
});
app.use((err, _req, res, _next) => {
    const safe = sanitizeError(err);
    console.error("[Server] Unhandled error:", safe.message);
    if (safe.stack) {
        console.error("[Server] Stack:", safe.stack);
    }
    res.status(500).json({ error: "Internal server error." });
});
let server = null;
async function main() {
    try {
        await rag_1.retriever.loadIndex();
        const index = rag_1.retriever.getIndex();
        console.log(`[Server] Search index ready: ${index ? index.chunkCount : 0} chunks (${index ? index.embeddingCount : 0} embeddings)`);
    }
    catch (err) {
        console.warn(`[Server] Could not load search index on startup: ${err.message}`);
    }
    server = app.listen(config_1.config.port, () => {
        console.log(`[Server] Pumpswap docs AI search listening on :${config_1.config.port}`);
    });
}
main().catch((err) => {
    console.error("[Server] Fatal startup error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
});
process.on("SIGTERM", () => {
    console.log("[Server] SIGTERM received, shutting down gracefully");
    if (server)
        server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
    console.log("[Server] SIGINT received, shutting down gracefully");
    if (server)
        server.close(() => process.exit(0));
});
exports.default = app;
//# sourceMappingURL=index.js.map