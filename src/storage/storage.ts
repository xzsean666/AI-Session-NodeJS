import type { SessionData } from "../types/session.js";

export interface ListSessionsOptions {
  /**
   * Maximum number of sessions to return.
   */
  limit?: number;
  /**
   * Number of sessions to skip (for pagination).
   */
  offset?: number;
  /**
   * Keyword search filtering across sessionId, systemContext, summary, or messages content.
   */
  search?: string;
  /**
   * Field to sort by. Defaults to 'updatedAt'.
   */
  sortBy?: "updatedAt" | "createdAt";
  /**
   * Sort direction. Defaults to 'desc' (newest first).
   */
  sortOrder?: "asc" | "desc";
}

/**
 * Storage interface for persisting and managing AI session data.
 * All operations are scoped by userId for isolation.
 */
export interface IStorage {
  /**
   * Save a new session or overwrite an existing session.
   */
  saveSession(session: SessionData): Promise<void>;

  /**
   * Load session data by userId and sessionId.
   * Returns null if session is not found.
   */
  loadSession(userId: string, sessionId: string): Promise<SessionData | null>;

  /**
   * Update an existing session.
   * Throws SessionNotFoundError or StorageError if update fails.
   */
  updateSession(session: SessionData): Promise<void>;

  /**
   * Delete a session by userId and sessionId.
   * Returns true if deleted, false if session did not exist.
   */
  deleteSession(userId: string, sessionId: string): Promise<boolean>;

  /**
   * List sessions belonging to a specific userId with optional filtering and pagination.
   */
  listSessions(userId: string, options?: ListSessionsOptions): Promise<SessionData[]>;
}
