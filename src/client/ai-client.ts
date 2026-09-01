import type { IStorage } from "../storage/storage.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import { SQLiteStorage } from "../storage/sqlite-storage.js";
import { CachedStorage, type StorageCacheOptions } from "../storage/cached-storage.js";
import type { IProvider } from "../provider/provider.js";
import type { ProviderConfig } from "../types/provider.js";
import { ProviderManager } from "../provider/provider-manager.js";
import { LoadBalancedProvider, type LoadBalancedProviderOptions } from "../provider/load-balanced-provider.js";
import { CachedProvider, ResponseCache, type ResponseCacheOptions } from "../cache/response-cache.js";
import { Session, type SessionContextBuilder } from "../session/session.js";
import { ContextManager, type ContextManagerOptions } from "../context/context-manager.js";
import type { SessionOptions, SessionData } from "../types/session.js";
import { InvalidRequestError } from "../types/errors.js";

export interface AIClientOptions {
  provider: ProviderConfig | LoadBalancedProviderOptions | IProvider;
  storage?: IStorage;
  /**
   * Path to SQLite database if using default SQLite storage. Defaults to './data/ai-session.db'.
   */
  dbPath?: string;
  /**
   * Enable or configure response-level caching. Set true to use default 5min TTL in-memory LRU cache.
   */
  cache?: boolean | ResponseCacheOptions | ResponseCache;
  /**
   * Enable or configure L1 in-memory session cache for storage. Defaults to false.
   */
  storageCache?: boolean | StorageCacheOptions;
  contextBuilder?: SessionContextBuilder;
  contextOptions?: ContextManagerOptions;
}

/**
 * AIClient is the primary entry point for configuring providers, storage, context management, and creating sessions.
 */
export class AIClient {
  private readonly provider: IProvider;
  private readonly storage: IStorage;
  private readonly contextBuilder: SessionContextBuilder;

  constructor(options: AIClientOptions) {
    if (!options || !options.provider) {
      throw new InvalidRequestError("AIClient requires a provider configuration or IProvider instance");
    }

    let rawProvider: IProvider;

    if ("chat" in options.provider && typeof options.provider.chat === "function") {
      rawProvider = options.provider;
    } else {
      const cfg = options.provider as ProviderConfig;
      const isLoadBalanced =
        (cfg.endpoints && cfg.endpoints.length > 0) ||
        (cfg.targets && cfg.targets.length > 0) ||
        (cfg.baseUrls && cfg.baseUrls.length > 1) ||
        (cfg.apiKeys && cfg.apiKeys.length > 1) ||
        Boolean(cfg.loadBalance);

      if (isLoadBalanced) {
        rawProvider = new LoadBalancedProvider({
          ...cfg,
          strategy: cfg.loadBalance?.strategy,
          cooldownMs: cfg.loadBalance?.cooldownMs,
          maxRetries: cfg.loadBalance?.maxRetries,
        });
      } else {
        rawProvider = ProviderManager.createProvider(cfg);
      }
    }

    // Apply response-level caching if configured
    if (options.cache) {
      if (options.cache === true) {
        this.provider = new CachedProvider(rawProvider);
      } else {
        this.provider = new CachedProvider(rawProvider, options.cache);
      }
    } else {
      this.provider = rawProvider;
    }

    let baseStorage =
      options.storage ??
      new SQLiteStorage({ dbPath: options.dbPath ?? "./data/ai-session.db" });

    // Apply storage L1 caching if configured
    if (options.storageCache) {
      const storageOpts = typeof options.storageCache === "object" ? options.storageCache : undefined;
      this.storage = new CachedStorage(baseStorage, storageOpts);
    } else {
      this.storage = baseStorage;
    }

    this.contextBuilder =
      options.contextBuilder ?? new ContextManager(options.contextOptions);
  }

  /**
   * Create or open a Session for a specific userId and sessionId.
   */
  session(options: SessionOptions): Session {
    return new Session({
      userId: options.userId,
      sessionId: options.sessionId,
      system: options.system,
      systemContext: options.systemContext,
      metadata: options.metadata,
      storage: this.storage,
      provider: this.provider,
      contextBuilder: this.contextBuilder,
    });
  }

  /**
   * Load an existing session if present in storage, otherwise returns null.
   */
  async loadSession(userId: string, sessionId: string): Promise<Session | null> {
    const existing = await this.storage.loadSession(userId, sessionId);
    if (!existing) {
      return null;
    }
    return this.session({
      userId,
      sessionId,
      systemContext: existing.systemContext,
      metadata: existing.metadata,
    });
  }

  /**
   * List all stored sessions for a given userId.
   */
  async listSessions(userId: string): Promise<SessionData[]> {
    return this.storage.listSessions(userId);
  }

  /**
   * Delete a session by userId and sessionId.
   */
  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    return this.storage.deleteSession(userId, sessionId);
  }

  /**
   * Access underlying storage instance.
   */
  getStorage(): IStorage {
    return this.storage;
  }

  /**
   * Access underlying provider instance.
   */
  getProvider(): IProvider {
    return this.provider;
  }

  /**
   * Access configured context builder instance.
   */
  getContextBuilder(): SessionContextBuilder {
    return this.contextBuilder;
  }
}
