import type { IStorage } from "../storage/storage.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import { SQLiteStorage } from "../storage/sqlite-storage.js";
import type { IProvider } from "../provider/provider.js";
import type { ProviderConfig } from "../types/provider.js";
import { ProviderManager } from "../provider/provider-manager.js";
import { Session, type SessionContextBuilder } from "../session/session.js";
import { ContextManager, type ContextManagerOptions } from "../context/context-manager.js";
import type { SessionOptions, SessionData } from "../types/session.js";
import { InvalidRequestError } from "../types/errors.js";

export interface AIClientOptions {
  provider: ProviderConfig | IProvider;
  storage?: IStorage;
  /**
   * Path to SQLite database if using default SQLite storage. Defaults to './data/ai-session.db'.
   */
  dbPath?: string;
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

    if ("chat" in options.provider && typeof options.provider.chat === "function") {
      this.provider = options.provider;
    } else {
      this.provider = ProviderManager.createProvider(options.provider as ProviderConfig);
    }

    this.storage =
      options.storage ??
      new SQLiteStorage({ dbPath: options.dbPath ?? "./data/ai-session.db" });
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
