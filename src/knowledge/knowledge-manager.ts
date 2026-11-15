import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SQLiteStorage, KnowledgeChunk } from "../storage/sqlite-storage.js";
import type { IStorage } from "../storage/storage.js";
import { chunkMarkdown, extractMarkdownTOC, type DocumentTOC } from "./markdown-chunker.js";
import { extractCodeSkeleton } from "./code-skeleton.js";
import { defaultTokenEstimator, type TokenEstimatorFn } from "../context/token-estimator.js";
import { InvalidRequestError } from "../types/errors.js";
import { extractTextFromContent } from "../types/message.js";

export type KnowledgeMode = "rag" | "skeleton" | "full";

export type VectorSearchFn = (
  query: string,
  limit: number,
  scope?: string
) => Promise<KnowledgeChunk[]> | KnowledgeChunk[];

export interface BuildSystemContextOptions {
  history?: Array<{ role: string; content: unknown }>;
  summary?: string;
}

export interface KnowledgeConfig {
  /**
   * Path to a markdown file, code file, or a directory. (Used in Node.js filesystem environments)
   */
  path?: string;

  /**
   * Direct markdown or text content string. (Ideal for Worker, serverless, or in-memory environments)
   */
  content?: string;

  /**
   * Virtual file map or collection of files with relative paths and contents.
   * e.g. { "faq.md": "# FAQ\n...", "api.md": "# API\n..." } or [{ path: "faq.md", content: "..." }]
   * Ideal for Cloudflare Workers when bundling docs or reading from R2/KV.
   */
  files?: Record<string, string> | Array<{ path?: string; content: string }>;

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

  /**
   * Watch the directory or file for live changes and automatically re-sync in the background.
   */
  watch?: boolean;

  /**
   * Debounce delay in milliseconds for file watcher re-sync. Defaults to 300ms.
   */
  watchDebounceMs?: number;

  /**
   * Custom vector search or semantic retriever.
   * Enables hybrid search combining FTS5 lexical matching with vector semantic retrieval via Reciprocal Rank Fusion (RRF).
   */
  vectorSearch?: VectorSearchFn;

  /**
   * Custom embedding function: (text: string) => Promise<number[]>.
   */
  embedder?: (text: string) => Promise<number[]>;

  /**
   * Whether to fallback to returning top chunks if the search query does not match any documents.
   * Defaults to false (avoids injecting irrelevant chunks into casual conversations).
   */
  fallbackOnNoMatch?: boolean;

  /**
   * Maximum tokens per section when chunking Markdown documents. Defaults to 800.
   */
  maxSectionTokens?: number;

  /**
   * Tokens of overlap between consecutive sub-chunks of oversized sections. Defaults to 60.
   */
  overlapTokens?: number;
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
  public readonly scope: string;
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
  private watcher?: fs.FSWatcher | null;
  private watchTimer?: NodeJS.Timeout | null;

  constructor(config: KnowledgeConfig, storage?: IStorage) {
    if (!config || (!config.path && !config.content && !config.files)) {
      throw new InvalidRequestError("KnowledgeConfig requires a valid path, content, or files");
    }

    this.config = config;
    this.targetPath = config.path ? path.resolve(config.path) : "";
    this.scope = this.targetPath
      ? this.targetPath.replace(/\\/g, "/")
      : (this.config.prompt ? crypto.createHash("md5").update(this.config.prompt).digest("hex") : "default");
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

    if (config.path && storage && "saveFileMeta" in storage && typeof (storage as any).saveFileMeta === "function") {
      this.storage = storage as SQLiteStorage;
    }

    if (this.config.watch && this.targetPath) {
      this.startWatch();
    }
  }

  /**
   * Start watching the target directory or file for live changes.
   */
  public startWatch(): void {
    if (this.watcher || !this.targetPath) {
      return;
    }
    try {
      if (fs.existsSync(this.targetPath)) {
        const debounceMs = this.config.watchDebounceMs ?? 300;
        this.watcher = fs.watch(this.targetPath, { recursive: true }, () => {
          if (this.watchTimer) {
            clearTimeout(this.watchTimer);
          }
          this.watchTimer = setTimeout(() => {
            this.sync().catch(() => {});
          }, debounceMs);
        });
      }
    } catch {
      // Ignore if recursive file watch is not supported on platform
    }
  }

  /**
   * Stop watching and release file handles.
   */
  public close(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
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
   * Scan disk or process virtual/in-memory files and perform synchronization.
   */
  async sync(): Promise<SyncResult> {
    if (this.config.path) {
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
        const visitedDirs = new Set<string>();
        const scanDir = (dir: string, depth = 0) => {
          if (depth > 15) return;
          let realDir: string;
          try {
            realDir = fs.realpathSync(dir);
          } catch {
            return;
          }
          if (visitedDirs.has(realDir)) return;
          visitedDirs.add(realDir);

          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(this.targetPath, fullPath).replace(/\\/g, "/");

            if (this.shouldIgnore(relPath)) {
              continue;
            }

            if (entry.isDirectory()) {
              scanDir(fullPath, depth + 1);
            } else if (entry.isFile() && this.isSupportedExtension(entry.name)) {
              try {
                const fstat = fs.statSync(fullPath);
                filesToProcess.push({ absPath: fullPath, relPath, stat: fstat });
              } catch {
                // ignore unreadable
              }
            }
          }
        };
        scanDir(this.targetPath);
      }

      let updatedFiles = 0;
      let deletedFiles = 0;
      const existingFileMetas = this.storage ? this.storage.getAllFileMetas(this.scope) : new Map();
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
          continue;
        }

        // Read file and chunk
        const content = fs.readFileSync(file.absPath, "utf-8");
        const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

        const ext = path.extname(file.absPath).toLowerCase();
        let chunks: Array<{ heading: string; content: string; tokens: number }> = [];

        if (ext === ".md" || ext === ".markdown") {
          const sections = chunkMarkdown(file.relPath, content, {
            tokenEstimator: this.tokenEstimator,
            maxSectionTokens: this.config.maxSectionTokens,
            overlapTokens: this.config.overlapTokens,
          });
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
            scope: this.scope,
          });
          this.storage.saveChunks(file.relPath, chunks, this.scope);
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

      // Clean up deleted files from SQLite (scoped strictly to this KnowledgeManager)
      if (this.storage) {
        for (const [recordedPath] of existingFileMetas) {
          if (!currentFileSet.has(recordedPath)) {
            this.storage.deleteFile(recordedPath, this.scope);
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

    // In-Memory Virtual Files Branch (used in Cloudflare Workers or when passing files/content)
    const virtualFiles: Array<{ relPath: string; content: string }> = [];

    if (typeof this.config.content === "string") {
      virtualFiles.push({ relPath: "knowledge.md", content: this.config.content });
    }

    if (this.config.files) {
      if (Array.isArray(this.config.files)) {
        for (const item of this.config.files) {
          if (item && typeof item.content === "string") {
            virtualFiles.push({ relPath: item.path || "doc.md", content: item.content });
          }
        }
      } else if (typeof this.config.files === "object") {
        for (const [filePath, fileContent] of Object.entries(this.config.files)) {
          if (typeof fileContent === "string") {
            virtualFiles.push({ relPath: filePath, content: fileContent });
          }
        }
      }
    }

    this.inMemoryChunks = [];
    this.inMemoryTOCs = [];

    for (const file of virtualFiles) {
      const ext = path.extname(file.relPath).toLowerCase();
      const isMarkdown = ext === ".md" || ext === ".markdown" || ext === ".txt" || !ext;

      if (isMarkdown) {
        const sections = chunkMarkdown(file.relPath, file.content, {
          tokenEstimator: this.tokenEstimator,
          maxSectionTokens: this.config.maxSectionTokens,
          overlapTokens: this.config.overlapTokens,
        });
        this.inMemoryTOCs.push(extractMarkdownTOC(file.relPath, file.content));
        for (const s of sections) {
          this.inMemoryChunks.push({
            filePath: file.relPath,
            heading: s.heading,
            content: s.content,
            tokens: s.tokens,
          });
        }
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
        const skeleton = extractCodeSkeleton(file.relPath, file.content);
        const tokens = this.tokenEstimator(`${file.relPath}\n${skeleton}`);
        this.inMemoryChunks.push({
          filePath: file.relPath,
          heading: file.relPath,
          content: skeleton,
          tokens,
        });
      } else {
        const tokens = this.tokenEstimator(`${file.relPath}\n${file.content}`);
        this.inMemoryChunks.push({
          filePath: file.relPath,
          heading: file.relPath,
          content: file.content,
          tokens,
        });
      }
    }

    this.cachedTOC = undefined;
    this.synced = true;

    return {
      totalFiles: virtualFiles.length,
      updatedFiles: virtualFiles.length,
      deletedFiles: 0,
      isIncremental: false,
      totalChunks: this.inMemoryChunks.length,
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
          ? (this.storage as any).getKnowledgeOutline(100, this.scope)
          : this.storage.getAllChunks(100, this.scope);

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
      const cleanHeadings = headings
        .slice(0, 4)
        .map((h) => {
          const parts = h.split(" > ");
          return parts[parts.length - 1].trim();
        })
        .filter(Boolean);
      tocLines.push(`- [${file}]: ${cleanHeadings.join(", ")}`);
    }
    const tocBlock = tocLines.join("\n");
    const tocTokens = this.tokenEstimator(tocBlock);

    this.cachedTOC = { tocBlock, tocTokens };
    return this.cachedTOC;
  }

  /**
   * Build an optimized System Prompt containing user persona, TOC, and relevant knowledge chunks.
   * Supports context-aware query expansion and hybrid search.
   */
  async buildSystemContext(
    userQuery?: string | unknown,
    contextOptions?: BuildSystemContextOptions
  ): Promise<{ systemPrompt: string; injectedTokens: number }> {
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
    const textQuery = typeof userQuery === "string" ? userQuery : extractTextFromContent(userQuery);

    // Multi-turn context-aware query expansion
    let effectiveQuery = textQuery;
    if (textQuery && contextOptions?.history && contextOptions.history.length > 0) {
      const isBrief = textQuery.trim().length <= 30;
      const hasPronoun = /(^|\s)(it|this|that|these|those|its|how much|what about|它|这个|那|它们|多少钱|怎么样)(\s|$|[?？,.])/i.test(
        textQuery
      );
      if (isBrief || hasPronoun) {
        for (let i = contextOptions.history.length - 1; i >= 0; i--) {
          const prevMsg = contextOptions.history[i];
          const prevText = extractTextFromContent(prevMsg.content).trim();
          if (prevText && prevText !== textQuery) {
            const prevWords = prevText
              .split(/[\s,，.。!！?？;；:：]+/)
              .filter((w) => w.length >= 2)
              .slice(-6);
            if (prevWords.length > 0) {
              effectiveQuery = `${textQuery} ${prevWords.join(" ")}`;
            }
            break;
          }
        }
      }
    }

    if (this.mode === "rag") {
      relevantChunks = await this.retrieveChunks(effectiveQuery, limit);
    } else {
      relevantChunks = this.storage
        ? this.storage.getAllChunks(limit, this.scope)
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

  /**
   * Retrieve chunks with optional hybrid search (lexical + vector RRF fusion).
   */
  private async retrieveChunks(query: string, limit: number): Promise<KnowledgeChunk[]> {
    if (!query) {
      return this.storage
        ? this.storage.getAllChunks(limit, this.scope)
        : this.inMemoryChunks.slice(0, limit);
    }

    const fallback = this.config.fallbackOnNoMatch ?? false;
    let lexicalChunks: KnowledgeChunk[] = [];
    if (this.storage) {
      lexicalChunks = this.storage.searchChunks(query, limit, this.scope, { fallbackOnNoMatch: fallback });
    } else {
      lexicalChunks = this.searchInMemoryChunks(query, limit, { fallbackOnNoMatch: fallback });
    }

    if (!this.config.vectorSearch) {
      return lexicalChunks;
    }

    try {
      const vectorChunks = await this.config.vectorSearch(query, limit, this.scope);
      if (!vectorChunks || vectorChunks.length === 0) {
        return lexicalChunks;
      }
      if (lexicalChunks.length === 0) {
        return vectorChunks.slice(0, limit);
      }

      // Reciprocal Rank Fusion (RRF)
      const scoreMap = new Map<string, { chunk: KnowledgeChunk; score: number }>();
      const k = 60;

      lexicalChunks.forEach((chunk, rank) => {
        const key = `${chunk.filePath}\0${chunk.heading}`;
        const score = 1 / (k + rank + 1);
        scoreMap.set(key, { chunk, score });
      });

      vectorChunks.forEach((chunk, rank) => {
        const key = `${chunk.filePath}\0${chunk.heading}`;
        const score = 1 / (k + rank + 1);
        const existing = scoreMap.get(key);
        if (existing) {
          existing.score += score;
        } else {
          scoreMap.set(key, { chunk, score });
        }
      });

      const combined = Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .map((item) => item.chunk);

      return combined.slice(0, limit);
    } catch {
      return lexicalChunks;
    }
  }

  /**
   * Fast in-memory relevance ranking for RAG queries without SQLite FTS5.
   */
  private searchInMemoryChunks(
    textQuery: string,
    limit: number,
    options?: { fallbackOnNoMatch?: boolean }
  ): KnowledgeChunk[] {
    if (!textQuery || textQuery.trim().length === 0 || this.inMemoryChunks.length === 0) {
      return this.inMemoryChunks.slice(0, limit);
    }

    const normalizedQuery = textQuery.toLowerCase().trim();
    const rawTerms = normalizedQuery
      .split(/[\s,，.。!！?？;；:：、/\\_—-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const termSet = new Set(rawTerms);

    // Extract CJK 2-grams and 3-grams for Chinese queries without spaces
    for (const term of rawTerms) {
      if (/[\u4e00-\u9fa5]/.test(term)) {
        if (term.length >= 2 && term.length <= 6) {
          termSet.add(term);
        }
        for (let i = 0; i < term.length - 1; i++) {
          termSet.add(term.slice(i, i + 2)); // 2-gram
          if (i < term.length - 2) {
            termSet.add(term.slice(i, i + 3)); // 3-gram
          }
        }
      }
    }

    const terms = Array.from(termSet);

    const scored = this.inMemoryChunks.map((chunk) => {
      let score = 0;
      const lowerHeading = chunk.heading.toLowerCase();
      const lowerContent = chunk.content.toLowerCase();

      // Full query match bonus
      if (lowerHeading.includes(normalizedQuery)) {
        score += 25;
      }
      if (lowerContent.includes(normalizedQuery)) {
        score += 15;
      }

      // Keyword & n-gram match
      for (const term of terms) {
        if (term.length === 1) {
          if (lowerHeading.includes(term)) score += 3;
          if (lowerContent.includes(term)) score += 1;
        } else if (term.length > 1) {
          const headingWeight = term.length >= 3 ? 8 : 5;
          if (lowerHeading.includes(term)) score += headingWeight;
          let idx = 0;
          let count = 0;
          while ((idx = lowerContent.indexOf(term, idx)) !== -1 && count < 5) {
            count++;
            score += Math.min(term.length, 3);
            idx += term.length;
          }
        }
      }

      return { chunk, score };
    });

    const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    if (matched.length > 0) {
      return matched.slice(0, limit).map((s) => s.chunk);
    }

    return options?.fallbackOnNoMatch ? this.inMemoryChunks.slice(0, limit) : [];
  }
}

