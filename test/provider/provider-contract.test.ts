import { describe, it, expect, beforeEach } from "vitest";
import {
  ProviderManager,
  handleProviderHttpError,
  iterateSSEEvents,
  AuthenticationError,
  RateLimitError,
  ProviderError,
  InvalidRequestError,
  type IProvider,
  type ProviderConfig,
  type ProviderChatRequest,
  type ProviderChatResponse,
  type ProviderChunkResponse,
} from "../../src/index.js";

describe("Provider Contract & ProviderManager (TASK-005)", () => {
  beforeEach(() => {
    ProviderManager.clear();
  });

  describe("ProviderManager Registry", () => {
    it("registers and creates custom provider by protocol", () => {
      const mockProvider: IProvider = {
        protocol: "mock",
        chat: async () => ({ role: "assistant", content: "mock reply" }),
        chatStream: async function* () {
          yield { delta: "chunk", done: true };
        },
      };

      ProviderManager.registerProvider("mock", (_cfg) => mockProvider);
      expect(ProviderManager.hasProvider("mock")).toBe(true);
      expect(ProviderManager.hasProvider("MOCK")).toBe(true);

      const created = ProviderManager.createProvider({
        protocol: "mock",
        baseUrl: "http://localhost:8080",
        model: "mock-model",
      });

      expect(created).toBe(mockProvider);
      expect(created.protocol).toBe("mock");
    });

    it("throws InvalidRequestError when creating unregistered protocol", () => {
      expect(() =>
        ProviderManager.createProvider({
          protocol: "unsupported",
          baseUrl: "http://localhost",
          model: "some-model",
        })
      ).toThrow(InvalidRequestError);
    });

    it("validates protocol arguments", () => {
      expect(() => ProviderManager.registerProvider("", () => ({} as IProvider))).toThrow(
        InvalidRequestError
      );
      // @ts-expect-error test invalid config
      expect(() => ProviderManager.createProvider({})).toThrow(InvalidRequestError);
    });
  });

  describe("handleProviderHttpError", () => {
    it("maps 401 and 403 to AuthenticationError", async () => {
      const resp401 = new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), {
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(handleProviderHttpError(resp401, "openai")).rejects.toThrow(AuthenticationError);

      const resp403 = new Response("Forbidden", {
        status: 403,
        statusText: "Forbidden",
      });

      await expect(handleProviderHttpError(resp403, "anthropic")).rejects.toThrow(AuthenticationError);
    });

    it("maps 429 to RateLimitError", async () => {
      const resp429 = new Response(JSON.stringify({ message: "Quota exceeded" }), {
        status: 429,
        statusText: "Too Many Requests",
      });

      await expect(handleProviderHttpError(resp429, "gemini")).rejects.toThrow(RateLimitError);
    });

    it("maps other 4xx/5xx to ProviderError with status code", async () => {
      const resp500 = new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      });

      try {
        await handleProviderHttpError(resp500, "openai");
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        const pErr = err as ProviderError;
        expect(pErr.statusCode).toBe(500);
        expect(pErr.protocol).toBe("openai");
      }
    });
  });

  describe("iterateSSEEvents", () => {
    it("parses standard multi-line and single-line SSE chunks", async () => {
      const sseText =
        "event: message\ndata: {\"text\":\"hello\"}\n\n" +
        ": ping\n\n" +
        "data: {\"text\":\"world\"}\n\n";

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText));
          controller.close();
        },
      });

      const events = [];
      for await (const ev of iterateSSEEvents(stream)) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("message");
      expect(events[0].data).toBe('{"text":"hello"}');
      expect(events[1].data).toBe('{"text":"world"}');
    });

    it("handles fragmented stream chunks across buffer boundaries", async () => {
      const chunk1 = "data: {\"step\":";
      const chunk2 = " 1}\n\ndata: {\"step\": 2}\n\n";

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk1));
          controller.enqueue(new TextEncoder().encode(chunk2));
          controller.close();
        },
      });

      const events = [];
      for await (const ev of iterateSSEEvents(stream)) {
        events.push(ev);
      }

      expect(events).toHaveLength(2);
      expect(JSON.parse(events[0].data)).toEqual({ step: 1 });
      expect(JSON.parse(events[1].data)).toEqual({ step: 2 });
    });
  });
});
