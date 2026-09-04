import type { MessageRole } from "./message.js";

export type KnownProviderProtocol = "openai" | "anthropic" | "gemini";
export type ProviderProtocol = KnownProviderProtocol | (string & {});

export interface EndpointTarget {
  protocol?: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  weight?: number;
  headers?: Record<string, string>;
  customOptions?: Record<string, unknown>;
}

export type LoadBalanceStrategy = "round-robin" | "random" | "weighted" | "priority";

export interface TargetInfo {
  index: number;
  baseUrl: string;
  protocol?: string;
  model?: string;
}

export interface LoadBalanceOptions {
  strategy?: LoadBalanceStrategy;
  cooldownMs?: number;
  maxRetries?: number;
  /**
   * Enable session affinity (Sticky Session / Session Pinning).
   * Requests with the same sessionId consistently pin to the same endpoint target,
   * maximizing prompt/prefix cache hit rates on LLMs (DeepSeek, Claude, OpenAI, vLLM).
   */
  sessionAffinity?: boolean;
  /**
   * Alias for sessionAffinity.
   */
  pinSession?: boolean;
  /**
   * Automatically re-pin to a new healthy target when the current pinned target encounters 429 or 5xx failures.
   * Defaults to true.
   */
  repinOnFailover?: boolean;
  /**
   * Maximum number of pinned session mappings to retain in memory to prevent leaks.
   * Defaults to 10,000.
   */
  maxPinnedSessions?: number;
}

export interface ProviderConfig {
  protocol: ProviderProtocol;
  baseUrl?: string;
  baseUrls?: string[];
  apiKey?: string;
  apiKeys?: string[];
  targets?: EndpointTarget[];
  endpoints?: EndpointTarget[];
  model: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  loadBalance?: LoadBalanceOptions;
  customOptions?: Record<string, unknown>;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ProviderChatRequest {
  model?: string;
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  customOptions?: Record<string, unknown>;
  /**
   * Optional sessionId for session-based routing and session pinning.
   */
  sessionId?: string;
  /**
   * Optional userId.
   */
  userId?: string;
  /**
   * Explicit target index, baseUrl string, or EndpointTarget to pin/route this request to.
   */
  pinnedTarget?: number | string | EndpointTarget;
  /**
   * Per-request override for session pinning. Set false to bypass pinning for this specific request.
   */
  pinSession?: boolean;
}

export interface ProviderChatResponse {
  content: string;
  role: "assistant";
  usage?: Usage;
  target?: TargetInfo;
  raw?: unknown;
}

export interface ProviderChunkResponse {
  delta: string;
  role?: "assistant";
  done: boolean;
  usage?: Usage;
  target?: TargetInfo;
  raw?: unknown;
}
