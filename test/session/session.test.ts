import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Session,
  MemoryStorage,
  type IProvider,
  type ProviderChatRequest,
  type ProviderChatResponse,
  ProviderError,
} from "../../src/index.js";

describe("Session & History Management (TASK-008)", () => {
  let storage: MemoryStorage;
  let mockProvider: IProvider;
  let chatCallHistory: ProviderChatRequest[] = [];

  beforeEach(() => {
    storage = new MemoryStorage();
    chatCallHistory = [];
    mockProvider = {
      protocol: "mock",
      chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
        chatCallHistory.push(req);
        return {
          role: "assistant",
          content: `Reply to: ${req.messages[req.messages.length - 1].content}`,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
      chatStream: async function* (req) {
        yield { delta: `Streamed: ${req.messages[req.messages.length - 1].content}`, done: true };
      },
    };
  });

  describe("Session creation and chat loop", () => {
    it("initializes new session with system context and saves message history", async () => {
      const session = new Session({
        userId: "user_001",
        sessionId: "sess_001",
        system: "You are a helpful assistant.",
        metadata: { client: "web" },
        storage,
        provider: mockProvider,
      });

      const reply1 = await session.chat("Hello AI");
      expect(reply1.content).toBe("Reply to: Hello AI");
      expect(reply1.message.role).toBe("assistant");
      expect(reply1.message.content).toBe("Reply to: Hello AI");

      const history1 = await session.getHistory();
      expect(history1).toHaveLength(2);
      expect(history1[0].role).toBe("user");
      expect(history1[0].content).toBe("Hello AI");
      expect(history1[1].role).toBe("assistant");
      expect(history1[1].content).toBe("Reply to: Hello AI");

      // Verify stored data in storage
      const stored = await storage.loadSession("user_001", "sess_001");
      expect(stored?.systemContext).toBe("You are a helpful assistant.");
      expect(stored?.messages).toHaveLength(2);
      expect(stored?.metadata?.client).toBe("web");
    });

    it("continues conversation and keeps appending full history", async () => {
      const session = new Session({
        userId: "user_001",
        sessionId: "sess_001",
        storage,
        provider: mockProvider,
      });

      await session.chat("Message 1");
      await session.chat("Message 2");
      await session.chat("Message 3");

      const history = await session.getHistory();
      expect(history).toHaveLength(6);
      expect(history.map((m) => m.content)).toEqual([
        "Message 1",
        "Reply to: Message 1",
        "Message 2",
        "Reply to: Message 2",
        "Message 3",
        "Reply to: Message 3",
      ]);

      // Verify the 3rd provider call received all prior messages
      expect(chatCallHistory).toHaveLength(3);
      expect(chatCallHistory[2].messages).toHaveLength(5); // 2 previous turns + new user message
    });
  });

  describe("Session restoration and persistence", () => {
    it("restores session state across new Session instances using the same userId and sessionId", async () => {
      // Session instance 1
      const session1 = new Session({
        userId: "user_alpha",
        sessionId: "sess_shared",
        system: "System prompt alpha",
        storage,
        provider: mockProvider,
      });
      await session1.chat("Initial message");

      // Session instance 2 (simulating app restart / new request)
      const session2 = new Session({
        userId: "user_alpha",
        sessionId: "sess_shared",
        storage,
        provider: mockProvider,
      });

      const history = await session2.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe("Initial message");

      const nextReply = await session2.chat("Second message");
      expect(nextReply.content).toBe("Reply to: Second message");

      const updatedHistory = await session2.getHistory();
      expect(updatedHistory).toHaveLength(4);
    });

    it("does not mix up sessions between different users with same sessionId", async () => {
      const sessionUserA = new Session({
        userId: "user_A",
        sessionId: "sess_common",
        storage,
        provider: mockProvider,
      });
      const sessionUserB = new Session({
        userId: "user_B",
        sessionId: "sess_common",
        storage,
        provider: mockProvider,
      });

      await sessionUserA.chat("Secret data from A");
      await sessionUserB.chat("Secret data from B");

      const historyA = await sessionUserA.getHistory();
      const historyB = await sessionUserB.getHistory();

      expect(historyA[0].content).toBe("Secret data from A");
      expect(historyB[0].content).toBe("Secret data from B");
      expect(historyA).toHaveLength(2);
      expect(historyB).toHaveLength(2);
    });
  });

  describe("Error handling during chat", () => {
    it("does not persist assistant message when provider fails", async () => {
      const failingProvider: IProvider = {
        protocol: "failing",
        chat: async () => {
          throw new ProviderError("AI service unavailable", { statusCode: 503 });
        },
        chatStream: async function* () {
          throw new ProviderError("AI service unavailable");
        },
      };

      const session = new Session({
        userId: "user_001",
        sessionId: "sess_fail",
        storage,
        provider: failingProvider,
      });

      await expect(session.chat("Will fail")).rejects.toThrow(ProviderError);

      const history = await session.getHistory();
      // No assistant message was saved, and failed user message rolled back
      expect(history).toHaveLength(0);

      const stored = await storage.loadSession("user_001", "sess_fail");
      expect(stored?.messages).toHaveLength(0);
    });
  });

  describe("Metadata and History manipulation", () => {
    it("updates metadata and clears history correctly", async () => {
      const session = new Session({
        userId: "user_001",
        sessionId: "sess_meta",
        storage,
        provider: mockProvider,
      });

      await session.chat("Hello");
      await session.updateMetadata({ lastAction: "chat", count: 1 });

      const meta = await session.getMetadata();
      expect(meta).toEqual({ lastAction: "chat", count: 1 });

      await session.clearHistory();
      const history = await session.getHistory();
      expect(history).toHaveLength(0);

      const stored = await storage.loadSession("user_001", "sess_meta");
      expect(stored?.metadata?.lastAction).toBe("chat");
    });

    it("deletes session from storage", async () => {
      const session = new Session({
        userId: "user_001",
        sessionId: "sess_del",
        storage,
        provider: mockProvider,
      });

      await session.chat("Hello");
      expect(await storage.loadSession("user_001", "sess_del")).not.toBeNull();

      const deleted = await session.delete();
      expect(deleted).toBe(true);
      expect(await storage.loadSession("user_001", "sess_del")).toBeNull();
    });
  });
});
