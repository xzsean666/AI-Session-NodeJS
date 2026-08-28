import { describe, it, expect } from "vitest";
import {
  AIClient,
  MemoryStorage,
  OpenAICompatibleProvider,
  AnthropicProvider,
  GeminiProvider,
  type IProvider,
  type ProviderChatRequest,
} from "../../src/index.js";

describe("End-to-End Integration (TASK-010)", () => {
  describe("OpenAI-Compatible Streaming & Non-Streaming Lifecycle", () => {
    it("runs chat and streamChat with OpenAICompatibleProvider and persists state", async () => {
      const storage = new MemoryStorage();

      const mockFetch: typeof fetch = async (url, init) => {
        const body = JSON.parse(init?.body as string);
        const isStream = Boolean(body.stream);
        const lastMsg = body.messages[body.messages.length - 1].content;

        if (isStream) {
          const sse =
            `data: {"choices":[{"delta":{"content":"Streamed reply to: "},"finish_reason":null}]}\n\n` +
            `data: {"choices":[{"delta":{"content":"${lastMsg}"},"finish_reason":"stop"}]}\n\n` +
            `data: [DONE]\n\n`;

          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        }

        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `Echo: ${lastMsg}` } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const ai = new AIClient({
        provider: {
          protocol: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          model: "gpt-4o",
          fetch: mockFetch,
        },
        storage,
      });

      const session = ai.session({
        userId: "user_e2e_1",
        sessionId: "sess_e2e_1",
        system: "You are a test assistant.",
      });

      // 1. Non-streaming turn
      const reply1 = await session.chat("Hello non-stream");
      expect(reply1.content).toBe("Echo: Hello non-stream");

      // 2. Streaming turn
      const stream = await session.chatStream("Hello stream");
      const streamDeltas: string[] = [];
      for await (const chunk of stream) {
        if (chunk.delta) {
          streamDeltas.push(chunk.delta);
        }
      }
      expect(streamDeltas.join("")).toBe("Streamed reply to: Hello stream");

      // 3. Verify history in storage
      const history = await session.getHistory();
      expect(history).toHaveLength(4);
      expect(history.map((m) => m.content)).toEqual([
        "Hello non-stream",
        "Echo: Hello non-stream",
        "Hello stream",
        "Streamed reply to: Hello stream",
      ]);
    });
  });

  describe("Application Restart & Session Restoration Flow", () => {
    it("seamlessly recovers history and session state on a new client instance", async () => {
      const sharedStorage = new MemoryStorage();

      const mockProvider: IProvider = {
        protocol: "mock",
        chat: async (req) => ({
          role: "assistant",
          content: `Bot response to: ${req.messages[req.messages.length - 1].content}`,
        }),
        chatStream: async function* () {},
      };

      // App Run 1: user opens session and chats
      const app1Client = new AIClient({
        provider: mockProvider,
        storage: sharedStorage,
      });

      const session1 = app1Client.session({
        userId: "user_reboot",
        sessionId: "session_persistent",
        system: "Be concise",
        metadata: { clientVersion: "1.0.0" },
      });

      await session1.chat("First message before restart");
      await session1.updateMetadata({ tag: "vip" });

      // App Run 2: app restarts, client is re-created with same storage
      const app2Client = new AIClient({
        provider: mockProvider,
        storage: sharedStorage,
      });

      const loadedSession = await app2Client.loadSession("user_reboot", "session_persistent");
      expect(loadedSession).not.toBeNull();

      const historyBeforeTurn = await loadedSession!.getHistory();
      expect(historyBeforeTurn).toHaveLength(2);
      expect(historyBeforeTurn[0].content).toBe("First message before restart");

      const metadata = await loadedSession!.getMetadata();
      expect(metadata.tag).toBe("vip");

      // Continue conversation on loaded session
      const reply = await loadedSession!.chat("Second message after restart");
      expect(reply.content).toBe("Bot response to: Second message after restart");

      const historyAfterTurn = await loadedSession!.getHistory();
      expect(historyAfterTurn).toHaveLength(4);
    });
  });

  describe("Context Compaction End-to-End Cycle", () => {
    it("automatically triggers compact when token budget is exceeded and continues seamlessly", async () => {
      const storage = new MemoryStorage();
      let summaryCount = 0;
      const requestsReceived: ProviderChatRequest[] = [];

      const mockProvider: IProvider = {
        protocol: "mock",
        chat: async (req) => {
          requestsReceived.push(req);
          // If request is asking for summary
          if (req.system?.includes("summarizer")) {
            summaryCount++;
            return {
              role: "assistant",
              content: `Summary #${summaryCount}: Key discussion points compacted.`,
            };
          }

          return {
            role: "assistant",
            content: `Response to: ${req.messages[req.messages.length - 1].content}`,
          };
        },
        chatStream: async function* () {},
      };

      const ai = new AIClient({
        provider: mockProvider,
        storage,
        contextOptions: {
          maxContextTokens: 100,
          compactThresholdTokens: 65,
          keepRecentMessages: 2,
          autoCompact: true,
        },
      });

      const session = ai.session({
        userId: "u_compact",
        sessionId: "s_compact",
        system: "You are an intelligent assistant.",
      });

      // Turn 1 & Turn 2 (4 messages total, well under 40 tokens)
      await session.chat("Hello from turn 1");
      await session.chat("Hello from turn 2");

      expect(summaryCount).toBe(0);
      expect(await session.getSummary()).toBeUndefined();

      // Turn 3: Adds more messages, now total tokens will exceed 40 tokens -> triggers automatic compaction!
      const turn3Result = await session.chat("Hello from turn 3 which pushes context over threshold");

      expect(turn3Result.compacted).toBe(true);
      expect(summaryCount).toBe(1);

      // Verify session summary is stored
      const summary = await session.getSummary();
      expect(summary).toBe("Summary #1: Key discussion points compacted.");

      // Verify full history is STILL COMPLETE (6 messages)
      const fullHistory = await session.getHistory();
      expect(fullHistory).toHaveLength(6);

      // Turn 4: Next request sends [Previous Conversation Summary] in system prompt and only recent messages
      const turn4Result = await session.chat("Turn 4 following compaction");
      expect(turn4Result.content).toBe("Response to: Turn 4 following compaction");

      // Inspect the latest request received by provider
      const lastRequest = requestsReceived[requestsReceived.length - 1];
      expect(lastRequest.system).toContain("[Previous Conversation Summary]");
      expect(lastRequest.system).toContain("Key discussion points compacted.");
      // Messages sent to provider are capped at recent uncompacted messages
      expect(lastRequest.messages.length).toBeLessThanOrEqual(4);

      // Full history has 8 messages!
      const finalHistory = await session.getHistory();
      expect(finalHistory).toHaveLength(8);
    });
  });

  describe("Anthropic and Gemini Providers in AIClient", () => {
    it("works with Anthropic provider configuration", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Hello from Claude adapter" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const ai = new AIClient({
        provider: {
          protocol: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-ant-test",
          model: "claude-3-5-sonnet",
          fetch: mockFetch,
        },
        storage: new MemoryStorage(),
      });

      const session = ai.session({
        userId: "u_claude",
        sessionId: "s_claude",
        system: "Claude assistant",
      });

      const reply = await session.chat("Hello Claude");
      expect(reply.content).toBe("Hello from Claude adapter");
      expect(await session.getHistory()).toHaveLength(2);
    });

    it("works with Gemini provider configuration", async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Hello from Gemini adapter" }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const ai = new AIClient({
        provider: {
          protocol: "gemini",
          baseUrl: "https://generativelanguage.googleapis.com",
          apiKey: "gemini-test",
          model: "gemini-1.5-pro",
          fetch: mockFetch,
        },
        storage: new MemoryStorage(),
      });

      const session = ai.session({
        userId: "u_gemini",
        sessionId: "s_gemini",
        system: "Gemini assistant",
      });

      const reply = await session.chat("Hello Gemini");
      expect(reply.content).toBe("Hello from Gemini adapter");
      expect(await session.getHistory()).toHaveLength(2);
    });
  });
});
