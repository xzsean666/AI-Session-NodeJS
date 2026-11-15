import { describe, it, expect } from "vitest";
import {
  MemoryStorage,
  CachedStorage,
  SQLiteStorage,
  extractCodeSkeleton,
  chunkMarkdown,
  extractMarkdownTOC,
  Session,
  AIClient,
  type IProvider,
  OpenAICompatibleProvider,
  LoadBalancedProvider,
  CachedProvider,
  KnowledgeManager,
} from "../../src/index.js";

describe("Production Audit Fixes & Regressions", () => {
  describe("Security: Storage Key Collision Immunity", () => {
    it("prevents multi-tenant session IDOR key collision in MemoryStorage", async () => {
      const storage = new MemoryStorage();

      await storage.saveSession({
        userId: "user:1",
        sessionId: "abc",
        messages: [{ id: "m1", role: "user", content: "secret tenant data", createdAt: 1 }],
        createdAt: 1,
        updatedAt: 1,
      });

      // User 'user' trying to access session '1:abc' should NOT hit 'user:1' + 'abc'
      const crossTenantLoad = await storage.loadSession("user", "1:abc");
      expect(crossTenantLoad).toBeNull();

      // Deleting 'user' + '1:abc' should not delete 'user:1' + 'abc'
      await storage.deleteSession("user", "1:abc");
      const original = await storage.loadSession("user:1", "abc");
      expect(original).not.toBeNull();
      expect(original?.userId).toBe("user:1");
    });

    it("prevents multi-tenant session IDOR key collision in CachedStorage", async () => {
      const underlying = new MemoryStorage();
      const cached = new CachedStorage(underlying);

      await cached.saveSession({
        userId: "tenant:alpha",
        sessionId: "123",
        messages: [{ id: "m1", role: "user", content: "confidential alpha", createdAt: 1 }],
        createdAt: 1,
        updatedAt: 1,
      });

      const maliciousLoad = await cached.loadSession("tenant", "alpha:123");
      expect(maliciousLoad).toBeNull();
    });
  });

  describe("Parser: Markdown & Code Skeleton Correctness", () => {
    it("does not treat # comments inside code blocks as Markdown headings", () => {
      const md = `
# Developer Guide

\`\`\`python
# This is a python comment
def hello():
    return "world"
\`\`\`

## Next Section
More details here.
`;
      const sections = chunkMarkdown("guide.md", md);
      const headings = sections.map((s) => s.heading);
      expect(headings).toContain("guide.md > Developer Guide");
      expect(headings).toContain("guide.md > Developer Guide > Next Section");
      expect(headings).not.toContain("guide.md > This is a python comment");

      const toc = extractMarkdownTOC("guide.md", md);
      expect(toc.headings.map((h) => h.heading)).not.toContain("This is a python comment");
    });

    it("preserves class method and property signatures in extractCodeSkeleton", () => {
      const tsCode = `
export class PaymentProcessor {
  private apiKey: string;

  constructor(key: string) {
    this.apiKey = key;
  }

  public async charge(amount: number): Promise<boolean> {
    const fee = amount * 0.02;
    return true;
  }

  get status(): string {
    return "active";
  }
}
`;
      const skeleton = extractCodeSkeleton("payment.ts", tsCode);
      expect(skeleton).toContain("export class PaymentProcessor {");
      expect(skeleton).toContain("constructor(key: string) { /* ... */ }");
      expect(skeleton).toContain("public async charge(amount: number): Promise<boolean> { /* ... */ }");
      expect(skeleton).toContain("get status(): string { /* ... */ }");
      expect(skeleton).not.toContain("const fee = amount * 0.02");
    });
  });

  describe("Storage: SQLite FTS5 & Multi-Scope Isolation", () => {
    it("eliminates Cartesian product duplication for duplicate headings", () => {
      const storage = new SQLiteStorage({ dbPath: ":memory:" });

      storage.saveChunks("doc.md", [
        { heading: "doc.md > Overview", content: "Introduction text keyword", tokens: 10 },
        { heading: "doc.md > Overview", content: "Different section same heading keyword", tokens: 10 },
      ]);

      const results = storage.searchChunks("keyword", 10);
      // Must return exactly 2 chunks, not 4 (no Cartesian product)
      expect(results).toHaveLength(2);
      expect(results[0].id).not.toBe(results[1].id);

      storage.close();
    });

    it("matches Chinese queries without spaces using CJK n-grams", () => {
      const storage = new SQLiteStorage({ dbPath: ":memory:" });

      storage.saveChunks("faq.md", [
        {
          heading: "faq.md > 售后退款政策",
          content: "针对所有VIP客户的退款与订单取消流程在此进行说明与指引。",
          tokens: 20,
        },
      ]);

      // Query without spaces
      const results = storage.searchChunks("VIP客户退款政策是什么", 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("VIP客户的退款");

      storage.close();
    });

    it("isolates different knowledge base scopes so Session B does not wipe Session A", async () => {
      const storage = new SQLiteStorage({ dbPath: ":memory:" });

      // Scope A
      storage.saveFileMeta({
        filePath: "docA.md",
        mtime: 100,
        size: 200,
        hash: "hashA",
        indexedAt: Date.now(),
        scope: "scopeA",
      });
      storage.saveChunks("docA.md", [{ heading: "DocA", content: "Content A", tokens: 5 }], "scopeA");

      // Scope B
      storage.saveFileMeta({
        filePath: "docB.md",
        mtime: 100,
        size: 200,
        hash: "hashB",
        indexedAt: Date.now(),
        scope: "scopeB",
      });
      storage.saveChunks("docB.md", [{ heading: "DocB", content: "Content B", tokens: 5 }], "scopeB");

      expect(storage.getAllFileMetas("scopeA").size).toBe(1);
      expect(storage.getAllFileMetas("scopeB").size).toBe(1);

      // Deleting within scope B must not affect scope A
      storage.deleteFile("docB.md", "scopeB");
      expect(storage.getFileMeta("docB.md", "scopeB")).toBeNull();
      expect(storage.getFileMeta("docA.md", "scopeA")).not.toBeNull();
      expect(storage.getAllChunks(10, "scopeA")).toHaveLength(1);

      storage.close();
    });
  });

  describe("Session: Concurrency Lock & Context Compaction Integration", () => {
    it("serializes concurrent chat calls using async mutex to prevent race conditions", async () => {
      const storage = new MemoryStorage();
      let callOrder: string[] = [];

      const mockProvider: IProvider = {
        protocol: "mock",
        chat: async (req) => {
          const userMsg = req.messages[req.messages.length - 1].content;
          callOrder.push(`start:${userMsg}`);
          await new Promise((r) => setTimeout(r, 20));
          callOrder.push(`end:${userMsg}`);
          return { role: "assistant", content: `Echo: ${userMsg}` };
        },
        chatStream: async function* () {},
      };

      const ai = new AIClient({
        provider: mockProvider,
        storage,
      });

      const session = ai.session({
        userId: "user_concurrency",
        sessionId: "sess_concurrency",
      });

      // Fire 2 concurrent chat calls simultaneously
      const [res1, res2] = await Promise.all([
        session.chat("First Call"),
        session.chat("Second Call"),
      ]);

      expect(res1.content).toBe("Echo: First Call");
      expect(res2.content).toBe("Echo: Second Call");

      // Operations must have executed sequentially, not interleaved
      expect(callOrder).toEqual([
        "start:First Call",
        "end:First Call",
        "start:Second Call",
        "end:Second Call",
      ]);

      const history = await session.getHistory();
      expect(history).toHaveLength(4);
      expect(history[0].content).toBe("First Call");
      expect(history[1].content).toBe("Echo: First Call");
      expect(history[2].content).toBe("Second Call");
      expect(history[3].content).toBe("Echo: Second Call");
    });

    it("retains conversation summary when knowledge base is enabled upon compaction", async () => {
      const storage = new MemoryStorage();
      let capturedSystemPrompt = "";

      const mockProvider: IProvider = {
        protocol: "mock",
        chat: async (req) => {
          capturedSystemPrompt = req.system || "";
          return { role: "assistant", content: "Assistant answer" };
        },
        chatStream: async function* () {},
      };

      const ai = new AIClient({
        provider: mockProvider,
        storage,
      });

      const session = ai.session({
        userId: "user_kb_compact",
        sessionId: "sess_kb_compact",
        system: {
          content: "# FAQ\nRefunds are processed within 3 days.",
          mode: "full",
        },
      });

      // Pre-seed an existing summary
      const data = await session.getData();
      data.summary = "User asked about refund rules earlier.";
      await storage.saveSession(data);
      await session.reload();

      await session.chat("How long does it take?");

      // System prompt must contain BOTH the knowledge text AND the previous conversation summary
      expect(capturedSystemPrompt).toContain("Refunds are processed within 3 days.");
      expect(capturedSystemPrompt).toContain("[Previous Conversation Summary]");
      expect(capturedSystemPrompt).toContain("User asked about refund rules earlier.");
    });
  });

  describe("Provider: OpenAI Trailing Usage & Reasoning Support", () => {
    it("captures trailing usage chunk emitted after finish_reason in streaming", async () => {
      const mockFetch: typeof fetch = async () => {
        const sse =
          `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
          `data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":5,"total_tokens":20}}\n\n` +
          `data: [DONE]\n\n`;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      };

      const provider = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o",
        fetch: mockFetch,
        customOptions: { maxRetries: 0 },
      });

      const stream = await provider.chatStream({
        messages: [{ role: "user", content: "Hi" }],
      });

      let finalUsage = undefined;
      for await (const chunk of stream) {
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      }

      expect(finalUsage).toBeDefined();
      expect(finalUsage?.promptTokens).toBe(15);
      expect(finalUsage?.completionTokens).toBe(5);
      expect(finalUsage?.totalTokens).toBe(20);
    });

    it("emits delta reasoning tokens for DeepSeek-R1 / thinking models", async () => {
      const mockFetch: typeof fetch = async () => {
        const sse =
          `data: {"choices":[{"delta":{"reasoning_content":"Thinking steps..."},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{"content":"Final Answer"},"finish_reason":"stop"}]}\n\n` +
          `data: [DONE]\n\n`;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      };

      const provider = new OpenAICompatibleProvider({
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "deepseek-reasoner",
        fetch: mockFetch,
        customOptions: { maxRetries: 0 },
      });

      const stream = await provider.chatStream({
        messages: [{ role: "user", content: "Solve math problem" }],
      });

      const reasoningDeltas: string[] = [];
      const contentDeltas: string[] = [];

      for await (const chunk of stream) {
        if (chunk.reasoning) {
          reasoningDeltas.push(chunk.reasoning);
        }
        if (chunk.delta) {
          contentDeltas.push(chunk.delta);
        }
      }

      expect(reasoningDeltas.join("")).toBe("Thinking steps...");
      expect(contentDeltas.join("")).toBe("Final Answer");
    });
  });

  describe("Proxy: CachedProvider method delegation", () => {
    it("transparently delegates LoadBalancedProvider methods via Proxy", () => {
      const lb = new LoadBalancedProvider({
        protocol: "openai",
        model: "gpt-4o",
        baseUrls: ["https://api-1.com/v1", "https://api-2.com/v1"],
        apiKey: "sk-test",
      });

      const cached = new CachedProvider(lb);

      // CachedProvider should directly proxy getTargets, pinSession, etc.
      expect(typeof (cached as any).getTargets).toBe("function");
      expect((cached as any).getTargets()).toHaveLength(2);

      (cached as any).pinSession("sess-1", 1);
      expect((cached as any).getPinnedTargetIndex("sess-1")).toBe(1);
    });
  });
});
