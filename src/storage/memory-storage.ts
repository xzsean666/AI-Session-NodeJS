import type { IStorage, ListSessionsOptions } from "./storage.js";
import type { SessionData } from "../types/session.js";
import { SessionNotFoundError, InvalidRequestError } from "../types/errors.js";

/**
 * In-memory implementation of IStorage for development, testing, and ephemeral sessions.
 * Isolates data per userId + sessionId and uses deep cloning to avoid external reference mutation.
 */
export class MemoryStorage implements IStorage {
  private sessions = new Map<string, SessionData>();

  private getKey(userId: string, sessionId: string): string {
    return `${encodeURIComponent(userId)}\0${encodeURIComponent(sessionId)}`;
  }

  private clone<T>(data: T): T {
    return structuredClone(data);
  }

  /**
   * Save a new session or overwrite an existing session.
   */
  async saveSession(session: SessionData): Promise<void> {
    if (!session || !session.userId || !session.sessionId) {
      throw new InvalidRequestError("Session must contain valid userId and sessionId");
    }
    const key = this.getKey(session.userId, session.sessionId);
    this.sessions.set(key, this.clone(session));
  }

  /**
   * Load session data by userId and sessionId.
   * Returns null if session is not found.
   */
  async loadSession(userId: string, sessionId: string): Promise<SessionData | null> {
    if (!userId || !sessionId) {
      return null;
    }
    const key = this.getKey(userId, sessionId);
    const session = this.sessions.get(key);
    if (!session) {
      return null;
    }
    return this.clone(session);
  }

  /**
   * Update an existing session.
   * Throws SessionNotFoundError if session does not exist.
   */
  async updateSession(session: SessionData): Promise<void> {
    if (!session || !session.userId || !session.sessionId) {
      throw new InvalidRequestError("Session must contain valid userId and sessionId");
    }
    const key = this.getKey(session.userId, session.sessionId);
    if (!this.sessions.has(key)) {
      throw new SessionNotFoundError(session.userId, session.sessionId);
    }
    this.sessions.set(key, this.clone(session));
  }

  /**
   * Delete a session by userId and sessionId.
   * Returns true if deleted, false if session did not exist.
   */
  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    if (!userId || !sessionId) {
      return false;
    }
    const key = this.getKey(userId, sessionId);
    return this.sessions.delete(key);
  }

  /**
   * List all sessions belonging to a specific userId with optional filtering and pagination.
   */
  async listSessions(userId: string, options?: ListSessionsOptions): Promise<SessionData[]> {
    if (!userId) {
      return [];
    }
    let results: SessionData[] = [];
    const searchLower = options?.search?.toLowerCase();

    for (const [, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        if (searchLower) {
          const matchSessionId = session.sessionId.toLowerCase().includes(searchLower);
          const matchSummary = session.summary?.toLowerCase().includes(searchLower);
          const matchSystem = session.systemContext?.toLowerCase().includes(searchLower);
          const matchMsg = session.messages.some((m) =>
            typeof m.content === "string" ? m.content.toLowerCase().includes(searchLower) : false
          );
          if (!matchSessionId && !matchSummary && !matchSystem && !matchMsg) {
            continue;
          }
        }
        results.push(this.clone(session));
      }
    }

    const sortBy = options?.sortBy ?? "updatedAt";
    const sortOrder = options?.sortOrder ?? "desc";

    results.sort((a, b) => {
      const valA = a[sortBy] ?? 0;
      const valB = b[sortBy] ?? 0;
      return sortOrder === "asc" ? valA - valB : valB - valA;
    });

    const offset = options?.offset ?? 0;
    if (offset > 0) {
      results = results.slice(offset);
    }
    if (options?.limit !== undefined && options.limit >= 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * Clear all sessions in memory. Useful for test cleanups.
   */
  async clear(): Promise<void> {
    this.sessions.clear();
  }

  /**
   * Get total count of stored sessions across all users.
   */
  get size(): number {
    return this.sessions.size;
  }
}
