import type { IProvider } from "./provider.js";
import type {
  ProviderConfig,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderChunkResponse,
  Usage,
} from "../types/provider.js";
import { ProviderError, InvalidRequestError } from "../types/errors.js";
import { handleProviderHttpError, iterateSSEEvents } from "./utils.js";
import { ProviderManager } from "./provider-manager.js";

/**
 * Provider adapter for Anthropic Claude API and compatible proxies.
 */
export class AnthropicProvider implements IProvider {
  public readonly protocol: string;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    if (!config || !config.baseUrl) {
      throw new InvalidRequestError("AnthropicProvider requires baseUrl in config");
    }
    this.protocol = config.protocol || "anthropic";
    this.config = config;
  }

  private getMessagesEndpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/messages")) {
      return base;
    }
    if (base.endsWith("/v1")) {
      return `${base}/messages`;
    }
    return `${base}/v1/messages`;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }
    return headers;
  }

  private extractSystemAndMessages(request: ProviderChatRequest): {
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    let system = request.system;
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        if (!system) {
          system = msg.content;
        } else {
          system = `${system}\n\n${msg.content}`;
        }
      } else {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    return { system, messages };
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const endpoint = this.getMessagesEndpoint();
    const headers = this.getHeaders();
    const model = request.model ?? this.config.model;

    if (!model) {
      throw new InvalidRequestError("Model must be specified in request or provider config");
    }

    const { system, messages } = this.extractSystemAndMessages(request);

    const payload: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: false,
      ...this.config.customOptions,
      ...request.customOptions,
    };

    if (system) {
      payload.system = system;
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }

    let response: Response;
    try {
      response = await fetchFn(endpoint, {
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
      throw new ProviderError("Invalid JSON response from Anthropic provider", {
        protocol: this.protocol,
        statusCode: response.status,
        cause: err,
      });
    }

    const textContent =
      data.content?.find((c: any) => c.type === "text")?.text ??
      data.content?.[0]?.text ??
      "";

    let usage: Usage | undefined;
    if (data.usage) {
      const promptTokens = data.usage.input_tokens;
      const completionTokens = data.usage.output_tokens;
      const totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
      usage = { promptTokens, completionTokens, totalTokens };
    }

    return {
      role: "assistant",
      content: textContent,
      usage,
      raw: data,
    };
  }

  async chatStream(request: ProviderChatRequest): Promise<AsyncIterable<ProviderChunkResponse>> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const endpoint = this.getMessagesEndpoint();
    const headers = this.getHeaders();
    const model = request.model ?? this.config.model;

    if (!model) {
      throw new InvalidRequestError("Model must be specified in request or provider config");
    }

    const { system, messages } = this.extractSystemAndMessages(request);

    const payload: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
      ...this.config.customOptions,
      ...request.customOptions,
    };

    if (system) {
      payload.system = system;
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }

    let response: Response;
    try {
      response = await fetchFn(endpoint, {
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

    return (async function* () {
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const event of iterateSSEEvents(response.body!)) {
        const eventType = event.event || "";
        const dataStr = event.data?.trim();

        if (eventType === "error") {
          throw new ProviderError(`Anthropic stream error: ${dataStr}`, {
            protocol: "anthropic",
            rawError: dataStr,
          });
        }

        if (!dataStr) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (parsed.type === "message_start" && parsed.message?.usage) {
          promptTokens = parsed.message.usage.input_tokens ?? 0;
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.text) {
          yield {
            delta: parsed.delta.text,
            role: "assistant",
            done: false,
            raw: parsed,
          };
        }

        if (parsed.type === "message_delta" && parsed.usage) {
          completionTokens = parsed.usage.output_tokens ?? completionTokens;
        }

        if (parsed.type === "message_stop") {
          yield {
            delta: "",
            role: "assistant",
            done: true,
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
            raw: parsed,
          };
          return;
        }
      }
    })();
  }
}

// Auto-register default "anthropic" protocol in ProviderManager
ProviderManager.registerProvider("anthropic", (cfg) => new AnthropicProvider(cfg));
