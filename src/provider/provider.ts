import type {
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChunkResponse,
} from "../types/provider.js";

/**
 * Universal interface for AI model providers.
 * Providers translate between unified SDK types and provider-specific wire protocols.
 */
export interface IProvider {
  /**
   * Protocol identifier (e.g., 'openai', 'anthropic', 'gemini').
   */
  readonly protocol: string;

  /**
   * Send a chat completion request and receive a full response.
   */
  chat(request: ProviderChatRequest): Promise<ProviderChatResponse>;

  /**
   * Send a streaming chat completion request and receive an async stream of chunks.
   */
  chatStream(request: ProviderChatRequest): Promise<AsyncIterable<ProviderChunkResponse>>;
}
