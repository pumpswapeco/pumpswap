import type { Chunk, IndexData, ServerConfig } from "./types";
export declare class HybridRetriever {
    private index;
    private geminiBaseUrl;
    private geminiEmbedModel;
    private geminiApiKey;
    private chatModel;
    constructor(config: ServerConfig);
    loadIndex(): Promise<void>;
    ensureIndex(): Promise<void>;
    private reloadIndex;
    private embedContent;
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    private cosineSimilarity;
    retrieve(question: string, topK?: number): Promise<{
        chunks: Chunk[];
        questionEmbedding: number[];
    }>;
    getIndex(): IndexData | null;
    generateAnswer(question: string, contextChunks: Array<{
        text: string;
        metadata: {
            title: string;
            sourceUrl: string;
        };
    }>): Promise<{
        answer: string;
        citations: Array<{
            id: string;
            title: string;
            sourceUrl: string;
            snippet: string;
            relevance: number;
        }>;
        sourcesUsed: number;
        model: string;
        timestamp: string;
    }>;
}
export declare const retriever: HybridRetriever;
//# sourceMappingURL=rag.d.ts.map