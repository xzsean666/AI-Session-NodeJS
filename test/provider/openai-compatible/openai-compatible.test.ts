import { describe, it, expect, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  ProviderManager,
  AuthenticationError,
  RateLimitError,
  ProviderError,
  InvalidRequestError,
} from "../../../src/index.js";

describe("OpenAICompatibleProvider (TASK-006)", () => {
  describe("Non-streaming chat", () => {
    it("sends standard chat request and returns parsed response", async () => {
      let requestedUrl = "";
      let requestedHeaders: Record<string, string> = {};
      let requestedBody: any;

      const mockFetch: typeof fetch = async (url, init) => {
        requestedUrl = url.toString();
        requestedHeaders = (init?.headers as Record<string, string>) || {};
        requestedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            id: "chatcmpl-123",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Hello! How can I help you today?",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 15,
              completion_tokens: 9,
              total_tokens: 24,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test-key-123",
        model: "gpt-4o",
        fetch: mockFetch,
      });

      const response = await provider.chat({
        system: "You are a coding assistant.",
        messages: [{ role: "user", content: "Write a hello world" }],
        temperature: 0.5,
      });

      expect(requestedUrl).toBe("https://api.openai.com/v1/chat/completions");
      expect(requestedHeaders["Authorization"]).toBe("Bearer sk-test-key-123");
      expect(requestedBody.model).toBe("gpt-4o");
      expect(requestedBody.temperature).toBe(0.5);
      expect(requestedBody.messages).toEqual([
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "Write a hello world" },
      ]);

      expect(response.role).toBe("assistant");
      expect(response.content).toBe("Hello! How can I help you today?");
      expect(response.usage).toEqual({
        promptTokens: 15,
        completionTokens: 9,
        totalTokens: 24,
      });
    });

    it("handles custom base URLs with/without trailing slashes", async () => {
      let requestedUrl = "";
      const mockFetch: typeof fetch = async (url) => {
        requestedUrl = url.toString();
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
          { status: 200 }
        );
      };

      const provider1 = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "http://localhost:11434/v1/",
        model: "llama3",
        fetch: mockFetch,
      });
      await provider1.chat({ messages: [{ role: "user", content: "hi" }] });
      expect(requestedUrl).toBe("http://localhost:11434/v1/chat/completions");

      const provider2 = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://proxy.example.com/custom/chat/completions",
        model: "llama3",
        fetch: mockFetch,
      });
      await provider2.chat({ messages: [{ role: "user", content: "hi" }] });
      expect(requestedUrl).toBe("https://proxy.example.com/custom/chat/completions");
    });
  });

  describe("Streaming chat", () => {
    it("streams chunks and yields deltas until [DONE]", async () => {
      const ssePayload =
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n' +
        "data: [DONE]\n\n";

      const mockFetch: typeof fetch = async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(ssePayload));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      const provider = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        fetch: mockFetch,
      });

      const stream = await provider.chatStream({
        messages: [{ role: "user", content: "Say hello" }],
      });

      const deltas: string[] = [];
      let finalUsage: any;

      for await (const chunk of stream) {
        if (chunk.delta) {
          deltas.push(chunk.delta);
        }
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      }

      expect(deltas.join("")).toBe("Hello world!");
      expect(finalUsage).toEqual({
        promptTokens: 10,
        completionTokens: 3,
        totalTokens: 13,
      });
    });
  });

  describe("Error handling and validation", () => {
    it("throws AuthenticationError on 401 response", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ error: { message: "Incorrect API key provided" } }),
          { status: 401, statusText: "Unauthorized" }
        );
      };

      const provider = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "bad-key",
        model: "gpt-4o",
        fetch: mockFetch,
      });

      await expect(
        provider.chat({ messages: [{ role: "user", content: "test" }] })
      ).rejects.toThrow(AuthenticationError);
    });

    it("throws RateLimitError on 429 response", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ error: { message: "Rate limit reached" } }),
          { status: 429, statusText: "Too Many Requests" }
        );
      };

      const provider = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        model: "gpt-4o",
        fetch: mockFetch,
      });

      await expect(
        provider.chat({ messages: [{ role: "user", content: "test" }] })
      ).rejects.toThrow(RateLimitError);
    });

    it("throws InvalidRequestError when baseUrl is missing", () => {
      // @ts-expect-error test missing baseUrl
      expect(() => new OpenAICompatibleProvider({ protocol: "openai" })).toThrow(
        InvalidRequestError
      );
    });

    it("instantiates through ProviderManager with openai protocol", () => {
      const provider = ProviderManager.createProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-key",
        model: "gpt-4o",
      });

      expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
      expect(provider.protocol).toBe("openai");
    });
  });
});
