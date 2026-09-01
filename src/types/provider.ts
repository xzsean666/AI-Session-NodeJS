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

export interface LoadBalanceOptions {
  strategy?: LoadBalanceStrategy;
  cooldownMs?: number;
  maxRetries?: number;
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
}

export interface ProviderChatResponse {
  content: string;
  role: "assistant";
  usage?: Usage;
  raw?: unknown;
}

export interface ProviderChunkResponse {
  delta: string;
  role?: "assistant";
  done: boolean;
  usage?: Usage;
  raw?: unknown;
}
