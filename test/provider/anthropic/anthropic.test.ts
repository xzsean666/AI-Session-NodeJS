import { describe, it, expect } from "vitest";
import {
  AnthropicProvider,
  ProviderManager,
  AuthenticationError,
  RateLimitError,
  ProviderError,
} from "../../../src/index.js";

describe("AnthropicProvider (TASK-007)", () => {
  describe("Non-streaming chat", () => {
    it("formats Anthropic messages, system prompt, headers, and parses response", async () => {
      let requestedUrl = "";
      let requestedHeaders: Record<string, string> = {};
      let requestedBody: any;

      const mockFetch: typeof fetch = async (url, init) => {
        requestedUrl = url.toString();
        requestedHeaders = (init?.headers as Record<string, string>) || {};
        requestedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hello from Claude!" }],
            model: "claude-3-5-sonnet-20241022",
            usage: {
              input_tokens: 25,
              output_tokens: 12,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new AnthropicProvider({
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-test-123",
        model: "claude-3-5-sonnet-20241022",
        fetch: mockFetch,
      });

      const response = await provider.chat({
        system: "You are Claude, created by Anthropic.",
        messages: [
          { role: "user", content: "Tell me a joke" },
          { role: "assistant", content: "Why did the chicken cross the road?" },
          { role: "user", content: "Why?" },
        ],
        temperature: 0.7,
      });

      expect(requestedUrl).toBe("https://api.anthropic.com/v1/messages");
      expect(requestedHeaders["x-api-key"]).toBe("sk-ant-test-123");
      expect(requestedHeaders["anthropic-version"]).toBe("2023-06-01");
      expect(requestedBody.model).toBe("claude-3-5-sonnet-20241022");
      expect(requestedBody.system).toBe("You are Claude, created by Anthropic.");
      expect(requestedBody.messages).toEqual([
        { role: "user", content: "Tell me a joke" },
        { role: "assistant", content: "Why did the chicken cross the road?" },
        { role: "user", content: "Why?" },
      ]);
      expect(requestedBody.temperature).toBe(0.7);

      expect(response.role).toBe("assistant");
      expect(response.content).toBe("Hello from Claude!");
      expect(response.usage).toEqual({
        promptTokens: 25,
        completionTokens: 12,
        totalTokens: 37,
      });
    });
  });

  describe("Streaming chat", () => {
    it("streams Anthropic SSE events content_block_delta and message_stop", async () => {
      const ssePayload =
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there!"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';

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

      const provider = new AnthropicProvider({
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-ant-test",
        model: "claude-3-5-sonnet",
        fetch: mockFetch,
      });

      const stream = await provider.chatStream({
        messages: [{ role: "user", content: "Hi" }],
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

      expect(deltas.join("")).toBe("Hi there!");
      expect(finalUsage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
    });
  });

  describe("Error handling and registration", () => {
    it("throws AuthenticationError on 401 response", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
          { status: 401, statusText: "Unauthorized" }
        );
      };

      const provider = new AnthropicProvider({
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "bad-key",
        model: "claude-3-haiku",
        fetch: mockFetch,
      });

      await expect(
        provider.chat({ messages: [{ role: "user", content: "hi" }] })
      ).rejects.toThrow(AuthenticationError);
    });

    it("creates via ProviderManager", () => {
      const provider = ProviderManager.createProvider({
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant",
        model: "claude-3-haiku",
      });

      expect(provider).toBeInstanceOf(AnthropicProvider);
      expect(provider.protocol).toBe("anthropic");
    });
  });
});
