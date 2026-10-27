import express, { Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import { config } from "./config";
import { retriever } from "./rag";
import { rateLimiter } from "./rateLimiter";
import type { ChatRequest } from "./types";

/**
 * Pumpswap documentation AI search service entry point.
 *
 * Restores the Express server that exposes the documentation search index built
 * by `pnpm index` (stored in public/index.json). Embeddings are loaded from the
 * existing index and are never regenerated here. The Gemini API key stays
 * server-side (inside rag.ts) and is never logged or returned to clients.
 */
const app: Express = express();

// --- CORS ---------------------------------------------------------------
// Config normalizes ALLOW_ORIGINS into a trimmed, non-empty string[]
// (default ["*"]). Fall back to allowing all origins when the list is empty.
const allowOrigins = config.allowOrigins.length > 0 ? config.allowOrigins : ["*"];
app.use(cors({ origin: allowOrigins }));

// --- Safe error logging ---------------------------------------------------
// Logs the error message and stack trace to the server terminal for diagnosis,
// while redacting the Gemini API key and any Authorization/Bearer values so
// secrets are never printed to stdout/stderr.
function sanitizeError(err: unknown): { message: string; stack?: string } {
  const apiKey = config.geminiApiKey;
  const redact = (input: string): string => {
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

// --- Body parsing --------------------------------------------------------
app.use(express.json({ limit: "1mb" }));

// --- Rate limiting (applied to stateful/chat routes) ---------------------
const rateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? "unknown";
  const { allowed, remaining, resetTime } = rateLimiter.isAllowed(key);
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(resetTime));
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }
  next();
};

// --- Health --------------------------------------------------------------
app.get("/health", (_req: Request, res: Response) => {
  const index = retriever.getIndex();
  res.status(200).json({
    status: "ok",
    indexLoaded: index !== null,
    chunkCount: index ? index.chunkCount : 0,
  });
});

// --- Chat ----------------------------------------------------------------
// POST /api/chat  { "message": "..." }
// Returns { answer, citations, sourcesUsed, model, timestamp } (ChatResponse).
app.post("/api/chat", rateLimitMiddleware, async (req: Request, res: Response) => {
  const { message } = req.body as ChatRequest;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "A non-empty 'message' field is required." });
  }

  try {
    // (Re)load the existing index from disk; embeddings are not regenerated.
    await retriever.ensureIndex();

    const { chunks } = await retriever.retrieve(message);
    const result = await retriever.generateAnswer(message, chunks);

    return res.status(200).json(result);
  } catch (err: unknown) {
    const safe = sanitizeError(err);
    console.error("[/api/chat] Error:", safe.message);
    if (safe.stack) {
      console.error("[/api/chat] Stack:", safe.stack);
    }
    const msg = safe.message;
    if (
      msg.includes("index not available") ||
      msg.includes("No index loaded") ||
      msg.includes("Run 'pnpm index'")
    ) {
      return res.status(503).json({
        error: "Search index not available. Run 'pnpm index' to build it, then restart the server.",
      });
    }
    // Never surface the Gemini API key or internal stack details to the client.
    return res.status(500).json({ error: "Internal server error." });
  }
});

// --- 404 ----------------------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// --- Global error handler -----------------------------------------------
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const safe = sanitizeError(err);
  console.error("[Server] Unhandled error:", safe.message);
  if (safe.stack) {
    console.error("[Server] Stack:", safe.stack);
  }
  res.status(500).json({ error: "Internal server error." });
});

let server: ReturnType<typeof app.listen> | null = null;

async function main(): Promise<void> {
  // Load and validate the existing search index on startup.
  // Do not regenerate embeddings; fail gracefully if the index is absent.
  try {
    await retriever.loadIndex();
    const index = retriever.getIndex();
    console.log(
      `[Server] Search index ready: ${index ? index.chunkCount : 0} chunks (${index ? index.embeddingCount : 0} embeddings)`
    );
  } catch (err: any) {
    console.warn(`[Server] Could not load search index on startup: ${err.message}`);
  }

  server = app.listen(config.port, () => {
    console.log(`[Server] Pumpswap docs AI search listening on :${config.port}`);
  });
}

main().catch((err: unknown) => {
  console.error(
    "[Server] Fatal startup error:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received, shutting down gracefully");
  if (server) server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("[Server] SIGINT received, shutting down gracefully");
  if (server) server.close(() => process.exit(0));
});

export default app;

