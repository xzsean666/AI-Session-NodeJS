import { createHash } from "node:crypto";
import type { IProvider } from "../provider/provider.js";
import type {
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChunkResponse,
} from "../types/provider.js";

export interface ResponseCacheOptions {
  /**
   * Time to live in milliseconds for cached responses. Defaults to 5 minutes (300,000ms).
   * Set to 0 to disable TTL expiration.
   */
  ttlMs?: number;

  /**
   * Maximum number of entries stored in the LRU cache. Defaults to 1000.
   */
  maxEntries?: number;

  /**
   * Custom key generator function.
   */
  keyGenerator?: (request: ProviderChatRequest, protocol: string) => string;
}

interface CacheEntry {
  response: ProviderChatResponse;
  expiresAt: number;
}

/**
 * High-performance in-memory LRU Response Cache with TTL expiration.
 */
export class ResponseCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly customKeyGen?: (request: ProviderChatRequest, protocol: string) => string;

  constructor(options: ResponseCacheOptions = {}) {
    this.defaultTtlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 1000;
    this.customKeyGen = options.keyGenerator;
  }

  /**
   * Generates a deterministic hash key for a chat request.
   */
  generateKey(request: ProviderChatRequest, protocol: string = ""): string {
    if (this.customKeyGen) {
      return this.customKeyGen(request, protocol);
    }

    const payload = {
      protocol,
      model: request.model ?? "",
      system: request.system ?? "",
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  /**
   * Retrieve a cached response if valid and not expired.
   */
  get(key: string): ProviderChatResponse | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Refresh LRU order (delete & re-insert)
    this.map.delete(key);
    this.map.set(key, entry);

    return {
      role: "assistant",
      content: entry.response.content,
      usage: entry.response.usage ? { ...entry.response.usage } : undefined,
      raw: {
        ...(typeof entry.response.raw === "object" && entry.response.raw !== null
          ? (entry.response.raw as Record<string, unknown>)
          : {}),
        cached: true,
      },
    };
  }

  /**
   * Store a chat response in the cache.
   */
  set(key: string, response: ProviderChatResponse, ttlMs?: number): void {
    const ttl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
    const expiresAt = ttl > 0 ? Date.now() + ttl : 0;

    // Enforce max entries via LRU eviction
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(key, {
      response: {
        role: "assistant",
        content: response.content,
        usage: response.usage ? { ...response.usage } : undefined,
        raw: response.raw,
      },
      expiresAt,
    });
  }

  /**
   * Check if a key is present and not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete an entry by key.
   */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Total number of cached entries.
   */
  get size(): number {
    return this.map.size;
  }
}

/**
 * CachedProvider wraps any IProvider with response-level caching.
 */
export class CachedProvider implements IProvider {
  public readonly protocol: string;
  private readonly provider: IProvider;
  private readonly cache: ResponseCache;

  constructor(provider: IProvider, options?: ResponseCacheOptions | ResponseCache) {
    this.protocol = provider.protocol;
    this.provider = provider;
    if (options instanceof ResponseCache) {
      this.cache = options;
    } else {
      this.cache = new ResponseCache(options);
    }
  }

  getCache(): ResponseCache {
    return this.cache;
  }

  getUnderlyingProvider(): IProvider {
    return this.provider;
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const noCache = Boolean(request.customOptions?.noCache);

    if (!noCache) {
      const key = this.cache.generateKey(request, this.protocol);
      const cached = this.cache.get(key);
      if (cached) {
        return cached;
      }
    }

    const response = await this.provider.chat(request);

    if (!noCache) {
      const key = this.cache.generateKey(request, this.protocol);
      this.cache.set(key, response);
    }

    return response;
  }

  async chatStream(request: ProviderChatRequest): Promise<AsyncIterable<ProviderChunkResponse>> {
    const noCache = Boolean(request.customOptions?.noCache);
    const key = this.cache.generateKey(request, this.protocol);

    if (!noCache) {
      const cached = this.cache.get(key);
      if (cached) {
        return (async function* () {
          // Playback cached content in chunks
          const text = cached.content;
          const chunkSize = 20;
          for (let i = 0; i < text.length; i += chunkSize) {
            yield {
              delta: text.slice(i, i + chunkSize),
              role: "assistant",
              done: false,
              raw: { cached: true },
            };
          }
          yield {
            delta: "",
            role: "assistant",
            done: true,
            usage: cached.usage,
            raw: { cached: true },
          };
        })();
      }
    }

    const underlyingStream = await this.provider.chatStream(request);
    const cache = this.cache;

    return (async function* () {
      let accumulatedContent = "";
      let finalUsage = undefined;
      let finalRaw = undefined;

      for await (const chunk of underlyingStream) {
        accumulatedContent += chunk.delta || "";
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
        if (chunk.raw) {
          finalRaw = chunk.raw;
        }
        yield chunk;
      }

      if (!noCache && accumulatedContent.length > 0) {
        cache.set(key, {
          role: "assistant",
          content: accumulatedContent,
          usage: finalUsage,
          raw: finalRaw,
        });
      }
    })();
  }
}
