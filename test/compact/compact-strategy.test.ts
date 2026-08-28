import { describe, it, expect } from "vitest";
import {
  summarizeConversation,
  CompactError,
  type IProvider,
  type Message,
} from "../../src/index.js";

describe("Compact Strategy (TASK-009)", () => {
  const sampleMessages: Message[] = [
    { id: "1", role: "user", content: "My name is Alice and I like pizza.", createdAt: 1000 },
    { id: "2", role: "assistant", content: "Nice to meet you Alice!", createdAt: 2000 },
    { id: "3", role: "user", content: "I also live in Tokyo.", createdAt: 3000 },
    { id: "4", role: "assistant", content: "Tokyo is a great city.", createdAt: 4000 },
  ];

  it("summarizes conversation turns through provider", async () => {
    let capturedSystem = "";
    let capturedPrompt = "";

    const mockProvider: IProvider = {
      protocol: "mock",
      chat: async (req) => {
        capturedSystem = req.system || "";
        capturedPrompt = req.messages[0].content;
        return {
          role: "assistant",
          content: "User Alice likes pizza and lives in Tokyo.",
        };
      },
      chatStream: async function* () {},
    };

    const summary = await summarizeConversation(sampleMessages, undefined, mockProvider);
    expect(summary).toBe("User Alice likes pizza and lives in Tokyo.");
    expect(capturedSystem).toContain("summarizer");
    expect(capturedPrompt).toContain("My name is Alice");
    expect(capturedPrompt).toContain("Tokyo");
  });

  it("combines with previous summary when present", async () => {
    let capturedPrompt = "";

    const mockProvider: IProvider = {
      protocol: "mock",
      chat: async (req) => {
        capturedPrompt = req.messages[0].content;
        return {
          role: "assistant",
          content: "Updated combined summary.",
        };
      },
      chatStream: async function* () {},
    };

    const summary = await summarizeConversation(
      sampleMessages,
      "Prior fact: Alice is a software engineer.",
      mockProvider
    );

    expect(summary).toBe("Updated combined summary.");
    expect(capturedPrompt).toContain("[PREVIOUS SUMMARY]");
    expect(capturedPrompt).toContain("Alice is a software engineer.");
  });

  it("throws CompactError when provider throws or returns empty", async () => {
    const failingProvider: IProvider = {
      protocol: "fail",
      chat: async () => {
        throw new Error("Provider rate limit error");
      },
      chatStream: async function* () {},
    };

    await expect(
      summarizeConversation(sampleMessages, undefined, failingProvider)
    ).rejects.toThrow(CompactError);
  });
});
