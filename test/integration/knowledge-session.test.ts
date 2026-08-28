import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AIClient,
  SQLiteStorage,
  type IProvider,
  type ProviderChatRequest,
} from "../../src/index.js";

describe("Knowledge Base in Session Integration", () => {
  const tempKnowledgeDir = path.resolve("./test/scratch-e2e-knowledge");
  const tempDbDir = path.resolve("./test/scratch-e2e-db");

  beforeEach(() => {
    if (fs.existsSync(tempKnowledgeDir)) {
      fs.rmSync(tempKnowledgeDir, { recursive: true, force: true });
    }
    if (fs.existsSync(tempDbDir)) {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempKnowledgeDir, { recursive: true });
    fs.mkdirSync(tempDbDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempKnowledgeDir)) {
      fs.rmSync(tempKnowledgeDir, { recursive: true, force: true });
    }
    if (fs.existsSync(tempDbDir)) {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
    }
  });

  it("supports passing a single markdown file path as system prompt", async () => {
    const mdPath = path.join(tempKnowledgeDir, "api-rules.md");
    fs.writeFileSync(
      mdPath,
      `# API Rules
## Authentication
All requests must include Bearer token in Authorization header.
`
    );

    let lastSystemReceived = "";
    const mockProvider: IProvider = {
      protocol: "openai",
      chat: async (req: ProviderChatRequest) => {
        lastSystemReceived = req.system || "";
        return {
          role: "assistant",
          content: "Answer based on API rules",
        };
      },
      chatStream: async function* () {
        yield { delta: "ok", done: true };
      },
    };

    const ai = new AIClient({
      provider: mockProvider,
      storage: new SQLiteStorage({ dbPath: path.join(tempDbDir, "test.db") }),
    });

    const session = ai.session({
      userId: "u1",
      sessionId: "s_file_test",
      system: mdPath, // Pass file path directly
    });

    const reply = await session.chat("How do I authenticate?");
    expect(reply.content).toBe("Answer based on API rules");
    expect(lastSystemReceived).toContain("Authentication");
    expect(lastSystemReceived).toContain("Bearer token");

    expect(session.getKnowledgeManager()).toBeDefined();
  });

  it("supports passing a directory with KnowledgeConfig as system prompt with RAG retrieval", async () => {
    // Create multiple markdown files
    fs.writeFileSync(
      path.join(tempKnowledgeDir, "01-order.md"),
      `# Order Module
## Status Transition
PENDING -> PAID -> SHIPPED -> COMPLETED
`
    );
    fs.writeFileSync(
      path.join(tempKnowledgeDir, "02-refund.md"),
      `# Refund Module
## Refund SLA
Refunds must be processed within 24 hours.
`
    );

    let lastSystemReceived = "";
    const mockProvider: IProvider = {
      protocol: "openai",
      chat: async (req: ProviderChatRequest) => {
        lastSystemReceived = req.system || "";
        return {
          role: "assistant",
          content: "Knowledge answer",
        };
      },
      chatStream: async function* () {
        yield { delta: "stream answer", done: true };
      },
    };

    const ai = new AIClient({
      provider: mockProvider,
      storage: new SQLiteStorage({ dbPath: path.join(tempDbDir, "test2.db") }),
    });

    const session = ai.session({
      userId: "u2",
      sessionId: "s_dir_test",
      system: {
        prompt: "You are the system architect.",
        path: tempKnowledgeDir,
        mode: "rag",
        maxKnowledgeTokens: 1500,
      },
    });

    // Query refund
    await session.chat("What is the refund SLA?");
    expect(lastSystemReceived).toContain("You are the system architect.");
    expect(lastSystemReceived).toContain("Refund SLA");
    expect(lastSystemReceived).toContain("within 24 hours");

    // Query order
    await session.chat("What is the order status transition?");
    expect(lastSystemReceived).toContain("Status Transition");
    expect(lastSystemReceived).toContain("PENDING -> PAID");
  });
});
