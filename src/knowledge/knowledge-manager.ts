import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SQLiteStorage, KnowledgeChunk } from "../storage/sqlite-storage.js";
import type { IStorage } from "../storage/storage.js";
import { chunkMarkdown, extractMarkdownTOC, type DocumentTOC } from "./markdown-chunker.js";
import { extractCodeSkeleton } from "./code-skeleton.js";
import { defaultTokenEstimator, type TokenEstimatorFn } from "../context/token-estimator.js";
import { InvalidRequestError } from "../types/errors.js";

export type KnowledgeMode = "rag" | "skeleton" | "full";

export interface KnowledgeConfig {
  /**
   * Path to a markdown file, code file, or a directory.
   */
  path: string;

  /**
   * Preceding system prompt / persona description.
   */
  prompt?: string;

  /**
   * Knowledge injection mode:
   * - 'rag': Header-chunked FTS5 retrieval matching user query (default, saves ~95% tokens).
   * - 'skeleton': Extract TypeScript interfaces, types, and function signatures.
   * - 'full': Full text of all files within token budget.
   */
  mode?: KnowledgeMode;

  /**
   * Optional maximum tokens limit to allocate for knowledge base context injection.
   * If undefined / omitted, no hard cap is applied, providing full knowledge detail.
   */
  maxKnowledgeTokens?: number;

  /**
   * Maximum number of relevant chunks to retrieve for RAG matching. Defaults to 15.
   */
  searchLimit?: number;

  /**
   * Supported file extensions. Defaults to ['.md', '.markdown', '.txt', '.ts', '.js', '.json', '.yaml', '.yml'].
   */
  extensions?: string[];

  /**
   * Glob-like patterns or substrings to ignore. Defaults to ['node_modules', '.git', 'dist', '.env'].
   */
  ignore?: string[];

  /**
   * Force full reindexing even if file modification timestamps have not changed. Defaults to false.
   */
  forceReindex?: boolean;

  /**
   * Custom token estimator function.
   */
  tokenEstimator?: TokenEstimatorFn;
}

export interface SyncResult {
  totalFiles: number;
  updatedFiles: number;
  deletedFiles: number;
  isIncremental: boolean;
  totalChunks: number;
}

export class KnowledgeManager {
  public readonly config: KnowledgeConfig;
  public readonly targetPath: string;
  public readonly mode: KnowledgeMode;
  public readonly maxKnowledgeTokens?: number;
  public readonly searchLimit: number;
  private readonly storage?: SQLiteStorage;
  private readonly extensions: Set<string>;
  private readonly ignorePatterns: string[];
  private readonly tokenEstimator: TokenEstimatorFn;
  private inMemoryChunks: KnowledgeChunk[] = [];
  private inMemoryTOCs: DocumentTOC[] = [];
  private synced = false;
  private cachedTOC?: { tocBlock: string; tocTokens: number };

  constructor(config: KnowledgeConfig, storage?: IStorage) {
    if (!config || !config.path) {
      throw new InvalidRequestError("KnowledgeConfig requires a valid path");
    }

    this.config = config;
    this.targetPath = path.resolve(config.path);
    this.mode = config.mode ?? "rag";
    this.maxKnowledgeTokens = config.maxKnowledgeTokens;
    this.searchLimit = config.searchLimit ?? 15;
    this.tokenEstimator = config.tokenEstimator ?? defaultTokenEstimator;

    const exts = config.extensions ?? [
      ".md",
      ".markdown",
      ".txt",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".json",
      ".yaml",
      ".yml",
    ];
    this.extensions = new Set(exts.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`)));

    this.ignorePatterns = config.ignore ?? [
      "node_modules",
      ".git",
      "dist",
      ".env",
      "coverage",
      ".DS_Store",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
    ];

    if (storage && "saveFileMeta" in storage && typeof (storage as any).saveFileMeta === "function") {
      this.storage = storage as SQLiteStorage;
    }
  }

  private shouldIgnore(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/");
    for (const pattern of this.ignorePatterns) {
      if (normalized.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  private isSupportedExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensions.has(ext);
  }

  /**
   * Scan disk and perform fast incremental synchronization with SQLite storage.
   */
  async sync(): Promise<SyncResult> {
    if (!fs.existsSync(this.targetPath)) {
      throw new InvalidRequestError(`Knowledge path does not exist: ${this.targetPath}`);
    }

    const stat = fs.statSync(this.targetPath);
    const filesToProcess: Array<{ absPath: string; relPath: string; stat: fs.Stats }> = [];

    if (stat.isFile()) {
      filesToProcess.push({
        absPath: this.targetPath,
        relPath: path.basename(this.targetPath),
        stat,
      });
    } else if (stat.isDirectory()) {
      const scanDir = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(this.targetPath, fullPath);

          if (this.shouldIgnore(relPath)) {
            continue;
          }

          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && this.isSupportedExtension(entry.name)) {
            const fstat = fs.statSync(fullPath);
            filesToProcess.push({ absPath: fullPath, relPath, stat: fstat });
          }
        }
      };
      scanDir(this.targetPath);
    }

    let updatedFiles = 0;
    let deletedFiles = 0;
    const existingFileMetas = this.storage ? this.storage.getAllFileMetas() : new Map();
    const currentFileSet = new Set<string>();

    this.inMemoryChunks = [];
    this.inMemoryTOCs = [];

    for (const file of filesToProcess) {
      currentFileSet.add(file.relPath);
      const cachedMeta = existingFileMetas.get(file.relPath);

      const mtime = Math.floor(file.stat.mtimeMs);
      const size = file.stat.size;

      // Incremental check: if mtime and size match and not forceReindex, skip re-reading
      const isUnchanged =
        !this.config.forceReindex &&
        cachedMeta &&
        cachedMeta.mtime === mtime &&
        cachedMeta.size === size;

      if (isUnchanged) {
        // Collect TOC if available
        continue;
      }

      // Read file and chunk
      const content = fs.readFileSync(file.absPath, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

      const ext = path.extname(file.absPath).toLowerCase();
      let chunks: Array<{ heading: string; content: string; tokens: number }> = [];

      if (ext === ".md" || ext === ".markdown") {
        const sections = chunkMarkdown(file.relPath, content, this.tokenEstimator);
        chunks = sections.map((s) => ({
          heading: s.heading,
          content: s.content,
          tokens: s.tokens,
        }));
        this.inMemoryTOCs.push(extractMarkdownTOC(file.relPath, content));
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
        const skeleton = extractCodeSkeleton(file.relPath, content);
        const tokens = this.tokenEstimator(`${file.relPath}\n${skeleton}`);
        chunks = [{ heading: file.relPath, content: skeleton, tokens }];
      } else {
        const tokens = this.tokenEstimator(`${file.relPath}\n${content}`);
        chunks = [{ heading: file.relPath, content, tokens }];
      }

      if (this.storage) {
        this.storage.saveFileMeta({
          filePath: file.relPath,
          mtime,
          size,
          hash,
          indexedAt: Date.now(),
        });
        this.storage.saveChunks(file.relPath, chunks);
      } else {
        for (const c of chunks) {
          this.inMemoryChunks.push({
            filePath: file.relPath,
            heading: c.heading,
            content: c.content,
            tokens: c.tokens,
          });
        }
      }

      updatedFiles++;
    }

    // Clean up deleted files from SQLite
    if (this.storage) {
      for (const [recordedPath] of existingFileMetas) {
        if (!currentFileSet.has(recordedPath)) {
          this.storage.deleteFile(recordedPath);
          deletedFiles++;
        }
      }
    }

    if (updatedFiles > 0 || deletedFiles > 0 || !this.cachedTOC) {
      this.cachedTOC = undefined;
    }

    this.synced = true;

    return {
      totalFiles: filesToProcess.length,
      updatedFiles,
      deletedFiles,
      isIncremental: updatedFiles < filesToProcess.length,
      totalChunks: this.storage ? this.storage.chunkCount : this.inMemoryChunks.length,
    };
  }

  private getOrCreateTOC(): { tocBlock: string; tocTokens: number } {
    if (this.cachedTOC) {
      return this.cachedTOC;
    }

    const fileHeadingsMap = new Map<string, string[]>();

    if (this.storage) {
      const outline =
        typeof (this.storage as any).getKnowledgeOutline === "function"
          ? (this.storage as any).getKnowledgeOutline(100)
          : this.storage.getAllChunks(100);

      for (const item of outline) {
        const list = fileHeadingsMap.get(item.filePath) ?? [];
        if (!list.includes(item.heading)) {
          list.push(item.heading);
        }
        fileHeadingsMap.set(item.filePath, list);
      }
    } else {
      for (const chunk of this.inMemoryChunks) {
        const list = fileHeadingsMap.get(chunk.filePath) ?? [];
        if (!list.includes(chunk.heading)) {
          list.push(chunk.heading);
        }
        fileHeadingsMap.set(chunk.filePath, list);
      }
    }

    const tocLines: string[] = ["# Knowledge Base Overview (Files & Sections)"];
    for (const [file, headings] of fileHeadingsMap.entries()) {
      tocLines.push(`- [${file}]: ${headings.slice(0, 5).join(", ")}`);
    }
    const tocBlock = tocLines.join("\n");
    const tocTokens = this.tokenEstimator(tocBlock);

    this.cachedTOC = { tocBlock, tocTokens };
    return this.cachedTOC;
  }

  /**
   * Build an optimized System Prompt containing user persona, TOC, and relevant knowledge chunks.
   */
  async buildSystemContext(userQuery?: string): Promise<{ systemPrompt: string; injectedTokens: number }> {
    if (!this.synced) {
      await this.sync();
    }

    const parts: string[] = [];

    // 1. Base Prompt / Persona
    if (this.config.prompt) {
      parts.push(this.config.prompt.trim());
    }

    let tokenBudget = this.maxKnowledgeTokens;

    // 2. Build or reuse cached TOC summary block
    const { tocBlock, tocTokens } = this.getOrCreateTOC();

    if (tokenBudget === undefined || tokenBudget > tocTokens + 200) {
      parts.push(tocBlock);
      if (tokenBudget !== undefined) {
        tokenBudget -= tocTokens;
      }
    }

    // 3. Search and inject relevant chunks
    let relevantChunks: KnowledgeChunk[] = [];
    const limit = this.searchLimit;
    if (this.mode === "rag") {
      if (this.storage) {
        relevantChunks = userQuery
          ? this.storage.searchChunks(userQuery, limit)
          : this.storage.getAllChunks(limit);
      } else {
        relevantChunks = this.inMemoryChunks.slice(0, limit);
      }
    } else {
      relevantChunks = this.storage
        ? this.storage.getAllChunks(limit)
        : this.inMemoryChunks;
    }

    const injectedChunkSections: string[] = [];
    let chunksTokens = 0;

    for (const chunk of relevantChunks) {
      const sectionText = `--- [Source: ${chunk.heading}] ---\n${chunk.content}`;
      const cost = this.tokenEstimator(sectionText);
      if (tokenBudget !== undefined && chunksTokens + cost > tokenBudget) {
        break;
      }
      injectedChunkSections.push(sectionText);
      chunksTokens += cost;
    }

    if (injectedChunkSections.length > 0) {
      parts.push("# Relevant Knowledge Context:\n" + injectedChunkSections.join("\n\n"));
    }

    const fullPrompt = parts.join("\n\n");
    const totalInjectedTokens = this.tokenEstimator(fullPrompt);

    return {
      systemPrompt: fullPrompt,
      injectedTokens: totalInjectedTokens,
    };
  }
}
