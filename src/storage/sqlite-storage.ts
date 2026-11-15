import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IStorage, ListSessionsOptions } from "./storage.js";
import type { SessionData } from "../types/session.js";
import { SessionNotFoundError, InvalidRequestError, StorageError } from "../types/errors.js";

// Safe node:sqlite import compatible with dual ESM/CJS builds
function getDatabaseSyncClass(): any {
  try {
    const entryPath = typeof __filename !== "undefined"
      ? __filename
      : path.join(process.cwd(), "package.json");
    const req = createRequire(entryPath);
    const mod = req("node:sqlite");
    return mod.DatabaseSync;
  } catch (err: unknown) {
    throw new StorageError("Failed to load built-in node:sqlite module (requires Node.js >= 22.5.0)", {
      cause: err,
    });
  }
}

export interface SQLiteStorageOptions {
  /**
   * Path to the SQLite database file. Defaults to './data/ai-session.db'.
   * Use ':memory:' for an in-memory SQLite database.
   */
  dbPath?: string;
}

export interface KnowledgeFileMeta {
  filePath: string;
  mtime: number;
  size: number;
  hash: string;
  indexedAt: number;
  scope?: string;
}

export interface KnowledgeChunk {
  id?: number;
  filePath: string;
  heading: string;
  content: string;
  tokens: number;
  scope?: string;
}

/**
 * SQLite storage implementation using Node.js built-in `node:sqlite` (Node >= 22.5.0).
 * Persists session data, message history, and knowledge base chunks with FTS5 search.
 */
export class SQLiteStorage implements IStorage {
  public readonly dbPath: string;
  private db: any;
  private readonly statements = new Map<string, any>();

  constructor(options: SQLiteStorageOptions = {}) {
    this.dbPath = options.dbPath ?? "./data/ai-session.db";

    if (this.dbPath !== ":memory:") {
      const dir = path.dirname(path.resolve(this.dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    try {
      const DatabaseSync = getDatabaseSyncClass();
      this.db = new DatabaseSync(this.dbPath);
    } catch (err: unknown) {
      throw new StorageError(`Failed to initialize SQLite database at ${this.dbPath}`, {
        cause: err,
      });
    }

    this.initTables();
  }

  private getStatement(sql: string): any {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private initTables(): void {
    // Enable WAL mode and performance PRAGMAs for concurrent access
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA cache_size = -64000;");
      this.db.exec("PRAGMA temp_store = MEMORY;");
    } catch {
      // ignore in memory
    }

    // 1. Session storage table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON ai_sessions(updated_at);
    `);

    // 2. Knowledge base file metadata table (for incremental change tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_knowledge_files (
        file_path TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scope, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_files_scope ON ai_knowledge_files(scope);
    `);

    // 3. Knowledge base chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        heading TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_file ON ai_knowledge_chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_scope ON ai_knowledge_chunks(scope);
    `);

    // 4. FTS5 Full-Text Search virtual table
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ai_knowledge_fts USING fts5(
          heading,
          content,
          file_path UNINDEXED
        );
      `);
    } catch {
      // If FTS5 is not compiled in some custom SQLite build, continue gracefully
    }
  }

  /**
   * Save a new session or overwrite an existing session.
   */
  async saveSession(session: SessionData): Promise<void> {
    if (!session || !session.userId || !session.sessionId) {
      throw new InvalidRequestError("Session must contain valid userId and sessionId");
    }

    const json = JSON.stringify(session);
    const stmt = this.getStatement(`
      INSERT INTO ai_sessions (user_id, session_id, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, session_id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `);

    try {
      stmt.run(
        session.userId,
        session.sessionId,
        json,
        session.createdAt,
        session.updatedAt
      );
    } catch (err: unknown) {
      throw new StorageError(`Failed to save session ${session.sessionId} in SQLite`, {
        cause: err,
      });
    }
  }

  /**
   * Load session data by userId and sessionId.
   */
  async loadSession(userId: string, sessionId: string): Promise<SessionData | null> {
    if (!userId || !sessionId) {
      return null;
    }

    const stmt = this.getStatement(`
      SELECT data FROM ai_sessions WHERE user_id = ? AND session_id = ?
    `);

    try {
      const row = stmt.get(userId, sessionId) as { data: string } | undefined;
      if (!row || !row.data) {
        return null;
      }
      return JSON.parse(row.data) as SessionData;
    } catch (err: unknown) {
      throw new StorageError(`Failed to load session ${sessionId} from SQLite`, {
        cause: err,
      });
    }
  }

  /**
   * Update an existing session.
   */
  async updateSession(session: SessionData): Promise<void> {
    if (!session || !session.userId || !session.sessionId) {
      throw new InvalidRequestError("Session must contain valid userId and sessionId");
    }

    const checkStmt = this.getStatement(`
      SELECT 1 FROM ai_sessions WHERE user_id = ? AND session_id = ?
    `);
    const exists = checkStmt.get(session.userId, session.sessionId);
    if (!exists) {
      throw new SessionNotFoundError(session.userId, session.sessionId);
    }

    const json = JSON.stringify(session);
    const updateStmt = this.getStatement(`
      UPDATE ai_sessions
      SET data = ?, updated_at = ?
      WHERE user_id = ? AND session_id = ?
    `);

    try {
      updateStmt.run(json, session.updatedAt, session.userId, session.sessionId);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update session ${session.sessionId} in SQLite`, {
        cause: err,
      });
    }
  }

  /**
   * Delete a session by userId and sessionId.
   */
  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    if (!userId || !sessionId) {
      return false;
    }

    const stmt = this.getStatement(`
      DELETE FROM ai_sessions WHERE user_id = ? AND session_id = ?
    `);

    try {
      const info = stmt.run(userId, sessionId);
      return (info.changes ?? 0) > 0;
    } catch (err: unknown) {
      throw new StorageError(`Failed to delete session ${sessionId} from SQLite`, {
        cause: err,
      });
    }
  }

  /**
   * List all sessions belonging to a specific userId with optional filtering and pagination.
   */
  async listSessions(userId: string, options?: ListSessionsOptions): Promise<SessionData[]> {
    if (!userId) {
      return [];
    }

    let sql = `SELECT data FROM ai_sessions WHERE user_id = ?`;
    const params: any[] = [userId];

    if (options?.search) {
      const escaped = options.search.replace(/[%_\\]/g, "\\$&");
      const pattern = `%${escaped}%`;
      sql += ` AND (session_id LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')`;
      params.push(pattern, pattern);
    }

    const sortCol = options?.sortBy === "createdAt" ? "created_at" : "updated_at";
    const sortDir = options?.sortOrder === "asc" ? "ASC" : "DESC";
    sql += ` ORDER BY ${sortCol} ${sortDir}`;

    if (options?.limit !== undefined && options.limit >= 0) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
      if (options?.offset !== undefined && options.offset > 0) {
        sql += ` OFFSET ?`;
        params.push(options.offset);
      }
    } else if (options?.offset !== undefined && options.offset > 0) {
      sql += ` LIMIT -1 OFFSET ?`;
      params.push(options.offset);
    }

    const stmt = this.getStatement(sql);

    try {
      const rows = stmt.all(...params) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as SessionData);
    } catch (err: unknown) {
      throw new StorageError(`Failed to list sessions for user ${userId} from SQLite`, {
        cause: err,
      });
    }
  }

  // ============================================================================
  // Knowledge Base Methods (Incremental tracking & FTS5 Search)
  // ============================================================================

  /**
   * Get metadata for a specific indexed knowledge file.
   */
  getFileMeta(filePath: string, scope?: string): KnowledgeFileMeta | null {
    if (scope !== undefined) {
      const stmt = this.getStatement(`
        SELECT file_path, mtime, size, hash, indexed_at, scope FROM ai_knowledge_files
        WHERE file_path = ? AND scope = ?
      `);
      const row = stmt.get(filePath, scope) as {
        file_path: string;
        mtime: number;
        size: number;
        hash: string;
        indexed_at: number;
        scope: string;
      } | undefined;
      if (row) {
        return {
          filePath: row.file_path,
          mtime: row.mtime,
          size: row.size,
          hash: row.hash,
          indexedAt: row.indexed_at,
          scope: row.scope,
        };
      }
      return null;
    }

    const stmt = this.getStatement(`
      SELECT file_path, mtime, size, hash, indexed_at, scope FROM ai_knowledge_files WHERE file_path = ? LIMIT 1
    `);
    const row = stmt.get(filePath) as {
      file_path: string;
      mtime: number;
      size: number;
      hash: string;
      indexed_at: number;
      scope: string;
    } | undefined;

    if (!row) return null;
    return {
      filePath: row.file_path,
      mtime: row.mtime,
      size: row.size,
      hash: row.hash,
      indexedAt: row.indexed_at,
      scope: row.scope,
    };
  }

  /**
   * Get all indexed knowledge file metadata (for incremental comparison).
   * Supports optional scope to isolate specific directory trees.
   */
  getAllFileMetas(scope?: string): Map<string, KnowledgeFileMeta> {
    let rows: Array<{
      file_path: string;
      mtime: number;
      size: number;
      hash: string;
      indexed_at: number;
      scope: string;
    }>;

    if (scope !== undefined) {
      const stmt = this.getStatement(`
        SELECT file_path, mtime, size, hash, indexed_at, scope FROM ai_knowledge_files
        WHERE scope = ?
      `);
      rows = stmt.all(scope) as any;
    } else {
      const stmt = this.getStatement(`
        SELECT file_path, mtime, size, hash, indexed_at, scope FROM ai_knowledge_files
      `);
      rows = stmt.all() as any;
    }

    const map = new Map<string, KnowledgeFileMeta>();
    for (const r of rows) {
      map.set(r.file_path, {
        filePath: r.file_path,
        mtime: r.mtime,
        size: r.size,
        hash: r.hash,
        indexedAt: r.indexed_at,
        scope: r.scope,
      });
    }
    return map;
  }

  /**
   * Save or update metadata for an indexed file.
   */
  saveFileMeta(meta: KnowledgeFileMeta): void {
    const scope = meta.scope ?? "";
    const stmt = this.getStatement(`
      INSERT INTO ai_knowledge_files (file_path, mtime, size, hash, indexed_at, scope)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, file_path) DO UPDATE SET
        mtime = excluded.mtime,
        size = excluded.size,
        hash = excluded.hash,
        indexed_at = excluded.indexed_at
    `);
    stmt.run(meta.filePath, meta.mtime, meta.size, meta.hash, meta.indexedAt, scope);
  }

  /**
   * Delete knowledge file metadata and all its associated chunks.
   */
  deleteFile(filePath: string, scope?: string): void {
    if (scope !== undefined) {
      const delMeta = this.getStatement("DELETE FROM ai_knowledge_files WHERE file_path = ? AND scope = ?");
      delMeta.run(filePath, scope);
      this.deleteChunksByFile(filePath, scope);
    } else {
      const delMeta = this.getStatement("DELETE FROM ai_knowledge_files WHERE file_path = ?");
      delMeta.run(filePath);
      this.deleteChunksByFile(filePath);
    }
  }

  /**
   * Save chunks for a file and index them in FTS5.
   * Wrapped in a transaction for 100x+ faster bulk insertion.
   */
  saveChunks(filePath: string, chunks: Array<{ heading: string; content: string; tokens: number }>, scope: string = ""): void {
    const insertChunk = this.getStatement(`
      INSERT INTO ai_knowledge_chunks (file_path, heading, content, tokens, scope)
      VALUES (?, ?, ?, ?, ?)
    `);

    let insertFts: any;
    try {
      insertFts = this.getStatement(`
        INSERT INTO ai_knowledge_fts (rowid, heading, content, file_path)
        VALUES (?, ?, ?, ?)
      `);
    } catch {
      insertFts = null;
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION;");
    try {
      // Delete existing chunks for this file first
      this.deleteChunksByFile(filePath, scope);

      for (const chunk of chunks) {
        const info = insertChunk.run(filePath, chunk.heading, chunk.content, chunk.tokens, scope);
        const chunkId = Number(info.lastInsertRowid);
        if (insertFts) {
          try {
            insertFts.run(chunkId, chunk.heading, chunk.content, filePath);
          } catch {
            // ignore FTS insert errors
          }
        }
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  }

  /**
   * Delete all chunks belonging to a file.
   */
  deleteChunksByFile(filePath: string, scope?: string): void {
    try {
      if (scope !== undefined) {
        const delFts = this.getStatement(`
          DELETE FROM ai_knowledge_fts
          WHERE rowid IN (SELECT id FROM ai_knowledge_chunks WHERE file_path = ? AND scope = ?)
        `);
        delFts.run(filePath, scope);
      } else {
        const delFts = this.getStatement(`
          DELETE FROM ai_knowledge_fts
          WHERE rowid IN (SELECT id FROM ai_knowledge_chunks WHERE file_path = ?)
        `);
        delFts.run(filePath);
      }
    } catch {
      // ignore
    }

    if (scope !== undefined) {
      const delChunks = this.getStatement("DELETE FROM ai_knowledge_chunks WHERE file_path = ? AND scope = ?");
      delChunks.run(filePath, scope);
    } else {
      const delChunks = this.getStatement("DELETE FROM ai_knowledge_chunks WHERE file_path = ?");
      delChunks.run(filePath);
    }
  }

  /**
   * Search knowledge base chunks matching a query via FTS5 with fallback to LIKE search.
   * Returns empty array if no matches are found, unless fallbackOnNoMatch is explicitly set.
   */
  searchChunks(
    query: string,
    limit: number = 5,
    scope?: string,
    options?: { fallbackOnNoMatch?: boolean }
  ): KnowledgeChunk[] {
    const rawQuery = typeof query === "string" ? query : String(query ?? "");
    const cleanedQuery = rawQuery.trim().replace(/['"^*]/g, " ");
    if (!cleanedQuery) {
      return this.getAllChunks(limit, scope);
    }

    // Try FTS5 MATCH first
    try {
      // Split query into keywords for OR/AND match, including CJK n-grams
      const rawWords = cleanedQuery
        .split(/[\s,，.。!！?？;；:：、/\\_—-]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      const wordSet = new Set(rawWords);
      for (const word of rawWords) {
        if (/[\u4e00-\u9fa5]/.test(word)) {
          for (let i = 0; i < word.length - 1; i++) {
            wordSet.add(word.slice(i, i + 2));
            if (i < word.length - 2) {
              wordSet.add(word.slice(i, i + 3));
            }
          }
        }
      }

      const words = Array.from(wordSet);

      if (words.length > 0) {
        const ftsQuery = words.map((w) => `"${w}"*`).join(" OR ");
        const stmt = scope !== undefined
          ? this.getStatement(`
              SELECT c.id, c.file_path, c.heading, c.content, c.tokens, c.scope
              FROM ai_knowledge_fts f
              JOIN ai_knowledge_chunks c ON c.id = f.rowid
              WHERE ai_knowledge_fts MATCH ? AND c.scope = ?
              LIMIT ?
            `)
          : this.getStatement(`
              SELECT c.id, c.file_path, c.heading, c.content, c.tokens, c.scope
              FROM ai_knowledge_fts f
              JOIN ai_knowledge_chunks c ON c.id = f.rowid
              WHERE ai_knowledge_fts MATCH ?
              LIMIT ?
            `);

        const rows = (scope !== undefined
          ? stmt.all(ftsQuery, scope, limit)
          : stmt.all(ftsQuery, limit)) as Array<{
          id: number;
          file_path: string;
          heading: string;
          content: string;
          tokens: number;
          scope: string;
        }>;

        if (rows && rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            filePath: r.file_path,
            heading: r.heading,
            content: r.content,
            tokens: r.tokens,
            scope: r.scope,
          }));
        }
      }
    } catch {
      // Fallback to substring matching below
    }

    // Fallback: substring matching using LIKE with candidate keywords
    try {
      const rawWords = cleanedQuery
        .split(/[\s,，.。!！?？;；:：、/\\_—-]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      const termSet = new Set<string>();
      if (cleanedQuery.length <= 50) {
        termSet.add(cleanedQuery);
      }
      for (const w of rawWords) {
        if (w.length >= 2) {
          termSet.add(w);
        }
        if (/[\u4e00-\u9fa5]/.test(w)) {
          for (let i = 0; i < w.length - 1; i++) {
            termSet.add(w.slice(i, i + 2));
            if (i < w.length - 2) {
              termSet.add(w.slice(i, i + 3));
            }
          }
        }
      }

      const terms = Array.from(termSet)
        .filter((t) => t.trim().length >= 2)
        .sort((a, b) => b.length - a.length)
        .slice(0, 12);

      if (terms.length > 0) {
        const clauses: string[] = [];
        const params: any[] = [];
        for (const term of terms) {
          clauses.push("(c.heading LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')");
          const pat = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
          params.push(pat, pat);
        }

        const whereClause = clauses.join(" OR ");
        const sql = scope !== undefined
          ? `SELECT c.id, c.file_path, c.heading, c.content, c.tokens, c.scope
             FROM ai_knowledge_chunks c
             WHERE (${whereClause}) AND c.scope = ?
             LIMIT ?`
          : `SELECT c.id, c.file_path, c.heading, c.content, c.tokens, c.scope
             FROM ai_knowledge_chunks c
             WHERE ${whereClause}
             LIMIT ?`;

        const queryParams = scope !== undefined ? [...params, scope, limit * 3] : [...params, limit * 3];
        const stmt = this.getStatement(sql);
        const rows = stmt.all(...queryParams) as Array<{
          id: number;
          file_path: string;
          heading: string;
          content: string;
          tokens: number;
          scope: string;
        }>;

        if (rows && rows.length > 0) {
          // Rank chunks by term relevance
          const scored = rows.map((r) => {
            let score = 0;
            for (const t of terms) {
              if (r.heading.includes(t)) score += t.length * 3;
              if (r.content.includes(t)) score += t.length;
            }
            return { r, score };
          });

          scored.sort((a, b) => b.score - a.score);
          return scored.slice(0, limit).map((s) => ({
            id: s.r.id,
            filePath: s.r.file_path,
            heading: s.r.heading,
            content: s.r.content,
            tokens: s.r.tokens,
            scope: s.r.scope,
          }));
        }
      }
    } catch {
      // Fallback to getAllChunks below
    }

    return options?.fallbackOnNoMatch ? this.getAllChunks(limit, scope) : [];
  }

  /**
   * Get all chunks up to a limit.
   */
  getAllChunks(limit: number = 20, scope?: string): KnowledgeChunk[] {
    let rows: any[];
    if (scope !== undefined) {
      const stmt = this.getStatement(`
        SELECT id, file_path, heading, content, tokens, scope
        FROM ai_knowledge_chunks
        WHERE scope = ?
        LIMIT ?
      `);
      rows = stmt.all(scope, limit);
    } else {
      const stmt = this.getStatement(`
        SELECT id, file_path, heading, content, tokens, scope
        FROM ai_knowledge_chunks
        LIMIT ?
      `);
      rows = stmt.all(limit);
    }
    return rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      heading: r.heading,
      content: r.content,
      tokens: r.tokens,
      scope: r.scope,
    }));
  }

  /**
   * Fast outline retrieval without fetching large content text.
   */
  getKnowledgeOutline(limit: number = 100, scope?: string): Array<{ filePath: string; heading: string }> {
    let rows: any[];
    if (scope !== undefined) {
      const stmt = this.getStatement(`
        SELECT DISTINCT file_path, heading
        FROM ai_knowledge_chunks
        WHERE scope = ?
        LIMIT ?
      `);
      rows = stmt.all(scope, limit);
    } else {
      const stmt = this.getStatement(`
        SELECT DISTINCT file_path, heading
        FROM ai_knowledge_chunks
        LIMIT ?
      `);
      rows = stmt.all(limit);
    }
    return rows.map((r) => ({
      filePath: r.file_path,
      heading: r.heading,
    }));
  }

  /**
   * Get count of indexed files.
   */
  get indexedFileCount(): number {
    const stmt = this.getStatement("SELECT COUNT(*) as cnt FROM ai_knowledge_files");
    const row = stmt.get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Get count of stored chunks.
   */
  get chunkCount(): number {
    const stmt = this.getStatement("SELECT COUNT(*) as cnt FROM ai_knowledge_chunks");
    const row = stmt.get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Clear all sessions from SQLite storage.
   */
  async clear(): Promise<void> {
    this.db.exec("DELETE FROM ai_sessions;");
  }

  /**
   * Clear all knowledge base indexes and chunks.
   */
  clearKnowledgeBase(): void {
    this.db.exec(`
      DELETE FROM ai_knowledge_files;
      DELETE FROM ai_knowledge_chunks;
    `);
    try {
      this.db.exec("DELETE FROM ai_knowledge_fts;");
    } catch {
      // ignore
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
