import type { IProvider } from "./provider.js";
import type {
  EndpointTarget,
  LoadBalanceOptions,
  LoadBalanceStrategy,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChunkResponse,
  ProviderConfig,
  ProviderProtocol,
  TargetInfo,
} from "../types/provider.js";
import { InvalidRequestError, ProviderError, RateLimitError } from "../types/errors.js";
import { ProviderManager } from "./provider-manager.js";

export interface LoadBalancedProviderOptions extends LoadBalanceOptions {
  protocol: ProviderProtocol;
  model: string;
  targets?: EndpointTarget[];
  endpoints?: EndpointTarget[];
  baseUrl?: string;
  baseUrls?: string[];
  apiKey?: string;
  apiKeys?: string[];
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  customOptions?: Record<string, unknown>;
}

/**
 * Normalizes various options into a clean list of EndpointTarget objects.
 */
export function normalizeEndpointTargets(options: {
  targets?: EndpointTarget[];
  endpoints?: EndpointTarget[];
  baseUrl?: string;
  baseUrls?: string[];
  apiKey?: string;
  apiKeys?: string[];
  headers?: Record<string, string>;
  customOptions?: Record<string, unknown>;
}): EndpointTarget[] {
  const explicitTargets = options.endpoints ?? options.targets;
  if (explicitTargets && explicitTargets.length > 0) {
    return explicitTargets.map((t) => ({
      protocol: t.protocol,
      baseUrl: t.baseUrl,
      apiKey: t.apiKey !== undefined ? t.apiKey : options.apiKey,
      model: t.model,
      weight: t.weight ?? 1,
      headers: { ...options.headers, ...t.headers },
      customOptions: { ...options.customOptions, ...t.customOptions },
    }));
  }

  const baseUrls: string[] = [];
  if (options.baseUrls && options.baseUrls.length > 0) {
    baseUrls.push(...options.baseUrls);
  } else if (options.baseUrl) {
    baseUrls.push(options.baseUrl);
  }

  const apiKeys: Array<string | undefined> = [];
  if (options.apiKeys && options.apiKeys.length > 0) {
    apiKeys.push(...options.apiKeys);
  } else if (options.apiKey !== undefined) {
    apiKeys.push(options.apiKey);
  } else {
    apiKeys.push(undefined);
  }

  if (baseUrls.length === 0) {
    throw new InvalidRequestError("LoadBalancedProvider requires at least one baseUrl or target");
  }

  const result: EndpointTarget[] = [];

  if (baseUrls.length === 1 && apiKeys.length > 1) {
    // 1 URL + multiple API Keys
    for (const key of apiKeys) {
      result.push({
        baseUrl: baseUrls[0],
        apiKey: key,
        weight: 1,
        headers: options.headers,
        customOptions: options.customOptions,
      });
    }
  } else if (baseUrls.length > 1 && apiKeys.length === 1) {
    // Multiple URLs + 1 shared API Key
    for (const url of baseUrls) {
      result.push({
        baseUrl: url,
        apiKey: apiKeys[0],
        weight: 1,
        headers: options.headers,
        customOptions: options.customOptions,
      });
    }
  } else if (baseUrls.length === apiKeys.length) {
    // Pair 1-to-1
    for (let i = 0; i < baseUrls.length; i++) {
      result.push({
        baseUrl: baseUrls[i],
        apiKey: apiKeys[i],
        weight: 1,
        headers: options.headers,
        customOptions: options.customOptions,
      });
    }
  } else {
    // Cross product or fallback
    for (const url of baseUrls) {
      for (const key of apiKeys) {
        result.push({
          baseUrl: url,
          apiKey: key,
          weight: 1,
          headers: options.headers,
          customOptions: options.customOptions,
        });
      }
    }
  }

  return result;
}

/**
 * LoadBalancedProvider distributes chat completions across multiple API Keys or Endpoint URLs
 * with support for Priority (Active/Passive Relay), Round-Robin, Random, Weighted routing,
 * 429 rate limit cooldown, and automatic failover.
 */
export class LoadBalancedProvider implements IProvider {
  public readonly protocol: string;
  private readonly model: string;
  private readonly rawOptions: LoadBalancedProviderOptions;
  private targets: EndpointTarget[];
  private providers: IProvider[];
  private strategy: LoadBalanceStrategy;
  private readonly cooldownMs: number;
  private readonly maxRetries: number;
  private readonly sessionAffinity: boolean;
  private readonly repinOnFailover: boolean;
  private readonly maxPinnedSessions: number;
  private readonly cooldowns: Map<number, number> = new Map();
  private readonly pinnedSessions: Map<string, number> = new Map();
  private currentIndex = 0;

  constructor(options: LoadBalancedProviderOptions) {
    if (!options || !options.protocol) {
      throw new InvalidRequestError("LoadBalancedProvider requires a valid protocol");
    }
    if (!options.model) {
      throw new InvalidRequestError("LoadBalancedProvider requires a model");
    }

    this.rawOptions = options;
    this.protocol = options.protocol;
    this.model = options.model;
    this.targets = normalizeEndpointTargets(options);
    this.strategy = options.strategy ?? "round-robin";
    this.cooldownMs = options.cooldownMs ?? 30000;
    this.maxRetries = options.maxRetries ?? Math.max(this.targets.length, 1);
    this.sessionAffinity = Boolean(options.sessionAffinity ?? options.pinSession);
    this.repinOnFailover = options.repinOnFailover !== false;
    this.maxPinnedSessions = options.maxPinnedSessions ?? 10000;
    this.providers = [];
    this.rebuildProviders();
  }

  /**
   * Rebuild internal IProvider instances for each target.
   */
  private rebuildProviders(): void {
    const fetchFn = this.rawOptions.fetch;
    this.providers = this.targets.map((target) => {
      const config: ProviderConfig = {
        protocol: target.protocol ?? this.protocol,
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model ?? this.model,
        headers: target.headers,
        fetch: fetchFn,
        customOptions: {
          maxRetries: 0,
          ...target.customOptions,
        },
      };
      return ProviderManager.createProvider(config);
    });
  }

  /**
   * Safely set a pinned session with LRU eviction to prevent unbounded memory growth.
   */
  private setPinnedSession(sessionId: string, index: number): void {
    this.pinnedSessions.delete(sessionId);
    if (this.pinnedSessions.size >= this.maxPinnedSessions) {
      const oldest = this.pinnedSessions.keys().next().value;
      if (oldest !== undefined) {
        this.pinnedSessions.delete(oldest);
      }
    }
    this.pinnedSessions.set(sessionId, index);
  }

  /**
   * Match target index from targetIndex number, baseUrl string, or EndpointTarget object.
   */
  findTargetIndex(target: number | string | EndpointTarget): number {
    if (typeof target === "number") {
      if (target >= 0 && target < this.targets.length) {
        return target;
      }
      return -1;
    }

    if (typeof target === "string") {
      const exact = this.targets.findIndex((t) => t.baseUrl === target);
      if (exact >= 0) return exact;
      return this.targets.findIndex((t) => t.baseUrl.includes(target));
    }

    if (target && typeof target === "object" && target.baseUrl) {
      return this.targets.findIndex((t) => {
        if (t.baseUrl !== target.baseUrl) return false;
        if (target.apiKey !== undefined && t.apiKey !== target.apiKey) return false;
        return true;
      });
    }

    return -1;
  }

  /**
   * Explicitly pin a session to a specific target endpoint.
   */
  pinSession(sessionId: string, target: number | string | EndpointTarget): void {
    if (!sessionId) {
      throw new InvalidRequestError("pinSession requires a non-empty sessionId");
    }
    const index = this.findTargetIndex(target);
    if (index < 0) {
      throw new InvalidRequestError(
        `Cannot pin session: target "${typeof target === "object" ? target.baseUrl : target}" not found`
      );
    }
    this.setPinnedSession(sessionId, index);
  }

  /**
   * Unpin a session, reverting it to standard load balancing.
   */
  unpinSession(sessionId: string): boolean {
    return this.pinnedSessions.delete(sessionId);
  }

  /**
   * Get pinned target index for a sessionId, if established.
   * Accessing the index refreshes its recency in the LRU eviction queue.
   */
  getPinnedTargetIndex(sessionId: string): number | undefined {
    const idx = this.pinnedSessions.get(sessionId);
    if (idx !== undefined) {
      this.pinnedSessions.delete(sessionId);
      this.pinnedSessions.set(sessionId, idx);
    }
    return idx;
  }

  /**
   * Get pinned EndpointTarget object for a sessionId.
   */
  getPinnedTarget(sessionId: string): EndpointTarget | undefined {
    const idx = this.getPinnedTargetIndex(sessionId);
    if (idx !== undefined && idx >= 0 && idx < this.targets.length) {
      return this.targets[idx];
    }
    return undefined;
  }

  /**
   * Clear all pinned session mappings.
   */
  clearPinnedSessions(): void {
    this.pinnedSessions.clear();
  }

  /**
   * Get total number of currently pinned sessions.
   */
  getPinnedSessionsCount(): number {
    return this.pinnedSessions.size;
  }

  /**
   * Get all pinned sessions and their associated targets.
   */
  getAllPinnedSessions(): Map<string, EndpointTarget> {
    const map = new Map<string, EndpointTarget>();
    for (const [sessId, idx] of this.pinnedSessions.entries()) {
      if (idx >= 0 && idx < this.targets.length) {
        map.set(sessId, this.targets[idx]);
      }
    }
    return map;
  }

  /**
   * Dynamically update endpoint targets at runtime without breaking active sessions or context.
   */
  updateTargets(targets: EndpointTarget[]): void {
    if (!targets || targets.length === 0) {
      throw new InvalidRequestError("Must provide at least one target in updateTargets");
    }
    this.targets = normalizeEndpointTargets({
      ...this.rawOptions,
      targets,
      endpoints: undefined,
    });
    this.rebuildProviders();
    this.cooldowns.clear();
    this.currentIndex = 0;

    for (const [sessId, idx] of this.pinnedSessions.entries()) {
      if (idx >= this.targets.length) {
        this.pinnedSessions.delete(sessId);
      }
    }
  }

  /**
   * Dynamically append a new endpoint target at runtime.
   */
  addTarget(target: EndpointTarget): void {
    if (!target || !target.baseUrl) {
      throw new InvalidRequestError("Target must have a valid baseUrl");
    }
    this.targets.push({
      protocol: target.protocol,
      baseUrl: target.baseUrl,
      apiKey: target.apiKey !== undefined ? target.apiKey : this.rawOptions.apiKey,
      model: target.model,
      weight: target.weight ?? 1,
      headers: { ...this.rawOptions.headers, ...target.headers },
      customOptions: { ...this.rawOptions.customOptions, ...target.customOptions },
    });
    this.rebuildProviders();
  }

  /**
   * Dynamically switch the load balancing / failover strategy at runtime.
   */
  setStrategy(strategy: LoadBalanceStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Get all registered endpoint targets.
   */
  getTargets(): readonly EndpointTarget[] {
    return this.targets;
  }

  /**
   * Mark an endpoint target index as cooling down until now + durationMs.
   */
  markCooldown(index: number, durationMs: number = this.cooldownMs): void {
    if (index >= 0 && index < this.targets.length) {
      this.cooldowns.set(index, Date.now() + durationMs);
    }
  }

  /**
   * Check if a target index is currently in cooldown.
   */
  isCoolingDown(index: number): boolean {
    const cooldownUntil = this.cooldowns.get(index);
    if (!cooldownUntil) return false;
    if (Date.now() >= cooldownUntil) {
      this.cooldowns.delete(index);
      return false;
    }
    return true;
  }

  /**
   * Get available (non-cooling) target indices.
   */
  private getAvailableIndices(): number[] {
    const now = Date.now();
    const available: number[] = [];
    for (let i = 0; i < this.targets.length; i++) {
      const cooldownUntil = this.cooldowns.get(i);
      if (!cooldownUntil || now >= cooldownUntil) {
        if (cooldownUntil) this.cooldowns.delete(i);
        available.push(i);
      }
    }
    return available;
  }

  /**
   * Choose target index from candidate list based on current strategy.
   */
  private chooseIndexByStrategy(available: number[]): number {
    // Priority (Active/Passive Fallback): Always select first healthy target (Target 0 > Target 1 > ...)
    if (this.strategy === "priority") {
      return available[0];
    }

    if (this.strategy === "random") {
      const randomIdx = Math.floor(Math.random() * available.length);
      return available[randomIdx];
    }

    if (this.strategy === "weighted") {
      let totalWeight = 0;
      for (const idx of available) {
        totalWeight += Math.max(this.targets[idx].weight ?? 1, 1);
      }
      let rand = Math.random() * totalWeight;
      for (const idx of available) {
        const weight = Math.max(this.targets[idx].weight ?? 1, 1);
        if (rand < weight) {
          return idx;
        }
        rand -= weight;
      }
      return available[0];
    }

    // Default: Round-Robin
    const chosen = available.find((i) => i >= this.currentIndex) ?? available[0];
    this.currentIndex = (chosen + 1) % this.targets.length;
    return chosen;
  }

  /**
   * Select candidate index according to load balancing strategy and session pinning.
   */
  selectTargetIndex(
    excludeIndices: Set<number> = new Set(),
    sessionId?: string,
    requestedTarget?: number | string | EndpointTarget,
    isPinExplicitlyDisabled = false
  ): number {
    // 1. Explicit requested target (per-request override)
    if (requestedTarget !== undefined) {
      const reqIdx = this.findTargetIndex(requestedTarget);
      if (reqIdx >= 0 && !excludeIndices.has(reqIdx) && !this.isCoolingDown(reqIdx)) {
        return reqIdx;
      }
    }

    // 2. Existing pinned session lookup (unless pinning is explicitly disabled for this request)
    if (!isPinExplicitlyDisabled && sessionId) {
      const pinnedIdx = this.getPinnedTargetIndex(sessionId);
      if (pinnedIdx !== undefined && pinnedIdx >= 0 && pinnedIdx < this.targets.length) {
        if (!excludeIndices.has(pinnedIdx) && !this.isCoolingDown(pinnedIdx)) {
          return pinnedIdx;
        }
      }
    }

    // 3. Retrieve available candidates
    let available = this.getAvailableIndices().filter((i) => !excludeIndices.has(i));

    if (available.length === 0) {
      // If all available are excluded, fallback to all non-excluded
      const nonExcluded: number[] = [];
      for (let i = 0; i < this.targets.length; i++) {
        if (!excludeIndices.has(i)) nonExcluded.push(i);
      }
      if (nonExcluded.length > 0) {
        available = nonExcluded;
      } else {
        return 0;
      }
    }

    return this.chooseIndexByStrategy(available);
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const sessionId = request.sessionId;
    const requestedTarget = request.pinnedTarget;
    const isPinExplicitlyDisabled = request.pinSession === false;
    const shouldAutoPin = request.pinSession === true || (request.pinSession !== false && this.sessionAffinity);
    const hasExistingPin = Boolean(sessionId && this.pinnedSessions.has(sessionId));
    const allowPinning = !isPinExplicitlyDisabled && (hasExistingPin || shouldAutoPin);

    const triedIndices = new Set<number>();
    const maxAttempts = Math.min(this.maxRetries, this.targets.length);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const targetIndex = this.selectTargetIndex(triedIndices, sessionId, requestedTarget, isPinExplicitlyDisabled);
      triedIndices.add(targetIndex);
      const provider = this.providers[targetIndex];
      const target = this.targets[targetIndex];

      try {
        const res = await provider.chat(request);

        // Update pinned target only on successful response
        if (sessionId && allowPinning) {
          if (this.repinOnFailover || !this.pinnedSessions.has(sessionId)) {
            this.setPinnedSession(sessionId, targetIndex);
          }
        }

        const targetInfo: TargetInfo = {
          index: targetIndex,
          baseUrl: target.baseUrl,
          protocol: target.protocol ?? this.protocol,
          model: target.model ?? this.model,
        };
        res.target = targetInfo;
        if (res.raw && typeof res.raw === "object") {
          (res.raw as any).target = targetInfo;
          (res.raw as any).targetIndex = targetIndex;
        } else {
          res.raw = { target: targetInfo, targetIndex };
        }

        return res;
      } catch (err: unknown) {
        lastError = err;

        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }

        // 429 RateLimit -> mark cooldown and try next target
        if (err instanceof RateLimitError) {
          this.markCooldown(targetIndex, this.cooldownMs);
          continue;
        }

        // 5xx Server Error or Network connection failure -> mark cooldown and try next target
        if (err instanceof ProviderError) {
          if (err.statusCode === undefined || err.statusCode >= 500) {
            this.markCooldown(targetIndex, this.cooldownMs);
            continue;
          }
        }

        // Other non-retryable errors (e.g. 400 Bad Request)
        throw err;
      }
    }

    throw lastError ?? new ProviderError("All load balanced providers failed");
  }

  async chatStream(request: ProviderChatRequest): Promise<AsyncIterable<ProviderChunkResponse>> {
    const sessionId = request.sessionId;
    const requestedTarget = request.pinnedTarget;
    const isPinExplicitlyDisabled = request.pinSession === false;
    const shouldAutoPin = request.pinSession === true || (request.pinSession !== false && this.sessionAffinity);
    const hasExistingPin = Boolean(sessionId && this.pinnedSessions.has(sessionId));
    const allowPinning = !isPinExplicitlyDisabled && (hasExistingPin || shouldAutoPin);

    const triedIndices = new Set<number>();
    const maxAttempts = Math.min(this.maxRetries, this.targets.length);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const targetIndex = this.selectTargetIndex(triedIndices, sessionId, requestedTarget, isPinExplicitlyDisabled);
      triedIndices.add(targetIndex);
      const provider = this.providers[targetIndex];
      const target = this.targets[targetIndex];

      try {
        const stream = await provider.chatStream(request);

        if (sessionId && allowPinning) {
          if (this.repinOnFailover || !this.pinnedSessions.has(sessionId)) {
            this.setPinnedSession(sessionId, targetIndex);
          }
        }

        const targetInfo: TargetInfo = {
          index: targetIndex,
          baseUrl: target.baseUrl,
          protocol: target.protocol ?? this.protocol,
          model: target.model ?? this.model,
        };

        return (async function* () {
          for await (const chunk of stream) {
            chunk.target = targetInfo;
            if (chunk.raw && typeof chunk.raw === "object") {
              (chunk.raw as any).target = targetInfo;
              (chunk.raw as any).targetIndex = targetIndex;
            }
            yield chunk;
          }
        })();
      } catch (err: unknown) {
        lastError = err;

        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }

        if (err instanceof RateLimitError) {
          this.markCooldown(targetIndex, this.cooldownMs);
          continue;
        }

        if (err instanceof ProviderError) {
          if (err.statusCode === undefined || err.statusCode >= 500) {
            this.markCooldown(targetIndex, this.cooldownMs);
            continue;
          }
        }

        throw err;
      }
    }

    throw lastError ?? new ProviderError("All load balanced stream providers failed");
  }
}
