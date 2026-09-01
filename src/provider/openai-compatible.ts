import type { IProvider } from "./provider.js";
import type {
  ProviderConfig,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChunkResponse,
  ChatMessage,
} from "../types/provider.js";
import { ProviderError, InvalidRequestError } from "../types/errors.js";
import { handleProviderHttpError, iterateSSEEvents, fetchWithRetry } from "./utils.js";
import { ProviderManager } from "./provider-manager.js";

/**
 * Provider adapter for OpenAI and OpenAI-compatible services (vLLM, LiteLLM, Ollama, etc.)
 */
export class OpenAICompatibleProvider implements IProvider {
  public readonly protocol: string;
  private readonly config: ProviderConfig;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    if (!config || !config.baseUrl) {
      throw new InvalidRequestError("OpenAICompatibleProvider requires baseUrl in config");
    }
    this.protocol = config.protocol || "openai";
    this.config = config;
    this.baseUrl = config.baseUrl;
  }

  private getChatEndpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) {
      return base;
    }
    return `${base}/chat/completions`;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private buildMessages(request: ProviderChatRequest): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // Prepend system prompt if provided and not already the first system message
    if (request.system) {
      const firstIsSameSystem =
        request.messages.length > 0 &&
        request.messages[0].role === "system" &&
        request.messages[0].content === request.system;

      if (!firstIsSameSystem) {
        messages.push({ role: "system", content: request.system });
      }
    }

    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    return messages;
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const endpoint = this.getChatEndpoint();
    const headers = this.getHeaders();
    const model = request.model ?? this.config.model;

    if (!model) {
      throw new InvalidRequestError("Model must be specified in request or provider config");
    }

    const customOptions = { ...this.config.customOptions, ...request.customOptions };
    delete (customOptions as Record<string, unknown>).noCache;

    const payload = {
      model,
      messages: this.buildMessages(request),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
      ...customOptions,
    };

    let response: Response;
    try {
      response = await fetchWithRetry(fetchFn, endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: request.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      throw new ProviderError(`Network error communicating with ${this.protocol} provider`, {
        protocol: this.protocol,
        cause: err,
      });
    }

    if (!response.ok) {
      await handleProviderHttpError(response, this.protocol);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderError("Invalid JSON response from OpenAI-compatible provider", {
        protocol: this.protocol,
        statusCode: response.status,
        cause: err,
      });
    }

    const choice = data.choices?.[0];
    const content =
      choice?.message?.content ||
      choice?.message?.reasoning_content ||
      choice?.message?.reasoning ||
      "";
    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined;

    return {
      role: "assistant",
      content,
      usage,
      raw: data,
    };
  }

  async chatStream(request: ProviderChatRequest): Promise<AsyncIterable<ProviderChunkResponse>> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const endpoint = this.getChatEndpoint();
    const headers = this.getHeaders();
    const model = request.model ?? this.config.model;

    if (!model) {
      throw new InvalidRequestError("Model must be specified in request or provider config");
    }

    const customOptions = { ...this.config.customOptions, ...request.customOptions };
    delete (customOptions as Record<string, unknown>).noCache;

    const payload = {
      model,
      messages: this.buildMessages(request),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...customOptions,
    };

    let response: Response;
    try {
      response = await fetchWithRetry(fetchFn, endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: request.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      throw new ProviderError(`Network error communicating with ${this.protocol} provider`, {
        protocol: this.protocol,
        cause: err,
      });
    }

    if (!response.ok) {
      await handleProviderHttpError(response, this.protocol);
    }

    if (!response.body) {
      throw new ProviderError("No response stream body returned by provider", {
        protocol: this.protocol,
      });
    }

    const protocol = this.protocol;

    return (async function* () {
      for await (const event of iterateSSEEvents(response.body!)) {
        const trimmed = event.data.trim();
        if (trimmed === "[DONE]") {
          yield { delta: "", done: true };
          return;
        }

        if (!trimmed) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        const deltaContent = choice?.delta?.content ?? "";
        const finishReason = choice?.finish_reason;
        const isDone = Boolean(finishReason && finishReason !== "null");

        const usage = parsed.usage
          ? {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
            }
          : undefined;

        if (!deltaContent && !isDone && !usage) {
          continue;
        }

        yield {
          delta: deltaContent,
          role: "assistant",
          done: isDone,
          usage,
          raw: parsed,
        };

        if (isDone) {
          return;
        }
      }
    })();
  }
}

// Auto-register default "openai" protocol in ProviderManager
ProviderManager.registerProvider("openai", (cfg) => new OpenAICompatibleProvider(cfg));
