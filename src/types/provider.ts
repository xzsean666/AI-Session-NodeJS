import type { MessageRole } from "./message.js";

export type KnownProviderProtocol = "openai" | "anthropic" | "gemini";
export type ProviderProtocol = KnownProviderProtocol | (string & {});

export interface ProviderConfig {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
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
