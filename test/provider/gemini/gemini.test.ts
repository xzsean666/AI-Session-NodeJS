import { describe, it, expect } from "vitest";
import {
  GeminiProvider,
  ProviderManager,
  AuthenticationError,
  RateLimitError,
  ProviderError,
} from "../../../src/index.js";

describe("GeminiProvider (TASK-007)", () => {
  describe("Non-streaming chat", () => {
    it("formats Gemini contents, systemInstruction, headers, and parses response", async () => {
      let requestedUrl = "";
      let requestedHeaders: Record<string, string> = {};
      let requestedBody: any;

      const mockFetch: typeof fetch = async (url, init) => {
        requestedUrl = url.toString();
        requestedHeaders = (init?.headers as Record<string, string>) || {};
        requestedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Hello from Gemini!" }],
                  role: "model",
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 8,
              totalTokenCount: 28,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new GeminiProvider({
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-api-key-123",
        model: "gemini-1.5-pro",
        fetch: mockFetch,
      });

      const response = await provider.chat({
        system: "You are a helpful Google AI.",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
          { role: "user", content: "What is 2+2?" },
        ],
        temperature: 0.2,
      });

      expect(requestedUrl).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent"
      );
      expect(requestedHeaders["x-goog-api-key"]).toBe("gemini-api-key-123");
      expect(requestedBody.systemInstruction).toEqual({
        parts: [{ text: "You are a helpful Google AI." }],
      });
      expect(requestedBody.contents).toEqual([
        { role: "user", parts: [{ text: "Hi" }] },
        { role: "model", parts: [{ text: "Hello!" }] },
        { role: "user", parts: [{ text: "What is 2+2?" }] },
      ]);
      expect(requestedBody.generationConfig).toEqual({ temperature: 0.2 });

      expect(response.role).toBe("assistant");
      expect(response.content).toBe("Hello from Gemini!");
      expect(response.usage).toEqual({
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
      });
    });
  });

  describe("Streaming chat", () => {
    it("streams Gemini SSE chunks and parses content parts and usage", async () => {
      const ssePayload =
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":" from Gemini"}],"role":"model"}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":"!"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":5,"totalTokenCount":17}}\n\n';

      const mockFetch: typeof fetch = async (url) => {
        expect(url.toString()).toContain(":streamGenerateContent?alt=sse");
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

      const provider = new GeminiProvider({
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-api-key",
        model: "gemini-1.5-flash",
        fetch: mockFetch,
      });

      const stream = await provider.chatStream({
        messages: [{ role: "user", content: "Greet me" }],
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

      expect(deltas.join("")).toBe("Hello from Gemini!");
      expect(finalUsage).toEqual({
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      });
    });
  });

  describe("Error handling and registration", () => {
    it("throws RateLimitError on 429 response", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({ error: { code: 429, message: "Resource exhausted" } }),
          { status: 429, statusText: "Too Many Requests" }
        );
      };

      const provider = new GeminiProvider({
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
        model: "gemini-1.5-flash",
        fetch: mockFetch,
      });

      await expect(
        provider.chat({ messages: [{ role: "user", content: "hi" }] })
      ).rejects.toThrow(RateLimitError);
    });

    it("creates via ProviderManager", () => {
      const provider = ProviderManager.createProvider({
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-key",
        model: "gemini-1.5-flash",
      });

      expect(provider).toBeInstanceOf(GeminiProvider);
      expect(provider.protocol).toBe("gemini");
    });
  });
});
