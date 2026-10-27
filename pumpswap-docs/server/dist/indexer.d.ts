import type { Chunk, IndexData } from "./types";
export interface DocFile {
    filepath: string;
    relativePath: string;
    title: string;
    description: string;
    headings: {
        text: string;
        level: number;
    }[];
    content: string;
}
export declare function splitIntoChunks(title: string, fullText: string, headings: {
    text: string;
    level: number;
}[], sourceUrl: string, slug: string, embedding: number[]): Chunk[];
export declare class DocIndexer {
    private sourceDir;
    private docExtension;
    constructor(sourceDir: string, docExtension?: string);
    index(): Promise<IndexData>;
    private indexFromFiles;
    buildAndSaveIndex(): Promise<IndexData>;
    protected writeFileAtomic(targetPath: string, content: string): Promise<void>;
    private readDocs;
    private walkDir;
    private parseMarkdown;
    private extractHeadings;
    private markdownToHtml;
    private inlineHtml;
    private concatContent;
}
export declare function main(docsDir?: string): Promise<IndexData>;
//# sourceMappingURL=indexer.d.ts.map