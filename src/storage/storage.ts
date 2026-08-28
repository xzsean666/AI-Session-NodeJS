import type { SessionData } from "../types/session.js";

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
   * List all sessions belonging to a specific userId.
   */
  listSessions(userId: string): Promise<SessionData[]>;
}
