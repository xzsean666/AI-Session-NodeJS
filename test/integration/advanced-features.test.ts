import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AIClient,
  MemoryStorage,
  SQLiteStorage,
  KnowledgeManager,
  chunkMarkdown,
  SessionStream,
  type IProvider,
  type ProviderChatRequest,
  type ProviderChunkResponse,
  type KnowledgeChunk,
} from "../../src/index.js";

describe("Advanced SDK Enhancements & Developer Experience", () => {
  const tempDir = path.resolve("./test/scratch-advanced-features");

  beforeEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Knowledge: Secondary Chunking on Oversized Sections", () => {
    it("sub-chunks oversized markdown sections by paragraphs with overlap and breadcrumbs", () => {
      // Create a markdown file with one section containing 4 large paragraphs
      const p1 = "Paragraph 1: Introduction to database replication protocols and consensus algorithms. ".repeat(15);
      const p2 = "Paragraph 2: Raft leader election details, term increments, and heartbeat intervals. ".repeat(15);
      const p3 = "Paragraph 3: Log compaction, snapshotting mechanisms, and state machine persistence. ".repeat(15);
      const p4 = "Paragraph 4: Split-brain prevention, quorum calculation, and network partition recovery. ".repeat(15);

      const content = `# Distributed Systems\n## Consensus Engine\n\n${p1}\n\n${p2}\n\n${p3}\n\n${p4}`;

      // Max 100 tokens per sub-chunk to trigger paragraph sub-chunking
      const sections = chunkMarkdown("consensus.md", content, {
        maxSectionTokens: 120,
        overlapTokens: 40,
      });

      expect(sections.length).toBeGreaterThan(1);
      expect(sections[0].heading).toContain("consensus.md > Distributed Systems > Consensus Engine (Part 1/");
      expect(sections[1].heading).toContain("consensus.md > Distributed Systems > Consensus Engine (Part 2/");

      // Check breadcrumbs
      expect(sections[0].breadcrumbs).toContain("Consensus Engine (Part 1)");
      expect(sections[1].breadcrumbs).toContain("Consensus Engine (Part 2)");
    });
  });

  describe("Knowledge: Zero-Match Relevance Suppression", () => {
    it("does not inject random knowledge chunks when query has no matching documents", async () => {
      const storage = new SQLiteStorage({ dbPath: ":memory:" });
      storage.saveChunks("shipping.md", [
        { heading: "shipping.md > Domestic", content: "Domestic shipping takes 2 business days.", tokens: 10 },
      ]);

      const manager = new KnowledgeManager(
        {
          content: "# Shipping\n## Domestic\nDomestic shipping takes 2 business days.",
          prompt: "You are a customer assistant.",
          mode: "rag",
          fallbackOnNoMatch: false, // Default is false
        },
        storage
      );

      // Casual greeting that does not match shipping
      const { systemPrompt } = await manager.buildSystemContext("Hello, good morning!");
      expect(systemPrompt).toContain("You are a customer assistant.");
      // Must NOT contain the shipping chunk
      expect(systemPrompt).not.toContain("Domestic shipping takes 2 business days.");
      expect(systemPrompt).not.toContain("# Relevant Knowledge Context:");

      storage.close();
    });
  });

  describe("Knowledge: Context-Aware Query Expansion in Multi-turn Chat", () => {
    it("expands brief queries containing pronouns using topic from previous turn", async () => {
      let capturedSystemPrompt = "";

      const mockProvider: IProvider = {
        protocol: "openai",
        chat: async (req: ProviderChatRequest) => {
          capturedSystemPrompt = req.system || "";
          return { role: "assistant", content: "Plan details" };
        },
        chatStream: async function* () {},
      };

      const ai = new AIClient({
        provider: mockProvider,
        storage: new MemoryStorage(),
      });

      const session = ai.session({
        userId: "u_ctx",
        sessionId: "s_ctx",
        system: {
          files: {
            "plans.md": "# Enterprise Plan\n## SLA Guarantee\nEnterprise plan comes with a 99.99% uptime SLA.",
          },
          mode: "rag",
        },
      });

      // Turn 1: Mention "Enterprise Plan"
      await session.chat("Tell me about the Enterprise Plan");
      expect(capturedSystemPrompt).toContain("Enterprise Plan");

      // Turn 2: Ask about "it" without mentioning Enterprise Plan directly
      await session.chat("What is its SLA?");

      // Knowledge retriever should have expanded "What is its SLA?" using "Enterprise Plan"
      expect(capturedSystemPrompt).toContain("Enterprise Plan > SLA Guarantee");
      expect(capturedSystemPrompt).toContain("99.99% uptime SLA");
    });
  });

  describe("Knowledge: Hybrid Search with Reciprocal Rank Fusion (RRF)", () => {
    it("merges lexical and custom vector search results using RRF ranking", async () => {
      const mockVectorSearch = async (query: string, limit: number) => {
        // Vector search returns a semantically matched chunk that has different wording
        return [
          {
            filePath: "terms.md",
            heading: "terms.md > Termination Clause",
            content: "Accounts may be closed upon 30 days notice.",
            tokens: 15,
          },
        ];
      };

      const manager = new KnowledgeManager({
        content: `# Legal\n## Cancellation\nUsers can stop service anytime.`,
        mode: "rag",
        vectorSearch: mockVectorSearch,
      });

      const { systemPrompt } = await manager.buildSystemContext("How do I terminate my contract?");

      // Hybrid search should include vector-found chunk even if keywords differ
      expect(systemPrompt).toContain("Termination Clause");
      expect(systemPrompt).toContain("Accounts may be closed upon 30 days notice.");
    });
  });

  describe("SessionStream: Fluent Streaming DX", () => {
    it("provides .text(), .reasoning(), .onText(), and .onReasoning() callbacks", async () => {
      const mockStream = async function* (): AsyncIterable<ProviderChunkResponse> {
        yield { delta: "", reasoning: "First thinking step... ", done: false };
        yield { delta: "", reasoning: "Second thinking step.", done: false };
        yield { delta: "Hello ", done: false };
        yield { delta: "World!", done: true, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      };

      const stream = new SessionStream(mockStream());
      const textsReceived: string[] = [];
      const reasoningsReceived: string[] = [];
      let finalResultCaptured: any = null;

      stream.onText((t) => textsReceived.push(t));
      stream.onReasoning((r) => reasoningsReceived.push(r));
      stream.onFinish((res) => {
        finalResultCaptured = res;
      });

      // Consume stream via .text()
      const fullText = await stream.text();
      const fullReasoning = await stream.reasoning();

      expect(fullText).toBe("Hello World!");
      expect(fullReasoning).toBe("First thinking step... Second thinking step.");
      expect(textsReceived).toEqual(["Hello ", "World!"]);
      expect(reasoningsReceived).toEqual(["First thinking step... ", "Second thinking step."]);
      expect(finalResultCaptured.usage?.totalTokens).toBe(7);
    });

    it("converts stream to standard Web ReadableStream for text and SSE format", async () => {
      const mockStream = async function* (): AsyncIterable<ProviderChunkResponse> {
        yield { delta: "Part1 ", done: false };
        yield { delta: "Part2", done: true };
      };

      // 1. Text ReadableStream
      const stream1 = new SessionStream(mockStream());
      const webStream = stream1.toReadableStream("text");
      const reader = webStream.getReader();
      const decoder = new TextDecoder();
      let decoded = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        decoded += decoder.decode(value);
      }
      expect(decoded).toBe("Part1 Part2");

      // 2. SSE ReadableStream
      const stream2 = new SessionStream(mockStream());
      const sseStream = stream2.toReadableStream("sse");
      const sseReader = sseStream.getReader();
      let sseDecoded = "";

      while (true) {
        const { value, done } = await sseReader.read();
        if (done) break;
        sseDecoded += decoder.decode(value);
      }
      expect(sseDecoded).toContain('data: {"delta":"Part1 "');
      expect(sseDecoded).toContain("data: [DONE]\n\n");
    });

    it("pipes stream to Node/Express response object via pipeToResponse", async () => {
      const mockStream = async function* (): AsyncIterable<ProviderChunkResponse> {
        yield { delta: "Chunk 1", done: false };
        yield { delta: "Chunk 2", done: true };
      };

      const stream = new SessionStream(mockStream());
      const writtenChunks: string[] = [];
      let ended = false;

      const mockRes = {
        headersSent: false,
        setHeader: () => {},
        write: (chunk: string) => writtenChunks.push(chunk),
        end: () => {
          ended = true;
        },
      };

      await stream.pipeToResponse(mockRes, { format: "text" });
      expect(writtenChunks).toEqual(["Chunk 1", "Chunk 2"]);
      expect(ended).toBe(true);
    });
  });

  describe("Session Lifecycle: Fork, Rollback, Export, getMessageCount", () => {
    it("forks a session into an independent branch with copied messages", async () => {
      const storage = new MemoryStorage();
      const mockProvider: IProvider = {
        protocol: "openai",
        chat: async (req) => ({ role: "assistant", content: `Echo: ${req.messages[req.messages.length - 1].content}` }),
        chatStream: async function* () {},
      };

      const ai = new AIClient({ provider: mockProvider, storage });
      const sessionA = ai.session({ userId: "user1", sessionId: "session_original" });

      await sessionA.chat("Message 1");
      await sessionA.chat("Message 2");

      expect(await sessionA.getMessageCount()).toBe(4); // 2 user + 2 assistant

      // Fork sessionA up to message index 2 (just Message 1 and its reply)
      const sessionB = await sessionA.fork("session_forked", 2);
      expect(sessionB.sessionId).toBe("session_forked");
      expect(await sessionB.getMessageCount()).toBe(2);

      // Chatting on sessionB should not alter sessionA
      await sessionB.chat("Branching message");
      expect(await sessionB.getMessageCount()).toBe(4);
      expect(await sessionA.getMessageCount()).toBe(4);

      const historyA = await sessionA.getHistory();
      const historyB = await sessionB.getHistory();
      expect(historyA[2].content).toBe("Message 2");
      expect(historyB[2].content).toBe("Branching message");
    });

    it("rolls back the last conversational turn (user and assistant pair)", async () => {
      const storage = new MemoryStorage();
      const mockProvider: IProvider = {
        protocol: "openai",
        chat: async () => ({ role: "assistant", content: "Answer" }),
        chatStream: async function* () {},
      };

      const ai = new AIClient({ provider: mockProvider, storage });
      const session = ai.session({ userId: "u_rollback", sessionId: "s_rollback" });

      await session.chat("Turn 1 Question");
      await session.chat("Turn 2 Mistaken Question");

      expect(await session.getMessageCount()).toBe(4);

      // Rollback last turn
      const rolledBack = await session.rollback();
      expect(rolledBack?.userMessage?.content).toBe("Turn 2 Mistaken Question");
      expect(rolledBack?.assistantMessage?.content).toBe("Answer");
      expect(await session.getMessageCount()).toBe(2);

      const history = await session.getHistory();
      expect(history[0].content).toBe("Turn 1 Question");
      expect(history[1].content).toBe("Answer");
    });

    it("exports session to formatted Markdown and JSON", async () => {
      const storage = new MemoryStorage();
      const mockProvider: IProvider = {
        protocol: "openai",
        chat: async () => ({ role: "assistant", content: "42 is the answer." }),
        chatStream: async function* () {},
      };

      const ai = new AIClient({ provider: mockProvider, storage });
      const session = ai.session({
        userId: "u_export",
        sessionId: "s_export",
        system: "You are the ultimate computer.",
      });

      await session.chat("What is the meaning of life?");

      // 1. Export Markdown
      const md = await session.export("markdown");
      expect(md).toContain("# Conversation: s_export");
      expect(md).toContain("👤 User");
      expect(md).toContain("What is the meaning of life?");
      expect(md).toContain("🤖 Assistant");
      expect(md).toContain("42 is the answer.");

      // 2. Export JSON
      const jsonStr = await session.export("json");
      const parsed = JSON.parse(jsonStr);
      expect(parsed.sessionId).toBe("s_export");
      expect(parsed.messages).toHaveLength(2);
    });
  });

  describe("Storage: Pagination, Sorting & Search in listSessions", () => {
    it("supports search, pagination, and sorting in SQLiteStorage and MemoryStorage", async () => {
      const storages = [
        new MemoryStorage(),
        new SQLiteStorage({ dbPath: ":memory:" }),
      ];

      for (const storage of storages) {
        // Seed 4 sessions
        await storage.saveSession({
          userId: "user_query",
          sessionId: "sess_alpha_billing",
          messages: [{ id: "1", role: "user", content: "How do I upgrade payment plan?", createdAt: 100 }],
          createdAt: 100,
          updatedAt: 100,
        });

        await storage.saveSession({
          userId: "user_query",
          sessionId: "sess_beta_auth",
          messages: [{ id: "2", role: "user", content: "Reset password instructions", createdAt: 200 }],
          createdAt: 200,
          updatedAt: 200,
        });

        await storage.saveSession({
          userId: "user_query",
          sessionId: "sess_gamma_support",
          messages: [{ id: "3", role: "user", content: "Need invoice receipt billing", createdAt: 300 }],
          createdAt: 300,
          updatedAt: 300,
        });

        await storage.saveSession({
          userId: "user_query",
          sessionId: "sess_delta_general",
          messages: [{ id: "4", role: "user", content: "General product overview", createdAt: 400 }],
          createdAt: 400,
          updatedAt: 400,
        });

        // 1. Search for 'billing' -> should match alpha and gamma
        const searchResults = await storage.listSessions("user_query", { search: "billing" });
        expect(searchResults.length).toBe(2);
        expect(searchResults.map((s) => s.sessionId)).toContain("sess_alpha_billing");
        expect(searchResults.map((s) => s.sessionId)).toContain("sess_gamma_support");

        // 2. Pagination: limit 2, offset 1
        const paginated = await storage.listSessions("user_query", { limit: 2, offset: 1 });
        expect(paginated.length).toBe(2);
        // Default sort is updatedAt desc: 400 (delta), 300 (gamma), 200 (beta), 100 (alpha)
        expect(paginated[0].sessionId).toBe("sess_gamma_support");
        expect(paginated[1].sessionId).toBe("sess_beta_auth");

        // 3. Sort by createdAt asc
        const ascList = await storage.listSessions("user_query", {
          sortBy: "createdAt",
          sortOrder: "asc",
          limit: 1,
        });
        expect(ascList[0].sessionId).toBe("sess_alpha_billing");
      }
    });
  });
});
