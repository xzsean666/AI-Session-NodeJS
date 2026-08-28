import { describe, it, expect } from "vitest";
import {
  AIClient,
  MemoryStorage,
  type IProvider,
  type ProviderChatRequest,
} from "../../src/index.js";

describe("AIClient (TASK-008)", () => {
  const mockProvider: IProvider = {
    protocol: "openai",
    chat: async (req: ProviderChatRequest) => ({
      role: "assistant",
      content: `AI echo: ${req.messages[req.messages.length - 1].content}`,
    }),
    chatStream: async function* (req) {
      yield { delta: `Streamed: ${req.messages[req.messages.length - 1].content}`, done: true };
    },
  };

  it("creates AIClient with config and manages sessions", async () => {
    const ai = new AIClient({
      provider: mockProvider,
    });

    const session = ai.session({
      userId: "alice",
      sessionId: "session_alice_1",
      system: "You are an assistant",
    });

    const reply = await session.chat("Hello from client test");
    expect(reply.content).toBe("AI echo: Hello from client test");

    // Load session via client
    const loaded = await ai.loadSession("alice", "session_alice_1");
    expect(loaded).not.toBeNull();
    const history = await loaded!.getHistory();
    expect(history).toHaveLength(2);

    // List sessions
    const sessions = await ai.listSessions("alice");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("session_alice_1");

    // Delete session
    const deleted = await ai.deleteSession("alice", "session_alice_1");
    expect(deleted).toBe(true);
    expect(await ai.loadSession("alice", "session_alice_1")).toBeNull();
  });

  it("instantiates provider automatically from ProviderConfig and uses SQLiteStorage by default", () => {
    const ai = new AIClient({
      provider: {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-mock",
        model: "gpt-4o",
      },
    });

    expect(ai.getProvider().protocol).toBe("openai");
    expect(ai.getStorage()).toBeDefined();

    // Custom memory storage option
    const aiMemory = new AIClient({
      provider: {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-mock",
        model: "gpt-4o",
      },
      storage: new MemoryStorage(),
    });
    expect(aiMemory.getStorage()).toBeInstanceOf(MemoryStorage);
  });
});
