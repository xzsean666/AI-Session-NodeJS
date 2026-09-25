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
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    if (!config || !config.baseUrl) {
      throw new InvalidRequestError("AnthropicProvider requires baseUrl in config");
    }
    this.protocol = config.protocol || "anthropic";
    this.config = config;
    this.baseUrl = config.baseUrl;
  }

  private getMessagesEndpoint(): string {
    const base = this.baseUrl.replace(/\/+$/, "");
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
    messages: Array<{ role: "user" | "assistant"; content: any }>;
  } {
    let system = request.system;
    const messages: Array<{ role: "user" | "assistant"; content: any }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        const txt = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (!system) {
          system = txt;
        } else {
          system = `${system}\n\n${txt}`;
        }
      } else {
        let content: any = msg.content;
        if (Array.isArray(msg.content)) {
          content = msg.content.map((item) => {
            if (item && typeof item === "object" && (item as any).type === "image_url" && (item as any).image_url?.url) {
              const url = (item as any).image_url.url;
              if (url.startsWith("data:")) {
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  return {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: match[1],
                      data: match[2],
                    },
                  };
                }
              }
            }
            return item;
          });
        }
        messages.push({
          role: msg.role as "user" | "assistant",
          content,
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

    const customOptions = { ...this.config.customOptions, ...request.customOptions };
    delete (customOptions as Record<string, unknown>).noCache;

    const payload: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: false,
      ...customOptions,
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

    const customOptions = { ...this.config.customOptions, ...request.customOptions };
    delete (customOptions as Record<string, unknown>).noCache;

    const payload: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages,
      stream: true,
      ...customOptions,
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
