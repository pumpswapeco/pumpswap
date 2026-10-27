export interface ServerConfig {
    port: number;
    geminiBaseUrl: string;
    geminiApiKey: string;
    geminiEmbedModel: string;
    chatModel: string;
    indexPath: string;
    authSecret: string;
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
    maxResponseSizeBytes: number;
    allowOrigins: string[];
}
export interface Chunk {
    id: string;
    text: string;
    embedding: number[];
    metadata: {
        title: string;
        slug: string;
        sourceUrl: string;
        headings: string[];
        headingLevel: number;
    };
}
export interface IndexData {
    version: number;
    createdAt: string;
    updatedAt: string;
    chunkCount: number;
    chunks: Chunk[];
    embeddingCount: number;
}
export interface ChatRequest {
    message: string;
    sessionId?: string;
}
export interface ChatResponse {
    answer: string;
    citations: Citation[];
    sourcesUsed: number;
    model: string;
    timestamp: string;
}
export interface Citation {
    id: string;
    title: string;
    sourceUrl: string;
    snippet: string;
    relevance: number;
}
export interface RetryConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    backoffFactor: number;
}
export interface RateLimitState {
    count: number;
    windowStart: number;
    lastReset: number;
}
export interface ConfigValidationError extends Error {
    details: string[];
}
//# sourceMappingURL=types.d.ts.map