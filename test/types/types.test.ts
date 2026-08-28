import { describe, it, expect } from "vitest";
import {
  AISessionError,
  StorageError,
  SessionNotFoundError,
  ProviderError,
  AuthenticationError,
  RateLimitError,
  InvalidRequestError,
  CompactError,
  type Message,
  type SessionData,
  type ProviderConfig,
  type ProviderChatRequest,
  type ProviderChatResponse,
  type ProviderChunkResponse,
  type IStorage,
  type IProvider,
} from "../../src/index.js";

describe("Unified Domain Types & Errors (TASK-003)", () => {
  describe("Error Hierarchy", () => {
    it("should instantiate base AISessionError", () => {
      const err = new AISessionError("test error");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AISessionError);
      expect(err.name).toBe("AISessionError");
      expect(err.message).toBe("test error");
    });

    it("should instantiate StorageError", () => {
      const err = new StorageError("storage failed");
      expect(err).toBeInstanceOf(AISessionError);
      expect(err).toBeInstanceOf(StorageError);
      expect(err.name).toBe("StorageError");
    });

    it("should instantiate SessionNotFoundError with userId and sessionId", () => {
      const err = new SessionNotFoundError("user_123", "sess_456");
      expect(err).toBeInstanceOf(AISessionError);
      expect(err).toBeInstanceOf(SessionNotFoundError);
      expect(err.name).toBe("SessionNotFoundError");
      expect(err.userId).toBe("user_123");
      expect(err.sessionId).toBe("sess_456");
      expect(err.message).toContain("user_123");
      expect(err.message).toContain("sess_456");
    });

    it("should instantiate ProviderError with status code, protocol, and raw error", () => {
      const raw = { error: { message: "Invalid API Key", type: "invalid_request_error" } };
      const err = new ProviderError("Provider failed", {
        statusCode: 401,
        protocol: "openai",
        rawError: raw,
      });
      expect(err).toBeInstanceOf(AISessionError);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.name).toBe("ProviderError");
      expect(err.statusCode).toBe(401);
      expect(err.protocol).toBe("openai");
      expect(err.rawError).toEqual(raw);
    });

    it("should instantiate AuthenticationError and RateLimitError extending ProviderError", () => {
      const authErr = new AuthenticationError("Unauthorized", { statusCode: 401, protocol: "anthropic" });
      expect(authErr).toBeInstanceOf(ProviderError);
      expect(authErr).toBeInstanceOf(AuthenticationError);
      expect(authErr.name).toBe("AuthenticationError");
      expect(authErr.statusCode).toBe(401);
      expect(authErr.protocol).toBe("anthropic");

      const rateErr = new RateLimitError("Rate limit exceeded", { statusCode: 429, protocol: "gemini" });
      expect(rateErr).toBeInstanceOf(ProviderError);
      expect(rateErr).toBeInstanceOf(RateLimitError);
      expect(rateErr.name).toBe("RateLimitError");
      expect(rateErr.statusCode).toBe(429);
    });

    it("should instantiate InvalidRequestError and CompactError", () => {
      const invErr = new InvalidRequestError("Invalid message role");
      expect(invErr).toBeInstanceOf(AISessionError);
      expect(invErr).toBeInstanceOf(InvalidRequestError);

      const compErr = new CompactError("Compacting context failed");
      expect(compErr).toBeInstanceOf(AISessionError);
      expect(compErr).toBeInstanceOf(CompactError);
    });
  });

  describe("Interface Conformance", () => {
    it("conforms to Message and SessionData type definitions", () => {
      const msg: Message = {
        id: "msg_1",
        role: "user",
        content: "Hello AI",
        createdAt: Date.now(),
        metadata: { source: "web" },
      };

      const session: SessionData = {
        userId: "u1",
        sessionId: "s1",
        systemContext: "You are helpful",
        messages: [msg],
        summary: "Previous conversation summary",
        metadata: { tag: "test" },
        createdAt: 1000,
        updatedAt: 2000,
      };

      expect(session.userId).toBe("u1");
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe("user");
    });

    it("conforms to ProviderConfig and Request/Response definitions", () => {
      const config: ProviderConfig = {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o",
      };

      const req: ProviderChatRequest = {
        model: config.model,
        messages: [{ role: "user", content: "Hi" }],
        system: "Be concise",
        temperature: 0.7,
      };

      const res: ProviderChatResponse = {
        role: "assistant",
        content: "Hello there!",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };

      const chunk: ProviderChunkResponse = {
        delta: "Hello",
        role: "assistant",
        done: false,
      };

      expect(config.protocol).toBe("openai");
      expect(req.messages[0].content).toBe("Hi");
      expect(res.content).toBe("Hello there!");
      expect(chunk.delta).toBe("Hello");
    });

    it("allows implementing mock IStorage and IProvider", async () => {
      const mockStorage: IStorage = {
        saveSession: async () => {},
        loadSession: async (_u, _s) => null,
        updateSession: async () => {},
        deleteSession: async (_u, _s) => true,
        listSessions: async (_u) => [],
      };

      const mockProvider: IProvider = {
        protocol: "custom",
        chat: async (_req) => ({ role: "assistant", content: "mock response" }),
        chatStream: async function* (_req) {
          yield { delta: "mock ", done: false };
          yield { delta: "response", done: true };
        },
      };

      expect(mockStorage).toBeDefined();
      expect(mockProvider.protocol).toBe("custom");
      const resp = await mockProvider.chat({ messages: [] });
      expect(resp.content).toBe("mock response");

      const chunks: string[] = [];
      for await (const chunk of await mockProvider.chatStream({ messages: [] })) {
        chunks.push(chunk.delta);
      }
      expect(chunks.join("")).toBe("mock response");
    });
  });
});
