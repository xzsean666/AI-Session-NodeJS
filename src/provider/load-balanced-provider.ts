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
  private readonly cooldowns: Map<number, number> = new Map();
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
        customOptions: target.customOptions,
      };
      return ProviderManager.createProvider(config);
    });
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
   * Select candidate index according to load balancing strategy.
   */
  selectTargetIndex(excludeIndices: Set<number> = new Set()): number {
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

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const triedIndices = new Set<number>();
    const maxAttempts = Math.min(this.maxRetries, this.targets.length);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const targetIndex = this.selectTargetIndex(triedIndices);
      triedIndices.add(targetIndex);
      const provider = this.providers[targetIndex];

      try {
        const res = await provider.chat(request);
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
    const triedIndices = new Set<number>();
    const maxAttempts = Math.min(this.maxRetries, this.targets.length);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const targetIndex = this.selectTargetIndex(triedIndices);
      triedIndices.add(targetIndex);
      const provider = this.providers[targetIndex];

      try {
        const stream = await provider.chatStream(request);
        return stream;
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
