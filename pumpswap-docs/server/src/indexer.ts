import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "./config";
import type { Chunk, IndexData } from "./types";
import { sleep } from "./utils/sleep";

// Gemini embedContent supports one content per REST call; process sequentially with a delay.
const EMBEDDING_DELAY_MS = 150;
const EMBEDDING_MAX_RETRIES = 3;
// Per-request abort timeout for Gemini embedding requests.
const EMBEDDING_TIMEOUT_MS = 30_000;

function isFiniteNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item): item is number => typeof item === "number" && Number.isFinite(item))
  );
}

function vectorNorm(vector: number[]): number {
  let sum = 0;
  for (const x of vector) {
    sum += x * x;
  }
  return Math.sqrt(sum);
}

/**
 * Generates real embeddings via the Google Gemini embedContent REST API.
 * The GEMINI_API_KEY is sent server-side only (as a query parameter) and is never logged.
 * Throws on HTTP errors (including quota exhaustion) or invalid vectors,
 * so indexing never succeeds with missing or fabricated embeddings.
 */
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const embeddings: number[][] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const url = `${config.geminiBaseUrl}/models/${config.geminiEmbedModel}:embedContent?key=${config.geminiApiKey}`;
    const body = JSON.stringify({
      content: { parts: [{ text }] },
      embedContentConfig: {
        taskType: "RETRIEVAL_DOCUMENT",
        autoTruncate: true,
      },
    });

    let lastError: unknown = null;
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
            throw new Error(
              `Gemini embeddings API quota exhausted (HTTP 429). Stopping indexing.`
            );
          }
          await sleep(Math.min(delay, 30000));
          continue;
        }

        if (!resp.ok) {
          const bodyText = await resp.text();
          throw new Error(
            `Gemini embeddings API request failed (HTTP ${resp.status}): ${bodyText}`
          );
        }

        const payload = (await resp.json()) as { embedding?: { values?: unknown } };
        if (!isFiniteNumberArray(payload.embedding?.values)) {
          throw new Error(
            "Gemini embeddings API returned an invalid or missing embedding vector."
          );
        }

        embeddings.push(payload.embedding.values);
        success = true;
        break;
      } catch (err: any) {
        lastError = err;
        if (err.name === "AbortError") {
          // Request timed out: abort indexing without retrying or writing a partial index.
          break;
        }
        if (err.message.includes("HTTP 429") && attempt < EMBEDDING_MAX_RETRIES) {
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (!success) {
      throw lastError
        ? lastError
        : new Error(`Gemini embeddings API failed for text index ${i}.`);
    }

    // Conservative delay between requests to stay within free-tier rate limits.
    if (i < texts.length - 1) {
      await sleep(EMBEDDING_DELAY_MS);
    }
  }

  return embeddings;
}

export interface DocFile {
  filepath: string;
  relativePath: string;
  title: string;
  description: string;
  headings: { text: string; level: number }[];
  content: string;
}

function createChunk(
  title: string,
  text: string,
  headings: { text: string; level: number }[],
  sourceUrl: string,
  slug: string,
  embedding: number[]
): Chunk {
  const textToEmbed = `${title}\n${headings.map((h) => `${h.level}. ${h.text}`).join("\n")}\n${text}`;

  return {
    id: crypto.randomUUID(),
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

export function splitIntoChunks(
  title: string,
  fullText: string,
  headings: { text: string; level: number }[],
  sourceUrl: string,
  slug: string,
  embedding: number[]
): Chunk[] {
  const chunks: Chunk[] = [];
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
    } else {
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
export class DocIndexer {
  private sourceDir: string;
  private docExtension: string;

  constructor(sourceDir: string, docExtension: string = ".md") {
    this.sourceDir = path.resolve(sourceDir);
    this.docExtension = docExtension;
  }

  async index(): Promise<IndexData> {
    const files = this.readDocs();
    if (files.length === 0) {
      throw new Error(
        `[Indexer] No Markdown files found in source directory: ${this.sourceDir}. Refusing to write an empty index.`
      );
    }
    return this.indexFromFiles(files);
  }

  private async indexFromFiles(files: DocFile[]): Promise<IndexData> {
    const chunks: Chunk[] = [];
    let chunkIndex = 0;

    for (const file of files) {
      const title = file.title || path.basename(file.relativePath, path.extname(file.relativePath));
      const slug = `/docs/${file.relativePath.replace(/\.md$/, "")}`;
      const sourceUrl = `https://doc.pumpswap.biz${slug}`;
      const headings = file.headings || [];
      const fullText = this.concatContent(file);

      // Placeholder embeddings are replaced with real vectors below.
      const chunksForFile = splitIntoChunks(title, fullText, headings, sourceUrl, slug, []);
      for (const chunk of chunksForFile) {
        chunk.id = `doc-${chunkIndex++}`;
        chunks.push(chunk);
      }
    }

    if (chunks.length === 0) {
      throw new Error(
        `[Indexer] Zero chunks were produced from the Markdown files in ${this.sourceDir}. Refusing to write an empty index.`
      );
    }

    console.log(
      `[Indexer] Generating real embeddings for ${chunks.length} chunks via Gemini (${config.geminiEmbedModel})...`
    );
    const embeddings = await generateEmbeddings(chunks.map((chunk) => chunk.text));

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `[Indexer] Gemini returned ${embeddings.length} embeddings for ${chunks.length} chunks. Stopping indexing.`
      );
    }

    const expectedDimension = embeddings[0].length;
    for (let i = 0; i < chunks.length; i++) {
      const vector = embeddings[i];
      if (vector.length !== expectedDimension) {
        throw new Error(
          `[Indexer] Chunk ${chunks[i].id} has embedding dimension ${vector.length}, expected ${expectedDimension}. Stopping indexing.`
        );
      }
      if (vectorNorm(vector) === 0) {
        throw new Error(
          `[Indexer] Chunk ${chunks[i].id} received a zero embedding vector from Gemini. Stopping indexing.`
        );
      }
      chunks[i].embedding = vector;
    }

    const index: IndexData = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chunkCount: chunks.length,
      chunks,
      // Every chunk above was embedded successfully; any failure throws before this point.
      embeddingCount: chunks.length,
    };

    return index;
  }

  async buildAndSaveIndex(): Promise<IndexData> {
    console.log("[Indexer] Reading documentation files...");
    const files = this.readDocs();
    if (files.length === 0) {
      throw new Error(
        `[Indexer] No Markdown files found in source directory: ${this.sourceDir}. Refusing to write an empty index.`
      );
    }
    console.log(`[Indexer] Found ${files.length} Markdown file(s) in ${this.sourceDir}`);
    const index = await this.indexFromFiles(files);

    console.log("[Indexer] Validating chunks...");
    for (const chunk of index.chunks) {
      if (chunk.embedding.length === 0) {
        throw new Error(
          `Chunk ${chunk.id} has no embedding. Run 'pnpm index' to generate embeddings with the Gemini API.`
        );
      }
    }

    console.log("[Indexer] Saving index to disk...");
    const indexPath =
      path.isAbsolute(config.indexPath)
        ? config.indexPath
        : path.resolve(__dirname, "..", config.indexPath);
    const dir = path.dirname(indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await this.writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
    console.log(`[Indexer] Index saved to ${indexPath}`);
    console.log(
      `[Indexer] Summary: ${files.length} Markdown file(s), ${index.chunkCount} chunks, ${index.embeddingCount} embeddings, output path: ${indexPath}`
    );

    return index;
  }

  protected async writeFileAtomic(targetPath: string, content: string): Promise<void> {
    const tmpPath = path.join(
      path.dirname(targetPath),
      `.index-${process.pid}-${Date.now()}.tmp`
    );
    try {
      await fs.promises.writeFile(tmpPath, content, "utf-8");
      await fs.promises.rename(tmpPath, targetPath);
    } catch (err) {
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // Best-effort cleanup of the temporary file after a failed write.
      }
      throw err;
    }
  }

  private readDocs(): DocFile[] {
    const files: DocFile[] = [];
    this.walkDir(this.sourceDir, "", files);
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private walkDir(dir: string, relPath: string, files: DocFile[]): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const rel = relPath ? `${relPath}/${entry}` : entry;
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        this.walkDir(fullPath, rel, files);
      } else if (stat.isFile() && entry.endsWith(this.docExtension)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const doc = this.parseMarkdown(content, fullPath, rel);
          files.push(doc);
        } catch (err) {
          console.warn(`[Indexer] Skipping ${rel}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private parseMarkdown(content: string, filepath: string, relPath: string): DocFile {
    const lines = content.split("\n");
    let inFrontmatter = true;
    let frontmatterEnd = -1;
    const frontmatter: { [key: string]: string } = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (inFrontmatter) {
        if (line.trim() === "---") {
          if (frontmatterEnd === -1) {
            frontmatterEnd = i;
          } else {
            inFrontmatter = false;
          }
        } else if (line.startsWith("title:")) {
          frontmatter.title = line.replace("title:", "").trim().replace(/^["']|["']$/g, "");
        } else if (line.startsWith("description:")) {
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

  private extractHeadings(lines: string[]): { text: string; level: number }[] {
    const headings: { text: string; level: number }[] = [];
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

  private markdownToHtml(lines: string[]): string {
    return lines.map((line) => this.inlineHtml(line)).join("\n");
  }

  private inlineHtml(line: string): string {
    let html = line;
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^[*-] /gm, "<li>");
    html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
    html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
    html = html.replace(/^#### (.*)$/gm, "<h4>$1</h4>");
    return html;
  }

  private concatContent(file: DocFile): string {
    const parts: string[] = [];
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

/**
 * CLI entry point for `pnpm index` (tsx src/indexer.ts).
 * Paths are resolved relative to this file so the command works regardless of
 * the caller's current working directory.
 */
export async function main(docsDir?: string): Promise<IndexData> {
  const serverDir = path.resolve(__dirname, "..");
  const resolvedDocsDir = docsDir ? path.resolve(docsDir) : path.resolve(serverDir, "..", "docs");
  const indexer = new DocIndexer(resolvedDocsDir);
  return indexer.buildAndSaveIndex();
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase();

if (isMainModule) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Indexer] Failed: ${message}`);
    process.exit(1);
  });
}

