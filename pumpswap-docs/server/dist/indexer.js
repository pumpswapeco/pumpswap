"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocIndexer = void 0;
exports.splitIntoChunks = splitIntoChunks;
exports.main = main;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("./config");
const sleep_1 = require("./utils/sleep");
const EMBEDDING_DELAY_MS = 150;
const EMBEDDING_MAX_RETRIES = 3;
const EMBEDDING_TIMEOUT_MS = 30_000;
function isFiniteNumberArray(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === "number" && Number.isFinite(item)));
}
function vectorNorm(vector) {
    let sum = 0;
    for (const x of vector) {
        sum += x * x;
    }
    return Math.sqrt(sum);
}
async function generateEmbeddings(texts) {
    if (texts.length === 0) {
        return [];
    }
    const embeddings = [];
    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        const url = `${config_1.config.geminiBaseUrl}/models/${config_1.config.geminiEmbedModel}:embedContent?key=${config_1.config.geminiApiKey}`;
        const body = JSON.stringify({
            content: { parts: [{ text }] },
            embedContentConfig: {
                taskType: "RETRIEVAL_DOCUMENT",
                autoTruncate: true,
            },
        });
        let lastError = null;
        let success = false;
        for (let attempt = 0; attempt <= EMBEDDING_MAX_RETRIES; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
            try {
                const resp = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body,
                    signal: controller.signal,
                });
                if (resp.status === 429) {
                    const retryAfter = resp.headers.get("retry-after");
                    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : EMBEDDING_DELAY_MS * (attempt + 1);
                    if (attempt === EMBEDDING_MAX_RETRIES) {
                        throw new Error(`Gemini embeddings API quota exhausted (HTTP 429). Stopping indexing.`);
                    }
                    await (0, sleep_1.sleep)(Math.min(delay, 30000));
                    continue;
                }
                if (!resp.ok) {
                    const bodyText = await resp.text();
                    throw new Error(`Gemini embeddings API request failed (HTTP ${resp.status}): ${bodyText}`);
                }
                const payload = (await resp.json());
                if (!isFiniteNumberArray(payload.embedding?.values)) {
                    throw new Error("Gemini embeddings API returned an invalid or missing embedding vector.");
                }
                embeddings.push(payload.embedding.values);
                success = true;
                break;
            }
            catch (err) {
                lastError = err;
                if (err.name === "AbortError") {
                    break;
                }
                if (err.message.includes("HTTP 429") && attempt < EMBEDDING_MAX_RETRIES) {
                    continue;
                }
                break;
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        if (!success) {
            throw lastError
                ? lastError
                : new Error(`Gemini embeddings API failed for text index ${i}.`);
        }
        if (i < texts.length - 1) {
            await (0, sleep_1.sleep)(EMBEDDING_DELAY_MS);
        }
    }
    return embeddings;
}
function createChunk(title, text, headings, sourceUrl, slug, embedding) {
    const textToEmbed = `${title}\n${headings.map((h) => `${h.level}. ${h.text}`).join("\n")}\n${text}`;
    return {
        id: crypto_1.default.randomUUID(),
        text: textToEmbed,
        embedding,
        metadata: {
            title,
            slug,
            sourceUrl,
            headings: headings.map((h) => h.text),
            headingLevel: headings.length > 0 ? headings[0].level : 1,
        },
    };
}
function splitIntoChunks(title, fullText, headings, sourceUrl, slug, embedding) {
    const chunks = [];
    const maxChars = 1500;
    const overlap = 200;
    const docParts = fullText.split(/\n\n+/);
    let buffer = "";
    for (const part of docParts) {
        const partLines = part.split("\n");
        const isHeading = partLines.length > 0 && partLines[0].trim().startsWith("#");
        if (isHeading) {
            if (buffer.length > 0) {
                chunks.push(createChunk(title, buffer, headings, sourceUrl, slug, embedding));
                buffer = "";
                headings = [];
            }
            if (partLines[0].trim().length > 1) {
                headings.push({ text: partLines[0].trim(), level: 2 });
            }
        }
        else {
            buffer += (buffer ? "\n\n" : "") + part;
        }
        if (buffer.length >= maxChars) {
            chunks.push(createChunk(title, buffer, headings, sourceUrl, slug, embedding));
            buffer = buffer.slice(-overlap);
        }
    }
    if (buffer.length > 0) {
        chunks.push(createChunk(title, buffer, headings, sourceUrl, slug, embedding));
    }
    return chunks;
}
class DocIndexer {
    sourceDir;
    docExtension;
    constructor(sourceDir, docExtension = ".md") {
        this.sourceDir = path_1.default.resolve(sourceDir);
        this.docExtension = docExtension;
    }
    async index() {
        const files = this.readDocs();
        if (files.length === 0) {
            throw new Error(`[Indexer] No Markdown files found in source directory: ${this.sourceDir}. Refusing to write an empty index.`);
        }
        return this.indexFromFiles(files);
    }
    async indexFromFiles(files) {
        const chunks = [];
        let chunkIndex = 0;
        for (const file of files) {
            const title = file.title || path_1.default.basename(file.relativePath, path_1.default.extname(file.relativePath));
            const slug = `/docs/${file.relativePath.replace(/\.md$/, "")}`;
            const sourceUrl = `https://doc.pumpswap.biz${slug}`;
            const headings = file.headings || [];
            const fullText = this.concatContent(file);
            const chunksForFile = splitIntoChunks(title, fullText, headings, sourceUrl, slug, []);
            for (const chunk of chunksForFile) {
                chunk.id = `doc-${chunkIndex++}`;
                chunks.push(chunk);
            }
        }
        if (chunks.length === 0) {
            throw new Error(`[Indexer] Zero chunks were produced from the Markdown files in ${this.sourceDir}. Refusing to write an empty index.`);
        }
        console.log(`[Indexer] Generating real embeddings for ${chunks.length} chunks via Gemini (${config_1.config.geminiEmbedModel})...`);
        const embeddings = await generateEmbeddings(chunks.map((chunk) => chunk.text));
        if (embeddings.length !== chunks.length) {
            throw new Error(`[Indexer] Gemini returned ${embeddings.length} embeddings for ${chunks.length} chunks. Stopping indexing.`);
        }
        const expectedDimension = embeddings[0].length;
        for (let i = 0; i < chunks.length; i++) {
            const vector = embeddings[i];
            if (vector.length !== expectedDimension) {
                throw new Error(`[Indexer] Chunk ${chunks[i].id} has embedding dimension ${vector.length}, expected ${expectedDimension}. Stopping indexing.`);
            }
            if (vectorNorm(vector) === 0) {
                throw new Error(`[Indexer] Chunk ${chunks[i].id} received a zero embedding vector from Gemini. Stopping indexing.`);
            }
            chunks[i].embedding = vector;
        }
        const index = {
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            chunkCount: chunks.length,
            chunks,
            embeddingCount: chunks.length,
        };
        return index;
    }
    async buildAndSaveIndex() {
        console.log("[Indexer] Reading documentation files...");
        const files = this.readDocs();
        if (files.length === 0) {
            throw new Error(`[Indexer] No Markdown files found in source directory: ${this.sourceDir}. Refusing to write an empty index.`);
        }
        console.log(`[Indexer] Found ${files.length} Markdown file(s) in ${this.sourceDir}`);
        const index = await this.indexFromFiles(files);
        console.log("[Indexer] Validating chunks...");
        for (const chunk of index.chunks) {
            if (chunk.embedding.length === 0) {
                throw new Error(`Chunk ${chunk.id} has no embedding. Run 'pnpm index' to generate embeddings with the Gemini API.`);
            }
        }
        console.log("[Indexer] Saving index to disk...");
        const indexPath = path_1.default.isAbsolute(config_1.config.indexPath)
            ? config_1.config.indexPath
            : path_1.default.resolve(__dirname, "..", config_1.config.indexPath);
        const dir = path_1.default.dirname(indexPath);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        await this.writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
        console.log(`[Indexer] Index saved to ${indexPath}`);
        console.log(`[Indexer] Summary: ${files.length} Markdown file(s), ${index.chunkCount} chunks, ${index.embeddingCount} embeddings, output path: ${indexPath}`);
        return index;
    }
    async writeFileAtomic(targetPath, content) {
        const tmpPath = path_1.default.join(path_1.default.dirname(targetPath), `.index-${process.pid}-${Date.now()}.tmp`);
        try {
            await fs_1.default.promises.writeFile(tmpPath, content, "utf-8");
            await fs_1.default.promises.rename(tmpPath, targetPath);
        }
        catch (err) {
            try {
                await fs_1.default.promises.unlink(tmpPath);
            }
            catch {
            }
            throw err;
        }
    }
    readDocs() {
        const files = [];
        this.walkDir(this.sourceDir, "", files);
        return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }
    walkDir(dir, relPath, files) {
        let entries = [];
        try {
            entries = fs_1.default.readdirSync(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path_1.default.join(dir, entry);
            const rel = relPath ? `${relPath}/${entry}` : entry;
            const stat = fs_1.default.statSync(fullPath);
            if (stat.isDirectory()) {
                this.walkDir(fullPath, rel, files);
            }
            else if (stat.isFile() && entry.endsWith(this.docExtension)) {
                try {
                    const content = fs_1.default.readFileSync(fullPath, "utf-8");
                    const doc = this.parseMarkdown(content, fullPath, rel);
                    files.push(doc);
                }
                catch (err) {
                    console.warn(`[Indexer] Skipping ${rel}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    }
    parseMarkdown(content, filepath, relPath) {
        const lines = content.split("\n");
        let inFrontmatter = true;
        let frontmatterEnd = -1;
        const frontmatter = {};
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (inFrontmatter) {
                if (line.trim() === "---") {
                    if (frontmatterEnd === -1) {
                        frontmatterEnd = i;
                    }
                    else {
                        inFrontmatter = false;
                    }
                }
                else if (line.startsWith("title:")) {
                    frontmatter.title = line.replace("title:", "").trim().replace(/^["']|["']$/g, "");
                }
                else if (line.startsWith("description:")) {
                    frontmatter.description = line.replace("description:", "").trim().replace(/^["']|["']$/g, "");
                }
            }
        }
        const contentLines = inFrontmatter ? lines.slice(frontmatterEnd + 1) : lines;
        const headings = this.extractHeadings(contentLines);
        const htmlContent = this.markdownToHtml(contentLines);
        return {
            filepath,
            relativePath: relPath,
            title: frontmatter.title || "",
            description: frontmatter.description || "",
            headings,
            content: htmlContent,
        };
    }
    extractHeadings(lines) {
        const headings = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#") && trimmed.length > 1) {
                const level = (trimmed.match(/^#+/)?.[0].length || 1);
                const text = trimmed.replace(/^#+\s*/, "");
                headings.push({ text, level });
            }
        }
        return headings;
    }
    markdownToHtml(lines) {
        return lines.map((line) => this.inlineHtml(line)).join("\n");
    }
    inlineHtml(line) {
        let html = line;
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/^[*-] /gm, "<li>");
        html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
        html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
        html = html.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
        return html;
    }
    concatContent(file) {
        const parts = [];
        if (file.description) {
            parts.push(file.description);
        }
        if (file.headings && file.headings.length > 0) {
            for (const h of file.headings) {
                parts.push(`<h${h.level}>${h.text}</h${h.level}>`);
            }
        }
        parts.push(file.content);
        return parts.join("\n\n");
    }
}
exports.DocIndexer = DocIndexer;
async function main(docsDir) {
    const serverDir = path_1.default.resolve(__dirname, "..");
    const resolvedDocsDir = docsDir ? path_1.default.resolve(docsDir) : path_1.default.resolve(serverDir, "..", "docs");
    const indexer = new DocIndexer(resolvedDocsDir);
    return indexer.buildAndSaveIndex();
}
const isMainModule = process.argv[1] !== undefined &&
    path_1.default.resolve(process.argv[1]).toLowerCase() === path_1.default.resolve(__filename).toLowerCase();
if (isMainModule) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Indexer] Failed: ${message}`);
        process.exit(1);
    });
}
//# sourceMappingURL=indexer.js.map