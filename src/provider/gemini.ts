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
 * Provider adapter for Google Gemini API and compatible proxies.
 */
export class GeminiProvider implements IProvider {
  public readonly protocol: string;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    if (!config || !config.baseUrl) {
      throw new InvalidRequestError("GeminiProvider requires baseUrl in config");
    }
    this.protocol = config.protocol || "gemini";
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private getEndpoint(model: string, streaming: boolean): string {
    const base = this.getBaseUrl();
    const action = streaming ? ":streamGenerateContent?alt=sse" : ":generateContent";

    if (base.includes(":generateContent") || base.includes(":streamGenerateContent")) {
      return base;
    }

    if (base.includes("/models/")) {
      return `${base}${action}`;
    }

    if (base.endsWith("/v1beta") || base.endsWith("/v1")) {
      return `${base}/models/${model}${action}`;
    }

    return `${base}/v1beta/models/${model}${action}`;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey) {
      headers["x-goog-api-key"] = this.config.apiKey;
    }
    return headers;
  }

  private buildContents(request: ProviderChatRequest): {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  } {
    let systemText = request.system;
    const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        if (!systemText) {
          systemText = msg.content;
        } else {
          systemText = `${systemText}\n\n${msg.content}`;
        }
      } else {
        const geminiRole = msg.role === "assistant" ? "model" : "user";
        contents.push({
          role: geminiRole,
          parts: [{ text: msg.content }],
        });
      }
    }

    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    if (systemText) {
      systemInstruction = {
        parts: [{ text: systemText }],
      };
    }

    return { systemInstruction, contents };
  }

  async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const model = request.model ?? this.config.model;

    if (!model) {
      throw new InvalidRequestError("Model must be specified in request or provider config");
    }

    const endpoint = this.getEndpoint(model, false);
    const headers = this.getHeaders();
    const { systemInstruction, contents } = this.buildContents(request);

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens;
    }

    const payload: Record<string, unknown> = {
      contents,
      ...this.config.customOptions,
      ...request.customOptions,
    };

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }
    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
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
      throw new ProviderError("Invalid JSON response from Gemini provider", {
        protocol: this.protocol,
        statusCode: response.status,
        cause: err,
      });
    }

    const firstCandidate = data.candidates?.[0];
    const textPart = firstCandidate?.content?.parts?.[0]?.text ?? "";

    let usage: Usage | undefined;
    if (data.usageMetadata) {
      usage = {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      };
    }

    return {
      role: "assistant",
      content: textPart,
      usage,
      raw: data,
    };
  }

  async chatStream(request: ProviderChatRequest): Promise<AsyncIterable<ProviderChunkResponse>> {
    const fetchFn = this.config.fetch ?? globalThis.fetch;
    const model = request.model ?? this.config.model;

    if (!model) {
      throw new InvalidRequestError("Model must be specified in request or provider config");
    }

    const endpoint = this.getEndpoint(model, true);
    const headers = this.getHeaders();
    const { systemInstruction, contents } = this.buildContents(request);

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens;
    }

    const payload: Record<string, unknown> = {
      contents,
      ...this.config.customOptions,
      ...request.customOptions,
    };

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }
    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
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
      for await (const event of iterateSSEEvents(response.body!)) {
        const dataStr = event.data?.trim();
        if (!dataStr) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }

        const candidate = parsed.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text ?? "";
        const finishReason = candidate?.finishReason;
        const isDone = Boolean(finishReason && finishReason !== "null");

        const usage = parsed.usageMetadata
          ? {
              promptTokens: parsed.usageMetadata.promptTokenCount,
              completionTokens: parsed.usageMetadata.candidatesTokenCount,
              totalTokens: parsed.usageMetadata.totalTokenCount,
            }
          : undefined;

        yield {
          delta: text,
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

// Auto-register default "gemini" protocol in ProviderManager
ProviderManager.registerProvider("gemini", (cfg) => new GeminiProvider(cfg));
