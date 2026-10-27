"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retriever = exports.HybridRetriever = void 0;
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:fs/promises");
const config_1 = require("./config");
const sleep_1 = require("./utils/sleep");
function isFiniteNumberArray(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === "number" && Number.isFinite(item)));
}
const KEYWORD_BOOST_WEIGHT = 0.15;
const NEAR_DUPLICATE_OVERLAP = 0.5;
const TECHNICAL_TERMS = {
    "token-2022": 5,
    "token2022": 5,
    "spl token": 4,
    "token program": 3,
    "tokenkeg": 4,
    "tokenzqd": 4,
    "mint owner": 3,
    "mint": 2,
    "pda": 3,
    "vault": 3,
    "cpi": 3,
    "program-aware": 3,
    "extension": 3,
    "extensions": 3,
    "transfer hook": 4,
    "transfer hooks": 4,
    "confidential transfer": 4,
    "interest-bearing": 3,
    "transfer fee": 3,
    "non-transferable": 3,
    "permanent delegate": 3,
    "metadata": 2,
    "stak": 2,
    "unstak": 2,
    "reward": 2,
    "claim": 2,
    "devnet": 1,
    "mainnet": 1,
    "audit": 1,
};
const STOPWORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "do",
    "does",
    "for",
    "from",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "is",
    "it",
    "its",
    "may",
    "not",
    "no",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "was",
    "were",
    "will",
    "with",
    "you",
    "your",
]);
function normalizeText(text) {
    return text
        .toLowerCase()
        .replace(/<[^>]*>/g, " ")
        .replace(/[^a-z0-9\s-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function extractQueryTerms(question) {
    const normalized = normalizeText(question);
    const terms = [];
    const add = (term, weight) => {
        if (!terms.some((t) => t.term === term)) {
            terms.push({ term, weight });
        }
    };
    for (const [term, weight] of Object.entries(TECHNICAL_TERMS)) {
        if (term.includes(" ") && normalized.includes(term)) {
            add(term, weight);
        }
    }
    const contentWords = normalized
        .split(/\s+/)
        .filter((w) => w && !STOPWORDS.has(w));
    for (let i = 0; i < contentWords.length - 1; i++) {
        add(`${contentWords[i]} ${contentWords[i + 1]}`, 0.75);
    }
    for (const word of normalized.split(/\s+/)) {
        if (!word || STOPWORDS.has(word))
            continue;
        if (TECHNICAL_TERMS[word] !== undefined) {
            add(word, TECHNICAL_TERMS[word]);
            continue;
        }
        let stemmed = false;
        for (const [term, weight] of Object.entries(TECHNICAL_TERMS)) {
            if (!term.includes(" ") && word.startsWith(term)) {
                add(term, weight);
                stemmed = true;
                break;
            }
        }
        if (!stemmed && /^[a-z0-9]{3,}$/.test(word)) {
            add(word, 0.5);
        }
    }
    return terms;
}
function countOccurrences(text, term) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    let count = 0;
    while (re.test(text)) {
        count += 1;
        if (count >= 3)
            break;
    }
    return count;
}
function keywordScore(chunkText, terms) {
    const normalized = normalizeText(chunkText);
    let score = 0;
    for (const { term, weight } of terms) {
        const count = countOccurrences(normalized, term);
        if (count === 0) {
            continue;
        }
        score += weight * (1 + 0.4 * Math.min(count - 1, 2));
    }
    return score;
}
function chunkWords(text) {
    return new Set(normalizeText(text).split(/\s+/).filter(Boolean));
}
function textOverlap(a, b) {
    const wordsA = chunkWords(a);
    const wordsB = chunkWords(b);
    if (wordsA.size === 0 || wordsB.size === 0) {
        return 0;
    }
    let intersection = 0;
    for (const word of wordsA) {
        if (wordsB.has(word)) {
            intersection += 1;
        }
    }
    return intersection / Math.min(wordsA.size, wordsB.size);
}
class HybridRetriever {
    index = null;
    geminiBaseUrl;
    geminiEmbedModel;
    geminiApiKey;
    chatModel;
    constructor(config) {
        this.geminiBaseUrl = config.geminiBaseUrl.replace(/\/+$/, "");
        this.geminiEmbedModel = config.geminiEmbedModel;
        this.geminiApiKey = config.geminiApiKey;
        this.chatModel = config.chatModel;
    }
    async loadIndex() {
        try {
            const indexPath = node_path_1.default.resolve(config_1.config.indexPath);
            const raw = await (0, promises_1.readFile)(indexPath, "utf8");
            this.index = JSON.parse(raw);
            console.log(`[HybridRetriever] Loaded index with ${this.index.chunkCount} chunks`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Unknown index loading error";
            console.warn(`[HybridRetriever] Could not load index from ${config_1.config.indexPath}: ${message}`);
            this.index = null;
        }
    }
    async ensureIndex() {
        try {
            await this.reloadIndex();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Unknown index loading error";
            console.warn(`[HybridRetriever] Failed to load index for retrieval: ${message}`);
            throw new Error("Search index not available. Check that the documentation index exists.");
        }
    }
    async reloadIndex() {
        const indexPath = node_path_1.default.resolve(config_1.config.indexPath);
        const raw = await (0, promises_1.readFile)(indexPath, "utf8");
        this.index = JSON.parse(raw);
    }
    async embedContent(text, taskType) {
        const url = `${this.geminiBaseUrl}/models/` +
            `${encodeURIComponent(this.geminiEmbedModel)}:embedContent` +
            `?key=${encodeURIComponent(this.geminiApiKey)}`;
        const body = JSON.stringify({
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: 768,
        });
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body,
        });
        if (!resp.ok) {
            const bodyText = await resp.text();
            throw new Error(`Gemini embeddings API request failed (HTTP ${resp.status}): ${bodyText}`);
        }
        const payload = (await resp.json());
        if (!isFiniteNumberArray(payload.embedding?.values)) {
            throw new Error("Gemini embeddings API returned an invalid or missing embedding vector.");
        }
        return payload.embedding.values;
    }
    async embed(text) {
        return this.embedContent(text, "RETRIEVAL_QUERY");
    }
    async embedBatch(texts) {
        const embeddings = [];
        for (let i = 0; i < texts.length; i++) {
            embeddings.push(await this.embedContent(texts[i], "RETRIEVAL_QUERY"));
            if (i < texts.length - 1) {
                await (0, sleep_1.sleep)(150);
            }
        }
        return embeddings;
    }
    cosineSimilarity(a, b) {
        if (a.length !== b.length || a.length === 0) {
            return 0;
        }
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dot / denom : 0;
    }
    async retrieve(question, topK = 5) {
        if (!this.index || this.index.chunkCount === 0) {
            throw new Error("No index loaded. Check that the documentation index exists.");
        }
        const questionEmbedding = await this.embed(question);
        const terms = extractQueryTerms(question);
        const scored = this.index.chunks.map((chunk) => ({
            chunk,
            sim: this.cosineSimilarity(questionEmbedding, chunk.embedding),
            keywordBoost: keywordScore(chunk.text, terms),
            score: 0,
        }));
        for (const item of scored) {
            item.score =
                item.sim + KEYWORD_BOOST_WEIGHT * Math.log1p(item.keywordBoost);
        }
        scored.sort((a, b) => b.score - a.score || b.sim - a.sim);
        const docKey = (item) => item.chunk.metadata.slug || item.chunk.metadata.title;
        const selected = [];
        for (const item of scored) {
            if (selected.length >= topK) {
                break;
            }
            if (selected.some((s) => docKey(s) === docKey(item))) {
                continue;
            }
            selected.push(item);
        }
        for (const item of scored) {
            if (selected.length >= topK) {
                break;
            }
            if (selected.includes(item)) {
                continue;
            }
            const nearDuplicate = selected.some((s) => textOverlap(item.chunk.text, s.chunk.text) > NEAR_DUPLICATE_OVERLAP);
            if (nearDuplicate) {
                continue;
            }
            selected.push(item);
        }
        return {
            chunks: selected.map((item) => item.chunk),
            questionEmbedding,
        };
    }
    getIndex() {
        return this.index;
    }
    async generateAnswer(question, contextChunks) {
        if (contextChunks.length === 0) {
            return {
                answer: "I couldn't find relevant documentation to answer your question. Please try rephrasing it or ask about another topic.",
                citations: [],
                sourcesUsed: 0,
                model: this.chatModel,
                timestamp: new Date().toISOString(),
            };
        }
        const context = contextChunks
            .map((chunk) => `[Source: ${chunk.metadata.title}]\n${chunk.text}`)
            .join("\n\n---\n\n");
        const systemPrompt = `You are a Pumpswap documentation assistant. Answer questions using only the retrieved documentation context below.

Rules:
- Answer only from the provided documentation context.
- Cite factual claims using [Source: <title>] format.
- If the documentation does not contain enough information, say so clearly.
- Never invent protocol details, account addresses, security claims, or deployment status.
- Preserve technical distinctions between SPL Token and Token-2022.
- Be concise and accurate.

Context:
${context}`;
        const endpoint = `${this.geminiBaseUrl}/models/` +
            `${encodeURIComponent(this.chatModel)}:generateContent` +
            `?key=${encodeURIComponent(this.geminiApiKey)}`;
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [{ text: `${systemPrompt}\n\n${question}` }],
                    },
                ],
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini answer generation failed (HTTP ${response.status}): ${errorText}`);
        }
        const payload = (await response.json());
        const messageContent = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        let answer;
        if (typeof messageContent === "string") {
            answer = messageContent;
        }
        else {
            throw new Error("Gemini answer generation returned no usable answer content.");
        }
        const citations = contextChunks.map((chunk, index) => ({
            id: `c${index + 1}`,
            title: chunk.metadata.title,
            sourceUrl: chunk.metadata.sourceUrl,
            snippet: chunk.text.slice(0, 200) +
                (chunk.text.length > 200 ? "..." : ""),
            relevance: 1 / (index + 1),
        }));
        return {
            answer,
            citations,
            sourcesUsed: contextChunks.length,
            model: this.chatModel,
            timestamp: new Date().toISOString(),
        };
    }
}
exports.HybridRetriever = HybridRetriever;
exports.retriever = new HybridRetriever(config_1.config);
//# sourceMappingURL=rag.js.map