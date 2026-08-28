import { describe, it, expect } from "vitest";
import {
  ContextManager,
  type IProvider,
  type SessionData,
} from "../../src/index.js";

describe("ContextManager (TASK-009)", () => {
  const mockProvider: IProvider = {
    protocol: "mock",
    chat: async () => ({
      role: "assistant",
      content: "Summary of older messages: Alice likes coding in Node.js.",
    }),
    chatStream: async function* () {},
  };

  const createTestSession = (messageCount = 6): SessionData => {
    const messages = [];
    for (let i = 1; i <= messageCount; i++) {
      messages.push({
        id: `m${i}`,
        role: (i % 2 === 1 ? "user" : "assistant") as "user" | "assistant",
        content: `This is message number ${i} containing some sample text to occupy token budget.`,
        createdAt: i * 1000,
      });
    }
    return {
      userId: "u1",
      sessionId: "s1",
      systemContext: "You are a helpful assistant.",
      messages,
      summary: undefined,
      createdAt: 1000,
      updatedAt: 1000,
    };
  };

  it("calculates session token counts accurately", () => {
    const manager = new ContextManager({ maxContextTokens: 1000 });
    const session = createTestSession(4);

    const tokens = manager.calculateSessionTokens(session);
    expect(tokens.systemTokens).toBeGreaterThan(0);
    expect(tokens.messagesTokens).toBeGreaterThan(0);
    expect(tokens.totalTokens).toBe(tokens.systemTokens + tokens.messagesTokens);
  });

  it("triggers shouldCompact only when total tokens >= threshold and messages > keepRecentMessages", () => {
    const manager = new ContextManager({
      maxContextTokens: 100,
      compactThresholdTokens: 50,
      keepRecentMessages: 2,
    });

    const smallSession = createTestSession(1);
    expect(manager.shouldCompact(smallSession)).toBe(false);

    const largeSession = createTestSession(6);
    expect(manager.shouldCompact(largeSession)).toBe(true);
  });

  it("builds context without compaction when under threshold", async () => {
    const manager = new ContextManager({
      maxContextTokens: 10000,
      compactThresholdTokens: 5000,
      keepRecentMessages: 2,
    });

    const session = createTestSession(4);
    const context = await manager.buildContext(session, mockProvider);

    expect(context.compacted).toBe(false);
    expect(context.messages).toHaveLength(4);
    expect(context.system).toBe("You are a helpful assistant.");
    expect(session.summary).toBeUndefined();
  });

  it("automatically compacts older messages when threshold exceeded", async () => {
    const manager = new ContextManager({
      maxContextTokens: 100,
      compactThresholdTokens: 50,
      keepRecentMessages: 2,
      autoCompact: true,
    });

    const session = createTestSession(6);
    expect(session.messages).toHaveLength(6);

    const context = await manager.buildContext(session, mockProvider);

    expect(context.compacted).toBe(true);
    // Full history is preserved intact!
    expect(session.messages).toHaveLength(6);
    // Summary was populated
    expect(session.summary).toBe("Summary of older messages: Alice likes coding in Node.js.");
    // System prompt in context contains summary
    expect(context.system).toContain("Previous Conversation Summary");
    expect(context.system).toContain("Alice likes coding in Node.js");
    // Context projection only includes the recent uncompacted messages
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0].content).toBe(session.messages[4].content);
    expect(context.messages[1].content).toBe(session.messages[5].content);
  });

  it("handles consecutive compaction cycles smoothly", async () => {
    let summaryCycle = 1;
    const iterativeProvider: IProvider = {
      protocol: "mock",
      chat: async () => ({
        role: "assistant",
        content: `Summary revision ${summaryCycle++}`,
      }),
      chatStream: async function* () {},
    };

    const manager = new ContextManager({
      maxContextTokens: 100,
      compactThresholdTokens: 40,
      keepRecentMessages: 2,
    });

    const session = createTestSession(4);
    await manager.buildContext(session, iterativeProvider);
    expect(session.summary).toBe("Summary revision 1");

    // Add more messages
    session.messages.push(
      { id: "m5", role: "user", content: "New question 5", createdAt: 5000 },
      { id: "m6", role: "assistant", content: "New answer 6", createdAt: 6000 },
      { id: "m7", role: "user", content: "New question 7", createdAt: 7000 }
    );

    const context2 = await manager.buildContext(session, iterativeProvider);
    expect(context2.compacted).toBe(true);
    expect(session.summary).toBe("Summary revision 2");
    expect(session.messages).toHaveLength(7); // full history never lost
  });
});
