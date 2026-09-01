import type { IStorage } from "./storage.js";
import type { SessionData } from "../types/session.js";
import { InvalidRequestError } from "../types/errors.js";

export interface StorageCacheOptions {
  /**
   * Time to live in milliseconds for cached sessions in memory.
   * Defaults to 10 minutes (600,000ms). 0 disables TTL expiration.
   */
  ttlMs?: number;

  /**
   * Maximum number of session items kept in L1 memory cache. Defaults to 500.
   */
  maxSessions?: number;
}

interface CacheItem {
  session: SessionData;
  expiresAt: number;
}

/**
 * CachedStorage wraps any IStorage (e.g. SQLiteStorage, Redis) with a high-speed L1 in-memory LRU cache.
 * Accelerates multi-turn chat interactions by avoiding repeated disk I/O and JSON deserialization.
 */
export class CachedStorage implements IStorage {
  private readonly underlying: IStorage;
  private readonly memoryCache = new Map<string, CacheItem>();
  private readonly defaultTtlMs: number;
  private readonly maxSessions: number;

  constructor(underlying: IStorage, options: StorageCacheOptions = {}) {
    if (!underlying) {
      throw new InvalidRequestError("CachedStorage requires an underlying IStorage instance");
    }
    this.underlying = underlying;
    this.defaultTtlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 500;

    // Proxy any custom methods/properties on underlying storage (e.g., knowledge base methods on SQLiteStorage)
    return new Proxy(this, {
      get(target: any, prop: string | symbol, receiver: any) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        const underlyingProp = (target.underlying as any)?.[prop];
        if (typeof underlyingProp === "function") {
          return underlyingProp.bind(target.underlying);
        }
        return underlyingProp;
      },
    });
  }

  private getCacheKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  private cloneSession(session: SessionData): SessionData {
    return {
      ...session,
      messages: session.messages.map((m) => ({ ...m })),
      metadata: session.metadata ? { ...session.metadata } : undefined,
    };
  }

  getUnderlyingStorage(): IStorage {
    return this.underlying;
  }

  /**
   * Clear in-memory L1 cache.
   */
  clearCache(): void {
    this.memoryCache.clear();
  }

  /**
   * Current number of cached sessions in L1 memory.
   */
  get cachedCount(): number {
    return this.memoryCache.size;
  }

  async saveSession(session: SessionData): Promise<void> {
    if (!session || !session.userId || !session.sessionId) {
      throw new InvalidRequestError("Session must contain valid userId and sessionId");
    }

    const key = this.getCacheKey(session.userId, session.sessionId);
    const expiresAt = this.defaultTtlMs > 0 ? Date.now() + this.defaultTtlMs : 0;

    // Maintain LRU size
    if (this.memoryCache.size >= this.maxSessions && !this.memoryCache.has(key)) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.memoryCache.delete(oldestKey);
      }
    }

    this.memoryCache.set(key, {
      session: this.cloneSession(session),
      expiresAt,
    });

    await this.underlying.saveSession(session);
  }

  async loadSession(userId: string, sessionId: string): Promise<SessionData | null> {
    if (!userId || !sessionId) {
      throw new InvalidRequestError("userId and sessionId are required");
    }

    const key = this.getCacheKey(userId, sessionId);
    const item = this.memoryCache.get(key);

    if (item) {
      if (item.expiresAt === 0 || Date.now() <= item.expiresAt) {
        // Refresh LRU position
        this.memoryCache.delete(key);
        this.memoryCache.set(key, item);
        return this.cloneSession(item.session);
      }
      this.memoryCache.delete(key);
    }

    // Cache miss -> read from underlying storage
    const session = await this.underlying.loadSession(userId, sessionId);
    if (session) {
      const expiresAt = this.defaultTtlMs > 0 ? Date.now() + this.defaultTtlMs : 0;
      this.memoryCache.set(key, {
        session: this.cloneSession(session),
        expiresAt,
      });
      return this.cloneSession(session);
    }

    return null;
  }

  async updateSession(session: SessionData): Promise<void> {
    if (!session || !session.userId || !session.sessionId) {
      throw new InvalidRequestError("Session must contain valid userId and sessionId");
    }

    const key = this.getCacheKey(session.userId, session.sessionId);
    const expiresAt = this.defaultTtlMs > 0 ? Date.now() + this.defaultTtlMs : 0;

    this.memoryCache.set(key, {
      session: this.cloneSession(session),
      expiresAt,
    });

    await this.underlying.updateSession(session);
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    if (!userId || !sessionId) {
      throw new InvalidRequestError("userId and sessionId are required");
    }

    const key = this.getCacheKey(userId, sessionId);
    this.memoryCache.delete(key);

    return this.underlying.deleteSession(userId, sessionId);
  }

  async listSessions(userId: string): Promise<SessionData[]> {
    return this.underlying.listSessions(userId);
  }
}
